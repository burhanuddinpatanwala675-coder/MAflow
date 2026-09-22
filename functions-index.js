/**
 * Automated backups — scheduled Cloud Function.
 *
 * This is NOT deployed automatically. It requires:
 *   1. A Firebase project on the Blaze (pay-as-you-go) plan — scheduled
 *      functions require billing enabled even if usage stays in the free tier.
 *   2. `firebase deploy --only functions` run from a project that has this
 *      file under functions/index.js and functions/package.json configured
 *      with "firebase-admin" and "firebase-functions" as dependencies.
 *   3. The default Cloud Storage bucket enabled for the project (created
 *      automatically the first time you use Storage in the Firebase Console).
 *
 * What it does:
 *   - Runs once a day (03:00 UTC — adjust to your users' quiet hours).
 *   - For every company, exports each of its collections to a single JSON
 *     file in Cloud Storage at:
 *         backups/{companyId}/{YYYY-MM-DD}.json
 *   - Writes a small record to companies/{companyId}/backups/{date} so the
 *     app can show "Last automatic backup: <date>" without needing Storage
 *     access from the client.
 *   - Keeps the last 30 daily backups per company and deletes older ones,
 *     so storage cost doesn't grow unbounded.
 *
 * This uses the Admin SDK, which bypasses firestore.rules entirely — that's
 * expected and safe here because this code only ever runs on Google's
 * trusted Cloud Functions infrastructure, never in a user's browser.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();
const bucket = admin.storage().bucket();

const BUSINESS_COLLECTIONS = [
  'quotations', 'challans', 'invoices', 'salestaxinvoices', 'commercialbills',
  'purchases', 'customers', 'suppliers', 'products', 'payments', 'expenses',
  'bankaccounts', 'settings'
];
const RETENTION_DAYS = 30;

exports.dailyCompanyBackup = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('0 3 * * *') // 03:00 UTC daily — adjust for your user base's timezone
  .timeZone('UTC')
  .onRun(async () => {
    const companiesSnap = await db.collection('companies').get();
    const today = new Date().toISOString().slice(0, 10);

    const results = await Promise.allSettled(
      companiesSnap.docs.map((companyDoc) => backupOneCompany(companyDoc.id, today))
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      console.error(`${failed.length} company backups failed:`, failed.map((f) => f.reason));
    }
    console.log(`Backup run complete: ${results.length - failed.length}/${results.length} companies succeeded.`);
    return null;
  });

async function backupOneCompany(companyId, dateStr) {
  const backup = { companyId, exportedAt: new Date().toISOString(), data: {} };

  for (const col of BUSINESS_COLLECTIONS) {
    const snap = await db.collection('companies').doc(companyId).collection(col).get();
    backup.data[col] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  const filePath = `backups/${companyId}/${dateStr}.json`;
  const file = bucket.file(filePath);
  await file.save(JSON.stringify(backup), { contentType: 'application/json' });

  // Small metadata record the app can read (see firestore.rules: read-only for owner/admin).
  await db
    .collection('companies').doc(companyId)
    .collection('backups').doc(dateStr)
    .set({
      date: dateStr,
      storagePath: filePath,
      sizeBytes: Buffer.byteLength(JSON.stringify(backup)),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  await pruneOldBackups(companyId);
}

async function pruneOldBackups(companyId) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const oldSnap = await db
    .collection('companies').doc(companyId)
    .collection('backups')
    .where('date', '<', cutoffStr)
    .get();

  await Promise.all(
    oldSnap.docs.map(async (d) => {
      const { storagePath } = d.data();
      if (storagePath) {
        await bucket.file(storagePath).delete({ ignoreNotFound: true });
      }
      await d.ref.delete();
    })
  );
}

/**
 * Optional callable function so an owner/admin can trigger an on-demand
 * backup from the app instead of waiting for the nightly run. Wire this up
 * client-side with httpsCallable(functions, 'requestBackupNow') if wanted —
 * not called from index.html yet.
 */
exports.requestBackupNow = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  }
  const companyId = data && data.companyId;
  if (!companyId) {
    throw new functions.https.HttpsError('invalid-argument', 'companyId is required.');
  }
  const memberDoc = await db
    .collection('companies').doc(companyId)
    .collection('members').doc(context.auth.uid)
    .get();
  if (!memberDoc.exists || !['owner', 'admin'].includes(memberDoc.data().role)) {
    throw new functions.https.HttpsError('permission-denied', 'Owner/Admin only.');
  }
  const today = new Date().toISOString().slice(0, 10);
  await backupOneCompany(companyId, today + '-manual');
  return { ok: true, date: today };
});
