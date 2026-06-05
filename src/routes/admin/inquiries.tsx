/**
 * /admin/inquiries - lightweight intake CRM.
 *
 * Therapists see only inquiries assigned to them. Admins see all inquiries,
 * can filter by therapist/status, and can reassign before conversion.
 */

import { Hono } from 'hono';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  contactInquiries,
  contactInquiryEvents,
  therapists,
} from '../../db/schema.js';
import type { AuthUser } from '../../lib/auth.js';
import {
  INQUIRY_STATUS_LABELS,
  INQUIRY_STATUSES,
  type InquiryStatus,
} from '../../lib/contact-inquiries.js';
import { ensureCsrfToken, verifyCsrfToken } from '../../lib/csrf.js';
import { sendInquiryReassignedEmail } from '../../lib/inquiry-notifications.js';
import { log } from '../../lib/phi-redactor.js';
import {
  AdminShell,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
} from '../../lib/ui/index.js';

export const adminInquiriesRoute = new Hono();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTIVE_STATUSES: InquiryStatus[] = [
  'new',
  'contacted',
  'follow_up_needed',
  'consult_scheduled',
];
const CLOSED_STATUSES: InquiryStatus[] = ['converted', 'archived', 'spam_duplicate'];

function isAdmin(user: AuthUser | undefined): boolean {
  return !user || user.role === 'admin';
}

function canAccessInquiry(
  user: AuthUser | undefined,
  assignedTherapistId: string | null,
): boolean {
  return isAdmin(user) || user?.therapistId === assignedTherapistId;
}

function statusBadge(status: string) {
  const variant:
    | 'default'
    | 'secondary'
    | 'destructive'
    | 'success'
    | 'outline' =
    status === 'spam_duplicate'
      ? 'destructive'
      : status === 'converted'
        ? 'success'
        : status === 'archived'
          ? 'secondary'
          : status === 'follow_up_needed'
            ? 'outline'
            : 'default';
  return <Badge variant={variant}>{INQUIRY_STATUS_LABELS[status as InquiryStatus] ?? status}</Badge>;
}

function fullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

function mailtoHref(row: {
  email: string;
  firstName: string;
  lastName: string;
}): string {
  const subject = 'Intensive Therapy Retreats inquiry';
  const body =
    `Hi ${row.firstName},\n\n` +
    `Thank you for reaching out to Intensive Therapy Retreats.\n\n`;
  const params = new URLSearchParams({ subject, body });
  return `mailto:${encodeURIComponent(row.email)}?${params.toString()}`;
}

function formatWindows(value: unknown): string {
  if (!Array.isArray(value)) return '-';
  const values = value.map((v) => String(v)).filter(Boolean);
  return values.length > 0 ? values.join(', ') : '-';
}

adminInquiriesRoute.get('/', async (c) => {
  const user = c.get('user');
  const admin = isAdmin(user);
  const view = c.req.query('view') === 'closed' ? 'closed' : 'active';
  const statusFilterRaw = c.req.query('status') ?? '';
  const statusFilter = (INQUIRY_STATUSES as readonly string[]).includes(statusFilterRaw)
    ? (statusFilterRaw as InquiryStatus)
    : '';
  const therapistFilterRaw = c.req.query('therapist') ?? '';
  const therapistFilter =
    admin && UUID_RE.test(therapistFilterRaw) ? therapistFilterRaw : '';
  const qFilter = (c.req.query('q') ?? '').trim().slice(0, 100);
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

  const conditions = [];
  if (admin) {
    if (therapistFilter) conditions.push(eq(contactInquiries.assignedTherapistId, therapistFilter));
  } else {
    conditions.push(eq(contactInquiries.assignedTherapistId, user.therapistId));
  }
  if (statusFilter) {
    conditions.push(eq(contactInquiries.status, statusFilter));
  } else if (view === 'closed') {
    conditions.push(inArray(contactInquiries.status, CLOSED_STATUSES));
  } else {
    conditions.push(inArray(contactInquiries.status, ACTIVE_STATUSES));
  }
  if (qFilter) {
    const escaped = qFilter.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const orClause = or(
      ilike(contactInquiries.firstName, pattern),
      ilike(contactInquiries.lastName, pattern),
      ilike(contactInquiries.email, pattern),
      ilike(contactInquiries.phone, pattern),
    );
    if (orClause) conditions.push(orClause);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: contactInquiries.id,
      status: contactInquiries.status,
      firstName: contactInquiries.firstName,
      lastName: contactInquiries.lastName,
      email: contactInquiries.email,
      phone: contactInquiries.phone,
      sourcePage: contactInquiries.sourcePage,
      createdAt: contactInquiries.createdAt,
      assignedTherapistId: contactInquiries.assignedTherapistId,
      assignedTherapistName: therapists.fullName,
    })
    .from(contactInquiries)
    .leftJoin(therapists, eq(contactInquiries.assignedTherapistId, therapists.id))
    .where(where)
    .orderBy(desc(contactInquiries.createdAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contactInquiries)
    .where(where);
  const total = Number(countRows[0]?.count ?? 0);

  const baseQs = (off: number) => {
    const params = new URLSearchParams();
    if (view !== 'active') params.set('view', view);
    if (statusFilter) params.set('status', statusFilter);
    if (therapistFilter) params.set('therapist', therapistFilter);
    if (qFilter) params.set('q', qFilter);
    if (limit !== DEFAULT_LIMIT) params.set('limit', String(limit));
    if (off !== 0) params.set('offset', String(off));
    const s = params.toString();
    return s.length > 0 ? `?${s}` : '';
  };
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;

  return c.html(
    <Layout title="Inquiries - ITR Clients">
      <AdminShell user={user} current="inquiries">
        <PageHeader
          title="Inquiries"
          description={`${rows.length} of ${total} · ${view === 'closed' ? 'closed' : 'active'}`}
        >
          <LinkButton
            href="/admin/inquiries"
            variant={view === 'active' ? 'default' : 'outline'}
            size="sm"
          >
            Active
          </LinkButton>
          <LinkButton
            href="/admin/inquiries?view=closed"
            variant={view === 'closed' ? 'default' : 'outline'}
            size="sm"
          >
            Closed
          </LinkButton>
        </PageHeader>

        <Card class="mb-6">
          <CardContent class="pt-6">
            <form method="get" class="flex flex-wrap items-end gap-3">
              <input type="hidden" name="view" value={view} />
              <div class="space-y-1.5 w-full sm:w-auto sm:min-w-[220px]">
                <label class="text-xs text-muted-foreground">Search</label>
                <Input name="q" value={qFilter} placeholder="name, email, or phone" />
              </div>
              <div class="space-y-1.5 w-full sm:w-auto sm:min-w-[180px]">
                <label class="text-xs text-muted-foreground">Status</label>
                <Select name="status">
                  <option value="">all</option>
                  {INQUIRY_STATUSES.map((s) => (
                    <option value={s} selected={s === statusFilter}>
                      {INQUIRY_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </div>
              {admin ? (
                <div class="space-y-1.5 w-full sm:w-auto sm:min-w-[200px]">
                  <label class="text-xs text-muted-foreground">Therapist</label>
                  <Select name="therapist">
                    <option value="">all</option>
                    {therapistRows.map((t) => (
                      <option value={t.id} selected={t.id === therapistFilter}>
                        {t.fullName}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <Button type="submit">Filter</Button>
              <LinkButton href={`/admin/inquiries${view === 'closed' ? '?view=closed' : ''}`} variant="ghost">
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
                <Th>Contact</Th>
                <Th>Therapist</Th>
                <Th>Status</Th>
                <Th>Source</Th>
                <Th>Submitted</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.length === 0 ? (
                <Tr>
                  <Td colspan={6} class="text-center text-sm text-muted-foreground py-6">
                    No inquiries found.
                  </Td>
                </Tr>
              ) : (
                rows.map((r) => (
                  <Tr href={`/admin/inquiries/${r.id}`}>
                    <Td>
                      <span class="font-mono text-xs text-primary">{r.id.slice(0, 8)}</span>
                    </Td>
                    <Td>
                      <div class="font-medium">{fullName(r.firstName, r.lastName)}</div>
                      <div class="text-xs text-muted-foreground">{r.email}</div>
                    </Td>
                    <Td class="text-sm text-muted-foreground">
                      {r.assignedTherapistName ?? 'Unassigned'}
                    </Td>
                    <Td>{statusBadge(r.status)}</Td>
                    <Td class="text-xs text-muted-foreground max-w-[220px] truncate">
                      {r.sourcePage ?? '-'}
                    </Td>
                    <Td class="text-xs text-muted-foreground">
                      {r.createdAt.toISOString().slice(0, 10)}
                    </Td>
                  </Tr>
                ))
              )}
            </Tbody>
          </Table>
        </Card>

        <div class="mt-6 flex items-center gap-2">
          {offset > 0 ? (
            <LinkButton href={`/admin/inquiries${baseQs(prevOffset)}`} variant="outline" size="sm">
              prev
            </LinkButton>
          ) : (
            <Button variant="outline" size="sm" disabled>
              prev
            </Button>
          )}
          {nextOffset < total ? (
            <LinkButton href={`/admin/inquiries${baseQs(nextOffset)}`} variant="outline" size="sm">
              next
            </LinkButton>
          ) : (
            <Button variant="outline" size="sm" disabled>
              next
            </Button>
          )}
        </div>
      </AdminShell>
    </Layout>,
  );
});

adminInquiriesRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const admin = isAdmin(user);
  const { db } = await getDb();

  const [row] = await db
    .select({
      id: contactInquiries.id,
      requestedTherapistId: contactInquiries.requestedTherapistId,
      assignedTherapistId: contactInquiries.assignedTherapistId,
      status: contactInquiries.status,
      firstName: contactInquiries.firstName,
      lastName: contactInquiries.lastName,
      email: contactInquiries.email,
      phone: contactInquiries.phone,
      location: contactInquiries.location,
      timezone: contactInquiries.timezone,
      consultationWindows: contactInquiries.consultationWindows,
      message: contactInquiries.message,
      heardFrom: contactInquiries.heardFrom,
      consentPhone: contactInquiries.consentPhone,
      consentText: contactInquiries.consentText,
      consentEmail: contactInquiries.consentEmail,
      policyServiceLevel: contactInquiries.policyServiceLevel,
      policyFinancial: contactInquiries.policyFinancial,
      sourcePage: contactInquiries.sourcePage,
      convertedRetreatId: contactInquiries.convertedRetreatId,
      contactedAt: contactInquiries.contactedAt,
      archivedAt: contactInquiries.archivedAt,
      createdAt: contactInquiries.createdAt,
      assignedTherapistName: therapists.fullName,
      assignedTherapistEmail: therapists.email,
    })
    .from(contactInquiries)
    .leftJoin(therapists, eq(contactInquiries.assignedTherapistId, therapists.id))
    .where(eq(contactInquiries.id, id));

  if (!row) return c.notFound();
  if (!canAccessInquiry(user, row.assignedTherapistId)) return c.notFound();

  const therapistRows = admin
    ? await db
        .select({ id: therapists.id, fullName: therapists.fullName })
        .from(therapists)
        .where(eq(therapists.active, true))
        .orderBy(asc(therapists.fullName))
    : [];

  const events = await db
    .select({
      eventType: contactInquiryEvents.eventType,
      payload: contactInquiryEvents.payload,
      createdAt: contactInquiryEvents.createdAt,
      actorTherapistName: therapists.fullName,
    })
    .from(contactInquiryEvents)
    .leftJoin(therapists, eq(contactInquiryEvents.actorTherapistId, therapists.id))
    .where(eq(contactInquiryEvents.inquiryId, id))
    .orderBy(desc(contactInquiryEvents.createdAt))
    .limit(50);

  const csrfToken = ensureCsrfToken(c);
  const name = fullName(row.firstName, row.lastName);

  return c.html(
    <Layout title={`Inquiry ${row.id.slice(0, 8)} - ITR Clients`}>
      <AdminShell user={user} current="inquiries">
        <PageHeader title={`Inquiry ${row.id.slice(0, 8)}`} description={row.id}>
          <LinkButton href="/admin/inquiries" variant="ghost" size="sm">
            Back
          </LinkButton>
          {row.convertedRetreatId ? (
            <LinkButton href={`/admin/clients/${row.convertedRetreatId}`} size="sm">
              Open retreat
            </LinkButton>
          ) : (
            <LinkButton href={`/admin/clients/new?inquiry_id=${row.id}`} size="sm">
              Create consent package
            </LinkButton>
          )}
        </PageHeader>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <Card>
            <CardHeader>
              <CardTitle class="text-sm text-muted-foreground">Status</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3">
              {statusBadge(row.status)}
              {row.contactedAt ? (
                <div class="text-xs text-muted-foreground">
                  Contacted {row.contactedAt.toISOString().slice(0, 10)}
                </div>
              ) : null}
              {row.archivedAt ? (
                <div class="text-xs text-muted-foreground">
                  Archived {row.archivedAt.toISOString().slice(0, 10)}
                </div>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle class="text-sm text-muted-foreground">Assigned therapist</CardTitle>
            </CardHeader>
            <CardContent>
              <div class="font-medium">{row.assignedTherapistName ?? 'Unassigned'}</div>
              {row.assignedTherapistEmail ? (
                <div class="text-xs text-muted-foreground">{row.assignedTherapistEmail}</div>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle class="text-sm text-muted-foreground">Submitted</CardTitle>
            </CardHeader>
            <CardContent class="text-sm">{row.createdAt.toISOString()}</CardContent>
          </Card>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <Card>
            <CardHeader>
              <CardTitle>Contact</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3 text-sm">
              <dl class="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-y-2 gap-x-4">
                <dt class="text-muted-foreground">Name</dt>
                <dd>{name}</dd>
                <dt class="text-muted-foreground">Email</dt>
                <dd class="break-all">{row.email}</dd>
                <dt class="text-muted-foreground">Phone</dt>
                <dd>{row.phone}</dd>
                <dt class="text-muted-foreground">Location</dt>
                <dd>{row.location}</dd>
                <dt class="text-muted-foreground">Time zone</dt>
                <dd>{row.timezone}</dd>
                <dt class="text-muted-foreground">Windows</dt>
                <dd>{formatWindows(row.consultationWindows)}</dd>
                <dt class="text-muted-foreground">Heard from</dt>
                <dd>{row.heardFrom ?? '-'}</dd>
              </dl>
              <a href={mailtoHref(row)} class="inline-flex text-primary underline">
                Open email client
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Consents and policy checks</CardTitle>
            </CardHeader>
            <CardContent>
              <ul class="space-y-2 text-sm">
                <li>{row.consentPhone ? 'Yes' : 'No'}: phone and voicemail</li>
                <li>{row.consentText ? 'Yes' : 'No'}: text messaging</li>
                <li>{row.consentEmail ? 'Yes' : 'No'}: email</li>
                <li>{row.policyServiceLevel ? 'Yes' : 'No'}: outpatient, not crisis care</li>
                <li>{row.policyFinancial ? 'Yes' : 'No'}: private pay</li>
              </ul>
            </CardContent>
          </Card>
        </div>

        <Card class="mb-6">
          <CardHeader>
            <CardTitle>Message</CardTitle>
          </CardHeader>
          <CardContent>
            <p class="whitespace-pre-wrap text-sm">{row.message ?? 'No message provided.'}</p>
            {row.sourcePage ? (
              <p class="mt-4 text-xs text-muted-foreground break-all">
                Source page: {row.sourcePage}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card class="mb-6">
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <form method="post" action={`/admin/inquiries/${row.id}/status`} class="flex flex-wrap gap-2">
              <CsrfInput token={csrfToken} />
              <Button type="submit" name="status" value="contacted" variant="outline">
                Mark contacted
              </Button>
              <Button type="submit" name="status" value="follow_up_needed" variant="outline">
                Needs follow-up
              </Button>
              <Button type="submit" name="status" value="consult_scheduled" variant="outline">
                Consult scheduled
              </Button>
              <Button type="submit" name="status" value="new" variant="outline">
                Reopen
              </Button>
              <Button type="submit" name="status" value="archived" variant="secondary">
                Archive
              </Button>
              <Button type="submit" name="status" value="spam_duplicate" variant="destructive">
                Mark spam or duplicate
              </Button>
            </form>

            {admin ? (
              <form method="post" action={`/admin/inquiries/${row.id}/reassign`} class="flex flex-wrap items-end gap-3">
                <CsrfInput token={csrfToken} />
                <div class="space-y-1.5 w-full sm:w-auto sm:min-w-[260px]">
                  <label class="text-xs text-muted-foreground">Reassign to</label>
                  <Select name="therapist_id" required>
                    <option value="">Select therapist</option>
                    {therapistRows.map((t) => (
                      <option value={t.id} selected={t.id === row.assignedTherapistId}>
                        {t.fullName}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button type="submit">Reassign</Button>
              </form>
            ) : null}

            {admin ? (
              <form method="post" action={`/admin/inquiries/${row.id}/delete`} class="border-t border-border pt-4">
                <CsrfInput token={csrfToken} />
                <Button type="submit" variant="destructive">
                  Delete lead
                </Button>
                <p class="mt-2 text-xs text-muted-foreground">
                  Deletes the inquiry and its history. Converted client records are not removed.
                </p>
              </form>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
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
                {events.map((e) => (
                  <Tr>
                    <Td class="text-xs text-muted-foreground whitespace-nowrap">
                      {e.createdAt.toISOString()}
                    </Td>
                    <Td>
                      <code class="font-mono text-xs">{e.eventType}</code>
                    </Td>
                    <Td class="text-sm">{e.actorTherapistName ?? 'system'}</Td>
                    <Td>
                      <code class="font-mono text-xs whitespace-pre-wrap break-all block max-w-md">
                        {e.payload ? JSON.stringify(e.payload) : ''}
                      </code>
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

adminInquiriesRoute.post('/:id/status', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
  const nextStatus = String(form.get('status') ?? '') as InquiryStatus;
  if (!(INQUIRY_STATUSES as readonly string[]).includes(nextStatus)) {
    return c.json({ error: 'invalid_status' }, 400);
  }
  if (nextStatus === 'converted') {
    return c.json({ error: 'conversion_uses_client_form' }, 400);
  }

  const { db } = await getDb();
  const [row] = await db
    .select({
      assignedTherapistId: contactInquiries.assignedTherapistId,
      status: contactInquiries.status,
    })
    .from(contactInquiries)
    .where(eq(contactInquiries.id, id));
  if (!row) return c.notFound();
  const user = c.get('user');
  if (!canAccessInquiry(user, row.assignedTherapistId)) return c.notFound();

  const now = new Date();
  const updateValues = {
    status: nextStatus,
    statusChangedAt: now,
    archivedAt:
      nextStatus === 'archived' || nextStatus === 'spam_duplicate' ? now : null,
    lastActionByTherapistId: user?.therapistId ?? null,
    updatedAt: now,
  };
  if (nextStatus === 'contacted') {
    Object.assign(updateValues, { contactedAt: now });
  }
  await db.update(contactInquiries)
    .set(updateValues)
    .where(eq(contactInquiries.id, id));
  await db.insert(contactInquiryEvents).values({
    inquiryId: id,
    actorTherapistId: user?.therapistId ?? null,
    eventType: 'status_changed',
    payload: { from: row.status, to: nextStatus },
  });

  return c.redirect(`/admin/inquiries/${id}`);
});

adminInquiriesRoute.post('/:id/reassign', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
  const user = c.get('user');
  if (!isAdmin(user)) return c.json({ error: 'forbidden' }, 403);
  const therapistId = String(form.get('therapist_id') ?? '');
  if (!UUID_RE.test(therapistId)) return c.json({ error: 'invalid_therapist' }, 400);

  const { db } = await getDb();
  const [inquiry] = await db
    .select({
      assignedTherapistId: contactInquiries.assignedTherapistId,
    })
    .from(contactInquiries)
    .where(eq(contactInquiries.id, id));
  if (!inquiry) return c.notFound();

  const [nextTherapist] = await db
    .select({ id: therapists.id, email: therapists.email })
    .from(therapists)
    .where(and(eq(therapists.id, therapistId), eq(therapists.active, true)));
  if (!nextTherapist) return c.json({ error: 'therapist_not_found' }, 400);

  const now = new Date();
  await db.update(contactInquiries)
    .set({
      assignedTherapistId: nextTherapist.id,
      statusChangedAt: now,
      lastActionByTherapistId: user?.therapistId ?? null,
      updatedAt: now,
    })
    .where(eq(contactInquiries.id, id));
  await db.insert(contactInquiryEvents).values({
    inquiryId: id,
    actorTherapistId: user?.therapistId ?? null,
    eventType: 'reassigned',
    payload: {
      fromTherapistId: inquiry.assignedTherapistId,
      toTherapistId: nextTherapist.id,
    },
  });

  await sendInquiryReassignedEmail({
    inquiryId: id,
    therapistEmail: nextTherapist.email,
  });

  return c.redirect(`/admin/inquiries/${id}`);
});

adminInquiriesRoute.post('/:id/delete', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
  const user = c.get('user');
  if (!isAdmin(user)) return c.json({ error: 'forbidden' }, 403);

  const { db } = await getDb();
  const [row] = await db
    .select({ id: contactInquiries.id })
    .from(contactInquiries)
    .where(eq(contactInquiries.id, id));
  if (!row) return c.notFound();

  await db.delete(contactInquiries).where(eq(contactInquiries.id, id));
  log.info('contact_inquiry_deleted', {
    inquiryId: id,
    actorTherapistId: user?.therapistId ?? null,
  });
  return c.redirect('/admin/inquiries?view=closed');
});
