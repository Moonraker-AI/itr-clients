/**
 * /admin/email-preview - render every notify-event body in the browser
 * (P3, v0.20.0). Lets ops sanity-check the wording / link shape of an
 * outbound email without firing it for real.
 *
 * Uses the real composeNotification() function from src/lib/notifications.ts
 * with a synthetic NotifyArgs payload (sample retreat id + token + names),
 * so what's rendered is byte-identical to what would ship for an event
 * with those inputs. No DB I/O.
 */

import { Hono } from 'hono';
import { raw } from 'hono/html';

import {
  composeNotification,
  type NotifyArgs,
  type NotifyEvent,
} from '../../lib/notifications.js';
import {
  AdminShell,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Layout,
  LinkButton,
  PageHeader,
  Select,
  Button,
} from '../../lib/ui/index.js';

export const adminEmailPreviewRoute = new Hono();

const EVENTS: NotifyEvent[] = [
  'consent_package_sent',
  'consents_signed',
  'deposit_paid',
  'dates_confirmed',
  'in_progress',
  'completion_submitted',
  'final_charged',
  'final_charge_failed',
  'final_charge_retry_exhausted',
  'cancelled',
];

const SAMPLE_RETREAT_ID = '00000000-0000-0000-0000-000000000000';

function sampleArgs(event: NotifyEvent, baseUrl: string): NotifyArgs {
  if (event === 'consent_package_sent') {
    return {
      event,
      retreatId: SAMPLE_RETREAT_ID,
      clientEmail: 'sample@example.com',
      clientFirstName: 'Sample',
      clientPortalUrl: `${baseUrl}/c/sample-token-0123456789abcdef/consents`,
    };
  }
  return {
    event,
    retreatId: SAMPLE_RETREAT_ID,
    adminUrl: `${baseUrl}/admin/clients/${SAMPLE_RETREAT_ID}`,
  };
}

adminEmailPreviewRoute.get('/', async (c) => {
  const requested = (c.req.query('event') ?? '') as NotifyEvent;
  const event: NotifyEvent = (EVENTS as readonly string[]).includes(requested)
    ? requested
    : 'consent_package_sent';

  const baseUrl = process.env.PUBLIC_BASE_URL ?? `${c.req.url.split('/admin')[0]}`;
  const composed = composeNotification(sampleArgs(event, baseUrl));
  const user = c.get('user');

  // iframe srcdoc so the body's CSS (none today, but leaves headroom for
  // future template work) cannot bleed into the admin shell. The srcdoc
  // attribute auto-escapes when rendered as JSX prop, so we must use raw()
  // to emit it verbatim - the body itself is operator-trusted JSX output
  // from composeNotification, never user input.
  const iframeAttr = `srcdoc="${composed.htmlBody.replace(/"/g, '&quot;')}"`;

  return c.html(
    <Layout title="Email preview - ITR Clients">
      <AdminShell user={user} current="email-preview">
        <PageHeader title="Email preview" description={`Template: ${composed.templateName}`}>
          <LinkButton href="/admin" variant="ghost" size="sm">
            ← Back to dashboard
          </LinkButton>
        </PageHeader>

        <Card class="mb-6">
          <CardContent class="pt-6">
            <form method="get" class="flex flex-wrap items-end gap-3">
              <div class="space-y-1.5">
                <label class="text-xs text-muted-foreground">Event</label>
                <Select name="event" class="min-w-[280px]">
                  {EVENTS.map((e) => (
                    <option value={e} selected={e === event}>
                      {e}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" size="default">
                Render
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card class="mb-4">
          <CardHeader>
            <CardTitle class="text-sm">
              Subject{' '}
              <Badge variant="secondary" class="ml-2">
                {composed.subject.length} chars
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <code class="font-mono text-sm break-all">{composed.subject}</code>
          </CardContent>
        </Card>

        <Card class="mb-4">
          <CardHeader>
            <CardTitle class="text-sm">HTML rendered</CardTitle>
          </CardHeader>
          <CardContent class="px-0">
            {raw(`<iframe ${iframeAttr} class="w-full min-h-[280px] border-0 bg-background"
              sandbox="allow-popups" title="email html preview"></iframe>`)}
          </CardContent>
        </Card>

        <Card class="mb-4">
          <details class="group">
            <summary class="flex cursor-pointer items-center justify-between px-6 py-4">
              <CardTitle class="text-sm">Plain-text body</CardTitle>
              <span class="text-muted-foreground transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <CardContent>
              <pre class="whitespace-pre-wrap text-xs font-mono text-muted-foreground">{composed.textBody}</pre>
            </CardContent>
          </details>
        </Card>

        <Card>
          <details class="group">
            <summary class="flex cursor-pointer items-center justify-between px-6 py-4">
              <CardTitle class="text-sm">HTML source</CardTitle>
              <span class="text-muted-foreground transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <CardContent>
              <pre class="whitespace-pre-wrap text-xs font-mono text-muted-foreground">{composed.htmlBody}</pre>
            </CardContent>
          </details>
        </Card>
      </AdminShell>
    </Layout>,
  );
});
