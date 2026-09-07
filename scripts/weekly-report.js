#!/usr/bin/env node
/**
 * Entry point run by GitHub Actions (.github/workflows/weekly-report.yml)
 * every Monday morning. Builds the weekly_reports/{weekId} summary document
 * that the dashboard's Analytics tab reads.
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

const {buildWeeklyReport} = require("./lib");

buildWeeklyReport()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal error running weekly-report:", err);
      process.exit(1);
    });
