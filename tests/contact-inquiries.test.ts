import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { validateContactInquiryPayload } from '../src/lib/contact-inquiries.ts';

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    therapistSlug: 'amy-shuman',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'Jane.Doe@example.com',
    phone: '(413) 555-0199',
    location: 'Northampton, MA',
    timezone: 'America/New_York',
    consultationTime: ['weekday_morning'],
    message: 'I would like to talk about an intensive.',
    heardFrom: 'Google',
    consentPhone: true,
    consentEmail: false,
    consentText: false,
    policyServiceLevel: true,
    policyFinancial: true,
    sourcePage: 'https://intensivetherapyretreat.com/',
    sourceKey: 'itr_contact',
    ...overrides,
  };
}

describe('contact inquiry validation', () => {
  test('accepts the public form payload', () => {
    const parsed = validateContactInquiryPayload(validPayload());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    assert.equal(parsed.data.therapistSlug, 'amy-shuman');
    assert.equal(parsed.data.email, 'jane.doe@example.com');
    assert.deepEqual(parsed.data.consultationWindows, ['weekday_morning']);
    assert.equal(parsed.data.consentPhone, true);
    assert.equal(parsed.data.policyFinancial, true);
    assert.match(parsed.data.contactHash, /^[a-f0-9]{64}$/);
  });

  test('splits legacy full-name payloads', () => {
    const parsed = validateContactInquiryPayload(validPayload({
      firstName: undefined,
      lastName: undefined,
      name: 'Jordan Example',
    }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    assert.equal(parsed.data.firstName, 'Jordan');
    assert.equal(parsed.data.lastName, 'Example');
  });

  test('requires at least one contact permission', () => {
    const parsed = validateContactInquiryPayload(validPayload({
      consentPhone: false,
      consentText: false,
      consentEmail: false,
    }));
    assert.deepEqual(parsed, { ok: false, error: 'missing_contact_consent' });
  });

  test('normalizes duplicate messages for hashing', () => {
    const first = validateContactInquiryPayload(validPayload({
      message: 'Please contact me about EMDR.',
    }));
    const second = validateContactInquiryPayload(validPayload({
      message: '  please   contact me about emdr!!! ',
    }));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    assert.equal(first.data.messageHash, second.data.messageHash);
  });
});
