import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const allowCount = new Counter('allow_count');
const denyCount = new Counter('deny_count');
const allowRate = new Rate('allow_rate');

// Run: k6 run scripts/loadtest.js
// Validates: ≤ burst_size ALLOWs per second window under 500 VUs
export const options = {
  scenarios: {
    burst_test: {
      executor: 'constant-vus',
      vus: 500,
      duration: '10s',
    },
  },
  thresholds: {
    // p99 of /check must be under 10ms (Redis round trip is the bottleneck)
    http_req_duration: ['p(99)<10'],
    // At least some requests must be denied (proves rate limiting is active)
    deny_count: ['count>0'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const CLIENT_KEY = 'loadtest_client';
const BURST_SIZE = 100;

export function setup() {
  // Configure the test client with a known limit
  const res = http.post(
    `${BASE_URL}/admin/clients`,
    JSON.stringify({
      client_key: CLIENT_KEY,
      algorithm: 'token_bucket',
      requests_per_second: 100,
      burst_size: BURST_SIZE,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (res.status !== 200) {
    throw new Error(`Setup failed: ${res.body}`);
  }
}

export default function () {
  const res = http.post(
    `${BASE_URL}/check`,
    JSON.stringify({ client_key: CLIENT_KEY }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const body = JSON.parse(res.body);
  const isAllow = body.decision === 'ALLOW';
  const isDeny = body.decision === 'DENY';

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'decision field present': () => body.decision === 'ALLOW' || body.decision === 'DENY',
    'remaining is non-negative': () => body.remaining >= 0,
    'reset is a unix timestamp': () => body.reset > 1700000000,
    'X-RateLimit-Limit header present': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
  });

  if (isAllow) allowCount.add(1);
  if (isDeny) denyCount.add(1);
  allowRate.add(isAllow ? 1 : 0);
}

export function handleSummary(data) {
  const allows = data.metrics.allow_count ? data.metrics.allow_count.values.count : 0;
  const denies = data.metrics.deny_count ? data.metrics.deny_count.values.count : 0;
  const totalRequests = allows + denies;
  const durationSec = 10;

  console.log('\n=== BucketAPI Load Test Summary ===');
  console.log(`Total requests : ${totalRequests}`);
  console.log(`ALLOWs         : ${allows}`);
  console.log(`DENYs          : ${denies}`);
  console.log(`Expected ALLOWs: ~${BURST_SIZE * durationSec} (${BURST_SIZE}/s × ${durationSec}s)`);
  console.log(`Allow rate     : ${((allows / totalRequests) * 100).toFixed(1)}%`);

  // Correctness check: ALLOWs should not exceed burst_size * test_duration_seconds
  const maxExpectedAllows = BURST_SIZE * durationSec;
  if (allows > maxExpectedAllows * 1.05) {
    console.error(`FAIL: too many ALLOWs (${allows} > ${maxExpectedAllows} + 5% tolerance) — double-spend detected`);
  } else {
    console.log(`PASS: ALLOW count within expected range (no double-spend)`);
  }

  return {};
}
