#!/usr/bin/env node
/**
 * seed-load-test-data.js
 *
 * Creates N fake companies, each with a realistic spread of records, against
 * a REAL Firebase project (never run this against production — point it at
 * a disposable test project). Used to answer the review's question honestly:
 * "how does this actually perform with 10,000 companies / millions of
 * records?" — you can't know that without data like this actually loaded.
 *
 * This uses the Admin SDK (bypasses security rules entirely, which is
 * correct for seeding — you're not testing rules here, you're testing query
 * performance under realistic volume).
 *
 * Setup:
 *   npm install --save-dev firebase-admin
 *   Download a service account key for your TEST project from
 *   Firebase Console → Project Settings → Service Accounts → Generate key
 *   Save it as ./service-account-test.json (gitignore this file!)
 *
 * Usage:
 *   node seed-load-test-data.js --companies=100 --recordsPerCompany=500
 *   node seed-load-test-data.js --companies=1000 --recordsPerCompany=1000
 *   node seed-load-test-data.js --companies=10000 --recordsPerCompany=200
 *
 * Recommended progression (per the review): run 100 -> 500 -> 1000 -> 10000
 * companies, checking dashboard/search/list load times at each step before
 * moving to the next order of magnitude.
 */

const admin = require('firebase-admin');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const NUM_COMPANIES = parseInt(args.companies || '100', 10);
const RECORDS_PER_COMPANY = parseInt(args.recordsPerCompany || '500', 10);
const BATCH_SIZE = 400; // Firestore batch writes cap at 500 ops; stay under with room for safety

const serviceAccountPath = path.join(__dirname, 'service-account-test.json');
let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (e) {
  console.error(`Missing ${serviceAccountPath} — download a service account key for your TEST project first. See the header comment in this file.`);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const PRODUCT_NAMES = ['Pesticide Spray', 'Fire Pipe', 'Safety Gloves', 'Steel Rod', 'Cement Bag', 'Paint Bucket', 'Cable Reel', 'Water Pump', 'Solar Panel', 'LED Bulb'];
const CUSTOMER_NAMES = ['Al-Noor Traders', 'City Hardware', 'Prime Suppliers', 'Metro Enterprises', 'Star Industries', 'Gulf Trading Co', 'National Builders', 'Faisal & Sons'];
const STATUSES = ['pending', 'approved', 'paid', 'draft'];

function randOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randId() { return Math.random().toString(36).slice(2, 10); }
function isoNow(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString();
}

async function commitBatchesOf(items, buildDoc) {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = db.batch();
    items.slice(i, i + BATCH_SIZE).forEach((item) => {
      const { ref, data } = buildDoc(item);
      batch.set(ref, data);
    });
    await batch.commit();
  }
}

async function seedOneCompany(index) {
  const companyId = `loadtest-company-${index}-${randId()}`;
  const ownerUid = `loadtest-owner-${index}`;

  await db.doc(`companies/${companyId}`).set({
    id: companyId, name: `Load Test Co ${index}`, ownerUid,
    plan: 'trial', status: 'active', trialEndsAt: isoNow(-9999), createdAt: isoNow(30),
  });
  await db.doc(`companies/${companyId}/members/${ownerUid}`).set({
    uid: ownerUid, name: 'Load Test Owner', email: `owner${index}@loadtest.com`, role: 'owner', status: 'active',
  });

  // Products & customers (small, bounded — realistic counts, not scaled with recordsPerCompany)
  const products = Array.from({ length: 50 }, (_, i) => ({ i }));
  await commitBatchesOf(products, ({ i }) => ({
    ref: db.doc(`companies/${companyId}/products/prod-${i}`),
    data: { id: `prod-${i}`, name: `${randOf(PRODUCT_NAMES)} ${i}`, unit: 'Nos', saleRate: 100 + i * 10, purchaseRate: 80 + i * 8, stock: 100, minStock: 10, updatedAt: isoNow() },
  }));

  const customers = Array.from({ length: 30 }, (_, i) => ({ i }));
  await commitBatchesOf(customers, ({ i }) => ({
    ref: db.doc(`companies/${companyId}/customers/cust-${i}`),
    data: { id: `cust-${i}`, name: `${randOf(CUSTOMER_NAMES)} ${i}`, phone: '0300-0000000', balance: 0, updatedAt: isoNow() },
  }));

  // The actual growth collections — this is what pagination is tested against.
  const docs = Array.from({ length: RECORDS_PER_COMPANY }, (_, i) => ({ i }));
  const collections = ['quotations', 'challans', 'invoices', 'payments'];
  for (const col of collections) {
    await commitBatchesOf(docs, ({ i }) => ({
      ref: db.doc(`companies/${companyId}/${col}/${col}-${i}`),
      data: {
        id: `${col}-${i}`, number: `AL-${1000 + i}-26`, date: isoNow(Math.floor(Math.random() * 365)),
        customerName: randOf(CUSTOMER_NAMES), total: Math.round(Math.random() * 100000) / 100,
        status: randOf(STATUSES), updatedAt: isoNow(Math.floor(Math.random() * 365)),
      },
    }));
  }

  return companyId;
}

async function main() {
  console.log(`Seeding ${NUM_COMPANIES} companies x ${RECORDS_PER_COMPANY} records/collection x 4 collections...`);
  const start = Date.now();
  const CONCURRENCY = 5; // don't hammer the project — seed a few companies at a time
  const ids = [];

  for (let i = 0; i < NUM_COMPANIES; i += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, NUM_COMPANIES - i) }, (_, j) => i + j);
    const results = await Promise.all(batch.map((idx) => seedOneCompany(idx)));
    ids.push(...results);
    console.log(`  ...${ids.length}/${NUM_COMPANIES} companies seeded (${((Date.now() - start) / 1000).toFixed(0)}s elapsed)`);
  }

  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(0)}s.`);
  console.log(`Sample company IDs to test against manually:`, ids.slice(0, 3));
  console.log(`Total est. documents written: ~${NUM_COMPANIES * (50 + 30 + RECORDS_PER_COMPANY * 4)}`);
  console.log(`Remember to delete this test data afterwards — it costs storage/reads if left in place.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
