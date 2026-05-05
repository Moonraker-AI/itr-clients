/**
 * /admin/clients/:id — minimal detail view.
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
  retreatRequiredConsents,
  retreats,
  therapists,
} from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { getTemplate } from '../../lib/consent-templates.js';
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

  const required = await db
    .select({
      templateId: retreatRequiredConsents.templateId,
      name: consentTemplates.name,
      requiresSignature: consentTemplates.requiresSignature,
    })
    .from(retreatRequiredConsents)
    .innerJoin(consentTemplates, eq(retreatRequiredConsents.templateId, consentTemplates.id))
    .where(eq(retreatRequiredConsents.retreatId, id))
    .orderBy(asc(consentTemplates.name));

  const sigs = await db
    .select({
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
      gmailMessageId: emailLog.gmailMessageId,
      status: emailLog.status,
      sentAt: emailLog.sentAt,
    })
    .from(emailLog)
    .where(eq(emailLog.retreatId, id))
    .orderBy(desc(emailLog.sentAt))
    .limit(20);

  const publicBase = process.env.PUBLIC_BASE_URL ?? `${c.req.url.split('/admin')[0]}`;
  const publicUrl = `${publicBase}/c/${row.clientToken}`;
  const consentsUrl = `${publicUrl}/consents`;

  const depositPaid = audits.some((a) => a.eventType === 'deposit_paid');
  const showConfirmDates = row.state === 'awaiting_deposit' && depositPaid;
  const user = c.get('user');

  return c.html(
    <Layout title={`Retreat ${row.retreatId.slice(0, 8)} — ITR Client HQ`}>
      <AdminShell user={user} current="dashboard">
        <PageHeader
          title={`Retreat ${row.retreatId.slice(0, 8)}`}
          description={row.retreatId}
        >
          <LinkButton href="/admin" variant="ghost" size="sm">
            ← Dashboard
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
                  ['State of residence', row.clientStateOfResidence ?? '—'],
                  ['Therapist', row.therapistFullName],
                  ['Location', row.locationName ?? '—'],
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
                      ? '—'
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
                        <Badge variant="success">
                          signed {sig.signedAt.toISOString().slice(0, 10)}
                        </Badge>
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
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
          </CardHeader>
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
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Email log</CardTitle>
          </CardHeader>
          <CardContent class="px-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>When</Th>
                  <Th>Template</Th>
                  <Th>Recipient</Th>
                  <Th>Status</Th>
                  <Th>Gmail msg id</Th>
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
                      {e.status === 'failed' ? (
                        <Badge variant="destructive">{e.status}</Badge>
                      ) : (
                        <Badge variant="secondary">{e.status}</Badge>
                      )}
                    </Td>
                    <Td>
                      <code class="font-mono text-xs">{e.gmailMessageId ?? ''}</code>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </CardContent>
        </Card>
      </AdminShell>
    </Layout>,
  );
});
