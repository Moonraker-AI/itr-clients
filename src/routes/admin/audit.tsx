/**
 * /admin/audit - global audit log with filters (P3, v0.15.0).
 *
 * The audit_events table records every state-machine transition, every
 * Stripe webhook landing, every consent signature, every refund, and a
 * handful of system events. Until v0.15.0 it was only browseable via the
 * per-retreat detail page; this route gives ops a global view that's
 * filterable by event_type / actor_type / retreat / date range.
 *
 * Therapist scoping: a non-admin therapist sees only audit events for
 * retreats they own. Rows with retreat_id IS NULL (system events) are
 * admin-only - we never join therapists into them so they would silently
 * drop out for non-admins anyway.
 *
 * Query params:
 *   ?event_type=<substring>     case-insensitive substring match on event_type
 *   ?actor_type=<enum>          one of therapist|client|system|stripe
 *   ?retreat=<uuid>             exact match
 *   ?from=YYYY-MM-DD            inclusive lower bound on created_at (UTC)
 *   ?to=YYYY-MM-DD              inclusive upper bound on created_at (UTC)
 *   ?limit=<n>                  default 50, max 200
 *   ?offset=<n>                 pagination offset
 *
 * Server-rendered HTML, no JS dependency.
 */

import { Hono } from 'hono';
import { and, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { auditEvents, retreats } from '../../db/schema.js';
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

export const adminAuditRoute = new Hono();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTOR_TYPES = ['therapist', 'client', 'system', 'stripe'] as const;
type ActorType = (typeof ACTOR_TYPES)[number];

adminAuditRoute.get('/', async (c) => {
  const eventTypeFilter = (c.req.query('event_type') ?? '').trim();
  const actorTypeRaw = (c.req.query('actor_type') ?? '').trim();
  const retreatIdRaw = (c.req.query('retreat') ?? '').trim();
  const fromRaw = (c.req.query('from') ?? '').trim();
  const toRaw = (c.req.query('to') ?? '').trim();

  const actorTypeFilter = (ACTOR_TYPES as readonly string[]).includes(actorTypeRaw)
    ? (actorTypeRaw as ActorType)
    : '';
  const retreatFilter = UUID_RE.test(retreatIdRaw) ? retreatIdRaw : '';
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
  if (eventTypeFilter) {
    // Substring match (case-insensitive) so ops can search "stripe" or
    // "consent" without memorising exact event_type strings.
    conditions.push(ilike(auditEvents.eventType, `%${eventTypeFilter}%`));
  }
  if (actorTypeFilter) {
    conditions.push(eq(auditEvents.actorType, actorTypeFilter));
  }
  if (retreatFilter) {
    conditions.push(eq(auditEvents.retreatId, retreatFilter));
  }
  if (fromDate) {
    conditions.push(gte(auditEvents.createdAt, new Date(`${fromDate}T00:00:00Z`)));
  }
  if (toDate) {
    // End-of-day inclusive so `to=2026-05-09` includes events at 23:59:59Z.
    conditions.push(lte(auditEvents.createdAt, new Date(`${toDate}T23:59:59.999Z`)));
  }

  // Therapist scoping. Non-admin therapists see only audit rows whose
  // retreat is theirs. Joining on retreats also drops system events
  // (retreat_id IS NULL) for non-admins, which is the correct outcome:
  // a therapist has no business reading global system audit events.
  let baseQuery;
  let countBase;
  if (user && user.role === 'therapist') {
    conditions.push(eq(retreats.therapistId, user.therapistId));
    baseQuery = db
      .select({
        id: auditEvents.id,
        retreatId: auditEvents.retreatId,
        actorType: auditEvents.actorType,
        actorId: auditEvents.actorId,
        eventType: auditEvents.eventType,
        payload: auditEvents.payload,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .innerJoin(retreats, eq(auditEvents.retreatId, retreats.id));
    countBase = db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .innerJoin(retreats, eq(auditEvents.retreatId, retreats.id));
  } else {
    baseQuery = db
      .select({
        id: auditEvents.id,
        retreatId: auditEvents.retreatId,
        actorType: auditEvents.actorType,
        actorId: auditEvents.actorId,
        eventType: auditEvents.eventType,
        payload: auditEvents.payload,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents);
    countBase = db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await baseQuery
    .where(where)
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)
    .offset(offset);

  const countRows = await countBase.where(where);
  const total = Number(countRows[0]?.count ?? 0);

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;

  const baseQs = (off: number) => {
    const params = new URLSearchParams();
    if (eventTypeFilter) params.set('event_type', eventTypeFilter);
    if (actorTypeFilter) params.set('actor_type', actorTypeFilter);
    if (retreatFilter) params.set('retreat', retreatFilter);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (limit !== DEFAULT_LIMIT) params.set('limit', String(limit));
    if (off !== 0) params.set('offset', String(off));
    const s = params.toString();
    return s.length > 0 ? `?${s}` : '';
  };

  const actorBadgeVariant = (actor: string): 'default' | 'secondary' | 'destructive' | 'success' | 'outline' => {
    if (actor === 'system') return 'secondary';
    if (actor === 'stripe') return 'outline';
    if (actor === 'client') return 'default';
    return 'success'; // therapist
  };

  return c.html(
    <Layout title="Audit log - ITR Clients">
      <AdminShell user={user} current="audit">
        <PageHeader
          title="Audit log"
          description={`${rows.length} of ${total} · offset ${offset}`}
        >
          <LinkButton href="/admin" variant="ghost" size="sm">
            ← Back to dashboard
          </LinkButton>
        </PageHeader>

        <Card class="mb-6">
          <CardContent class="pt-6">
            <form method="get" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
              <div class="space-y-1.5">
                <label class="text-xs text-muted-foreground">Event type contains</label>
                <Input
                  name="event_type"
                  value={eventTypeFilter}
                  placeholder="e.g. stripe, consent, transition"
                />
              </div>
              <div class="space-y-1.5">
                <label class="text-xs text-muted-foreground">Actor</label>
                <Select name="actor_type">
                  <option value="">all</option>
                  {ACTOR_TYPES.map((a) => (
                    <option value={a} selected={a === actorTypeFilter}>
                      {a}
                    </option>
                  ))}
                </Select>
              </div>
              <div class="space-y-1.5">
                <label class="text-xs text-muted-foreground">Retreat id</label>
                <Input
                  name="retreat"
                  value={retreatFilter}
                  placeholder="uuid"
                  class="font-mono text-xs"
                />
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
                <LinkButton href="/admin/audit" variant="ghost" size="default">
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
                <Th>Actor</Th>
                <Th>Event</Th>
                <Th>Retreat</Th>
                <Th>Actor id</Th>
                <Th>Payload</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.length === 0 ? (
                <Tr>
                  <Td colspan={6} class="text-center text-sm text-muted-foreground py-8">
                    No matching audit events.
                  </Td>
                </Tr>
              ) : (
                rows.map((r) => {
                  const payloadStr = JSON.stringify(r.payload ?? {});
                  const truncated =
                    payloadStr.length > 160 ? `${payloadStr.slice(0, 157)}...` : payloadStr;
                  return (
                    <Tr>
                      <Td class="text-xs text-muted-foreground whitespace-nowrap">
                        {r.createdAt.toISOString()}
                      </Td>
                      <Td>
                        <Badge variant={actorBadgeVariant(r.actorType)}>{r.actorType}</Badge>
                      </Td>
                      <Td class="font-mono text-xs">{r.eventType}</Td>
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
                      <Td class="font-mono text-xs">
                        {r.actorId ? r.actorId.slice(0, 12) : '-'}
                      </Td>
                      <Td>
                        <code class="font-mono text-xs break-all">{truncated}</code>
                      </Td>
                    </Tr>
                  );
                })
              )}
            </Tbody>
          </Table>
        </Card>

        <div class="mt-4 flex items-center justify-between gap-3">
          {hasPrev ? (
            <LinkButton href={`/admin/audit${baseQs(prevOffset)}`} variant="outline" size="sm">
              ← Prev
            </LinkButton>
          ) : (
            <span />
          )}
          {hasNext ? (
            <LinkButton href={`/admin/audit${baseQs(nextOffset)}`} variant="outline" size="sm">
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
