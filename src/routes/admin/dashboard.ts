/**
 * /admin — list view of all retreats with state + therapist filters (M7).
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
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  clients,
  retreats,
  therapists,
} from '../../db/schema.js';
import { formatCents } from '../../lib/pricing.js';
import { RETREAT_STATES, type RetreatState } from '../../lib/state-machine.js';

export const adminDashboardRoute = new Hono();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

adminDashboardRoute.get('/', async (c) => {
  const stateFilter = c.req.query('state') ?? '';
  const therapistFilter = c.req.query('therapist') ?? '';
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(c.req.query('limit') ?? DEFAULT_LIMIT)),
  );
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));

  const { db } = await getDb();

  const therapistRows = await db
    .select({ id: therapists.id, fullName: therapists.fullName })
    .from(therapists)
    .where(eq(therapists.active, true))
    .orderBy(asc(therapists.fullName));

  const conditions = [];
  if (stateFilter && (RETREAT_STATES as readonly string[]).includes(stateFilter)) {
    conditions.push(eq(retreats.state, stateFilter as RetreatState));
  }
  if (therapistFilter) {
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
  const count = countRows[0]?.count ?? 0;

  return c.html(
    renderDashboard({
      rows,
      total: Number(count ?? 0),
      stateFilter,
      therapistFilter,
      therapists: therapistRows,
      limit,
      offset,
    }),
  );
});

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

interface DashArgs {
  rows: DashRow[];
  total: number;
  stateFilter: string;
  therapistFilter: string;
  therapists: Array<{ id: string; fullName: string }>;
  limit: number;
  offset: number;
}

function renderDashboard(args: DashArgs): string {
  const stateOptions = RETREAT_STATES.map(
    (s) =>
      `<option value="${s}"${s === args.stateFilter ? ' selected' : ''}>${s}</option>`,
  ).join('');
  const therapistOptions = args.therapists
    .map(
      (t) =>
        `<option value="${escAttr(t.id)}"${t.id === args.therapistFilter ? ' selected' : ''}>${escHtml(t.fullName)}</option>`,
    )
    .join('');

  const tbody = args.rows
    .map((r) => {
      const dates =
        r.scheduledStartDate && r.scheduledEndDate
          ? `${r.scheduledStartDate} → ${r.scheduledEndDate}`
          : '—';
      const total = r.totalActualCents
        ? `${formatCents(r.totalActualCents)} <span class="meta">(actual)</span>`
        : `${formatCents(r.totalPlannedCents)} <span class="meta">(planned)</span>`;
      return `<tr>
        <td><a href="/admin/clients/${escAttr(r.retreatId)}"><code>${escHtml(r.retreatId.slice(0, 8))}</code></a></td>
        <td>${escHtml(r.clientFirstName)} ${escHtml(r.clientLastName)}</td>
        <td>${escHtml(r.therapistFullName)}</td>
        <td><code>${escHtml(r.state)}</code></td>
        <td>${escHtml(dates)}</td>
        <td>${total}</td>
        <td>${escHtml(r.createdAt.toISOString().slice(0, 10))}</td>
      </tr>`;
    })
    .join('');

  const prevOffset = Math.max(0, args.offset - args.limit);
  const nextOffset = args.offset + args.limit;
  const hasPrev = args.offset > 0;
  const hasNext = nextOffset < args.total;
  const baseQs = (off: number) => {
    const params = new URLSearchParams();
    if (args.stateFilter) params.set('state', args.stateFilter);
    if (args.therapistFilter) params.set('therapist', args.therapistFilter);
    if (args.limit !== DEFAULT_LIMIT) params.set('limit', String(args.limit));
    if (off !== 0) params.set('offset', String(off));
    const s = params.toString();
    return s.length > 0 ? `?${s}` : '';
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Dashboard — ITR Client HQ</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-weight: 600; }
    form.filters { display: flex; gap: 0.6rem; align-items: end; flex-wrap: wrap; margin-bottom: 1rem; padding: 0.8rem; background: #f6f6f6; border-radius: 4px; }
    form.filters label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 12px; color: #555; }
    form.filters select { padding: 0.3rem; font: inherit; min-width: 180px; }
    form.filters button, form.filters a { padding: 0.4rem 0.8rem; font: inherit; cursor: pointer; }
    table { border-collapse: collapse; width: 100%; }
    th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
    th { background: #f6f6f6; font-weight: 600; }
    code { background: #f0f0f0; padding: 0 0.25rem; font: 12px ui-monospace, monospace; }
    .meta { color: #999; font-size: 11px; }
    .pager { margin-top: 1rem; display: flex; gap: 1rem; align-items: center; }
    .pager a { padding: 0.3rem 0.6rem; border: 1px solid #ccc; text-decoration: none; }
    .pager .disabled { color: #aaa; pointer-events: none; }
    .actions { margin-bottom: 1rem; }
    .actions a { margin-right: 0.6rem; }
  </style>
</head>
<body>
  <h1>Retreats</h1>
  <p class="actions">
    <a href="/admin/clients/new">+ New client</a>
    <a href="/admin/pricing">Pricing config</a>
  </p>
  <form class="filters" method="get">
    <label>State
      <select name="state">
        <option value="">all</option>
        ${stateOptions}
      </select>
    </label>
    <label>Therapist
      <select name="therapist">
        <option value="">all</option>
        ${therapistOptions}
      </select>
    </label>
    <button type="submit">Filter</button>
    <a href="/admin">Clear</a>
  </form>
  <p class="meta">${args.rows.length} of ${args.total} retreats · offset ${args.offset} · limit ${args.limit}</p>
  <table>
    <thead>
      <tr>
        <th>Id</th><th>Client</th><th>Therapist</th><th>State</th><th>Scheduled</th><th>Total</th><th>Created</th>
      </tr>
    </thead>
    <tbody>${tbody}</tbody>
  </table>
  <div class="pager">
    <a class="${hasPrev ? '' : 'disabled'}" href="/admin${baseQs(prevOffset)}">← prev</a>
    <a class="${hasNext ? '' : 'disabled'}" href="/admin${baseQs(nextOffset)}">next →</a>
  </div>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escAttr(s: string): string {
  return escHtml(s).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
