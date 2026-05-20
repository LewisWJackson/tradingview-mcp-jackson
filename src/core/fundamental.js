/**
 * Fundamental filters — FED calendar + Earnings check.
 * Scrapes Finviz for live data; falls back to rules.json dates if fetch fails.
 */
import { get } from "node:https";

const MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

// ETFs never have earnings
const ETF_SYMBOLS = new Set(["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "XLF", "XLE"]);

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function fetchHtml(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { clearTimeout(timer); resolve(body); });
    }).on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** "Jul 29 AMC" → "2026-07-29"  (assumes current year, bumps to next if past) */
function parseFinvizDate(raw, today = new Date()) {
  const m = raw.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})/);
  if (!m) return null;
  const month = MONTHS[m[1]];
  const day = parseInt(m[2], 10);
  if (!month || !day) return null;

  const year = today.getFullYear();
  const candidate = new Date(year, month - 1, day);
  // If more than 30 days in the past → must be next year
  if (candidate < new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)) {
    candidate.setFullYear(year + 1);
  }
  return candidate.toISOString().split("T")[0];
}

/** Calendar days between isoDate and today (negative = past) */
function daysDiff(isoDate, today = new Date()) {
  const t = new Date(isoDate);
  const d = new Date(today.toISOString().split("T")[0]);
  return Math.round((t - d) / 864e5);
}

// ─── Finviz scrapers ──────────────────────────────────────────────────────────

async function scrapeEarnings(symbol) {
  const html = await fetchHtml(`https://finviz.com/quote.ashx?t=${symbol}`);
  // The earnings cell sits right after the "Earnings" label cell
  const m = html.match(/Earnings<\/b><\/td>\s*<td[^>]*>\s*([-A-Za-z0-9 ]+?)\s*<\/td>/i);
  if (!m) return null;
  const raw = m[1].trim();
  if (raw === "-" || raw.toUpperCase() === "N/A") return null;
  return raw;
}

async function scrapeCalendarFedEvents(today = new Date()) {
  const html = await fetchHtml("https://finviz.com/calendar.ashx");

  // Rows look like: <tr ...><td ...>May 28</td> ... FOMC ... </tr>
  // Collect all text nodes near FOMC/Fed references
  const events = [];
  const fedRe = /FOMC|Fed Funds|Federal Reserve|Interest Rate Decision/i;

  // Split by <tr to process row by row
  const rows = html.split(/<tr[\s>]/i);
  let lastDate = null;

  for (const row of rows) {
    // Try to pull a date from this row
    const dateMatch = row.match(/([A-Za-z]{3})\s+(\d{1,2})/);
    if (dateMatch) {
      const candidate = parseFinvizDate(dateMatch[0], today);
      if (candidate) lastDate = candidate;
    }
    if (fedRe.test(row) && lastDate) {
      // Extract event name — strip tags
      const name = row.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      events.push({ date: lastDate, event: name });
    }
  }

  return events;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check FED and earnings filters for a list of symbols.
 * @param {string[]} symbols  Watchlist (e.g. ["AAPL","NVDA","SPY"])
 * @param {object}   rules    Parsed rules.json object (may contain fundamental_filters)
 * @returns {object} { checked_at, fed, earnings, warnings }
 */
export async function checkFundamentals(symbols = [], rules = {}) {
  const today = new Date();
  const rf = rules.fundamental_filters || {};

  // ── FED ──────────────────────────────────────────────────────────────────
  let fedEvents = [];

  // 1. Try Finviz calendar
  try {
    const live = await scrapeCalendarFedEvents(today);
    fedEvents = live;
  } catch (_) {
    // Finviz unreachable — proceed with rules.json fallback
  }

  // 2. Merge rules.json fed_dates fallback (avoid duplicates)
  const seenDates = new Set(fedEvents.map((e) => e.date));
  for (const d of rf.fed_dates || []) {
    if (!seenDates.has(d)) {
      fedEvents.push({ date: d, event: "FOMC Meeting", source: "rules.json" });
    }
  }

  // Classify FED events
  const fedUpcoming = fedEvents
    .map((e) => ({ ...e, days_away: daysDiff(e.date, today) }))
    .filter((e) => e.days_away >= -2 && e.days_away <= 30)
    .sort((a, b) => a.days_away - b.days_away);

  const fedActive = fedUpcoming.some((e) => Math.abs(e.days_away) <= 2);

  // ── EARNINGS ──────────────────────────────────────────────────────────────
  const earnings = {};

  for (const symbol of symbols) {
    if (ETF_SYMBOLS.has(symbol)) {
      earnings[symbol] = { is_etf: true, active: false };
      continue;
    }

    let dateStr = null;
    let source = null;

    // 1. Try Finviz
    try {
      const raw = await scrapeEarnings(symbol);
      if (raw) {
        dateStr = parseFinvizDate(raw, today);
        source = "finviz";
      }
    } catch (_) {}

    // 2. Fallback to rules.json
    if (!dateStr && rf.earnings?.[symbol]) {
      dateStr = rf.earnings[symbol];
      source = "rules.json";
    }

    if (!dateStr) {
      earnings[symbol] = { date: null, active: false, days_away: null, source: null };
      continue;
    }

    const days = daysDiff(dateStr, today);
    earnings[symbol] = {
      date: dateStr,
      active: Math.abs(days) <= 7,
      days_away: days,
      source,
    };
  }

  // ── Warnings ──────────────────────────────────────────────────────────────
  const warnings = [];
  if (fedActive) {
    const next = fedUpcoming.find((e) => Math.abs(e.days_away) <= 2);
    warnings.push(
      `⚠️ FILTRO FED ACTIVO — evento "${next?.event}" el ${next?.date} (${next?.days_away >= 0 ? "en " + next.days_away : "hace " + Math.abs(next.days_away)} días). Considerar NO operar hoy.`,
    );
  }
  for (const [sym, data] of Object.entries(earnings)) {
    if (data.active) {
      const dir = data.days_away >= 0 ? `en ${data.days_away} días` : `hace ${Math.abs(data.days_away)} días`;
      warnings.push(
        `⚠️ FILTRO EARNINGS ${sym} — earnings ${dir} (${data.date}). NO operar ${sym}.`,
      );
    }
  }

  return {
    checked_at: today.toISOString().split("T")[0],
    fed: {
      active: fedActive,
      upcoming: fedUpcoming,
    },
    earnings,
    warnings,
  };
}
