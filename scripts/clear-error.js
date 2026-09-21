/**
 * One-off maintenance helper: clears the stored lastError/consecutiveFailures
 * for one company in Firestore, so the dashboard stops showing the red
 * "Error" badge for it. Does NOT fix whatever was actually failing -- if the
 * site is still blocking us, the badge will just start climbing again on the
 * next scheduled run. Run manually from the "Clear error badge" workflow in
 * the Actions tab.
 *
 * Usage: node clear-error.js <company-key>
 */
const {initializeApp, cert} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({credential: cert(serviceAccount)});
const db = getFirestore();

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error("Usage: node clear-error.js <company-key>");
    process.exit(1);
  }
  await db.collection("rates").doc(key).set({
    lastError: null,
    consecutiveFailures: 0,
  }, {merge: true});
  console.log(`Cleared error state for ${key}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

