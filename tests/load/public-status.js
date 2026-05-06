// k6 load — public client status page. Hits /c/<TOKEN> which executes:
//   - 1 SELECT on retreats + clients + therapists (joined)
//   - 1 SELECT on pricing_config
//   - 1 SELECT on retreat_required_consents + consent_templates
//   - 1 SELECT on consent_signatures
//   - JSX render
//
// This is the heaviest read-only public page. Use it to find Cloud SQL
// connection-pool exhaustion + Cloud Run autoscaling breakpoints.
//
// IMPORTANT: needs a real client_token. Seed one via `npm run smoke:retreat`
// against dev (returns the token in stdout). Token is single-tenant so
// the same one across all VUs is fine for load purposes.
//
// The /c/* surface has a 60-req/min/IP rate limiter (P1#8). k6 sources
// from a single IP, so per-VU throughput is bounded by that. To get past
// it for load testing, either:
//   1. Run k6 from multiple IPs (cloud k6 / multiple workers)
//   2. Temporarily raise the limit on dev for the test window
// Option 2 is cheaper. Don't forget to lower it back.
//
// Usage:
//   BASE_URL=https://itr-client-hq-buejbopu5q-uc.a.run.app \
//   TOKEN=<from smoke:retreat output> \
//   k6 run tests/load/public-status.js

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TOKEN = __ENV.TOKEN;

if (!TOKEN) {
  throw new Error(
    'TOKEN env var required. Run `npm run smoke:retreat` to generate one.',
  );
}

export const options = {
  vus: Number(__ENV.K6_VUS || 5),
  duration: __ENV.K6_DURATION || '1m',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<800'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/c/${TOKEN}`);
  check(res, {
    'status 200': (r) => r.status === 200,
    'has therapist line': (r) => (r.body || '').includes('Your therapist'),
    'no 429': (r) => r.status !== 429,
  });
}
