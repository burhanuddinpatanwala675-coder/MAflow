# Multi-Tenant SaaS — Deployment Guide & Migration Status

This covers what changed in `index.html` in this pass, how to deploy it, and
what's still outstanding against the full master-prompt spec.

## Update: role/permission, performance, and observability pass

Following a cross-check review, four gaps were fixed in this pass:

### 1. Role system unified — legacy shared-PIN gate removed
The old `admin`/`viewer` toggle (shared password, default `1234`, unrelated to
who was actually signed in) is gone. Every permission check now reads the
signed-in user's **real** company role from
`companies/{companyId}/members/{uid}` — never from a client-editable field.
A per-role, per-module permission table (`ROLE_PERMS` in `index.html`,
`roleCanWrite()` in `firestore.rules` — kept in sync) now governs:

| Role | Can edit |
|---|---|
| Owner / Admin | Everything |
| Sales | Quotations, Challans, Invoices, Customers/Suppliers, Payments |
| Accounts | Invoices, Sales Tax, Commercial Bills, Purchases, Customers/Suppliers, Payments, Expenses, Bank, Ledger |
| Warehouse | Challans, Purchases, Products/Stock |
| Viewer | Nothing — read-only everywhere |

Deleting anything is still owner/admin-only, everywhere, matching the rules.
Nav tabs now hide themselves for roles that have no access to that module.

**Team management is now real**: Company Settings → Team lets an owner/admin
invite a teammate by email + role, see pending invites, change someone's
role, or remove them. The invited person uses "Have a company invite? Join
your team" on the login screen with the **Company Code** (shown in the Team
tab) + their email + a password they choose. No backend/Cloud Function is
needed for this — it's enforced entirely by `firestore.rules` (an invite doc
keyed by email, readable only by a matching authenticated email, consumed
exactly once to create the member doc with the *invite's* role, never a
self-chosen one).

### 2. Performance — real pagination, not a promise
The fast-growing transactional collections (quotations, challans, invoices,
sales tax invoices, commercial bills, purchases, payments, expenses) are now
loaded via a **capped live listener** (`limit(200)`, most recent first) instead
of loading the entire collection. A "Load older records" button uses a
cursor (`startAfter`) to fetch the next page on demand — a one-time read, not
a live listener, since history doesn't need to update in real time. Small,
bounded collections (products, customers, suppliers, bank accounts, settings)
are intentionally left as full live listeners, since the rest of the app
depends on having the complete list for autocomplete and dropdowns.

This directly addresses the "never load an entire collection" / "cursor-based
pagination" requirements — for real, not just in the rules.

### 3. Error logging
`window.onerror` and `unhandledrejection` are now caught globally and written
to `companies/{companyId}/errorlogs` (throttled client-side so a repeating
error can't flood writes). Owner/admin can see the last 50 errors — who hit
them, on which page, with what message — on the Audit page. This is a
self-hosted minimal version (no third-party APM service is reachable from
this build environment); swapping in Sentry or similar later is a drop-in
replacement for `logErrorToFirestore()`.

### 4. Audit log is no longer local-only
`addAudit()` still writes to the browser's `localStorage` (unchanged,
instant, no read required) **and** now mirrors every entry to
`companies/{companyId}/auditlogs` (best-effort, never blocks the UI on
failure). Owner/admin see a "Company-Wide Activity" section on the Audit page
pulling the last 100 entries across every device/user, not just the one
browser that performed the action.

### 5. Automated backups (code provided, not deployed)
`functions-index.js` (in this delivery, alongside `index.html` and
`firestore.rules`) is a scheduled Cloud Function that exports every company's
data to Cloud Storage nightly, keeps 30 days of history, prunes older ones,
and writes a small metadata record the app could surface as "last backup: …".
**This requires a Blaze-plan Firebase project and `firebase deploy --only
functions`** — it is not deployed automatically and this environment can't
deploy or test it. Treat it as a reviewed, ready-to-deploy starting point, not
a verified-in-production system. The existing manual Export/Import buttons in
the app still work independently of this and need no extra setup.

---

## Update: role sync, read-cost audit, and test tooling

Following the follow-up review, four more things were addressed:

### Single source of truth for role permissions
`ROLE_PERMS` (index.html) and `roleCanWrite()` (firestore.rules) were two
hand-maintained copies of the same table — exactly the drift risk the review
flagged. They're now **generated** from one file, `role-permissions.json`:

```bash
# after editing role-permissions.json:
node generate-rules.js          # regenerates both files in place
node generate-rules.js --check  # exits 1 if either file has drifted — wire into CI/pre-deploy
```

Running the generator for the first time against this codebase actually
**caught a real bug**: the hand-written rules let `warehouse` write to
`customers`/`suppliers`, but the UI's `ROLE_PERMS` only ever gave warehouse
*read* access there. The generated version (now shipped) is the corrected,
more restrictive one — this is exactly the kind of silent drift the
single-source-of-truth approach exists to prevent.

### Firebase read-cost audit
Reviewed every `onSnapshot`/`getDocs`/`getDoc` call site. Most were already
sound (listeners only bill for changed docs after the initial load; the
on-demand loaders for Team/Audit data are cache-guarded so they never re-fire
on re-render). One real gap fixed: the Team tab's member/invite lookups had
no `limit()` — added `limit(500)` defensively, even though team size is
naturally small.

### Firestore Rules test suite (written, not run here)
`firestore.rules.test.js` — uses `@firebase/rules-unit-testing` against the
local emulator. Covers tenant isolation, the full role matrix (including the
specific "warehouse can't approve invoices" / "sales can't edit settings"
cases from the original review), the invite-acceptance flow, trial-expiry
write-blocking, and the super-admin allowlist. **This was not executed** —
this sandbox has no network access to the emulator binaries. Run it with:

```bash
npm install --save-dev @firebase/rules-unit-testing mocha
firebase emulators:exec --only firestore "mocha firestore.rules.test.js --timeout 20000"
```

### Load testing tooling (written, not run here)
- `seed-load-test-data.js` — Admin SDK script to generate N fake companies
  with realistic record volumes against a **disposable test project**.
- `LOAD_TEST_PLAN.md` — what to measure, the 100 → 500 → 1,000 → 10,000
  company progression, how to read Chrome DevTools timings, and how to spot
  a mis-scoped query via the Firebase usage dashboard.
- `load-test.js` — a k6 script simulating concurrent users hitting the same
  paginated queries the app itself runs, to check for contention under load.

Same honesty note as the rules tests: written and syntax-checked, not run
against a live project — this environment can't reach Firebase's network.

---



- **Data model**: every business collection (`quotations`, `invoices`, `products`, etc.)
  now lives under `companies/{companyId}/{collection}/{docId}` instead of a flat
  top-level collection. This is what makes tenant isolation possible.
- **One shared Firebase project** for the whole platform, configured once by
  whoever deploys the app (see below) — not per company.
- **Company registration** (`Create your account` on the login screen): a new
  company signs up with name, owner, email/password, phone, country, currency,
  timezone, website, NTN, tax number, address. This creates:
  - `companies/{companyId}` — profile + `plan:'trial'`, `status:'trial'`, 14-day `trialEndsAt`
  - `companies/{companyId}/members/{uid}` — the signer-upper as `role:'owner'`
  - `users/{uid}` — a pointer doc so login knows which company to load
  - `companies/{companyId}/settings/branding` — pre-filled from the signup form
  - A verification email is sent automatically.
- **Login**: email/password, "Remember me" (persistent vs session-only), "Forgot
  password?" (sends a reset email).
- **Firestore Security Rules** (`firestore.rules`, provided separately) — this is
  what actually enforces isolation. A company can only read/write data under its
  own `companies/{companyId}/...` path; this is checked server-side, not just
  hidden in the UI.
- **Trial/subscription banner** on the dashboard, driven live from the company
  doc — shows days remaining, and an expired-trial notice once `trialEndsAt`
  has passed. Writes are blocked by the security rules once status leaves
  `trial`/`active`; **reads still work**, so no data is ever hidden or deleted
  on expiry.

## One-time deployment (you, the platform owner — not your customers)

1. Create **one** Firebase project for the whole platform (not per customer).
2. Firestore Database → Create Database → **Production mode**.
3. Authentication → Sign-in method → enable **Email/Password**.
4. Deploy `firestore.rules` (Firebase Console → Firestore → Rules → paste and
   Publish, or via CLI: `firebase deploy --only firestore:rules`).
5. Project Settings → General → Your apps → add a Web app → copy the config
   object.
6. Open `index.html`, find `SAAS_FIREBASE_CONFIG` near the top of the second
   `<script type="module">` block, and paste your real values in place of
   every `"REPLACE_ME"`.
7. Deploy the HTML file to your hosting of choice (Netlify, Firebase Hosting,
   etc.). Customers now hit **Register** directly — they never see Firebase or
   any setup screen.
8. (Optional, later) Deploy `functions-index.js` for automated backups — see
   section 5 above for prerequisites.

> For local testing before you've edited the source, the old wizard screen
> still works as a *developer-only* fallback — it stores its config in
> `localStorage` under `saas_fbcfg_dev` (separate from anything customer-facing).

## Known limitations to be aware of

- **Document numbering** (`AL-1234-26` style) is still generated from a
  per-browser `localStorage` counter with a same-session duplicate check
  against loaded data. Two people in the same company entering documents at
  literally the same moment on different devices could theoretically get
  colliding numbers. A robust fix needs a server-side counter (Cloud Function
  + transaction) — not built yet.
- **Company ID generation** at registration is client-side
  (`slugify(companyName) + uid.slice(0,6)`). Collisions are astronomically
  unlikely but not cryptographically impossible; the security rules do refuse
  to let a second signup overwrite an existing `companies/{companyId}` doc, so
  the worst case is a failed registration, not a data collision.
- **Ownership transfer isn't built.** The rules deliberately block anyone
  (including admins) from promoting someone to `owner` or editing the current
  owner's own member record — there's no UI flow yet for "transfer ownership."
  For now that needs a direct Firestore Console edit by you.
- **No live rule testing was performed** (see the cross-check response
  earlier in this conversation) — everything above was verified by careful
  manual tracing of the rules logic, not the Firebase emulator test suite.
  Run that yourself before production.

## Not done yet (still open against the master prompt)

- Super Admin portal (view/suspend/activate companies, approve payments,
  revenue stats, announcements).
- Manual payment submission + approval flow (EasyPaisa/Bank Transfer,
  transaction ID, screenshot, pending → approved, duplicate transaction-ID
  check).
- Expiry email reminders (7/3/1 day before, on expiry, after expiry) — needs
  a scheduled Cloud Function, since nothing runs unless a browser is open.
- Language system (English / Roman Urdu / Urdu) — no i18n layer exists; all
  UI strings are hardcoded English throughout every render function.
- Help system (WhatsApp/email support, FAQs, floating button with
  auto-attached context).
- Further performance work: image optimization, code splitting (this is a
  single monolithic HTML file by original design), avoiding unnecessary
  re-renders (the whole app re-renders on most state changes rather than
  patching the DOM).
- Duplicate/dead-code audit across the whole file.

## SaaS readiness (honest, not aspirational)

**Foundation: real, and now more complete.** Tenant isolation is enforced
server-side. Roles are real and per-user, not a shared password. The biggest
data-growth collections are paginated instead of loaded in full. Errors and
activity are visible server-side instead of vanishing into one person's
browser console. A reviewed (not yet deployed) automated-backup function
exists.

**Still not enterprise-scale.** No Super Admin portal, no payment/subscription
lifecycle beyond the trial banner, no i18n, no code-splitting, and the rules
have been traced carefully but not run against the Firebase emulator's actual
test suite. This is a solid, secure, reasonably fast multi-tenant
*foundation* — it is not yet a 10,000-company production platform.

