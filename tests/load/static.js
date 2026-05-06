// k6 static-asset load — measures CDN-style serving of CSS + fonts +
// brand image. These are served from the Hono serveStatic middleware
// with `Cache-Control: public, max-age=31536000, immutable` so warmed
// up they should hit the Cloud Run frontend cache.
//
// Usage:
//   BASE_URL=https://itr-client-hq-buejbopu5q-uc.a.run.app k6 run tests/load/static.js

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  vus: Number(__ENV.K6_VUS || 30),
  duration: __ENV.K6_DURATION || '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:css}': ['p(95)<150'],
    'http_req_duration{name:font}': ['p(95)<150'],
    'http_req_duration{name:logo}': ['p(95)<150'],
  },
};

export default function () {
  const css = http.get(`${BASE_URL}/static/app.css`, { tags: { name: 'css' } });
  const font = http.get(
    `${BASE_URL}/static/fonts/outfit-latin-wght-normal.woff2`,
    { tags: { name: 'font' } },
  );
  const logo = http.get(`${BASE_URL}/static/brand/logo.png`, {
    tags: { name: 'logo' },
  });
  check(css, { 'css 200': (r) => r.status === 200 });
  check(font, { 'font 200': (r) => r.status === 200 });
  check(logo, { 'logo 200': (r) => r.status === 200 });
  sleep(0.5);
}
