# Load & Performance Test Plan

This is the "not just feel, real numbers" step from the review. It's a
procedure + scripts, not results — nobody can honestly hand you performance
numbers without running them against a real deployed project with real data
volume, which this sandbox can't do (no network access to Firebase from
here). Run this yourselves before trusting any performance claim, including
mine.

## What to measure

For each of these, record actual milliseconds, not a feeling:

| Operation | Where in the app | Target |
|---|---|---|
| Login → Dashboard visible | boot() → launchApp() → first paint | < 2s on a normal connection, < 1s ideally |
| Open Quotations list (200 most recent) | docList('Quotation') | < 1s |
| "Load older records" click | loadMoreCol() | < 1s |
| Search within a loaded list | filterTable() (client-side, already-loaded data) | near-instant (<100ms) — it's an in-memory filter, not a query |
| Save a new invoice | saveForm() → fbSave() | < 1s to see the success toast |
| Print/PDF generation | buildPrint() / browser print dialog | < 2s to render the print preview |
| Switch between nav tabs | go() → renderApp() | should feel instant — this is pure re-render of already-loaded data, no network call |

## Test procedure

### Step 1 — seed realistic data
Use `seed-load-test-data.js` against a **disposable test Firebase project**
(never production). Run the progression the review recommended:

```bash
node seed-load-test-data.js --companies=100  --recordsPerCompany=500
# measure the table above, using one of the seeded company accounts

node seed-load-test-data.js --companies=500  --recordsPerCompany=500
# measure again

node seed-load-test-data.js --companies=1000 --recordsPerCompany=1000
# measure again

node seed-load-test-data.js --companies=10000 --recordsPerCompany=200
# measure again
```

Because every company's data lives under its own `companies/{companyId}/...`
path, **a single company's experience should not degrade as the *total*
number of companies on the platform grows** — that's the entire point of the
per-tenant subcollection structure. What you're actually checking:
1. Does one company with a *lot* of its own data (many records) stay fast?
   (tests the pagination work)
2. Does the *platform* stay healthy with many companies total, even if each
   one only has a little data? (tests Firestore's general scaling, and
   whether any query anywhere accidentally scans across companies instead of
   staying scoped to one — it shouldn't, since every query in `index.html`
   is built from `colRef()`/`docRef()` which always includes the companyId
   in the path, but verify this directly in the Firebase Console's usage
   dashboard: reads should track with *active* companies, not total
   companies.)

### Step 2 — measure in the browser, not just by feel
Use Chrome DevTools → Network tab (filter to `firestore.googleapis.com`) and
Performance tab while doing each operation in the table above:
- Network tab: how many requests, how much data transferred, how long until
  the response completes.
- Performance tab → record while clicking "Load older records" or switching
  tabs: look for long tasks (>50ms) that would make the UI feel janky.
- Console: `performance.mark()` / `performance.measure()` around
  `launchApp()` and `renderApp()` if you want exact numbers logged, e.g.:
  ```js
  performance.mark('boot-start');
  // ...after launchApp() calls renderApp() the first time...
  performance.mark('boot-end');
  performance.measure('boot', 'boot-start', 'boot-end');
  console.log(performance.getEntriesByName('boot')[0].duration);
  ```

### Step 3 — concurrent users (k6)
`load-test.js` (k6 script, provided separately) simulates multiple users
hitting Firestore concurrently via the REST API, to check for contention
issues (unlikely with Firestore's architecture, but worth confirming rather
than assuming). Requires a real Firebase Auth ID token per simulated user —
see the script's header comment for how to generate test tokens.

```bash
# install k6: https://k6.io/docs/get-started/installation/
k6 run load-test.js
```

### Step 4 — read your Firebase billing/usage dashboard
This is the review's "cost, more than performance" point. After each seeding
run and each round of manual testing, check Firebase Console → Usage and
billing:
- Document reads — should scale with active usage, not sit high at idle.
- Whether the `limit(200)` pagination is actually capping reads the way it's
  supposed to (compare reads-per-dashboard-load before/after this pass — it
  should be visibly lower for companies with large record counts).

## Interpreting results

- If dashboard/list load times grow noticeably as *one company's own* record
  count grows past ~1000 in a collection, that means `loadMoreCol()` cursor
  pagination isn't actually being hit — check that the initial `limit(200)`
  listener isn't silently being bypassed somewhere.
- If load times grow as *total platform* company count grows (with each
  individual company's data volume held constant), that's a sign a query
  somewhere isn't properly scoped to `companies/{companyId}/...` — search
  `index.html` for any `collection(db, ...)` call that doesn't go through
  `colRef()`/`docRef()`.
- If Firestore read counts are much higher than expected for a simple
  dashboard load, check for any place `renderApp()` might be triggering a
  fresh `getDocs()` call instead of reading from the already-cached
  `STATE`/`window.DB` — see the "read-cost audit" notes for the pattern to
  look for (uncached loaders called from inside a render function run on
  every re-render, not just once).

## Clean-up
Delete all `loadtest-company-*` documents from the test project when done —
either via the Firebase Console (Firestore → filter by ID prefix) or a
short admin-SDK script using the same service account. Don't leave load-test
data in a project you're paying for.
