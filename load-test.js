/**
 * load-test.js — k6 script
 *
 * Simulates concurrent users each loading their own company's dashboard data
 * (the paginated quotations/invoices/etc. queries), to check for contention
 * or slowdown under concurrent load. Uses the Firestore REST API directly
 * since k6 doesn't speak the Firestore SDK's gRPC/WebChannel protocol.
 *
 * SETUP — you need real ID tokens for real test users in your test project:
 *   1. Seed test data first: node seed-load-test-data.js --companies=50 ...
 *   2. For each seeded company's owner uid, mint a custom token with the
 *      Admin SDK, then exchange it for an ID token (a short script — see
 *      `mint-test-tokens.js` you'd write alongside this, using
 *      admin.auth().createCustomToken(uid) then the Identity Toolkit REST
 *      API's signInWithCustomToken endpoint to get a real ID token).
 *   3. Save the resulting tokens + companyIds as `test-tokens.json`:
 *        [{ "companyId": "loadtest-company-0-abc123", "idToken": "eyJ..." }, ...]
 *   4. Set PROJECT_ID as an environment variable.
 *
 * Run:
 *   PROJECT_ID=your-test-project-id k6 run load-test.js
 *
 * This script was written but not executed in the environment that produced
 * it — no network access to run k6 or reach Firebase from there. Run it
 * yourselves; treat this as a correct starting point, not a verified result.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const PROJECT_ID = __ENV.PROJECT_ID;
if (!PROJECT_ID) {
  throw new Error('Set PROJECT_ID env var, e.g. PROJECT_ID=my-test-project k6 run load-test.js');
}

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('./test-tokens.json'));
});

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

export const options = {
  scenarios: {
    ramping_users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },   // ramp to 20 concurrent "users"
        { duration: '1m', target: 20 },    // hold at 20
        { duration: '30s', target: 100 },  // spike to 100 concurrent
        { duration: '1m', target: 100 },   // hold at 100
        { duration: '30s', target: 0 },    // ramp down
      ],
    },
  },
  thresholds: {
    // These are starting targets, not guarantees — tune based on what you
    // actually observe, then tighten them as real acceptance criteria.
    http_req_duration: ['p(95)<1500', 'p(99)<3000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const account = tokens[Math.floor(Math.random() * tokens.length)];
  const headers = { Authorization: `Bearer ${account.idToken}` };

  // 1) Dashboard-equivalent: read the company doc (subscription/branding).
  let res = http.get(`${BASE}/companies/${account.companyId}`, { headers });
  check(res, { 'company doc: status 200': (r) => r.status === 200 });

  sleep(0.3);

  // 2) Quotations list — the paginated query the app actually runs
  //    (structuredQuery via :runQuery, matching orderBy + limit).
  const runQueryUrl = `${BASE}:runQuery`;
  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'quotations' }],
      orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'DESCENDING' }],
      limit: 200,
    },
    parent: `projects/${PROJECT_ID}/databases/(default)/documents/companies/${account.companyId}`,
  });
  res = http.post(runQueryUrl, body, { headers: { ...headers, 'Content-Type': 'application/json' } });
  check(res, { 'quotations query: status 200': (r) => r.status === 200 });

  sleep(0.3);

  // 3) Products list (small, unbounded collection — should still be fast).
  res = http.get(`${BASE}/companies/${account.companyId}/products?pageSize=300`, { headers });
  check(res, { 'products list: status 200': (r) => r.status === 200 });

  sleep(1);
}
