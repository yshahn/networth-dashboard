const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} = require("plaid");

admin.initializeApp();
const db = admin.firestore();

// Secrets — set these with:
//   firebase functions:secrets:set PLAID_CLIENT_ID
//   firebase functions:secrets:set PLAID_SECRET
//   firebase functions:secrets:set PLAID_ENV   (sandbox | development | production)
const PLAID_CLIENT_ID = defineSecret("PLAID_CLIENT_ID");
const PLAID_SECRET = defineSecret("PLAID_SECRET");
const PLAID_ENV = defineSecret("PLAID_ENV");
const APILLOW_API_KEY = defineSecret("APILLOW_API_KEY");

const SECRETS = [PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV];

function getPlaidClient() {
  const env = PLAID_ENV.value() || "sandbox";
  const configuration = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID.value(),
        "PLAID-SECRET": PLAID_SECRET.value(),
      },
    },
  });
  return new PlaidApi(configuration);
}

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  return request.auth.uid;
}

/**
 * 1) Frontend calls this first to get a link_token, which is used to
 *    open Plaid Link (the bank-login popup).
 */
exports.createLinkToken = onCall({ secrets: SECRETS }, async (request) => {
  const uid = requireAuth(request);
  const client = getPlaidClient();

  try {
    const response = await client.linkTokenCreate({
      user: { client_user_id: uid },
      client_name: "Net Worth Dashboard",
      products: [Products.Investments, Products.Liabilities],
      optional_products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    return { linkToken: response.data.link_token };
  } catch (err) {
    logger.error("createLinkToken failed", err?.response?.data || err);
    throw new HttpsError("internal", "Plaid link token 생성에 실패했습니다.");
  }
});

/**
 * 2) After the user finishes the Plaid Link flow in the browser,
 *    frontend sends back the public_token. We exchange it for a
 *    permanent access_token and store it server-side only.
 */
exports.exchangePublicToken = onCall({ secrets: SECRETS }, async (request) => {
  const uid = requireAuth(request);
  const { publicToken, institutionName } = request.data || {};

  if (!publicToken) {
    throw new HttpsError("invalid-argument", "publicToken이 필요합니다.");
  }

  const client = getPlaidClient();

  try {
    const exchangeRes = await client.itemPublicTokenExchange({
      public_token: publicToken,
    });

    const accessToken = exchangeRes.data.access_token;
    const itemId = exchangeRes.data.item_id;

    // accessToken is sensitive — stored only in a collection the
    // Firestore rules block from direct client reads.
    await db
      .collection("users")
      .doc(uid)
      .collection("plaidItems")
      .doc(itemId)
      .set({
        accessToken,
        institutionName: institutionName || "Unknown",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    return { success: true, itemId };
  } catch (err) {
    logger.error("exchangePublicToken failed", err?.response?.data || err);
    throw new HttpsError("internal", "계좌 연결에 실패했습니다.");
  }
});

/**
 * 3) On-demand balance fetch — call this whenever the dashboard wants
 *    fresh numbers (e.g. when the user opens the app).
 */
exports.getBalances = onCall({ secrets: SECRETS }, async (request) => {
  const uid = requireAuth(request);
  const client = getPlaidClient();

  const itemsSnap = await db
    .collection("users")
    .doc(uid)
    .collection("plaidItems")
    .get();

  const allAccounts = [];

  for (const doc of itemsSnap.docs) {
    const { accessToken, institutionName } = doc.data();
    try {
      const balRes = await client.accountsBalanceGet({
        access_token: accessToken,
      });
      balRes.data.accounts.forEach((acc) => {
        allAccounts.push({
          itemId: doc.id,
          institutionName,
          accountId: acc.account_id,
          name: acc.name,
          type: acc.type, // depository | investment | credit | loan
          subtype: acc.subtype,
          balance: acc.balances.current,
          available: acc.balances.available,
        });
      });
    } catch (err) {
      logger.error(`balance fetch failed for item ${doc.id}`, err?.response?.data || err);
      // continue with other items even if one institution fails
    }
  }

  return { accounts: allAccounts };
});

/**
 * 4) Scheduled job — runs daily, pulls balances for every connected
 *    user, and writes a dated snapshot to Firestore so the trend
 *    chart fills in automatically without anyone opening the app.
 *    Default: every day at 7:00 AM US/Eastern.
 */
exports.dailySnapshot = onSchedule(
  { schedule: "0 7 * * *", timeZone: "America/New_York", secrets: SECRETS },
  async () => {
    const client = getPlaidClient();
    const usersSnap = await db.collection("users").get();

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const itemsSnap = await db
        .collection("users")
        .doc(uid)
        .collection("plaidItems")
        .get();
      const manualSnap = await db
        .collection("users")
        .doc(uid)
        .collection("accounts")
        .get();

      // Skip users with nothing to snapshot at all.
      if (itemsSnap.empty && manualSnap.empty) continue;

      let totalAssets = 0;
      let totalLiabilities = 0;
      const breakdown = {};

      // --- Plaid-linked accounts ---
      for (const itemDoc of itemsSnap.docs) {
        const { accessToken, institutionName } = itemDoc.data();
        try {
          const balRes = await client.accountsBalanceGet({
            access_token: accessToken,
          });
          balRes.data.accounts.forEach((acc) => {
            const bal = acc.balances.current || 0;
            const key = `${institutionName}:${acc.subtype || acc.type}`;
            breakdown[key] = (breakdown[key] || 0) + bal;
            if (acc.type === "credit" || acc.type === "loan") {
              totalLiabilities += bal;
            } else {
              totalAssets += bal;
            }
          });
        } catch (err) {
          logger.error(`snapshot balance fetch failed uid=${uid} item=${itemDoc.id}`, err?.response?.data || err);
        }
      }

      // --- Manually entered accounts (MassMutual, real estate, etc.) ---
      manualSnap.docs.forEach((doc) => {
        const { type, category, name, balance } = doc.data();
        const bal = balance || 0;
        const key = `manual:${category || "other"}`;
        breakdown[key] = (breakdown[key] || 0) + bal;
        if (type === "liability") {
          totalLiabilities += bal;
        } else {
          totalAssets += bal;
        }
      });

      const today = new Date().toISOString().slice(0, 10);
      await db
        .collection("users")
        .doc(uid)
        .collection("snapshots")
        .doc(today)
        .set({
          date: today,
          totalAssets,
          totalLiabilities,
          netWorth: totalAssets - totalLiabilities,
          breakdown,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }

    logger.info(`dailySnapshot complete for ${usersSnap.size} user(s)`);
  }
);

/**
 * 5) On-demand property value lookup — given a street address, calls
 *    APIllow (third-party Zillow data API) and returns the Zestimate
 *    so the frontend can refresh a manually-entered real estate
 *    account without the user looking it up by hand.
 */
exports.getPropertyValue = onCall({ secrets: [APILLOW_API_KEY] }, async (request) => {
  requireAuth(request);
  const { address } = request.data || {};

  if (!address || !address.trim()) {
    throw new HttpsError("invalid-argument", "주소가 필요합니다.");
  }

  try {
    const res = await fetch("https://api.apillow.co/v1/properties", {
      method: "POST",
      headers: {
        "X-API-Key": APILLOW_API_KEY.value(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ search: address.trim(), type: "sale" }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error("APIllow request failed", res.status, text);
      throw new HttpsError("internal", "부동산 시세 조회에 실패했습니다.");
    }

    const data = await res.json();
    const result = data.results && data.results[0];

    if (!result || !result.success || result.zestimate == null) {
      throw new HttpsError("not-found", "해당 주소의 시세를 찾을 수 없습니다. 주소를 더 정확히 입력해보세요.");
    }

    return {
      zestimate: result.zestimate,
      address: result.street_address || address,
      price: result.price ?? null,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error("getPropertyValue failed", err);
    throw new HttpsError("internal", "부동산 시세 조회 중 오류가 발생했습니다.");
  }
});

/**
 * 6) Scheduled job — runs weekly, refreshes the Zestimate for every
 *    manually-entered real estate account that has an address saved,
 *    so balances stay current without anyone clicking a button.
 *    Default: every Sunday at 6:00 AM US/Eastern (before dailySnapshot).
 */
exports.weeklyZestimateRefresh = onSchedule(
  { schedule: "0 6 * * 0", timeZone: "America/New_York", secrets: [APILLOW_API_KEY] },
  async () => {
    const usersSnap = await db.collection("users").get();
    let updated = 0;

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const accountsSnap = await db
        .collection("users")
        .doc(uid)
        .collection("accounts")
        .where("category", "==", "real_estate")
        .get();

      for (const accDoc of accountsSnap.docs) {
        const { address } = accDoc.data();
        if (!address) continue;

        try {
          const res = await fetch("https://api.apillow.co/v1/properties", {
            method: "POST",
            headers: {
              "X-API-Key": APILLOW_API_KEY.value(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ search: address, type: "sale" }),
          });

          if (!res.ok) {
            logger.error(`zestimate refresh failed uid=${uid} acc=${accDoc.id} status=${res.status}`);
            continue;
          }

          const data = await res.json();
          const result = data.results && data.results[0];
          if (result && result.success && result.zestimate != null) {
            await accDoc.ref.update({ balance: result.zestimate });
            updated++;
          }
        } catch (err) {
          logger.error(`zestimate refresh error uid=${uid} acc=${accDoc.id}`, err);
        }
      }
    }

    logger.info(`weeklyZestimateRefresh updated ${updated} propert(y/ies)`);
  }
);
