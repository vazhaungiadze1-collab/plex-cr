/**
 * PLEX — competitor USD <-> USDT rate-tracking logic, shared by the two
 * entry-point scripts (update-rates.js, weekly-report.js) that GitHub
 * Actions runs on a schedule.
 *
 * This is the same logic that used to live in a Firebase Cloud Function, but
 * moved here so the whole project can stay on Firebase's free Spark plan.
 * Cloud Functions' outbound internet access (needed to call each company's
 * site) requires the paid Blaze plan; a GitHub Actions runner is just a
 * normal Linux machine with full internet access, so no Firebase upgrade is
 * needed — only Firestore (free) and Hosting (free) are used on the Firebase
 * side, and this script writes into Firestore using a service-account key
 * (Admin SDK), the same way the Cloud Function used to.
 *
 * IMPORTANT: none of the endpoints below are official public APIs — they are
 * the internal endpoints each company's own website calculator calls. They
 * can change or start blocking us at any time without notice. Every fetch is
 * wrapped so one company's failure never blocks the others, and failures are
 * written to Firestore (lastError) so the dashboard can show a stale/error
 * badge instead of silently going quiet.
 *
 * Requires initializeApp() (from firebase-admin/app) to have already been
 * called by the entry-point script before this file is required.
 */

const {getFirestore, FieldValue, Timestamp} = require("firebase-admin/firestore");

const db = getFirestore();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 PLEX-RateBot/1.0";

const FETCH_TIMEOUT_MS = 15000;
const RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1000, 3000, 6000, 12000]; // between attempts 1->2, 2->3, 3->4, 4->5 — wider spread gives a short-lived block (e.g. Cloudflare rate-limit) more room to clear within one run

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One HTTP attempt: JSON GET with a timeout and a browser-like UA/Referer. */
async function fetchJsonOnce(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        ...(referer ? {"Referer": referer} : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * JSON GET with automatic retries. A single flaky request (timeout, 502 from
 * the target site, a brief network hiccup) should not mark a whole company as
 * failed for the run — most of these sites occasionally blip under load.
 *
 * `validate`, when given, is called with the parsed JSON on every attempt and
 * should return an error-message string if the shape is wrong, or a falsy
 * value if it looks good. This matters because a request that a site's
 * anti-bot/rate-limit layer intercepts often still comes back as HTTP 200
 * with valid-but-different JSON (not a thrown network error), so without this
 * the retry loop above would never see it as a failure worth retrying — the
 * caller would only find out after already giving up. Folding validation
 * into the same retry loop means a transient block gets the same
 * retry+backoff chance to clear as an ordinary network hiccup.
 */
async function fetchJson(url, referer, validate) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const json = await fetchJsonOnce(url, referer);
      if (validate) {
        const validationError = validate(json);
        if (validationError) throw new Error(validationError);
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_DELAYS_MS[attempt] || 2000);
      }
    }
  }
  throw lastErr;
}

/**
 * Werty / GeCrypto / Alltrust / Bitcasa all run on the same white-label
 * "exchanger" platform, exposing:
 *   GET {base}/service/api/v1/public/exchanger/route/get/one/?id={routeId}
 * which returns { data: { route: { rate: { rateFullNumber, ... }, from, to } } }
 * where rateFullNumber = how many units of `from` currency equal 1 unit of
 * `to` currency — i.e. exactly the number the site's own calculator shows.
 */
async function fetchExchangerPlatformRate(base, routeId) {
  const url =
    `${base}/service/api/v1/public/exchanger/route/get/one/?id=${routeId}&lang=en`;
  const json = await fetchJson(url, base + "/", (j) => {
    const rate = j && j.data && j.data.route && j.data.route.rate;
    const looksValid = rate && (rate.rateFullNumber !== undefined || rate.in !== undefined);
    return looksValid ? null : `unexpected response shape for routeId=${routeId}`;
  });
  const rate = json.data.route.rate;
  return Number(rate.rateFullNumber !== undefined ? rate.rateFullNumber : rate.in);
}

/**
 * Companies and how to compute today's rates for each.
 *
 * usdToUsdtRate = USD needed to receive 1 USDT (client BUYS USDT with cash)
 * usdtToUsdRate = USDT needed to receive 1 USD (client SELLS USDT for cash)
 *
 * Both are expressed the same way every site displays them ("X <from> = 1
 * <to>"), so the dashboard can show them directly without further math.
 */
const COMPANIES = {
  werty: {
    label: "Werty",
    website: "https://werty.tech",
    async fetchRates() {
      const base = "https://werty.tech";
      const usdtToUsdRate = await fetchExchangerPlatformRate(
          base, "6580ad77a8cd1684a53a1c0f"); // USDT -> Cash USD
      const usdToUsdtRate = await fetchExchangerPlatformRate(
          base, "6580a9c383e050ce5371edb5"); // Cash USD -> USDT
      return {usdToUsdtRate, usdtToUsdRate};
    },
  },
  gecrypto: {
    label: "GeCrypto",
    website: "https://gecrypto.com",
    async fetchRates() {
      const base = "https://gecrypto.com";
      const usdtToUsdRate = await fetchExchangerPlatformRate(
          base, "69d40aa5c79a06b18465d8f7"); // USDT -> Cash USD Tbilisi
      const usdToUsdtRate = await fetchExchangerPlatformRate(
          base, "69d4065dc79a06b18465cf1b"); // Cash USD Tbilisi -> USDT
      return {usdToUsdtRate, usdtToUsdRate};
    },
  },
  alltrust: {
    label: "Alltrust",
    website: "https://alltrust.me",
    async fetchRates() {
      const base = "https://alltrust.me";
      const usdToUsdtRate = await fetchExchangerPlatformRate(
          base, "650ea14bc854282201557564"); // Cash USD (Tbilisi Center) -> USDT
      const usdtToUsdRate = await fetchExchangerPlatformRate(
          base, "650ea4394757be4abd70e687"); // USDT -> Cash USD (Tbilisi Center)
      return {usdToUsdtRate, usdtToUsdRate};
    },
  },
  bitcasa: {
    label: "Bitcasa",
    website: "https://www.bitcasa.ge",
    async fetchRates() {
      const base = "https://www.bitcasa.ge";
      const usdtToUsdRate = await fetchExchangerPlatformRate(
          base, "691613f6af2d55619a88560b"); // USDT -> Cash USD Tbilisi
      const usdToUsdtRate = await fetchExchangerPlatformRate(
          base, "690def144a317862d02bb453"); // Cash USD Tbilisi -> USDT
      return {usdToUsdtRate, usdtToUsdRate};
    },
  },
  gauscrypto: {
    label: "Gaus Crypto",
    website: "https://gauscrypto.com",
    async fetchRates() {
      const base = "https://gauscrypto.com";
      // operations/{giveCurrencyId}/{receiveCurrencyId}; 1 = USDT TRC20, 2 = US Dollar.
      const validateCourse = (j) =>
        (j && j.attributes && j.attributes.course && j.attributes.course.rate)
          ? null
          : "unexpected response shape from gauscrypto rates API";
      const sellJson = await fetchJson(
          `${base}/apis/client-api/v1/rates/operations/1/2`, base + "/", validateCourse); // give USDT, receive USD
      const buyJson = await fetchJson(
          `${base}/apis/client-api/v1/rates/operations/2/1`, base + "/", validateCourse); // give USD, receive USDT
      const sellRaw = Number(sellJson.attributes.course.rate);
      const buyRaw = Number(buyJson.attributes.course.rate);
      if (!sellRaw || !buyRaw) {
        throw new Error("unexpected response shape from gauscrypto rates API");
      }
      // Gaus Crypto's `rate` is "received per 1 given" (inverse of the other
      // sites' convention), so invert it to match "X from = 1 to".
      return {
        usdtToUsdRate: 1 / sellRaw,
        usdToUsdtRate: 1 / buyRaw,
      };
    },
  },
  stellex: {
    label: "Stellex",
    website: "https://stellex.ge",
    type: "fee_only",
    async fetchRates() {
      // Stellex does not publish a fixed USD/USDT print rate — it prices off
      // the live market rate plus a fee tier. We record the fee schedule
      // instead of a single number; the dashboard renders it as a small
      // table rather than two rate figures.
      const base = "https://www.stellex.ge";
      const json = await fetchJson(`${base}/api/rates`, base + "/");
      return {feeTiers: json};
    },
  },
  // PLEX's own live rate (not a competitor) — runs on the same white-label
  // "exchanger" platform as Werty/GeCrypto/Alltrust/Bitcasa, so it's fetched
  // the same way. `isSelf: true` lets the dashboard highlight this card and
  // exclude it from "cheapest competitor" / calculator-vs-competitors math.
  plex: {
    label: "PLEX",
    website: "https://www.platformaex.com",
    isSelf: true,
    async fetchRates() {
      const base = "https://www.platformaex.com";
      const usdtToUsdRate = await fetchExchangerPlatformRate(
          base, "69de86a1d7e71417c034d447"); // USDT TRC20 -> Cash USD (Tbilisi, Chavchavadze 37G)
      const usdToUsdtRate = await fetchExchangerPlatformRate(
          base, "69de8426c8f05e2a624aa064"); // Cash USD (Tbilisi, Chavchavadze 37G) -> USDT TRC20
      return {usdToUsdtRate, usdtToUsdRate};
    },
  },
};

const RATE_FIELDS = ["usdToUsdtRate", "usdtToUsdRate"];

/**
 * Compares the newly-fetched rates against whatever is currently stored and
 * writes one document per changed field to rates/{key}/changes. This is the
 * data the Analytics tab and the weekly report are built on — without it we
 * would only ever know "the current number", never "how often it moves" or
 * "how big the moves are".
 */
async function logChanges(ref, cfg, previousData, newData) {
  const changesCol = ref.collection("changes");
  const batch = db.batch();
  let any = false;

  if (cfg.type === "fee_only") {
    const prevJson = previousData && JSON.stringify(previousData.feeTiers || null);
    const newJson = JSON.stringify(newData.feeTiers || null);
    if (previousData && prevJson !== newJson) {
      batch.set(changesCol.doc(), {
        field: "feeTiers",
        changedAt: FieldValue.serverTimestamp(),
      });
      any = true;
    }
  } else {
    for (const field of RATE_FIELDS) {
      const prevVal = previousData && previousData[field];
      const newVal = newData[field];
      if (
        typeof prevVal === "number" && typeof newVal === "number" &&
        prevVal !== newVal
      ) {
        const diff = newVal - prevVal;
        batch.set(changesCol.doc(), {
          field,
          previousValue: prevVal,
          newValue: newVal,
          diff,
          diffPercent: (diff / prevVal) * 100,
          direction: diff > 0 ? "up" : "down",
          changedAt: FieldValue.serverTimestamp(),
        });
        any = true;
      }
    }
  }

  if (any) {
    await batch.commit();
  }
}

async function updateCompany(key, cfg) {
  const ref = db.collection("rates").doc(key);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  try {
    const prevSnap = await ref.get();
    const previousData = prevSnap.exists ? prevSnap.data() : null;
    const data = await cfg.fetchRates();
    await ref.set({
      label: cfg.label,
      website: cfg.website,
      type: cfg.type || "rate",
      isSelf: !!cfg.isSelf,
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
      lastSuccessAt: FieldValue.serverTimestamp(),
      lastError: null,
      consecutiveFailures: 0,
    }, {merge: true});
    await ref.collection("history").doc(today).set({
      ...data,
      capturedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
    // Only log changes against a rate we actually had before (skip the very
    // first fetch ever, which would otherwise look like "first change").
    if (previousData) {
      await logChanges(ref, cfg, previousData, data);
    }
    console.log(`[${key}] updated`, data);
    return {key, ok: true};
  } catch (err) {
    console.error(`[${key}] failed: ${err.message}`);
    // Read the previous failure count so the dashboard can distinguish "one
    // blip, still has a fresh number from a few hours ago" from "three
    // scheduled runs in a row have failed, this needs a look."
    const prev = await ref.get();
    const consecutiveFailures = ((prev.exists && prev.data().consecutiveFailures) || 0) + 1;
    await ref.set({
      label: cfg.label,
      website: cfg.website,
      type: cfg.type || "rate",
      isSelf: !!cfg.isSelf,
      lastAttemptAt: FieldValue.serverTimestamp(),
      lastError: err.message,
      consecutiveFailures,
    }, {merge: true});
    return {key, ok: false, error: err.message, consecutiveFailures};
  }
}

async function updateAll() {
  const results = [];
  for (const [key, cfg] of Object.entries(COMPANIES)) {
    // Sequential on purpose — gentle on each site, and easier to read logs.
    results.push(await updateCompany(key, cfg));
  }
  return results;
}

/** ISO-ish week id, e.g. "2026-W36". Just needs to sort chronologically. */
function weekId(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
      ((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function computeCompanyWeeklyStats(key, cfg, periodStartTs) {
  const changesSnap = await db
      .collection("rates").doc(key).collection("changes")
      .where("changedAt", ">=", periodStartTs)
      .get();

  if (cfg.type === "fee_only") {
    return {label: cfg.label, type: "fee_only", changeCount: changesSnap.size};
  }

  const perField = {usdToUsdtRate: [], usdtToUsdRate: []};
  changesSnap.forEach((doc) => {
    const d = doc.data();
    if (perField[d.field]) perField[d.field].push(d.diffPercent);
  });

  const summarizeField = (values) => {
    if (!values.length) return {count: 0, netPercent: 0, avgAbsPercent: 0, maxAbsPercent: 0};
    const net = values.reduce((a, b) => a + b, 0);
    const avgAbs = values.reduce((a, b) => a + Math.abs(b), 0) / values.length;
    const maxAbs = Math.max(...values.map(Math.abs));
    return {count: values.length, netPercent: net, avgAbsPercent: avgAbs, maxAbsPercent: maxAbs};
  };

  const buy = summarizeField(perField.usdToUsdtRate);
  const sell = summarizeField(perField.usdtToUsdRate);

  return {
    label: cfg.label,
    type: "rate",
    changeCount: buy.count + sell.count,
    buy,
    sell,
  };
}

async function buildWeeklyReport() {
  const now = new Date();
  const periodStart = new Date(now.getTime() - 7 * 86400000);
  const periodStartTs = Timestamp.fromDate(periodStart);

  const companies = {};
  for (const [key, cfg] of Object.entries(COMPANIES)) {
    companies[key] = await computeCompanyWeeklyStats(key, cfg, periodStartTs);
  }

  const rateCompanies = Object.entries(companies).filter(([, c]) => c.type === "rate");
  let mostActive = null;
  let mostStable = null;
  for (const [key, c] of rateCompanies) {
    if (!mostActive || c.changeCount > companies[mostActive].changeCount) mostActive = key;
    if (!mostStable || c.changeCount < companies[mostStable].changeCount) mostStable = key;
  }

  const totalChanges = rateCompanies.reduce((sum, [, c]) => sum + c.changeCount, 0);
  const summaryParts = [
    `Over the last 7 days, the tracked companies changed their USD/USDT rates ${totalChanges} time(s) in total.`,
  ];
  if (mostActive && companies[mostActive].changeCount > 0) {
    summaryParts.push(
        `${companies[mostActive].label} was the most active, with ${companies[mostActive].changeCount} change(s).`,
    );
  }
  if (mostStable && mostStable !== mostActive) {
    summaryParts.push(
        `${companies[mostStable].label} was the most stable, with ${companies[mostStable].changeCount} change(s).`,
    );
  }

  const report = {
    generatedAt: FieldValue.serverTimestamp(),
    periodStart: periodStart.toISOString(),
    periodEnd: now.toISOString(),
    companies,
    mostActive,
    mostStable,
    totalChanges,
    summary: summaryParts.join(" "),
  };

  const id = weekId(now);
  await db.collection("weekly_reports").doc(id).set(report, {merge: true});
  console.log(`weekly report ${id} generated`, {totalChanges, mostActive, mostStable});
  return {id, ...report};
}

module.exports = {COMPANIES, updateAll, updateCompany, buildWeeklyReport, weekId};
