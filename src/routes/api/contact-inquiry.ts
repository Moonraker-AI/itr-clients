import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, asc, count, eq, gte } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { contactInquiries, contactInquiryEvents, therapists } from '../../db/schema.js';
import {
  hashIp,
  validateContactInquiryPayload,
} from '../../lib/contact-inquiries.js';
import {
  sendInquiryConfirmationEmail,
  sendInquiryReceivedEmail,
} from '../../lib/inquiry-notifications.js';
import { log } from '../../lib/phi-redactor.js';
import { clientIp, createRateLimiter } from '../../lib/rate-limit.js';

export const contactInquiryRoute = new Hono();

const CONTACT_DAILY_LIMIT = 2;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const limiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 8,
  bucketKey: (c) => clientIp(c),
});

contactInquiryRoute.get('/form', async (c) => {
  const selectedTherapist = cleanQuery(c.req.query('therapist') ?? c.req.query('clinician') ?? '', 96);
  const sourceKey = cleanQuery(c.req.query('sourceKey') ?? c.req.query('source') ?? 'itr_contact', 80);
  const sourcePage = cleanQuery(c.req.query('sourcePage') ?? c.req.query('page') ?? '', 800);
  const { db } = await getDb();
  const therapistRows = await db
    .select({
      slug: therapists.slug,
      fullName: therapists.fullName,
    })
    .from(therapists)
    .where(eq(therapists.active, true))
    .orderBy(asc(therapists.fullName));

  return c.html(renderEmbeddedForm({
    therapists: therapistRows,
    selectedTherapist,
    sourceKey,
    sourcePage,
  }));
});

contactInquiryRoute.get('/form.js', (c) => {
  c.header('Content-Type', 'application/javascript; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(EMBED_FORM_JS);
});

contactInquiryRoute.options('/', async (c) => {
  if (!applyCors(c)) return c.json({ error: 'forbidden' }, 403);
  return c.body(null, 204);
});

contactInquiryRoute.post(
  '/',
  bodyLimit({
    maxSize: 32_768,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
  limiter.middleware({
    onBlock: (c) => {
      log.warn('contact_inquiry_rate_limited', {
        ipHash: hashIp(clientIp(c)),
        origin: c.req.header('origin') ?? null,
      });
    },
  }),
  async (c) => {
    if (!applyCors(c)) return c.json({ error: 'forbidden' }, 403);

    const parsedBody = await parseInquiryBody(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;

    // Honeypot. Return success so bots do not learn the rule.
    if (String(body.company ?? '').trim()) {
      return c.json({ ok: true });
    }

    const parsed = validateContactInquiryPayload(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    const data = parsed.data;
    const { db } = await getDb();

    const [therapist] = await db
      .select({
        id: therapists.id,
        email: therapists.email,
        fullName: therapists.fullName,
      })
      .from(therapists)
      .where(and(eq(therapists.slug, data.therapistSlug), eq(therapists.active, true)))
      .limit(1);
    if (!therapist) {
      return c.json({ error: 'therapist_not_found' }, 400);
    }

    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const [contactCountRow] = await db
      .select({ value: count() })
      .from(contactInquiries)
      .where(
        and(
          eq(contactInquiries.contactHash, data.contactHash),
          gte(contactInquiries.createdAt, since),
        ),
      );
    const contactCount = Number(contactCountRow?.value ?? 0);
    if (contactCount >= CONTACT_DAILY_LIMIT) {
      log.warn('contact_inquiry_daily_limit_suppressed', {
        contactHash: data.contactHash,
      });
      return c.json({ ok: true });
    }

    if (data.messageHash) {
      const [messageCountRow] = await db
        .select({ value: count() })
        .from(contactInquiries)
        .where(
          and(
            eq(contactInquiries.messageHash, data.messageHash),
            gte(contactInquiries.createdAt, since),
          ),
        );
      const messageCount = Number(messageCountRow?.value ?? 0);
      if (messageCount > 0) {
        log.warn('contact_inquiry_duplicate_message_suppressed', {
          contactHash: data.contactHash,
        });
        return c.json({ ok: true });
      }
    }

    const ipHash = hashIp(clientIp(c));
    const userAgent = c.req.header('user-agent')?.slice(0, 500) ?? null;

    const [inquiry] = await db
      .insert(contactInquiries)
      .values({
        requestedTherapistId: therapist.id,
        assignedTherapistId: therapist.id,
        status: 'new',
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone,
        location: data.location,
        timezone: data.timezone,
        consultationWindows: data.consultationWindows,
        message: data.message,
        heardFrom: data.heardFrom,
        consentPhone: data.consentPhone,
        consentText: data.consentText,
        consentEmail: data.consentEmail,
        policyServiceLevel: data.policyServiceLevel,
        policyFinancial: data.policyFinancial,
        sourcePage: data.sourcePage,
        sourceKey: data.sourceKey,
        contactHash: data.contactHash,
        messageHash: data.messageHash,
        ipHash,
        userAgent,
      })
      .returning({ id: contactInquiries.id });

    if (!inquiry) {
      log.error('contact_inquiry_insert_failed');
      return c.json({ error: 'insert_failed' }, 500);
    }

    await db.insert(contactInquiryEvents).values({
      inquiryId: inquiry.id,
      actorTherapistId: null,
      eventType: 'created',
      payload: {
        requestedTherapistId: therapist.id,
        assignedTherapistId: therapist.id,
        sourceKey: data.sourceKey,
      },
    });

    await sendInquiryReceivedEmail({
      inquiryId: inquiry.id,
      therapistEmail: therapist.email,
    });
    await sendInquiryConfirmationEmail({
      to: data.email,
      firstName: data.firstName,
    });

    log.info('contact_inquiry_created', {
      inquiryId: inquiry.id,
      therapistId: therapist.id,
      sourceKey: data.sourceKey,
    });
    return c.json({ ok: true });
  },
);

function allowedOrigins(): Set<string> {
  const configured = (process.env.CONTACT_INQUIRY_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([
    'https://sites.moonraker.ai',
    'https://intensivetherapyretreat.com',
    'https://www.intensivetherapyretreat.com',
    'https://clients.intensivetherapyretreat.com',
    ...configured,
  ]);
}

function cleanQuery(value: string, max: number): string {
  return String(value || '').trim().slice(0, max);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function renderEmbeddedForm(args: {
  therapists: Array<{ slug: string; fullName: string }>;
  selectedTherapist: string;
  sourceKey: string;
  sourcePage: string;
}): string {
  const selected = args.therapists.some((t) => t.slug === args.selectedTherapist)
    ? args.selectedTherapist
    : '';
  const therapistOptions = args.therapists
    .map((therapist) => {
      const isSelected = therapist.slug === selected ? ' selected' : '';
      return `<option value="${escapeHtml(therapist.slug)}"${isSelected}>${escapeHtml(therapist.fullName)}</option>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Contact Intensive Therapy Retreats</title>
  <style>
    :root {
      color-scheme: light;
      --ink: oklch(24% 0.025 185);
      --muted: oklch(48% 0.025 185);
      --line: oklch(84% 0.035 185);
      --surface: oklch(98% 0.012 185);
      --raised: oklch(99% 0.008 185);
      --teal: oklch(47% 0.105 185);
      --teal-dark: oklch(35% 0.09 185);
      --danger: oklch(45% 0.14 25);
      --radius: 15px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: transparent; color: var(--ink); }
    body { padding: 12px; }
    form {
      display: grid;
      gap: 16px;
      background: var(--raised);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: clamp(20px, 4vw, 34px);
      box-shadow: 0 18px 45px oklch(30% 0.03 185 / 0.12);
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .field { display: grid; gap: 6px; }
    label, legend {
      font-size: 0.9rem;
      font-weight: 650;
      color: var(--teal-dark);
    }
    input, select, textarea {
      width: 100%;
      border: 1.5px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
      color: var(--ink);
      font: inherit;
      padding: 12px 13px;
    }
    textarea { min-height: 116px; resize: vertical; }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--teal);
      box-shadow: 0 0 0 3px oklch(60% 0.08 190 / 0.18);
    }
    fieldset {
      display: grid;
      gap: 10px;
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
    }
    .choice {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 9px;
      align-items: start;
      color: var(--ink);
      font-size: 0.94rem;
      font-weight: 450;
    }
    .choice input { width: 16px; height: 16px; margin: 2px 0 0; padding: 0; }
    .checks { display: grid; gap: 10px; }
    .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    button {
      justify-self: start;
      border: 0;
      border-radius: 999px;
      background: var(--teal);
      color: oklch(98% 0.01 185);
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      padding: 13px 24px;
      transition: background-color 180ms ease-out, transform 140ms ease-out;
    }
    button:hover { background: var(--teal-dark); transform: translateY(-1px); }
    button:disabled { cursor: wait; opacity: 0.7; transform: none; }
    .privacy, .status {
      margin: 0;
      color: var(--muted);
      font-size: 0.88rem;
      line-height: 1.45;
    }
    .status { min-height: 1.3em; }
    .status[data-tone="success"] { color: var(--teal-dark); }
    .status[data-tone="error"] { color: var(--danger); }
    @media (max-width: 620px) {
      form { border-radius: 10px; padding: 18px; }
      .grid { grid-template-columns: 1fr; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <form method="POST" action="/api/public/contact-inquiry" data-contact-inquiry-form novalidate>
    <input type="hidden" name="sourceKey" value="${escapeHtml(args.sourceKey || 'itr_contact')}">
    <input type="hidden" name="sourcePage" value="${escapeHtml(args.sourcePage)}" data-source-page>

    <div class="field">
      <label for="therapistSlug">Therapist</label>
      <select id="therapistSlug" name="therapistSlug" required>
        <option value="">Choose a therapist</option>
        ${therapistOptions}
      </select>
    </div>

    <div class="grid">
      <div class="field">
        <label for="firstName">First name</label>
        <input id="firstName" name="firstName" autocomplete="given-name" required>
      </div>
      <div class="field">
        <label for="lastName">Last name</label>
        <input id="lastName" name="lastName" autocomplete="family-name" required>
      </div>
    </div>

    <div class="grid">
      <div class="field">
        <label for="phone">Phone</label>
        <input id="phone" name="phone" type="tel" autocomplete="tel" required>
      </div>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required>
      </div>
    </div>

    <div class="grid">
      <div class="field">
        <label for="location">City and state</label>
        <input id="location" name="location" autocomplete="address-level2" required>
      </div>
      <div class="field">
        <label for="timezone">Time zone</label>
        <select id="timezone" name="timezone" required data-timezone>
          <option value="">Select time zone</option>
          <optgroup label="UTC-12 to UTC-10">
            <option value="Etc/GMT+12">GMT-12:00 - International Date Line West</option>
            <option value="Pacific/Pago_Pago">GMT-11:00 - American Samoa</option>
            <option value="Pacific/Honolulu">GMT-10:00 - Hawaii</option>
          </optgroup>
          <optgroup label="UTC-9 to UTC-7">
            <option value="America/Anchorage">GMT-09:00 - Alaska</option>
            <option value="America/Los_Angeles">GMT-08:00 - Pacific Time (US &amp; Canada)</option>
            <option value="America/Vancouver">GMT-08:00 - Vancouver</option>
            <option value="America/Tijuana">GMT-08:00 - Tijuana, Baja California</option>
            <option value="America/Denver">GMT-07:00 - Mountain Time (US &amp; Canada)</option>
            <option value="America/Phoenix">GMT-07:00 - Arizona (no DST)</option>
            <option value="America/Chihuahua">GMT-07:00 - Chihuahua, Mazatlan</option>
          </optgroup>
          <optgroup label="UTC-6 to UTC-4">
            <option value="America/Chicago">GMT-06:00 - Central Time (US &amp; Canada)</option>
            <option value="America/Mexico_City">GMT-06:00 - Mexico City, Guadalajara</option>
            <option value="America/Regina">GMT-06:00 - Saskatchewan (no DST)</option>
            <option value="America/New_York">GMT-05:00 - Eastern Time (US &amp; Canada)</option>
            <option value="America/Toronto">GMT-05:00 - Toronto</option>
            <option value="America/Indiana/Indianapolis">GMT-05:00 - Indiana (East)</option>
            <option value="America/Bogota">GMT-05:00 - Bogota, Lima, Quito</option>
            <option value="America/Halifax">GMT-04:00 - Atlantic Time (Canada)</option>
            <option value="America/Caracas">GMT-04:00 - Caracas</option>
            <option value="America/Santiago">GMT-04:00 - Santiago</option>
            <option value="America/La_Paz">GMT-04:00 - La Paz</option>
            <option value="America/Manaus">GMT-04:00 - Manaus</option>
          </optgroup>
          <optgroup label="UTC-3:30 to UTC-1">
            <option value="America/St_Johns">GMT-03:30 - Newfoundland</option>
            <option value="America/Sao_Paulo">GMT-03:00 - Brasilia, Sao Paulo</option>
            <option value="America/Argentina/Buenos_Aires">GMT-03:00 - Buenos Aires</option>
            <option value="America/Montevideo">GMT-03:00 - Montevideo</option>
            <option value="Atlantic/South_Georgia">GMT-02:00 - Mid-Atlantic</option>
            <option value="Atlantic/Azores">GMT-01:00 - Azores</option>
            <option value="Atlantic/Cape_Verde">GMT-01:00 - Cape Verde</option>
          </optgroup>
          <optgroup label="UTC+0">
            <option value="UTC">GMT+00:00 - UTC</option>
            <option value="Europe/London">GMT+00:00 - London, Dublin, Edinburgh</option>
            <option value="Europe/Lisbon">GMT+00:00 - Lisbon</option>
            <option value="Atlantic/Reykjavik">GMT+00:00 - Reykjavik</option>
            <option value="Africa/Casablanca">GMT+00:00 - Casablanca</option>
            <option value="Africa/Monrovia">GMT+00:00 - Monrovia</option>
          </optgroup>
          <optgroup label="UTC+1 to UTC+2">
            <option value="Europe/Amsterdam">GMT+01:00 - Amsterdam, Berlin, Bern, Rome</option>
            <option value="Europe/Paris">GMT+01:00 - Paris, Brussels</option>
            <option value="Europe/Madrid">GMT+01:00 - Madrid</option>
            <option value="Africa/Lagos">GMT+01:00 - West Central Africa</option>
            <option value="Africa/Cairo">GMT+02:00 - Cairo</option>
            <option value="Africa/Johannesburg">GMT+02:00 - Johannesburg, Harare</option>
            <option value="Asia/Jerusalem">GMT+02:00 - Jerusalem</option>
            <option value="Europe/Athens">GMT+02:00 - Athens, Bucharest</option>
            <option value="Europe/Helsinki">GMT+02:00 - Helsinki, Kyiv</option>
            <option value="Europe/Istanbul">GMT+03:00 - Istanbul</option>
          </optgroup>
          <optgroup label="UTC+3 to UTC+5:45">
            <option value="Asia/Riyadh">GMT+03:00 - Riyadh, Kuwait</option>
            <option value="Asia/Baghdad">GMT+03:00 - Baghdad</option>
            <option value="Africa/Nairobi">GMT+03:00 - Nairobi</option>
            <option value="Europe/Moscow">GMT+03:00 - Moscow, St. Petersburg</option>
            <option value="Asia/Tehran">GMT+03:30 - Tehran</option>
            <option value="Asia/Dubai">GMT+04:00 - Abu Dhabi, Dubai</option>
            <option value="Asia/Tbilisi">GMT+04:00 - Tbilisi</option>
            <option value="Asia/Yerevan">GMT+04:00 - Yerevan</option>
            <option value="Asia/Kabul">GMT+04:30 - Kabul</option>
            <option value="Asia/Karachi">GMT+05:00 - Karachi, Islamabad</option>
            <option value="Asia/Tashkent">GMT+05:00 - Tashkent</option>
            <option value="Asia/Kolkata">GMT+05:30 - Mumbai, New Delhi, Kolkata</option>
            <option value="Asia/Colombo">GMT+05:30 - Sri Lanka</option>
            <option value="Asia/Kathmandu">GMT+05:45 - Kathmandu</option>
          </optgroup>
          <optgroup label="UTC+6 to UTC+8">
            <option value="Asia/Dhaka">GMT+06:00 - Dhaka</option>
            <option value="Asia/Almaty">GMT+06:00 - Almaty</option>
            <option value="Asia/Yangon">GMT+06:30 - Yangon (Rangoon)</option>
            <option value="Asia/Bangkok">GMT+07:00 - Bangkok, Hanoi, Jakarta</option>
            <option value="Asia/Ho_Chi_Minh">GMT+07:00 - Ho Chi Minh City</option>
            <option value="Asia/Krasnoyarsk">GMT+07:00 - Krasnoyarsk</option>
            <option value="Asia/Shanghai">GMT+08:00 - Beijing, Shanghai</option>
            <option value="Asia/Hong_Kong">GMT+08:00 - Hong Kong</option>
            <option value="Asia/Singapore">GMT+08:00 - Singapore, Kuala Lumpur</option>
            <option value="Asia/Taipei">GMT+08:00 - Taipei</option>
            <option value="Australia/Perth">GMT+08:00 - Perth</option>
            <option value="Asia/Ulaanbaatar">GMT+08:00 - Ulaanbaatar</option>
          </optgroup>
          <optgroup label="UTC+9 to UTC+14">
            <option value="Asia/Seoul">GMT+09:00 - Seoul</option>
            <option value="Asia/Tokyo">GMT+09:00 - Tokyo, Osaka, Sapporo</option>
            <option value="Australia/Darwin">GMT+09:30 - Darwin</option>
            <option value="Australia/Adelaide">GMT+09:30 - Adelaide</option>
            <option value="Australia/Brisbane">GMT+10:00 - Brisbane</option>
            <option value="Australia/Sydney">GMT+10:00 - Sydney, Melbourne</option>
            <option value="Pacific/Port_Moresby">GMT+10:00 - Port Moresby</option>
            <option value="Pacific/Noumea">GMT+11:00 - New Caledonia</option>
            <option value="Pacific/Auckland">GMT+12:00 - Auckland, Wellington</option>
            <option value="Pacific/Fiji">GMT+12:00 - Fiji</option>
            <option value="Pacific/Tongatapu">GMT+13:00 - Nukualofa</option>
            <option value="Pacific/Apia">GMT+13:00 - Samoa</option>
          </optgroup>
        </select>
      </div>
    </div>

    <fieldset>
      <legend>Best time to talk</legend>
      <label class="choice"><input type="checkbox" name="consultationTime" value="weekday_morning"><span>Weekday morning</span></label>
      <label class="choice"><input type="checkbox" name="consultationTime" value="weekday_afternoon"><span>Weekday afternoon</span></label>
      <label class="choice"><input type="checkbox" name="consultationTime" value="weekday_evening"><span>Weekday evening</span></label>
    </fieldset>

    <div class="field">
      <label for="message">What is going on?</label>
      <textarea id="message" name="message" required></textarea>
    </div>

    <div class="field">
      <label for="heardFrom">How did you hear about us?</label>
      <select id="heardFrom" name="heardFrom">
        <option value="">Select an option</option>
        <option value="Google Search">Google Search</option>
        <option value="Google Maps">Google Maps</option>
        <option value="Gemini">Gemini</option>
        <option value="ChatGPT">ChatGPT</option>
        <option value="Claude">Claude</option>
        <option value="Perplexity">Perplexity</option>
        <option value="Newsletter">Newsletter</option>
        <option value="Referral">Referral</option>
        <option value="Other">Other</option>
      </select>
    </div>

    <fieldset>
      <legend>Contact permission</legend>
      <label class="choice"><input type="checkbox" name="consentPhone" value="true"><span>Phone call or voicemail</span></label>
      <label class="choice"><input type="checkbox" name="consentText" value="true"><span>Text message</span></label>
      <label class="choice"><input type="checkbox" name="consentEmail" value="true"><span>Email</span></label>
    </fieldset>

    <div class="checks">
      <label class="choice"><input type="checkbox" name="policyServiceLevel" value="true" required><span>I understand this is outpatient care and not crisis support.</span></label>
      <label class="choice"><input type="checkbox" name="policyFinancial" value="true" required><span>I understand retreats are private pay and insurance is not accepted.</span></label>
    </div>

    <div class="hp" aria-hidden="true">
      <label for="company">Company</label>
      <input id="company" name="company" tabindex="-1" autocomplete="off">
    </div>

    <button type="submit" data-submit-button>Send a private message</button>
    <p class="privacy">Your inquiry is sent through our secure intake system. A therapist will follow up using the contact preferences you choose.</p>
    <p class="status" data-form-status role="status" aria-live="polite"></p>
  </form>
  <script src="/api/public/contact-inquiry/form.js" defer></script>
</body>
</html>`;
}

const EMBED_FORM_JS = `(() => {
  const form = document.querySelector('[data-contact-inquiry-form]');
  if (!(form instanceof HTMLFormElement)) return;

  const statusEl = form.querySelector('[data-form-status]');
  const submitButton = form.querySelector('[data-submit-button]');
  const sourcePage = form.querySelector('[data-source-page]');
  const timezone = form.querySelector('[data-timezone]');

  function sendHeight() {
    const height = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    window.parent.postMessage({ type: 'itrContactFormHeight', height }, '*');
  }

  if (sourcePage instanceof HTMLInputElement && !sourcePage.value) {
    sourcePage.value = document.referrer || '';
  }
  if (timezone instanceof HTMLSelectElement && !timezone.value && 'Intl' in window) {
    timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  }

  if ('ResizeObserver' in window) {
    new ResizeObserver(sendHeight).observe(document.body);
  }
  window.addEventListener('load', sendHeight);
  setTimeout(sendHeight, 250);

  function setStatus(message, tone) {
    if (!(statusEl instanceof HTMLElement)) return;
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
    sendHeight();
  }

  function payloadFrom(formData) {
    return {
      therapistSlug: formData.get('therapistSlug'),
      firstName: formData.get('firstName'),
      lastName: formData.get('lastName'),
      email: formData.get('email'),
      phone: formData.get('phone'),
      location: formData.get('location'),
      timezone: formData.get('timezone'),
      consultationTime: formData.getAll('consultationTime'),
      message: formData.get('message'),
      heardFrom: formData.get('heardFrom'),
      consentPhone: formData.get('consentPhone') === 'true',
      consentText: formData.get('consentText') === 'true',
      consentEmail: formData.get('consentEmail') === 'true',
      policyServiceLevel: formData.get('policyServiceLevel') === 'true',
      policyFinancial: formData.get('policyFinancial') === 'true',
      sourcePage: formData.get('sourcePage') || document.referrer || '',
      sourceKey: formData.get('sourceKey') || 'itr_contact',
      company: formData.get('company') || ''
    };
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('', 'neutral');
    if (!form.reportValidity()) {
      sendHeight();
      return;
    }

    const formData = new FormData(form);
    const payload = payloadFrom(formData);
    if (!payload.consultationTime.length) {
      setStatus('Choose at least one time window.', 'error');
      return;
    }
    if (!payload.consentPhone && !payload.consentText && !payload.consentEmail) {
      setStatus('Choose at least one contact permission.', 'error');
      return;
    }

    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = true;
      submitButton.textContent = 'Sending...';
    }

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || 'submit_failed');
      }
      form.reset();
      if (sourcePage instanceof HTMLInputElement) sourcePage.value = document.referrer || '';
      if (timezone instanceof HTMLSelectElement && 'Intl' in window) {
        timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      }
      setStatus('Thank you. Your inquiry was sent securely.', 'success');
    } catch {
      setStatus('The message could not be sent. Please call us or try again.', 'error');
    } finally {
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = false;
        submitButton.textContent = 'Send a private message';
      }
      sendHeight();
    }
  });
})();`;

type BodyParseResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

async function parseInquiryBody(c: Context): Promise<BodyParseResult> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? '';

  if (contentType.includes('application/json')) {
    try {
      return {
        ok: true,
        body: (await c.req.json()) as Record<string, unknown>,
      };
    } catch {
      return { ok: false, error: 'invalid_json' };
    }
  }

  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    try {
      const form = await c.req.formData();
      const body: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        const nextValue = typeof value === 'string' ? value : value.name;
        const current = body[key];
        if (current == null) {
          body[key] = nextValue;
        } else if (Array.isArray(current)) {
          current.push(nextValue);
        } else {
          body[key] = [current, nextValue];
        }
      }
      return { ok: true, body };
    } catch {
      return { ok: false, error: 'invalid_form' };
    }
  }

  return { ok: false, error: 'unsupported_content_type' };
}

function applyCors(c: Context): boolean {
  const origin = c.req.header('origin');
  if (!origin) return true;
  const requestOrigin = new URL(c.req.url).origin;
  const localDev =
    process.env.NODE_ENV !== 'production' &&
    (/^http:\/\/localhost:\d+$/.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  if (origin !== requestOrigin && !localDev && !allowedOrigins().has(origin)) return false;
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Access-Control-Max-Age', '86400');
  return true;
}
