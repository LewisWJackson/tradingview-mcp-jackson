/**
 * Yahoo Finance batch quote client.
 *
 * Factored from scripts/dashboard/gen_brief.js. The HTTP + auth flow is the
 * same; this module exposes a clean fetchQuotes(symbols) Promise and adds
 * per-symbol spread + quote-age enrichment for the live feed.
 *
 * Phase B contract:
 * - 15s per-request timeout — surfaces as a typed Error with `kind = 'timeout'`.
 * - HTTP 429 surfaces as a typed Error with `kind = 'rate_limit'`.
 * - HTTP 5xx surfaces as `kind = 'server_error'`; other non-2xx as `kind = 'http_error'`.
 * - Auth (getCrumb) failures surface as `kind = 'auth_error'`.
 * - Every thrown error carries `source = 'yahoo'` so the chain can audit which
 *   provider failed without parsing the message string.
 * - fetchQuotes returns a `missing` array of symbols Yahoo did NOT return rows
 *   for, so partial-batch behavior is auditable rather than silent.
 *
 * Source attribution lives at the chain layer (Task 7); this module deliberately
 * does NOT stamp `quoteSource: 'yahoo'` onto each row — the chain does, after
 * deciding which source actually answered.
 */

import https from 'node:https';

const TIMEOUT_MS = 15_000;
const BATCH_URL = 'https://query2.finance.yahoo.com/v7/finance/quote';
const CRUMB_URL = 'https://query2.finance.yahoo.com/v1/test/getcrumb';
const FC_URL = 'https://fc.yahoo.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function classifyHttpKind(status) {
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server_error';
  return 'http_error';
}

function httpGet(url, { cookies } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': UA };
    if (cookies) headers.Cookie = cookies;
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, { cookies }).then(resolve, reject);
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', (e) => {
      // Network-level failure — tag as http_error so the chain can introspect.
      const err = new Error(`Yahoo network error: ${e.message}`);
      err.kind = 'http_error';
      err.source = 'yahoo';
      err.status = null;
      err.cause = e;
      reject(err);
    });
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      const err = new Error(`Yahoo request timed out after ${TIMEOUT_MS}ms`);
      err.kind = 'timeout';
      err.source = 'yahoo';
      err.status = null;
      err.timeoutMs = TIMEOUT_MS;
      reject(err);
    });
  });
}

async function authenticate() {
  const init = await httpGet(FC_URL);
  const setCookie = init.headers['set-cookie'] || [];
  const cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
  const crumbRes = await httpGet(CRUMB_URL, { cookies });
  if (crumbRes.status !== 200) {
    const err = new Error(`Yahoo getCrumb failed: status ${crumbRes.status}`);
    err.status = crumbRes.status;
    err.kind = 'auth_error';
    err.source = 'yahoo';
    throw err;
  }
  return { crumb: crumbRes.body.trim(), cookies };
}

export function buildQuoteUrl(symbols, crumb) {
  return `${BATCH_URL}?symbols=${encodeURIComponent(symbols.join(','))}&crumb=${encodeURIComponent(crumb)}`;
}

export function normalizeQuoteRow(r) {
  const price = r.regularMarketPrice ?? null;
  const bid = r.bid ?? null;
  const ask = r.ask ?? null;
  const spreadAbsolute = (bid != null && ask != null) ? +(ask - bid).toFixed(4) : null;
  const spreadPctOfPrice = (spreadAbsolute != null && price) ? +((spreadAbsolute / price) * 100).toFixed(2) : null;
  const marketTimeEpochSec = r.regularMarketTime ?? null;
  return {
    symbol: r.symbol,
    price, bid, ask, spreadAbsolute, spreadPctOfPrice,
    averageDailyVolume10Day: r.averageDailyVolume10Day ?? null,
    volume: r.regularMarketVolume ?? null,
    prevClose: r.regularMarketPreviousClose ?? null,
    openToday: r.regularMarketOpen ?? null,
    marketTimeEpochSec,
    marketTimeIso: marketTimeEpochSec ? new Date(marketTimeEpochSec * 1000).toISOString() : null,
  };
}

export function parseQuoteResponse(body) {
  const parsed = JSON.parse(body);
  const rows = parsed?.quoteResponse?.result || [];
  const map = {};
  for (const r of rows) {
    // Drop rows that lack a symbol key — do not fabricate. Auditable via the
    // `missing` array returned by fetchQuotes.
    if (!r || typeof r.symbol !== 'string') continue;
    map[r.symbol] = normalizeQuoteRow(r);
  }
  return map;
}

/**
 * Fetch a batch of quotes. Returns { quotes, fetchedAt, session, missing }.
 * Throws a typed Error on HTTP failure (timeout / 429 / 5xx / other) so the
 * chain caller can decide backoff policy by `err.kind` and `err.source`.
 */
export async function fetchQuotes(symbols, session = null) {
  if (symbols.length === 0) return { quotes: {}, fetchedAt: new Date(), missing: [] };
  if (symbols.length > 50) throw new Error('Yahoo batch max is 50 symbols');

  const active = session ?? await authenticate();
  const url = buildQuoteUrl(symbols, active.crumb);
  const fetchedAt = new Date();
  const res = await httpGet(url, { cookies: active.cookies });

  if (res.status === 401) {
    // Crumb expired — re-authenticate once and retry.
    const fresh = await authenticate();
    const retry = await httpGet(buildQuoteUrl(symbols, fresh.crumb), { cookies: fresh.cookies });
    if (retry.status !== 200) {
      const err = new Error(`Yahoo status ${retry.status} after re-auth`);
      err.status = retry.status;
      err.kind = classifyHttpKind(retry.status);
      err.source = 'yahoo';
      throw err;
    }
    const quotes = parseQuoteResponse(retry.body);
    const missing = symbols.filter(s => !(s in quotes));
    return { quotes, fetchedAt, session: fresh, missing };
  }

  if (res.status !== 200) {
    const err = new Error(`Yahoo status ${res.status}`);
    err.status = res.status;
    err.kind = classifyHttpKind(res.status);
    err.source = 'yahoo';
    throw err;
  }

  const quotes = parseQuoteResponse(res.body);
  const missing = symbols.filter(s => !(s in quotes));
  return { quotes, fetchedAt, session: active, missing };
}

export { authenticate };
