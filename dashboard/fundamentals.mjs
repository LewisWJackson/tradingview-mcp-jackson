/**
 * Fundamental data fetcher — TradingView Scanner API
 * Uses the same public endpoint that powers TradingView's own screener.
 * No API key required. Works reliably for all TASI (Tadawul) stocks.
 */

const cache = new Map(); // sym → { data, ts }
const TTL   = 2 * 60 * 60 * 1000; // 2 hours

const HEADERS = {
  "User-Agent":   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":       "application/json",
  "Content-Type": "application/json",
  "Origin":       "https://www.tradingview.com",
  "Referer":      "https://www.tradingview.com/",
};

const SCANNER_URL = "https://scanner.tradingview.com/global/scan";

// ── TradingView scanner columns we want ──────────────────────────────────────
const COLUMNS = [
  // Price / market
  "close", "change", "change_abs", "volume", "market_cap_basic",

  // Valuation
  "price_earnings_ttm",          // trailing P/E
  "price_earnings_fwd",          // forward P/E
  "price_book_ratio",            // P/B
  "price_sales_ratio",           // P/S
  "enterprise_value_ebitda_ttm", // EV/EBITDA
  "earnings_per_share_basic_ttm",// EPS (TTM)
  "earnings_per_share_fwd",      // EPS forward
  "price_earnings_growth_ttm",   // PEG

  // Dividends
  "dividends_yield_current",     // dividend yield %
  "dps_common_stock_prim_issue_fy", // DPS
  "dividend_payout_ratio_ttm",   // payout ratio

  // Profitability
  "return_on_equity",            // ROE %
  "return_on_assets",            // ROA %
  "net_margin",                  // net margin %
  "gross_margin_ttm",            // gross margin %
  "operating_margin",            // operating margin %
  "ebitda_margin_ttm",           // EBITDA margin %

  // Growth
  "revenue_growth_ttm_yoy",      // revenue growth YoY %
  "earnings_growth_ttm_yoy",     // earnings growth YoY %

  // Health
  "debt_to_equity",              // D/E
  "current_ratio_fq",            // current ratio
  "quick_ratio_fq",              // quick ratio
  "cash_n_short_term_invest_fq", // cash
  "total_debt_fq",               // total debt
  "free_cash_flow_margin_ttm",   // FCF margin %
  "free_cash_flow_ttm",          // free cash flow (absolute)

  // 52-week / MAs
  "High.6M",    // 52-week high (approx)
  "Low.6M",     // 52-week low  (approx)
  "price_52_week_high",
  "price_52_week_low",
  "SMA50",
  "SMA200",

  // Other
  "beta_1_year",
  "relative_volume_10d_calc",
];

// ── Main fetch ────────────────────────────────────────────────────────────────
export async function getFundamentals(sym) {
  if (cache.has(sym)) {
    const { data, ts } = cache.get(sym);
    if (Date.now() - ts < TTL) return data;
  }

  const body = JSON.stringify({
    symbols: { tickers: [sym], query: { types: [] } },
    columns: COLUMNS,
  });

  const res = await fetch(SCANNER_URL, {
    method:  "POST",
    headers: HEADERS,
    body,
  });

  if (!res.ok) throw new Error(`TradingView scanner: HTTP ${res.status}`);

  const json   = await res.json();
  const fields = json?.data?.[0]?.d;
  if (!fields) throw new Error(`No fundamental data for ${sym}`);

  // Map column array → named object
  const raw = {};
  COLUMNS.forEach((col, i) => { raw[col] = fields[i] ?? null; });

  const data = extract(raw, sym);
  cache.set(sym, { data, ts: Date.now() });
  return data;
}

// ── Map raw fields → clean uniform object ────────────────────────────────────
function extract(r, sym) {
  const pctField = v => (v != null ? Math.round(v * 100) / 100 : null); // already %
  const h52 = r["price_52_week_high"] ?? r["High.6M"];
  const l52  = r["price_52_week_low"]  ?? r["Low.6M"];

  return {
    sym,
    fetchedAt: new Date().toISOString(),
    currency:  "SAR",

    // ── Market ────────────────────────────────────────────────────────────
    price:      r["close"],
    change:     r["change"],
    changeAbs:  r["change_abs"],
    volume:     r["volume"],
    marketCap:  r["market_cap_basic"],

    // ── Valuation ─────────────────────────────────────────────────────────
    // P/E: TradingView leaves this null for some Saudi banks — fall back to price/EPS
    peTrailing:  r["price_earnings_ttm"] ??
                   (r["close"] != null && r["earnings_per_share_basic_ttm"] > 0
                     ? Math.round((r["close"] / r["earnings_per_share_basic_ttm"]) * 100) / 100
                     : null),
    peForward:   r["price_earnings_fwd"],
    pb:          r["price_book_ratio"],
    ps:          r["price_sales_ratio"],
    evEbitda:    r["enterprise_value_ebitda_ttm"],
    eps:         r["earnings_per_share_basic_ttm"],
    epsForward:  r["earnings_per_share_fwd"],
    pegRatio:    r["price_earnings_growth_ttm"],

    // ── Dividends ─────────────────────────────────────────────────────────
    divYield:     r["dividends_yield_current"],          // already in %
    divRate:      r["dps_common_stock_prim_issue_fy"],
    payoutRatio:  r["dividend_payout_ratio_ttm"],        // already in %

    // ── Profitability ─────────────────────────────────────────────────────
    roe:          r["return_on_equity"],         // already %
    roa:          r["return_on_assets"],
    netMargin:    r["net_margin"],
    grossMargin:  r["gross_margin_ttm"],
    opMargin:     r["operating_margin"],
    ebitdaMargin: r["ebitda_margin_ttm"],

    // ── Growth ────────────────────────────────────────────────────────────
    revenueGrowth:  r["revenue_growth_ttm_yoy"],
    earningsGrowth: r["earnings_growth_ttm_yoy"],

    // ── Financial Health ──────────────────────────────────────────────────
    debtToEquity:  r["debt_to_equity"],           // ratio (e.g. 0.45 = 45%)
    currentRatio:  r["current_ratio_fq"],
    quickRatio:    r["quick_ratio_fq"],
    totalCash:     r["cash_n_short_term_invest_fq"],
    totalDebt:     r["total_debt_fq"],
    freeCashflow:  r["free_cash_flow_ttm"],
    fcfMargin:     r["free_cash_flow_margin_ttm"],

    // ── 52-week / Technical ────────────────────────────────────────────────
    high52w:  h52,
    low52w:   l52,
    ma50:     r["SMA50"],
    ma200:    r["SMA200"],
    volRatio: r["relative_volume_10d_calc"],

    // ── Other ─────────────────────────────────────────────────────────────
    beta: r["beta_1_year"],
  };
}

// ── Fundamental scoring (0–100) ───────────────────────────────────────────────
export function scoreFundamentals(f, sector) {
  if (!f) return null;
  const isBanking = sector === "banking" || sector === "insurance";
  const scores    = [];

  function add(val, good, fair, label, invert = false) {
    if (val == null) return;
    let s;
    if (!invert) s = val <= good ? 1 : val <= fair ? 0.5 : 0;
    else         s = val >= good ? 1 : val >= fair  ? 0.5 : 0;
    scores.push({ label, val, s });
  }

  // Valuation (lower is better)
  if (!isBanking) {
    add(f.peTrailing, 12, 20, "P/E");
    add(f.pb,          1.5, 3, "P/B");
  } else {
    add(f.peTrailing, 10, 16, "P/E");
    add(f.pb,          1, 2,  "P/B");
  }
  if (f.evEbitda != null && f.evEbitda > 0)
    add(f.evEbitda, 8, 15, "EV/EBITDA");

  // Dividend (higher is better — handled via override below)
  if (f.divYield != null)
    scores.push({ label: "Div Yield", val: f.divYield, s: 0 });
  else
    scores.push({ label: "Div Yield", val: null, s: 0.25 });

  // Profitability (higher is better)
  add(f.roe,       15, 10, "ROE",        true);
  add(f.netMargin, 15,  8, "Net Margin", true);
  if (f.opMargin != null)
    add(f.opMargin, 20, 12, "Op Margin", true);

  // Health
  if (!isBanking) {
    if (f.debtToEquity != null)
      add(f.debtToEquity, 0.5, 1.5, "D/E");     // TV returns ratio (e.g. 0.45)
    if (f.currentRatio != null)
      add(f.currentRatio, null, null, "Current Ratio", true);
  }

  // Dividend yield scoring override
  const divEntry = scores.find(s => s.label === "Div Yield");
  if (divEntry && f.divYield != null) {
    divEntry.s = f.divYield >= 5 ? 1 : f.divYield >= 3 ? 0.7 : f.divYield >= 1 ? 0.4 : 0.1;
  }

  if (!scores.length) return { score: null, signal: "N/A", details: [] };

  const avg    = scores.reduce((a, b) => a + b.s, 0) / scores.length;
  const score  = Math.round(avg * 100);
  const signal =
    score >= 70 ? "UNDERVALUED" :
    score >= 45 ? "FAIR VALUE"  :
                  "OVERVALUED";

  return { score, signal, details: scores };
}
