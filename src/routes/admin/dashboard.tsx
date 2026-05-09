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
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { clients, retreats, therapists } from '../../db/schema.js';
import { ensureCsrfToken } from '../../lib/csrf.js';
import { formatCents } from '../../lib/pricing.js';
import { RETREAT_STATES, type RetreatState } from '../../lib/state-machine.js';
import {
  AdminShell,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CsrfInput,
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
  Button,
} from '../../lib/ui/index.js';

export const adminDashboardRoute = new Hono();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BulkResult {
  action: 'cancel' | 'resend-consent';
  ok: number;
  skipped: number;
  failed: number;
  errors: { retreatId: string; error: string }[];
}

function parseBulkResult(raw: string | undefined): BulkResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<BulkResult>;
    if (parsed && typeof parsed.action === 'string' && typeof parsed.ok === 'number') {
      return {
        action: parsed.action,
        ok: parsed.ok,
        skipped: parsed.skipped ?? 0,
        failed: parsed.failed ?? 0,
        errors: parsed.errors ?? [],
      };
    }
  } catch {
    // Malformed → render no banner. The query string is user-supplied
    // (after a redirect) so we tolerate junk silently.
  }
  return null;
}

interface DashRow {
  retreatId: string;
  state: string;
  program: string;
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
  // Free-text search across client first/last name + email. Capped at
  // 100 chars to keep the URL sane and to bound the LIKE pattern length.
  const qFilter = (c.req.query('q') ?? '').trim().slice(0, 100);

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
  if (qFilter) {
    // Escape SQL-LIKE metacharacters in the user input so a search for
    // "smith_jones%" matches the literal substring instead of widening
    // the pattern. Then wrap in `%...%` for substring semantics.
    const escaped = qFilter.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const orClause = or(
      ilike(clients.firstName, pattern),
      ilike(clients.lastName, pattern),
      ilike(clients.email, pattern),
    );
    if (orClause) conditions.push(orClause);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      program: retreats.program,
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
    // Join clients so the same WHERE (which may reference clients
    // columns when ?q= is set) is satisfiable. The retreats→clients
    // FK is required so the join doesn't drop rows.
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .where(where);
  const total = Number(countRows[0]?.count ?? 0);

  const csrfToken = ensureCsrfToken(c);
  const bulkResult = parseBulkResult(c.req.query('bulk_result'));
  const bulkError = c.req.query('bulk_error') ?? '';

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;
  const baseQs = (off: number) => {
    const params = new URLSearchParams();
    if (stateFilter) params.set('state', stateFilter);
    if (therapistFilter) params.set('therapist', therapistFilter);
    if (qFilter) params.set('q', qFilter);
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
                <label class="text-xs text-muted-foreground">Search</label>
                <Input
                  name="q"
                  value={qFilter}
                  placeholder="client name or email"
                  class="min-w-[220px]"
                />
              </div>
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

        {bulkResult ? (
          <Alert variant={bulkResult.failed > 0 ? 'destructive' : 'default'} class="mb-4">
            <AlertTitle>
              Bulk {bulkResult.action}: {bulkResult.ok} ok · {bulkResult.skipped} skipped ·{' '}
              {bulkResult.failed} failed
            </AlertTitle>
            {bulkResult.errors.length > 0 ? (
              <AlertDescription>
                <ul class="mt-1 list-disc pl-5 text-xs">
                  {bulkResult.errors.slice(0, 5).map((e) => (
                    <li>
                      <code class="font-mono">{e.retreatId.slice(0, 8)}</code>: {e.error}
                    </li>
                  ))}
                  {bulkResult.errors.length > 5 ? (
                    <li>+ {bulkResult.errors.length - 5} more</li>
                  ) : null}
                </ul>
              </AlertDescription>
            ) : null}
          </Alert>
        ) : null}
        {bulkError ? (
          <Alert variant="destructive" class="mb-4">
            <AlertDescription>Bulk action error: {bulkError}</AlertDescription>
          </Alert>
        ) : null}

        <form method="post" action="/admin/bulk" class="group/bulk">
          <CsrfInput token={csrfToken} />
          <Card>
            <Table>
              <Thead>
                <Tr>
                  <Th class="w-10"></Th>
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
                      <Td class="w-10">
                        <input
                          type="checkbox"
                          name="ids"
                          value={r.retreatId}
                          aria-label={`Select ${r.retreatId.slice(0, 8)}`}
                          class="h-4 w-4 rounded border-input"
                        />
                      </Td>
                      <Td>
                        <span class="font-mono text-xs text-primary">
                          {r.retreatId.slice(0, 8)}
                        </span>
                      </Td>
                      <Td>
                        {r.clientFirstName} {r.clientLastName}
                      </Td>
                      <Td class="text-muted-foreground">{r.therapistFullName}</Td>
                      <Td>
                        <div class="flex flex-wrap items-center gap-1.5">
                          {stateBadge(r.state)}
                          {r.program === 'kair' ? (
                            <Badge variant="outline" class="border-primary text-primary">
                              KAIR
                            </Badge>
                          ) : null}
                        </div>
                      </Td>
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
          {/* Bulk action toolbar — hidden until at least one row is
              selected. Lives BELOW the table so the table's vertical
              position doesn't shift when a checkbox is ticked. Uses
              Tailwind v4's named group + :has() variant; works in
              every modern browser. */}
          <div class="hidden group-has-[input:checked]/bulk:flex mt-3 flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>With selected:</span>
            <Button type="submit" name="action" value="resend-consent" variant="outline" size="sm">
              Resend consent emails
            </Button>
            <Button type="submit" name="action" value="cancel" variant="destructive" size="sm">
              Cancel
            </Button>
            <span class="text-xs">(max 25 per request)</span>
          </div>
        </form>

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
