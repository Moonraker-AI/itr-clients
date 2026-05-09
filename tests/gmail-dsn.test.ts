import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { parseDsn } from '../src/lib/gmail.ts';

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('parseDsn: hard bounce with In-Reply-To at top level', () => {
  const dsn = {
    id: 'gmail_internal_42',
    internalDate: String(Date.UTC(2026, 4, 7, 12, 0, 0)),
    payload: {
      mimeType: 'multipart/report',
      headers: [
        { name: 'From', value: 'mailer-daemon@googlemail.com' },
        { name: 'In-Reply-To', value: '<orig-uuid-1@clients.itr.test>' },
      ],
      parts: [
        {
          mimeType: 'text/plain',
          headers: [],
          body: { data: b64url('Delivery to the following recipient failed permanently.') },
        },
        {
          mimeType: 'message/delivery-status',
          headers: [],
          body: {
            data: b64url(
              [
                'Reporting-MTA: dns; mx.google.com',
                '',
                'Final-Recipient: rfc822; nobody@bad.example.com',
                'Action: failed',
                'Status: 5.1.1',
                'Diagnostic-Code: smtp; 550-5.1.1 The email account does not exist.',
              ].join('\r\n'),
            ),
          },
        },
        {
          mimeType: 'message/rfc822',
          headers: [],
          parts: [
            {
              mimeType: 'text/plain',
              headers: [
                { name: 'Message-ID', value: '<orig-uuid-1@clients.itr.test>' },
                { name: 'From', value: 'clients@intensivetherapyretreat.com' },
              ],
              body: { data: '' },
            },
          ],
        },
      ],
    },
  };

  test('extracts inReplyTo without brackets', () => {
    const out = parseDsn(dsn);
    assert.equal(out.inReplyTo, 'orig-uuid-1@clients.itr.test');
  });

  test('extracts hard-bounce status code', () => {
    const out = parseDsn(dsn);
    assert.equal(out.statusCode, '5.1.1');
  });

  test('extracts diagnostic code as failureReason', () => {
    const out = parseDsn(dsn);
    assert.match(out.failureReason ?? '', /account does not exist/);
  });

  test('extracts final recipient', () => {
    const out = parseDsn(dsn);
    assert.equal(out.finalRecipient, 'rfc822; nobody@bad.example.com');
  });

  test('preserves Gmail internal id and receivedAt', () => {
    const out = parseDsn(dsn);
    assert.equal(out.gmailMessageId, 'gmail_internal_42');
    assert.equal(out.receivedAt.toISOString(), '2026-05-07T12:00:00.000Z');
  });
});

describe('parseDsn: falls back to embedded rfc822 Message-ID when no top-level In-Reply-To', () => {
  test('walks message/rfc822 child headers', () => {
    const dsn = {
      id: 'g_2',
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'multipart/report',
        headers: [{ name: 'From', value: 'postmaster@example.com' }],
        parts: [
          {
            mimeType: 'message/delivery-status',
            headers: [],
            body: {
              data: b64url(
                ['Final-Recipient: rfc822; gone@example.com', 'Status: 5.4.4'].join('\r\n'),
              ),
            },
          },
          {
            mimeType: 'message/rfc822',
            headers: [],
            parts: [
              {
                mimeType: 'text/plain',
                headers: [{ name: 'Message-Id', value: '<fallback-uuid@x>' }],
                body: { data: '' },
              },
            ],
          },
        ],
      },
    };
    const out = parseDsn(dsn);
    assert.equal(out.inReplyTo, 'fallback-uuid@x');
  });
});

describe('parseDsn: transient (4.x.x) bounce', () => {
  test('reflects statusCode 4.x.x', () => {
    const dsn = {
      id: 'g_3',
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'multipart/report',
        headers: [{ name: 'In-Reply-To', value: '<x@y>' }],
        parts: [
          {
            mimeType: 'message/delivery-status',
            headers: [],
            body: {
              data: b64url(
                [
                  'Final-Recipient: rfc822; busy@example.com',
                  'Status: 4.2.2',
                  'Diagnostic-Code: smtp; 452 mailbox full',
                ].join('\r\n'),
              ),
            },
          },
        ],
      },
    };
    const out = parseDsn(dsn);
    assert.equal(out.statusCode, '4.2.2');
    assert.match(out.failureReason ?? '', /mailbox full/);
  });
});

describe('parseDsn: malformed / missing parts', () => {
  test('no delivery-status part yields null fields', () => {
    const dsn = {
      id: 'g_4',
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'In-Reply-To', value: '<lone@x>' }],
        body: { data: b64url('plain body, no DSN structure') },
      },
    };
    const out = parseDsn(dsn);
    assert.equal(out.inReplyTo, 'lone@x');
    assert.equal(out.statusCode, null);
    assert.equal(out.finalRecipient, null);
    assert.equal(out.failureReason, null);
  });

  test('completely empty payload returns null inReplyTo', () => {
    const out = parseDsn({ id: 'g_5', internalDate: String(Date.now()), payload: {} });
    assert.equal(out.inReplyTo, null);
    assert.equal(out.statusCode, null);
  });
});
