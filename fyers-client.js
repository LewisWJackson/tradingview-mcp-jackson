// Fyers API v3 client — live order placement for NSE/BSE equities & F&O.
//
// Auth model (OAuth2):
//   1. Register an app at https://myapi.fyers.in/  → get APP_ID + SECRET_ID.
//   2. Run `npm run fyers:auth` once per day to mint a fresh access token.
//   3. This client reads FYERS_APP_ID + FYERS_ACCESS_TOKEN from .env and
//      signs every request with the `AppId:AccessToken` Authorization header.
//
// Docs: https://myapi.fyers.in/docsv3

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";

// ── Load .env (same lightweight parser as scalper-run.js) ───────────
const envPath = new URL(".env", import.meta.url);
if (existsSync(envPath)) {
  readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const [k, ...v] = line.split("=");
      if (k && !k.startsWith("#") && v.length)
        process.env[k.trim()] = v.join("=").trim();
    });
}

export const BASE = "https://api-t1.fyers.in/api/v3";
// Market-data endpoints (quotes/history/depth) live under /data, not /api/v3.
export const DATA_BASE = "https://api-t1.fyers.in/data";
export const APP_ID = process.env.FYERS_APP_ID;
export const SECRET_ID = process.env.FYERS_SECRET_ID;
export const REDIRECT_URI =
  process.env.FYERS_REDIRECT_URI || "https://127.0.0.1/fyers/callback";

// dryRun() short-circuits every order-placing call — nothing hits the exchange,
// the intended payload is logged instead. Read at call-time so a runner can
// force-enable it (e.g. simulation mode) before any order fires. Real money
// moves only when FYERS_DRY_RUN is explicitly "false".
export const dryRun = () => process.env.FYERS_DRY_RUN !== "false";
// Snapshot for display/logging at import time.
export const DRY_RUN = dryRun();

// ── Auth helpers ────────────────────────────────────────────────────

// SHA-256 of "APP_ID:SECRET_ID" — required to exchange an auth code for a token.
export function appIdHash() {
  if (!APP_ID || !SECRET_ID)
    throw new Error("FYERS_APP_ID and FYERS_SECRET_ID must be set in .env");
  return createHash("sha256").update(`${APP_ID}:${SECRET_ID}`).digest("hex");
}

// The URL the user opens in a browser to log in and receive an auth code.
export function loginUrl(state = "fyers") {
  const q = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state,
  });
  return `${BASE}/generate-authcode?${q}`;
}

// Exchange the one-time auth code (from the redirect URL) for an access token.
export async function exchangeAuthCode(authCode) {
  const res = await fetch(`${BASE}/validate-authcode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      appIdHash: appIdHash(),
      code: authCode,
    }),
  });
  const data = await res.json();
  if (data.s !== "ok" || !data.access_token)
    throw new Error(`Auth failed: ${data.message || JSON.stringify(data)}`);
  return data.access_token;
}

// ── Signed request wrapper ──────────────────────────────────────────
function authHeader() {
  const token = process.env.FYERS_ACCESS_TOKEN;
  if (!APP_ID || !token)
    throw new Error(
      "FYERS_APP_ID / FYERS_ACCESS_TOKEN missing — run `npm run fyers:auth`",
    );
  return `${APP_ID}:${token}`;
}

async function request(method, path, body = null, base = BASE) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.s === "error")
    throw new Error(`Fyers API error [${path}]: ${data.message || data.code}`);
  return data;
}

// ── Account / market data ───────────────────────────────────────────
export const getProfile = () => request("GET", "/profile");
export const getFunds = () => request("GET", "/funds");
export const getPositions = () => request("GET", "/positions");
export const getOrders = () => request("GET", "/orders");

// symbols: "NSE:SBIN-EQ" or "NSE:SBIN-EQ,NSE:NIFTY50-INDEX"
export const getQuotes = (symbols) =>
  request("GET", `/quotes?symbols=${encodeURIComponent(symbols)}`, null, DATA_BASE);

// Intraday OHLCV candles. resolution "1" = 1-min. Returns [{ts,open,high,low,close,vol}].
export async function getHistory(symbol, resolution = "1", days = 1) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const q = new URLSearchParams({
    symbol,
    resolution,
    date_format: "1",
    range_from: fmt(from),
    range_to: fmt(to),
    cont_flag: "1",
  });
  const res = await request("GET", `/history?${q}`, null, DATA_BASE);
  return (res.candles || []).map((c) => ({
    ts: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    vol: c[5],
  }));
}

// ── Orders ──────────────────────────────────────────────────────────
// side: 1 = Buy, -1 = Sell
// type: 1 = Limit, 2 = Market, 3 = Stop (SL-M), 4 = Stop-Limit (SL-L)
// productType: "INTRADAY" | "CNC" | "MARGIN" | "CO" | "BO"
export async function placeOrder({
  symbol,
  qty,
  side,
  type = 2,
  productType = "INTRADAY",
  limitPrice = 0,
  stopPrice = 0,
  validity = "DAY",
  disclosedQty = 0,
  offlineOrder = false,
}) {
  const body = {
    symbol,
    qty,
    type,
    side,
    productType,
    limitPrice,
    stopPrice,
    validity,
    disclosedQty,
    offlineOrder,
  };

  if (dryRun()) {
    console.log("🧪 DRY_RUN — order NOT sent to Fyers:", JSON.stringify(body));
    return { s: "ok", dryRun: true, order: body };
  }
  // /orders/sync blocks until the exchange responds with an order id.
  return request("POST", "/orders/sync", body);
}

export async function cancelOrder(id) {
  if (dryRun()) {
    console.log("🧪 DRY_RUN — cancel NOT sent:", id);
    return { s: "ok", dryRun: true, id };
  }
  return request("DELETE", "/orders/sync", { id });
}

// Flatten every open position (INTRADAY square-off).
export async function exitAllPositions() {
  if (dryRun()) {
    console.log("🧪 DRY_RUN — exit-all NOT sent");
    return { s: "ok", dryRun: true };
  }
  return request("DELETE", "/positions", {});
}
