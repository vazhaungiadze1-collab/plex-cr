#!/usr/bin/env node
/**
 * Entry point run by GitHub Actions (.github/workflows/update-rates.yml)
 * three times a day. Refreshes all 6 companies' rates in Firestore.
 *
 * Requires a Firebase service-account key JSON in the FIREBASE_SERVICE_ACCOUNT
 * environment variable (set as a GitHub Actions secret — see README.md).
 */
const {initializeApp, cert} = require("firebase-admin/app");

const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!keyJson) {
  console.error(
      "Missing FIREBASE_SERVICE_ACCOUNT environment variable. " +
      "Set it as a GitHub Actions secret (see README.md) or export it " +
      "locally before running this script.",
  );
  process.exit(1);
}

initializeApp({credential: cert(JSON.parse(keyJson))});

const {updateAll} = require("./lib");

updateAll()
    .then((results) => {
      console.log(JSON.stringify(results, null, 2));
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        console.warn(`${failed.length} of ${results.length} companies failed this run.`);
      } else {
        console.log(`All ${results.length} companies updated successfully.`);
      }
      // Exit 0 even on partial failure — one flaky site shouldn't mark the
      // whole scheduled run red in GitHub's UI; the dashboard's own
      // Stale/Error badges are the right place to notice that.
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal error running update-rates:", err);
      process.exit(1);
    });
