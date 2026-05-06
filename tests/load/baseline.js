// k6 baseline load — hits /health on the dev service.
// Establishes a floor: how many req/s can a single Cloud Run instance
// serve when the work is essentially zero (timestamp + JSON encode).
//
// Usage:
//   BASE_URL=https://itr-client-hq-buejbopu5q-uc.a.run.app k6 run tests/load/baseline.js
//
// Tune VUs + duration via env: K6_VUS=50 K6_DURATION=2m k6 run …

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  vus: Number(__ENV.K6_VUS || 20),
  duration: __ENV.K6_DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/health`);
  check(res, {
    'status 200': (r) => r.status === 200,
    'body has ok': (r) => (r.body || '').includes('"ok":true'),
  });
}
