/**
 * /admin/clients/:id - minimal detail view.
 *
 * Renders: client + retreat snapshot, state, public client_token URL,
 * required consents w/ signed-or-not, recent audit events, recent emails.
 * Top-nav links to refund + cancel + dashboard. Therapist-scoped via the
 * M8 requireAuth middleware + therapistCanAccess gate.
 */

import { Hono } from 'hono';
import { asc, desc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  auditEvents,
  clients,
  consentSignatures,
  consentTemplates,
  emailLog,
  locations,
  payments,
  payouts,
  retreatRequiredConsents,
  retreats,
  therapists,
} from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { getTemplate, sortRequiredConsents } from '../../lib/consent-templates.js';
import { formatCents } from '../../lib/pricing.js';
import {
  AdminShell,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Layout,
  LinkButton,
  PageHeader,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '../../lib/ui/index.js';

export const adminClientsDetailRoute = new Hono();

// Native <details>/<summary> collapsible card header. Hides the default
// marker on every browser, applies CardHeader-style padding + flex.
const SUMMARY_CLASS =
  'flex items-center justify-between gap-3 p-6 cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden [&::marker]:hidden';

function DefList({ rows }: { rows: Array<[string, unknown]> }) {
  return (
    <dl class="grid grid-cols-[180px_1fr] gap-y-2 gap-x-4 text-sm">
      {rows.map(([label, value]) => (
        <>
          <dt class="text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </>
      ))}
    </dl>
  );
}

adminClientsDetailRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();

  const [row] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      therapistId: retreats.therapistId,
      clientToken: retreats.clientToken,
      plannedFullDays: retreats.plannedFullDays,
      plannedHalfDays: retreats.plannedHalfDays,
      paymentMethod: retreats.paymentMethod,
      pricingBasis: retreats.pricingBasis,
      pricingNotes: retreats.pricingNotes,
      fullDayRateCents: retreats.fullDayRateCents,
      halfDayRateCents: retreats.halfDayRateCents,
      depositCents: retreats.depositCents,
      totalPlannedCents: retreats.totalPlannedCents,
      scheduledStartDate: retreats.scheduledStartDate,
      scheduledEndDate: retreats.scheduledEndDate,
      createdAt: retreats.createdAt,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      clientEmail: clients.email,
      clientStateOfResidence: clients.stateOfResidence,
      therapistFullName: therapists.fullName,
      locationName: locations.name,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .innerJoin(therapists, eq(retreats.therapistId, therapists.id))
    .leftJoin(locations, eq(retreats.locationId, locations.id))
    .where(eq(retreats.id, id));

  if (!row) return c.notFound();
  if (!therapistCanAccess(c.get('user'), row.therapistId)) return c.notFound();

  const requiredRaw = await db
    .select({
      templateId: retreatRequiredConsents.templateId,
      name: consentTemplates.name,
      requiresSignature: consentTemplates.requiresSignature,
    })
    .from(retreatRequiredConsents)
    .innerJoin(consentTemplates, eq(retreatRequiredConsents.templateId, consentTemplates.id))
    .where(eq(retreatRequiredConsents.retreatId, id))
    .orderBy(asc(consentTemplates.name));
  const required = sortRequiredConsents(requiredRaw);

  const sigs = await db
    .select({
      id: consentSignatures.id,
      templateId: consentSignatures.templateId,
      signedAt: consentSignatures.signedAt,
      pdfStoragePath: consentSignatures.pdfStoragePath,
    })
    .from(consentSignatures)
    .where(eq(consentSignatures.retreatId, id));
  const sigByTemplate = new Map(sigs.map((s) => [s.templateId, s]));

  const audits = await db
    .select({
      eventType: auditEvents.eventType,
      actorType: auditEvents.actorType,
      payload: auditEvents.payload,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(eq(auditEvents.retreatId, id))
    .orderBy(desc(auditEvents.createdAt))
    .limit(50);

  const emails = await db
    .select({
      recipient: emailLog.recipient,
      templateName: emailLog.templateName,
      messageId: emailLog.messageId,
      status: emailLog.status,
      sentAt: emailLog.sentAt,
      bouncedAt: emailLog.bouncedAt,
      bounceReason: emailLog.bounceReason,
    })
    .from(emailLog)
    .where(eq(emailLog.retreatId, id))
    .orderBy(desc(emailLog.sentAt))
    .limit(20);

  const paymentRows = await db
    .select({
      id: payments.id,
      kind: payments.kind,
      status: payments.status,
      amountCents: payments.amountCents,
      stripePaymentIntentId: payments.stripePaymentIntentId,
      failureCode: payments.failureCode,
      failureMessage: payments.failureMessage,
      attemptCount: payments.attemptCount,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(eq(payments.retreatId, id))
    .orderBy(desc(payments.createdAt));

  // Phase C (v0.26.0). Connect payouts for this retreat. Grouped by
  // payment_id so each payment row can render its matching transfer(s).
  // Payouts with NULL payment_id (race between transfer.created and
  // payments insert) are surfaced unattached at the bottom of the card.
  const payoutRows = await db
    .select({
      id: payouts.id,
      paymentId: payouts.paymentId,
      stripeTransferId: payouts.stripeTransferId,
      amountCents: payouts.amountCents,
      status: payouts.status,
      createdAt: payouts.createdAt,
    })
    .from(payouts)
    .where(eq(payouts.retreatId, id))
    .orderBy(desc(payouts.createdAt));
  // Orphans (payment_id IS NULL - race between transfer.created and our
  // payments insert) are visible on /admin/payouts; not surfaced here to
  // keep the card focused on the per-payment correlation.
  const payoutsByPaymentId = new Map<string, typeof payoutRows>();
  for (const p of payoutRows) {
    if (!p.paymentId) continue;
    const arr = payoutsByPaymentId.get(p.paymentId) ?? [];
    arr.push(p);
    payoutsByPaymentId.set(p.paymentId, arr);
  }

  // Stripe dashboard mode: pick `/test/` segment when our secret key is
  // a test-mode key, otherwise live. Restricted keys (`rk_*`) follow the
  // same `_test_`/`_live_` convention as secret keys (`sk_*`).
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
  const stripeMode = /_test_/.test(stripeKey) ? 'test' : 'live';
  const stripeBase =
    stripeMode === 'test'
      ? 'https://dashboard.stripe.com/test'
      : 'https://dashboard.stripe.com';
  const stripePiUrl = (pi: string): string | null => {
    // Skip our synthetic PI placeholders (e.g. final_zero_<retreatId>) which
    // are written for $0 final-charge rows and have no Stripe object.
    if (!pi || pi.startsWith('final_zero_')) return null;
    return `${stripeBase}/payments/${pi}`;
  };
  const stripeTransferUrl = (transferId: string): string =>
    `${stripeBase}/connect/transfers/${transferId}`;
  const payoutBadgeVariant = (
    status: 'pending' | 'in_transit' | 'paid' | 'failed' | 'reversed',
  ): 'default' | 'secondary' | 'destructive' | 'success' | 'outline' => {
    if (status === 'paid') return 'success';
    if (status === 'reversed' || status === 'failed') return 'destructive';
    if (status === 'in_transit') return 'default';
    return 'secondary';
  };

  const publicBase = process.env.PUBLIC_BASE_URL ?? `${c.req.url.split('/admin')[0]}`;
  const publicUrl = `${publicBase}/c/${row.clientToken}`;
  const consentsUrl = `${publicUrl}/consents`;

  const depositPaid = audits.some((a) => a.eventType === 'deposit_paid');
  const showConfirmDates = row.state === 'awaiting_deposit' && depositPaid;
  const user = c.get('user');

  return c.html(
    <Layout title={`Retreat ${row.retreatId.slice(0, 8)} - ITR Clients`}>
      <AdminShell user={user} current="dashboard">
        <PageHeader
          title={`Retreat ${row.retreatId.slice(0, 8)}`}
          description={row.retreatId}
        >
          <LinkButton href="/admin" variant="ghost" size="sm">
            ← Dashboard
          </LinkButton>
          <LinkButton
            href={`/admin/clients/${row.retreatId}/export.json`}
            variant="outline"
            size="sm"
          >
            Export
          </LinkButton>
          <LinkButton href={`/admin/clients/${row.retreatId}/refund`} variant="outline" size="sm">
            Refund
          </LinkButton>
          <LinkButton
            href={`/admin/clients/${row.retreatId}/cancel`}
            variant="destructive"
            size="sm"
          >
            Cancel
          </LinkButton>
        </PageHeader>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <Card>
            <CardHeader>
              <CardTitle class="text-sm text-muted-foreground">State</CardTitle>
            </CardHeader>
            <CardContent>
              <Badge variant="default" class="text-sm px-3 py-1">
                {row.state}
              </Badge>
            </CardContent>
          </Card>
          <Card class="lg:col-span-2">
            <CardHeader>
              <CardTitle class="text-sm text-muted-foreground">Public client URL</CardTitle>
            </CardHeader>
            <CardContent class="space-y-2">
              <a
                href={publicUrl}
                target="_blank"
                class="block font-mono text-xs text-primary hover:underline break-all"
              >
                {publicUrl}
              </a>
              <a
                href={consentsUrl}
                target="_blank"
                class="block font-mono text-xs text-muted-foreground hover:text-primary hover:underline break-all"
              >
                {consentsUrl}
              </a>
            </CardContent>
          </Card>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <Card>
            <CardHeader>
              <CardTitle>Client + therapist</CardTitle>
            </CardHeader>
            <CardContent>
              <DefList
                rows={[
                  ['Client', `${row.clientFirstName} ${row.clientLastName}`],
                  ['Email', row.clientEmail],
                  ['State of residence', row.clientStateOfResidence ?? '-'],
                  ['Therapist', row.therapistFullName],
                  ['Location', row.locationName ?? '-'],
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pricing</CardTitle>
            </CardHeader>
            <CardContent>
              <DefList
                rows={[
                  ['Basis', row.pricingBasis],
                  ['Payment method', row.paymentMethod],
                  ['Full day rate', `${formatCents(row.fullDayRateCents)} × ${row.plannedFullDays}`],
                  [
                    'Half day rate',
                    row.halfDayRateCents == null
                      ? '-'
                      : `${formatCents(row.halfDayRateCents)} × ${row.plannedHalfDays}`,
                  ],
                  ['Total planned', formatCents(row.totalPlannedCents)],
                  ['Deposit', formatCents(row.depositCents)],
                  ['Pricing notes', row.pricingNotes ?? ''],
                ]}
              />
            </CardContent>
          </Card>
        </div>

        {row.scheduledStartDate && row.scheduledEndDate ? (
          <Card class="mb-6">
            <CardHeader>
              <CardTitle>Scheduled dates</CardTitle>
            </CardHeader>
            <CardContent>
              <DefList
                rows={[
                  ['Start', row.scheduledStartDate],
                  ['End', row.scheduledEndDate],
                ]}
              />
            </CardContent>
          </Card>
        ) : showConfirmDates ? (
          <Card class="mb-6">
            <CardHeader>
              <CardTitle>Next step</CardTitle>
            </CardHeader>
            <CardContent>
              <LinkButton href={`/admin/clients/${row.retreatId}/confirm-dates`}>
                Confirm retreat dates
              </LinkButton>
            </CardContent>
          </Card>
        ) : null}

        {row.state === 'in_progress' ? (
          <Card class="mb-6">
            <CardHeader>
              <CardTitle>Next step</CardTitle>
            </CardHeader>
            <CardContent>
              <LinkButton href={`/admin/clients/${row.retreatId}/complete`}>
                Complete retreat + charge balance
              </LinkButton>
            </CardContent>
          </Card>
        ) : null}

        {row.state === 'final_charge_failed' ? (
          <Alert variant="destructive" class="mb-6">
            <AlertTitle>Final charge failed</AlertTitle>
            <AlertDescription>
              <p class="mb-2">
                Auto-retry runs at 24h then 72h cadence via the retry cron. Client recovery links:
              </p>
              <ul class="space-y-1 text-xs font-mono">
                <li>
                  Update saved card (Stripe portal): {publicBase}/c/{row.clientToken}/update-payment
                </li>
                <li>
                  3DS hosted-confirmation page: {publicBase}/c/{row.clientToken}/confirm-payment
                </li>
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <Card class="mb-6">
          <CardHeader>
            <CardTitle>Required consents</CardTitle>
          </CardHeader>
          <CardContent>
            <ul class="space-y-2 text-sm">
              {required.map((r) => {
                const sig = sigByTemplate.get(r.templateId);
                let title: string;
                try {
                  title = getTemplate(r.name).meta.title;
                } catch {
                  title = r.name;
                }
                return (
                  <li class="flex items-center justify-between gap-3">
                    <span>{title}</span>
                    {r.requiresSignature ? (
                      sig ? (
                        sig.pdfStoragePath ? (
                          <a
                            href={`/admin/clients/${row.retreatId}/consents/${sig.id}/pdf`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Download signed PDF (opens in new tab)"
                          >
                            <Badge variant="success">
                              signed {sig.signedAt.toISOString().slice(0, 10)} ↗
                            </Badge>
                          </a>
                        ) : (
                          <Badge variant="success">
                            signed {sig.signedAt.toISOString().slice(0, 10)} (PDF pending)
                          </Badge>
                        )
                      ) : (
                        <Badge variant="destructive">not yet signed</Badge>
                      )
                    ) : (
                      <Badge variant="secondary">informational</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <Card class="mb-6">
          <details class="group">
            <summary class={SUMMARY_CLASS}>
              <CardTitle>
                Audit log{' '}
                <span class="text-sm font-normal text-muted-foreground">({audits.length})</span>
              </CardTitle>
              <span class="text-muted-foreground transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <CardContent class="px-0">
              <Table>
                <Thead>
                  <Tr>
                    <Th>When</Th>
                    <Th>Event</Th>
                    <Th>Actor</Th>
                    <Th>Payload</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {audits.map((a) => (
                    <Tr>
                      <Td class="text-xs text-muted-foreground whitespace-nowrap">
                        {a.createdAt.toISOString()}
                      </Td>
                      <Td>
                        <code class="font-mono text-xs">{a.eventType}</code>
                      </Td>
                      <Td class="text-sm">{a.actorType}</Td>
                      <Td>
                        <code class="font-mono text-xs whitespace-pre-wrap break-all block max-w-md">
                          {a.payload ? JSON.stringify(a.payload) : ''}
                        </code>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </CardContent>
          </details>
        </Card>

        <Card>
          <details class="group">
            <summary class={SUMMARY_CLASS}>
              <CardTitle>
                Payments{' '}
                <span class="text-sm font-normal text-muted-foreground">
                  ({paymentRows.length}) · Stripe {stripeMode} mode
                </span>
              </CardTitle>
              <span class="text-muted-foreground transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <CardContent class="px-0">
              <Table>
                <Thead>
                  <Tr>
                    <Th>Created</Th>
                    <Th>Kind</Th>
                    <Th>Amount</Th>
                    <Th>Status</Th>
                    <Th>Attempts</Th>
                    <Th>PaymentIntent</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {paymentRows.length === 0 ? (
                    <Tr>
                      <Td colspan={6} class="text-center text-sm text-muted-foreground py-6">
                        No payments yet.
                      </Td>
                    </Tr>
                  ) : (
                    paymentRows.flatMap((p) => {
                      const piUrl = p.stripePaymentIntentId
                        ? stripePiUrl(p.stripePaymentIntentId)
                        : null;
                      const failed = p.status === 'failed';
                      const matchingPayouts = payoutsByPaymentId.get(p.id) ?? [];
                      const trs = [
                        <Tr>
                          <Td class="text-xs text-muted-foreground whitespace-nowrap">
                            {p.createdAt.toISOString()}
                          </Td>
                          <Td class="text-sm">{p.kind}</Td>
                          <Td class="text-sm font-medium">{formatCents(p.amountCents)}</Td>
                          <Td>
                            {failed ? (
                              <div class="flex flex-col gap-0.5">
                                <Badge variant="destructive">{p.status}</Badge>
                                {p.failureCode || p.failureMessage ? (
                                  <span class="text-xs text-muted-foreground">
                                    {p.failureCode ?? ''}
                                    {p.failureCode && p.failureMessage ? ': ' : ''}
                                    {p.failureMessage ?? ''}
                                  </span>
                                ) : null}
                              </div>
                            ) : (
                              <Badge variant="secondary">{p.status}</Badge>
                            )}
                          </Td>
                          <Td class="text-xs text-muted-foreground">{p.attemptCount}</Td>
                          <Td>
                            {piUrl ? (
                              <a
                                href={piUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="font-mono text-xs underline hover:text-primary"
                              >
                                {p.stripePaymentIntentId} ↗
                              </a>
                            ) : (
                              <code class="font-mono text-xs text-muted-foreground">
                                {p.stripePaymentIntentId ?? '-'}
                              </code>
                            )}
                          </Td>
                        </Tr>,
                      ];
                      for (const po of matchingPayouts) {
                        trs.push(
                          <Tr class="bg-muted/30">
                            <Td class="text-xs text-muted-foreground whitespace-nowrap pl-8">
                              ↳ payout
                            </Td>
                            <Td class="text-xs text-muted-foreground">therapist</Td>
                            <Td class="text-sm font-medium">
                              {formatCents(po.amountCents)}
                            </Td>
                            <Td>
                              <Badge variant={payoutBadgeVariant(po.status)}>
                                {po.status}
                              </Badge>
                            </Td>
                            <Td class="text-xs text-muted-foreground" />
                            <Td>
                              {po.stripeTransferId ? (
                                <a
                                  href={stripeTransferUrl(po.stripeTransferId)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  class="font-mono text-xs underline hover:text-primary"
                                >
                                  {po.stripeTransferId} ↗
                                </a>
                              ) : (
                                <span class="text-xs text-muted-foreground">-</span>
                              )}
                            </Td>
                          </Tr>,
                        );
                      }
                      return trs;
                    })
                  )}
                </Tbody>
              </Table>
            </CardContent>
          </details>
        </Card>

        <Card>
          <details class="group">
            <summary class={SUMMARY_CLASS}>
              <CardTitle>
                Email log{' '}
                <span class="text-sm font-normal text-muted-foreground">({emails.length})</span>
              </CardTitle>
              <span class="text-muted-foreground transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <CardContent class="px-0">
              <Table>
                <Thead>
                  <Tr>
                    <Th>When</Th>
                    <Th>Template</Th>
                    <Th>Recipient</Th>
                    <Th>Status</Th>
                    <Th>Message id</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {emails.map((e) => (
                    <Tr>
                      <Td class="text-xs text-muted-foreground whitespace-nowrap">
                        {e.sentAt.toISOString()}
                      </Td>
                      <Td class="text-sm">{e.templateName}</Td>
                      <Td class="text-sm">{e.recipient}</Td>
                      <Td>
                        {e.status === 'failed' || e.status === 'bounced' ? (
                          <div class="flex flex-col gap-1">
                            <Badge variant="destructive">{e.status}</Badge>
                            {e.bounceReason ? (
                              <span class="text-xs text-muted-foreground">
                                {e.bounceReason}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <Badge variant="secondary">{e.status}</Badge>
                        )}
                      </Td>
                      <Td>
                        <code class="font-mono text-xs">{e.messageId ?? ''}</code>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </CardContent>
          </details>
        </Card>
      </AdminShell>
    </Layout>,
  );
});
