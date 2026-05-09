# Email bounce tracking (P1 #10)

## Status

**Implemented in v0.12.0.** Code paths now write `status='bounced'` on
hard bounces (5.x.x). Two ops steps must complete before the cron does
anything in prod — see "Post-merge activation" below.

### What shipped

- `email_log.message_id` now stores the RFC 5322 Message-ID we generate
  at send time (migration 0007 renamed from `gmail_message_id`).
- `email_log.bounced_at` and `email_log.bounce_reason` columns added.
- `gmail.ts` exports `listBounces()` + `parseDsn()` (RFC 3464).
- `/api/cron/scan-bounces` is mounted, guarded by `verifyCronSecret`.
- Admin retreat detail badges `bounced` as destructive with reason.

### Post-merge activation

The cron is wired but is a **no-op until two ops steps are done**:

1. **Workspace DWD scope grant** — the bounce-scan service account must
   be authorized for `https://www.googleapis.com/auth/gmail.readonly` on
   `clients@intensivetherapyretreat.com`. Update the existing DWD entry
   (Workspace admin → Security → API controls → Domain-wide delegation)
   to include both scopes:
   - `https://www.googleapis.com/auth/gmail.send` (existing)
   - `https://www.googleapis.com/auth/gmail.readonly` (new)
2. **Cloud Scheduler job** — see "Cloud Scheduler" section below for the
   gcloud command. Run it for both `itr-clients-dev` and
   `itr-clients-prod`.

Until step 1 is done, calls to `listBounces()` fail with
`Insufficient Permission` and the cron returns `{ found: 0, ... }`.

### Interim manual workaround (still relevant for old rows)

Pre-0007 sends stored Gmail's internal id in `email_log`, not the RFC
Message-ID, so the cron cannot match those rows. For any retreat sent
before 2026-05-07, fall back to the manual inbox check below.

## Why this matters

`emailLog.status` defaults to `'sent'` after `gmail.sendEmail` returns —
that confirms Gmail accepted the message for delivery, not that the
recipient received it. Hard bounces (mailbox-full, doesn't-exist,
domain-no-MX) come back as a separate **Delivery Status Notification
(DSN)** email to the sending mailbox a few minutes later.

Without bounce tracking:
- A typo in a client email goes silently undetected; the staff thinks
  the consent package was delivered.
- A domain-level outage (e.g. `intensivetherapyretreat.com` MX glitch
  for therapist notifications) is invisible.
- The `email_log` `status` column lies — every row says `'sent'`.

## Interim (no code change)

Until the cron is wired up, the on-call rotation should:

1. Once a day, log into the `clients@intensivetherapyretreat.com`
   inbox.
2. Filter for `from:mailer-daemon@googlemail.com OR
   from:postmaster@*` over the last 24h.
3. For any DSN, find the original `In-Reply-To` Gmail Message-ID,
   look it up in `email_log` (or visit the corresponding `retreatId`
   admin page) and reach out to the client manually.

This is awful but works for low volume.

## Full implementation

### Schema

`email_log` already has `status` enum + `bounced` value. Add two
optional columns for diagnostics:

```ts
bouncedAt: timestamp('bounced_at', { withTimezone: true }),
bounceReason: text('bounce_reason'),
```

Migration: standard drizzle-kit `db:generate` + `db:migrate`.

### Gmail wrapper extension

`src/lib/gmail.ts` currently only exports `sendEmail`. Add:

```ts
export interface InboxScanResult {
  gmailMessageId: string;
  inReplyTo: string | null;       // <Message-ID> of the original
  finalRecipient: string | null;  // RFC 3464 Final-Recipient header
  failureReason: string | null;   // first non-empty Diagnostic-Code line
  receivedAt: Date;
}

/**
 * List DSN messages received in the sender mailbox since `since`.
 * Returns parsed metadata; does NOT mark them as read.
 */
export async function listBounces(args: {
  since: Date;
  limit?: number;
}): Promise<InboxScanResult[]>;
```

Implementation sketch (using `googleapis` package, already a runtime dep):

```ts
const gmail = google.gmail({ version: 'v1', auth: getJwtClient() });
const q = `from:mailer-daemon@googlemail.com after:${unix(args.since)}`;
const list = await gmail.users.messages.list({
  userId: 'me',
  q,
  maxResults: args.limit ?? 50,
});
const ids = list.data.messages?.map((m) => m.id!) ?? [];
const out: InboxScanResult[] = [];
for (const id of ids) {
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full',
  });
  out.push(parseDsn(msg.data));
}
return out;
```

`parseDsn` walks `payload.headers` for `In-Reply-To`, then descends into
`payload.parts` looking for the `message/delivery-status` part. The
delivery-status body has `Final-Recipient`, `Action`, `Status`, and
`Diagnostic-Code` lines — parse them with a tiny header parser.

### Cron route

`src/routes/api/cron-scan-bounces.ts` mirrors the existing cron pattern:

```ts
export const cronScanBouncesRoute = new Hono();

cronScanBouncesRoute.post('/scan-bounces', async (c) => {
  if (!verifyCronSecret(c)) return c.json({ error: 'forbidden' }, 403);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h window
  const bounces = await listBounces({ since });

  let updated = 0;
  for (const b of bounces) {
    if (!b.inReplyTo) continue;
    // Original gmailMessageId is the Gmail-internal id; In-Reply-To
    // carries RFC 5322 Message-ID like "<abc@mail.gmail.com>". Strip
    // angle brackets + match against email_log.gmailMessageId — which
    // is currently the Gmail internal id, NOT the RFC Message-ID.
    // TODO: store the RFC Message-ID at send time so this lookup works.
    const messageId = b.inReplyTo.replace(/[<>]/g, '');
    const result = await db
      .update(emailLog)
      .set({
        status: 'bounced',
        bouncedAt: b.receivedAt,
        bounceReason: b.failureReason ?? 'unknown',
      })
      .where(eq(emailLog.gmailMessageId, messageId));
    updated += result.rowCount ?? 0;
  }

  log.info('bounce_scan_complete', { found: bounces.length, updated });
  return c.json({ found: bounces.length, updated });
});
```

### `sendEmail` change required

The match in the cron above will not work today because `email_log`
stores Gmail's internal id, not the RFC `Message-ID`. Two fixes:

1. **Preferred**: have `sendEmail` extract the `Message-ID` header from
   the response and return both `internalMessageId` and `messageId`
   (RFC). Store the RFC one in `email_log.gmailMessageId` (rename the
   column to `messageId` since it's no longer Gmail-specific).
2. **Fallback**: index `email_log` by `(recipient, sentAt)` and match
   bounces using `Final-Recipient` + a time window. Less reliable.

Go with #1 once we touch this.

### Cloud Scheduler

Add to `infra/scheduler/`:

```bash
gcloud scheduler jobs create http itr-scan-bounces \
  --schedule='*/30 * * * *' \
  --uri="https://itr-client-hq-<hash>.run.app/api/cron/scan-bounces" \
  --http-method=POST \
  --oidc-service-account-email=itr-cron@<PROJECT>.iam.gserviceaccount.com \
  --headers='X-Cron-Shared-Secret=<from secret manager>'
```

30-min cadence is fine — bounces typically arrive within minutes of
sending and there's no urgency to react in seconds.

### Server.ts wiring

```ts
import { cronScanBouncesRoute } from './routes/api/cron-scan-bounces.js';
// …
app.route('/api/cron', cronScanBouncesRoute);
```

### Admin surface

Bounced emails should be visible on the retreat detail page. The email
log table already renders `status` — `'bounced'` will show up
automatically; consider styling it as a destructive badge so it stands
out next to `'sent'`.

Optional follow-up: add a bulk-resend action on the admin detail page
for any retreat with a recent bounce.

## Effort estimate

- Schema migration: 30 min
- Gmail wrapper extension + DSN parsing: ~2h (DSN format is well-defined
  RFC 3464, but parsing the multipart structure is finicky)
- Cron route + tests: 1h
- Cloud Scheduler job + secret wiring: 30 min
- Admin badge styling tweak: 10 min

**~4h total** for a single focused session. Until then, the manual
inbox check above is the operational workaround.

## Open questions

- Should soft bounces (mailbox full, temporary domain unreachable) be
  tracked separately? Recommend yes — `'bounced'` for hard, `'failed'`
  for soft + already-retried. The Gmail DSN distinguishes these in the
  Status header (`5.x.x` = permanent, `4.x.x` = transient).
- What's the action threshold for bounced therapist emails? Probably
  page the admin (it's likely an MX/DNS bug, not a typo).
- Should clients with bounced emails block the consent flow entirely?
  Currently they can still load `/c/<token>` from the original link
  even if the email never arrived. Probably leave that path open —
  the consent flow is the source of truth, the email is the convenience.
