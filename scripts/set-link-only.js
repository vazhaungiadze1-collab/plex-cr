/**
 * One-off maintenance helper: converts a company's dashboard card into a
 * simple "visit the website" link-out card. Clears its tracked rate data
 * and history/changes subcollections in Firestore, and marks the doc
 * `type: "link_only"` so the dashboard renders it without live Buy/Sell
 * numbers or a Live/Stale/Error badge -- instead showing just its logo and
 * social links, with the whole card clickable through to the site.
 *
 * Use this for a company whose rates we can no longer fetch automatically
 * (e.g. permanently blocked at the IP level) but that should still appear
 * on the dashboard, rather than removing them entirely.
 *
 * IMPORTANT: also remove the company from COMPANIES in scripts/lib.js (or
 * make sure it's already absent) -- otherwise the next scheduled run will
 * just refetch and overwrite this back to a normal rate card.
 *
 * Usage: node set-link-only.js <company-key>
 */
const {initializeApp, cert} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({credential: cert(serviceAccount)});
const db = getFirestore();

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error("Usage: node set-link-only.js <company-key>");
    process.exit(1);
  }

  const docRef = db.collection("rates").doc(key);
  const doc = await docRef.get();
  if (!doc.exists) {
    console.error(`No Firestore doc found at rates/${key} -- nothing to convert.`);
    process.exit(1);
  }
  const existing = doc.data();

  for (const sub of ["history", "changes"]) {
    const subRef = docRef.collection(sub);
    await db.recursiveDelete(subRef);
    console.log(`Cleared rates/${key}/${sub}`);
  }

  // .set() without {merge: true} fully replaces the doc, so old fields
  // like usdToUsdtRate/usdtToUsdRate/lastError/consecutiveFailures/
  // updatedAt are dropped rather than just zeroed out.
  await docRef.set({
    label: existing.label || key,
    website: existing.website || null,
    type: "link_only",
  });
  console.log(`Set rates/${key} to link_only mode (rate data and history cleared).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
