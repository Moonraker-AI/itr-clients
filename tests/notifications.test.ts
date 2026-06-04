import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { composeNotification, emailButton } from '../src/lib/notifications.ts';

const RETREAT_ID = '00000000-0000-0000-0000-000000000000';
const PORTAL_URL = 'https://clients.intensivetherapyretreat.com/c/sample-token';

describe('notification email HTML', () => {
  test('consent package uses a CTA button instead of visible raw URL', () => {
    const out = composeNotification({
      event: 'consent_package_sent',
      retreatId: RETREAT_ID,
      clientEmail: 'client@example.com',
      clientFirstName: 'Anna',
      clientPortalUrl: PORTAL_URL,
    });

    assert.match(out.htmlBody, /Review and sign consents/);
    assert.match(out.htmlBody, new RegExp(`href="${PORTAL_URL}"`));
    assert.doesNotMatch(out.htmlBody, new RegExp(`>${PORTAL_URL}</a>`));
    assert.match(out.textBody, new RegExp(PORTAL_URL));
  });

  test('emailButton escapes label text', () => {
    const html = emailButton(PORTAL_URL, 'Review <now>');
    assert.match(html, /Review &lt;now&gt;/);
    assert.doesNotMatch(html, /Review <now>/);
  });
});
