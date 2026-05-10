/**
 * /admin/payouts - global Stripe Connect payout ledger (Phase C, v0.26.0).
 *
 * One row per payouts table entry, populated by the transfer.* webhook
 * handlers in src/routes/api/webhooks-stripe.ts. Therapist scoping mirrors
 * /admin/audit: a non-admin therapist sees only payouts whose therapist_id
 * matches their own; admins see everything.
 *
 * Query params:
 *   ?therapist=<uuid>           exact match on payouts.therapist_id (admin only)
 *   ?status=<enum>              one of pending|in_transit|paid|failed|reversed
 *   ?from=YYYY-MM-DD            inclusive lower bound on created_at (UTC)
 *   ?to=YYYY-MM-DD              inclusive upper bound on created_at (UTC)
 *   ?limit=<n>                  default 50, max 200
 *   ?offset=<n>                 pagination offset
 */

import { Hono } from 'hono';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { payouts, retreats, therapists } from '../../db/schema.js';
import {
  AdminShell,
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Layout,
  LinkButton,
  PageHeader,
  Select,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '../../lib/ui/index.js';

export const adminPayoutsRoute = new Hono();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAYOUT_STATUSES = [
  'pending',
  'in_transit',
  'paid',
  'failed',
  'reversed',
] as const;
type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

function statusBadgeVariant(
  status: PayoutStatus,
): 'default' | 'secondary' | 'destructive' | 'success' | 'outline' {
  if (status === 'paid') return 'success';
  if (status === 'reversed' || status === 'failed') return 'destructive';
  if (status === 'in_transit') return 'default';
  return 'secondary'; // pending
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

function stripeConnectTransferUrl(transferId: string): string {
  // Connect transfers live under /connect/transfers/:id. Test vs live mode is
  // detected from the secret key prefix (matches the v0.19.0 pattern in
  // clients-detail.tsx).
  const isTest = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ?? false;
  const prefix = isTest ? 'test/' : '';
  return `https://dashboard.stripe.com/${prefix}connect/transfers/${transferId}`;
}

adminPayoutsRoute.get('/', async (c) => {
  const therapistRaw = (c.req.query('therapist') ?? '').trim();
  const statusRaw = (c.req.query('status') ?? '').trim();
  const fromRaw = (c.req.query('from') ?? '').trim();
  const toRaw = (c.req.query('to') ?? '').trim();

  const therapistFilter = UUID_RE.test(therapistRaw) ? therapistRaw : '';
  const statusFilter = (PAYOUT_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as PayoutStatus)
    : '';
  const fromDate = DATE_RE.test(fromRaw) ? fromRaw : '';
  const toDate = DATE_RE.test(toRaw) ? toRaw : '';

  const limitRaw = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
  const offsetRaw = Number(c.req.query('offset') ?? 0);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitRaw)))
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetRaw)
    ? Math.max(0, Math.trunc(offsetRaw))
    : 0;

  const { db } = await getDb();
  const user = c.get('user');

  const conditions = [];
  if (statusFilter) {
    conditions.push(eq(payouts.status, statusFilter));
  }
  if (fromDate) {
    conditions.push(gte(payouts.createdAt, new Date(`${fromDate}T00:00:00Z`)));
  }
  if (toDate) {
    conditions.push(
      lte(payouts.createdAt, new Date(`${toDate}T23:59:59.999Z`)),
    );
  }
  // Admin-only: filter by an arbitrary therapist UUID. Non-admins are
  // already pinned to their own therapist_id below, so honouring the
  // ?therapist= param for them would be at best redundant and at worst
  // would let a request return zero rows misleadingly.
  if (therapistFilter && user?.role !== 'therapist') {
    conditions.push(eq(payouts.therapistId, therapistFilter));
  }
  if (user && user.role === 'therapist') {
    conditions.push(eq(payouts.therapistId, user.therapistId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: payouts.id,
      retreatId: payouts.retreatId,
      stripeTransferId: payouts.stripeTransferId,
      destinationAccountId: payouts.destinationAccountId,
      amountCents: payouts.amountCents,
      status: payouts.status,
      createdAt: payouts.createdAt,
      therapistId: payouts.therapistId,
      therapistName: therapists.fullName,
    })
    .from(payouts)
    .innerJoin(therapists, eq(payouts.therapistId, therapists.id))
    .where(where)
    .orderBy(desc(payouts.createdAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(payouts)
    .where(where);
  const total = Number(countRows[0]?.count ?? 0);

  // Therapist dropdown options. Only fetched for admins; therapists never
  // see the picker because their view is pinned to their own id.
  let therapistOptions: Array<{ id: string; fullName: string }> = [];
  if (user?.role !== 'therapist') {
    therapistOptions = await db
      .select({ id: therapists.id, fullName: therapists.fullName })
      .from(therapists)
      .where(eq(therapists.active, true))
      .orderBy(therapists.fullName);
  }

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;

  const baseQs = (off: number) => {
    const params = new URLSearchParams();
    if (therapistFilter) params.set('therapist', therapistFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (limit !== DEFAULT_LIMIT) params.set('limit', String(limit));
    if (off !== 0) params.set('offset', String(off));
    const s = params.toString();
    return s.length > 0 ? `?${s}` : '';
  };

  return c.html(
    <Layout title="Payouts - ITR Clients">
      <AdminShell user={user} current="payouts">
        <PageHeader
          title="Payouts"
          description={`${rows.length} of ${total} · offset ${offset}`}
        >
          <LinkButton href="/admin" variant="ghost" size="sm">
            ← Back to dashboard
          </LinkButton>
        </PageHeader>

        <Card class="mb-6">
          <CardContent class="pt-6">
            <form
              method="get"
              class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
            >
              {user?.role !== 'therapist' ? (
                <div class="space-y-1.5">
                  <label class="text-xs text-muted-foreground">Therapist</label>
                  <Select name="therapist">
                    <option value="">all</option>
                    {therapistOptions.map((t) => (
                      <option value={t.id} selected={t.id === therapistFilter}>
                        {t.fullName}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <div class="space-y-1.5">
                <label class="text-xs text-muted-foreground">Status</label>
                <Select name="status">
                  <option value="">all</option>
                  {PAYOUT_STATUSES.map((s) => (
                    <option value={s} selected={s === statusFilter}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
              <div class="space-y-1.5">
                <label class="text-xs text-muted-foreground">From (UTC)</label>
                <Input name="from" type="date" value={fromDate} />
              </div>
              <div class="space-y-1.5">
                <label class="text-xs text-muted-foreground">To (UTC)</label>
                <Input name="to" type="date" value={toDate} />
              </div>
              <div class="flex gap-2 sm:col-span-2 lg:col-span-5">
                <Button type="submit" size="default">
                  Filter
                </Button>
                <LinkButton href="/admin/payouts" variant="ghost" size="default">
                  Clear
                </LinkButton>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <Table>
            <Thead>
              <Tr>
                <Th>When (UTC)</Th>
                <Th>Therapist</Th>
                <Th>Retreat</Th>
                <Th class="text-right">Amount</Th>
                <Th>Status</Th>
                <Th>Transfer</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.length === 0 ? (
                <Tr>
                  <Td
                    colspan={6}
                    class="text-center text-sm text-muted-foreground py-8"
                  >
                    No payouts yet.
                  </Td>
                </Tr>
              ) : (
                rows.map((r) => (
                  <Tr>
                    <Td class="text-xs text-muted-foreground whitespace-nowrap">
                      {r.createdAt.toISOString()}
                    </Td>
                    <Td class="text-sm">{r.therapistName}</Td>
                    <Td>
                      {r.retreatId ? (
                        <a
                          href={`/admin/clients/${r.retreatId}`}
                          class="font-mono text-xs underline hover:text-primary"
                        >
                          {r.retreatId.slice(0, 8)}
                        </a>
                      ) : (
                        <span class="text-xs text-muted-foreground">-</span>
                      )}
                    </Td>
                    <Td class="text-right font-mono text-sm whitespace-nowrap">
                      {formatCents(r.amountCents)}
                    </Td>
                    <Td>
                      <Badge variant={statusBadgeVariant(r.status)}>
                        {r.status}
                      </Badge>
                    </Td>
                    <Td>
                      {r.stripeTransferId ? (
                        <a
                          href={stripeConnectTransferUrl(r.stripeTransferId)}
                          target="_blank"
                          rel="noreferrer"
                          class="font-mono text-xs underline hover:text-primary"
                        >
                          {r.stripeTransferId.slice(0, 14)} ↗
                        </a>
                      ) : (
                        <span class="text-xs text-muted-foreground">-</span>
                      )}
                    </Td>
                  </Tr>
                ))
              )}
            </Tbody>
          </Table>
        </Card>

        <div class="mt-4 flex items-center justify-between gap-3">
          {hasPrev ? (
            <LinkButton
              href={`/admin/payouts${baseQs(prevOffset)}`}
              variant="outline"
              size="sm"
            >
              ← Prev
            </LinkButton>
          ) : (
            <span />
          )}
          {hasNext ? (
            <LinkButton
              href={`/admin/payouts${baseQs(nextOffset)}`}
              variant="outline"
              size="sm"
            >
              Next →
            </LinkButton>
          ) : (
            <span />
          )}
        </div>
      </AdminShell>
    </Layout>,
  );
});
