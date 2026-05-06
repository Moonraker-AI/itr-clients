/**
 * /admin - list view of all retreats with state + therapist filters (M7).
 *
 * Query params:
 *   ?state=<state>             single state filter
 *   ?therapist=<therapist_id>  single therapist filter
 *   ?limit=<n>                 default 50, max 200
 *   ?offset=<n>                pagination offset
 *
 * Server-rendered HTML, no JS dependency.
 */

import { Hono } from 'hono';
import { raw } from 'hono/html';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { clients, retreats, therapists } from '../../db/schema.js';
import { formatCents } from '../../lib/pricing.js';
import { RETREAT_STATES, type RetreatState } from '../../lib/state-machine.js';
import {
  AdminShell,
  Badge,
  Card,
  CardContent,
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
  Button,
} from '../../lib/ui/index.js';

export const adminDashboardRoute = new Hono();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DashRow {
  retreatId: string;
  state: string;
  scheduledStartDate: string | null;
  scheduledEndDate: string | null;
  totalPlannedCents: number;
  totalActualCents: number | null;
  createdAt: Date;
  clientFirstName: string;
  clientLastName: string;
  therapistFullName: string;
  therapistId: string;
}

adminDashboardRoute.get('/', async (c) => {
  const stateFilter = c.req.query('state') ?? '';
  const therapistFilterRaw = c.req.query('therapist') ?? '';
  // UUID shape guard so a malformed `?therapist=` value can't reach drizzle
  // and surface as a database-level error.
  const therapistFilter = UUID_RE.test(therapistFilterRaw) ? therapistFilterRaw : '';

  // NaN guards - Number("not-a-num") is NaN; coerce to defaults.
  const limitRaw = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
  const offsetRaw = Number(c.req.query('offset') ?? 0);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitRaw)))
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetRaw)
    ? Math.max(0, Math.trunc(offsetRaw))
    : 0;

  const { db } = await getDb();

  const therapistRows = await db
    .select({ id: therapists.id, fullName: therapists.fullName })
    .from(therapists)
    .where(eq(therapists.active, true))
    .orderBy(asc(therapists.fullName));

  const user = c.get('user');
  const conditions = [];
  if (stateFilter && (RETREAT_STATES as readonly string[]).includes(stateFilter)) {
    conditions.push(eq(retreats.state, stateFilter as RetreatState));
  }
  // Therapist scoping (DESIGN §12 M8): non-admin therapists see only their own.
  if (user && user.role === 'therapist') {
    conditions.push(eq(retreats.therapistId, user.therapistId));
  } else if (therapistFilter) {
    conditions.push(eq(retreats.therapistId, therapistFilter));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      scheduledStartDate: retreats.scheduledStartDate,
      scheduledEndDate: retreats.scheduledEndDate,
      totalPlannedCents: retreats.totalPlannedCents,
      totalActualCents: retreats.totalActualCents,
      createdAt: retreats.createdAt,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      therapistFullName: therapists.fullName,
      therapistId: therapists.id,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .innerJoin(therapists, eq(retreats.therapistId, therapists.id))
    .where(where)
    .orderBy(desc(retreats.createdAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(retreats)
    .where(where);
  const total = Number(countRows[0]?.count ?? 0);

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;
  const baseQs = (off: number) => {
    const params = new URLSearchParams();
    if (stateFilter) params.set('state', stateFilter);
    if (therapistFilter) params.set('therapist', therapistFilter);
    if (limit !== DEFAULT_LIMIT) params.set('limit', String(limit));
    if (off !== 0) params.set('offset', String(off));
    const s = params.toString();
    return s.length > 0 ? `?${s}` : '';
  };

  const stateBadge = (state: string) => {
    const variant: 'default' | 'secondary' | 'destructive' | 'success' | 'outline' =
      state === 'cancelled' || state === 'failed'
        ? 'destructive'
        : state === 'completed' || state === 'paid_in_full'
          ? 'success'
          : state === 'draft' || state === 'pending'
            ? 'secondary'
            : 'default';
    return <Badge variant={variant}>{state}</Badge>;
  };

  return c.html(
    <Layout title="Dashboard - ITR Clients">
      <AdminShell user={user} current="dashboard">
        <PageHeader title="Retreats" description={`${rows.length} of ${total} · offset ${offset}`}>
          <LinkButton href="/admin/clients/new" size="sm">
            + New client
          </LinkButton>
          {user?.role === 'admin' ? (
            <LinkButton href="/admin/pricing" variant="outline" size="sm">
              Pricing config
            </LinkButton>
          ) : null}
        </PageHeader>

        <Card class="mb-6">
          <CardContent class="pt-6">
            <form method="get" class="flex flex-wrap items-end gap-3">
              <div class="space-y-1.5">
                <label class="text-xs text-muted-foreground">State</label>
                <Select name="state" class="min-w-[180px]">
                  <option value="">all</option>
                  {RETREAT_STATES.map((s) => (
                    <option value={s} selected={s === stateFilter}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
              <div class="space-y-1.5">
                <label class="text-xs text-muted-foreground">Therapist</label>
                <Select name="therapist" class="min-w-[200px]">
                  <option value="">all</option>
                  {therapistRows.map((t) => (
                    <option value={t.id} selected={t.id === therapistFilter}>
                      {t.fullName}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" size="default">
                Filter
              </Button>
              <LinkButton href="/admin" variant="ghost" size="default">
                Clear
              </LinkButton>
            </form>
          </CardContent>
        </Card>

        <Card>
          <Table>
            <Thead>
              <Tr>
                <Th>Id</Th>
                <Th>Client</Th>
                <Th>Therapist</Th>
                <Th>State</Th>
                <Th>Scheduled</Th>
                <Th>Total</Th>
                <Th>Created</Th>
              </Tr>
            </Thead>
            <Tbody>
              {(rows as DashRow[]).map((r) => {
                const dates =
                  r.scheduledStartDate && r.scheduledEndDate
                    ? `${r.scheduledStartDate} → ${r.scheduledEndDate}`
                    : '-';
                const totalLabel = r.totalActualCents
                  ? `${formatCents(r.totalActualCents)}`
                  : `${formatCents(r.totalPlannedCents)}`;
                const totalSuffix = r.totalActualCents ? 'actual' : 'planned';
                return (
                  <Tr href={`/admin/clients/${r.retreatId}`}>
                    <Td>
                      <span class="font-mono text-xs text-primary">
                        {r.retreatId.slice(0, 8)}
                      </span>
                    </Td>
                    <Td>
                      {r.clientFirstName} {r.clientLastName}
                    </Td>
                    <Td class="text-muted-foreground">{r.therapistFullName}</Td>
                    <Td>{stateBadge(r.state)}</Td>
                    <Td class="text-sm">{dates}</Td>
                    <Td>
                      <span class="font-medium">{totalLabel}</span>{' '}
                      <span class="text-xs text-muted-foreground">({totalSuffix})</span>
                    </Td>
                    <Td class="text-xs text-muted-foreground">
                      {r.createdAt.toISOString().slice(0, 10)}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        </Card>

        <div class="mt-6 flex items-center gap-2">
          {hasPrev ? (
            <LinkButton href={`/admin${baseQs(prevOffset)}`} variant="outline" size="sm">
              ← prev
            </LinkButton>
          ) : (
            <Button variant="outline" size="sm" disabled>
              ← prev
            </Button>
          )}
          {hasNext ? (
            <LinkButton href={`/admin${baseQs(nextOffset)}`} variant="outline" size="sm">
              next →
            </LinkButton>
          ) : (
            <Button variant="outline" size="sm" disabled>
              next →
            </Button>
          )}
        </div>
        {raw('')}
      </AdminShell>
    </Layout>,
  );
});
