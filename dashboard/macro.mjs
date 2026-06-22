// Macro calendar events — extracted from server.mjs (pure data + fn).
// Hardcoded 2025-2026 macro events. Add new rows each year.
// impact: 'high' | 'medium' | 'low'
// tasiImpact: 'bullish' | 'bearish' | 'neutral' | 'closed' | null (unknown until event)
export const MACRO_EVENTS = [
  // ── Saudi Public Holidays 2026 (TASI closed) ──────────────────────────────
  { date: '2026-02-22', type: 'holiday', label: 'Saudi Founding Day', detail: 'TASI closed', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-03-28', type: 'holiday', label: 'Eid Al-Fitr Holiday', detail: 'TASI closed (approx)', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-03-29', type: 'holiday', label: 'Eid Al-Fitr Holiday', detail: 'TASI closed', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-03-30', type: 'holiday', label: 'Eid Al-Fitr Holiday', detail: 'TASI closed', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-03-31', type: 'holiday', label: 'Eid Al-Fitr Holiday', detail: 'TASI closed', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-04-01', type: 'holiday', label: 'Eid Al-Fitr Holiday', detail: 'TASI closed', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-06-04', type: 'holiday', label: 'Eid Al-Adha Holiday', detail: 'TASI closed (approx)', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-06-05', type: 'holiday', label: 'Eid Al-Adha Holiday', detail: 'TASI closed', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-06-06', type: 'holiday', label: 'Eid Al-Adha Holiday', detail: 'TASI closed', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-06-07', type: 'holiday', label: 'Eid Al-Adha Holiday', detail: 'TASI closed', impact: 'low', tasiImpact: 'closed' },
  { date: '2026-09-23', type: 'holiday', label: 'Saudi National Day', detail: 'TASI closed', impact: 'low', tasiImpact: 'closed' },
  // ── US Federal Reserve (FOMC) 2026 ────────────────────────────────────────
  { date: '2026-01-28', type: 'fed',     label: 'FOMC Rate Decision', detail: 'US Federal Reserve interest rate decision', impact: 'high', tasiImpact: null },
  { date: '2026-03-18', type: 'fed',     label: 'FOMC Rate Decision', detail: 'US Federal Reserve interest rate decision', impact: 'high', tasiImpact: null },
  { date: '2026-05-06', type: 'fed',     label: 'FOMC Rate Decision', detail: 'US Federal Reserve interest rate decision', impact: 'high', tasiImpact: null },
  { date: '2026-06-17', type: 'fed',     label: 'FOMC Rate Decision', detail: 'US Federal Reserve interest rate decision', impact: 'high', tasiImpact: null },
  { date: '2026-07-29', type: 'fed',     label: 'FOMC Rate Decision', detail: 'US Federal Reserve interest rate decision', impact: 'high', tasiImpact: null },
  { date: '2026-09-16', type: 'fed',     label: 'FOMC Rate Decision', detail: 'US Federal Reserve interest rate decision', impact: 'high', tasiImpact: null },
  { date: '2026-11-04', type: 'fed',     label: 'FOMC Rate Decision', detail: 'US Federal Reserve interest rate decision', impact: 'high', tasiImpact: null },
  { date: '2026-12-16', type: 'fed',     label: 'FOMC Rate Decision', detail: 'US Federal Reserve interest rate decision', impact: 'high', tasiImpact: null },
  // ── SAMA (Saudi Central Bank) ─────────────────────────────────────────────
  // SAMA typically moves in sync with Fed; exact dates announced closer to meeting
  { date: '2026-03-19', type: 'sama',    label: 'SAMA Rate Decision', detail: 'Saudi Central Bank — follows Fed direction', impact: 'high', tasiImpact: null },
  { date: '2026-06-18', type: 'sama',    label: 'SAMA Rate Decision', detail: 'Saudi Central Bank — follows Fed direction', impact: 'high', tasiImpact: null },
  { date: '2026-09-17', type: 'sama',    label: 'SAMA Rate Decision', detail: 'Saudi Central Bank — follows Fed direction', impact: 'high', tasiImpact: null },
  { date: '2026-12-17', type: 'sama',    label: 'SAMA Rate Decision', detail: 'Saudi Central Bank — follows Fed direction', impact: 'high', tasiImpact: null },
  // ── OPEC / OPEC+ ─────────────────────────────────────────────────────────
  { date: '2026-05-28', type: 'opec',    label: 'OPEC+ Meeting', detail: 'Oil output policy decision — directly affects Saudi Aramco & energy sector', impact: 'high', tasiImpact: null },
  { date: '2026-11-26', type: 'opec',    label: 'OPEC+ Meeting', detail: 'Oil output policy decision — directly affects Saudi Aramco & energy sector', impact: 'high', tasiImpact: null },
  // ── US CPI (inflation) ────────────────────────────────────────────────────
  { date: '2026-01-15', type: 'cpi',     label: 'US CPI (Dec)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-02-12', type: 'cpi',     label: 'US CPI (Jan)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-03-12', type: 'cpi',     label: 'US CPI (Feb)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-04-10', type: 'cpi',     label: 'US CPI (Mar)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-05-12', type: 'cpi',     label: 'US CPI (Apr)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-06-11', type: 'cpi',     label: 'US CPI (May)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-07-15', type: 'cpi',     label: 'US CPI (Jun)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-08-13', type: 'cpi',     label: 'US CPI (Jul)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-09-11', type: 'cpi',     label: 'US CPI (Aug)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-10-14', type: 'cpi',     label: 'US CPI (Sep)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-11-12', type: 'cpi',     label: 'US CPI (Oct)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  { date: '2026-12-11', type: 'cpi',     label: 'US CPI (Nov)', detail: 'US inflation data — influences Fed path & global risk appetite', impact: 'medium', tasiImpact: null },
  // ── US Non-Farm Payrolls ──────────────────────────────────────────────────
  { date: '2026-01-09', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-02-06', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-03-06', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-04-03', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-05-01', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-06-05', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-07-02', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-08-07', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-09-04', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-10-02', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-11-06', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  { date: '2026-12-04', type: 'nfp',     label: 'US Jobs (NFP)', detail: 'Non-Farm Payrolls — labor market strength affects Fed policy', impact: 'medium', tasiImpact: null },
  // ── Saudi TASI Earnings Season ────────────────────────────────────────────
  { date: '2026-01-20', type: 'earnings', label: 'TASI Q4 Earnings Season', detail: 'Major Saudi companies report Q4 2025 results — expect elevated volatility', impact: 'medium', tasiImpact: null },
  { date: '2026-04-20', type: 'earnings', label: 'TASI Q1 Earnings Season', detail: 'Major Saudi companies report Q1 2026 results — expect elevated volatility', impact: 'medium', tasiImpact: null },
  { date: '2026-07-20', type: 'earnings', label: 'TASI Q2 Earnings Season', detail: 'Major Saudi companies report Q2 2026 results — expect elevated volatility', impact: 'medium', tasiImpact: null },
  { date: '2026-10-20', type: 'earnings', label: 'TASI Q3 Earnings Season', detail: 'Major Saudi companies report Q3 2026 results — expect elevated volatility', impact: 'medium', tasiImpact: null },
  // ── Jackson Hole (Fed annual symposium) ────────────────────────────────────
  { date: '2026-08-27', type: 'fed',     label: 'Jackson Hole Symposium', detail: 'Fed Chair annual speech — major policy signal for markets globally', impact: 'high', tasiImpact: null },
  // ── Saudi Vision 2030 / Saudi GDP ─────────────────────────────────────────
  { date: '2026-03-15', type: 'macro',   label: 'Saudi GDP Q4 2025', detail: 'Saudi quarterly GDP release — signals domestic economic health', impact: 'medium', tasiImpact: null },
  { date: '2026-06-15', type: 'macro',   label: 'Saudi GDP Q1 2026', detail: 'Saudi quarterly GDP release — signals domestic economic health', impact: 'medium', tasiImpact: null },
  { date: '2026-09-15', type: 'macro',   label: 'Saudi GDP Q2 2026', detail: 'Saudi quarterly GDP release — signals domestic economic health', impact: 'medium', tasiImpact: null },
  { date: '2026-12-15', type: 'macro',   label: 'Saudi GDP Q3 2026', detail: 'Saudi quarterly GDP release — signals domestic economic health', impact: 'medium', tasiImpact: null },
];

export function getUpcomingEvents(daysAhead = 21) {
  const nowKSA   = new Date(Date.now() + 3 * 3600 * 1000);
  const todayStr = nowKSA.toISOString().slice(0, 10);
  const endDate  = new Date(nowKSA.getTime() + daysAhead * 86400 * 1000).toISOString().slice(0, 10);
  return MACRO_EVENTS
    .filter(e => e.date >= todayStr && e.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}
