/**
 * momentum_subperiod_test.mjs — is the momentum edge from all years, or 1–2 hot ones?
 *
 * Same validated momentum portfolio (compliant ∩ liquid-top-50% ∩ ≥2y, top-quintile 6-1mo,
 * one obs / non-overlapping 20-session rebalance, equal-weight basket, 0.11% RT, ex-COVID).
 * Per-period excess returns are then bucketed by calendar year and by halves to see if the
 * edge is persistent or carried by a single regime.
 *
 * Run: node scripts/momentum_subperiod_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const winx = a => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '–';
const cagr = a => a.length ? Math.pow(1 + mean(a), 252 / H) - 1 : NaN;

async function main() {
  await warm([...TASI_STOCKS.map(s => toYahooSym(s.sym)), '^TASI.SR'], '10y');
  const data = {}, compliant = new Set();
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    const dates = b.map(x => iso(x.t));
    data[s.sym] = { dates, closes: b.map(x => x.c), volumes: b.map(x => x.v), dateIdx: Object.fromEntries(dates.map((dt, i) => [dt, i])) };
    if (getShariaStatus(s.sym).status === 'compliant') compliant.add(s.sym);
  }
  const ib = await getBars('^TASI.SR', '10y'); const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  const fwd = (sym, date) => { const d = data[sym]; const i = d.dateIdx[date]; if (i == null || i + H >= d.closes.length) return null; return d.closes[i + H] / d.closes[i] - 1; };
  const ewC = {}; const ew = date => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  const rows = [];   // {date, year, abs, exc}
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const bench = ew(date); if (bench == null) continue;
    const momRows = [];
    for (const s of usable) {
      if (!compliant.has(s)) continue; const d = data[s]; const i = d.dateIdx[date];
      if (i == null || i < 504 || i < 126 || i + H >= d.closes.length) continue;
      const mom6 = d.closes[i - 21] / d.closes[i - 126] - 1; if (!isFinite(mom6)) continue;
      let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.closes[k] * (d.volumes[k] || 0); n++; }
      momRows.push({ s, mom6, liq: liq / n });
    }
    if (momRows.length < 10) continue;
    const liquid = [...momRows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(momRows.length * 0.5));
    const ranked = [...liquid].sort((a, b) => b.mom6 - a.mom6);
    const picks = ranked.slice(0, Math.max(5, Math.floor(ranked.length * 0.2))).map(r => r.s);
    const rs = picks.map(s => fwd(s, date)).filter(r => r != null); if (!rs.length) continue;
    const abs = mean(rs) - COST_RT;
    rows.push({ date, year: +date.slice(0, 4), abs, exc: abs - bench });
  }

  const report = (label, sub) => {
    const abs = sub.map(r => r.abs), exc = sub.map(r => r.exc);
    console.log(`  ${label.padEnd(16)} ${String(sub.length).padStart(4)}  ${pct(mean(abs)).padStart(8)} ${pct(cagr(abs)).padStart(8)}  ${pct(mean(exc)).padStart(9)} ${tstat(exc).toFixed(2).padStart(6)} ${winx(exc).padStart(5)}`);
  };

  console.log(`\n=== MOMENTUM SUB-PERIOD SPLIT — is the edge persistent or one hot regime? ===`);
  console.log(`Per-period excess vs equal-weight basket, 0.11% RT, ex-COVID. ${rows.length} periods total.`);
  console.log(`\n  ${'bucket'.padEnd(16)} ${'per'.padStart(4)}  ${'ABS/pd'.padStart(8)} ${'~CAGR'.padStart(8)}  ${'EXCESS/pd'.padStart(9)} ${'t-exc'.padStart(6)} ${'win'.padStart(5)}`);
  report('ALL', rows);
  console.log('  ── by calendar year ──');
  const years = [...new Set(rows.map(r => r.year))].sort();
  for (const y of years) report(String(y), rows.filter(r => r.year === y));
  console.log('  ── by half ──');
  const mid = rows[Math.floor(rows.length / 2)].date;
  report(`H1 (≤${mid})`, rows.filter(r => r.date <= mid));
  report(`H2 (>${mid})`, rows.filter(r => r.date > mid));
  const pos = years.filter(y => mean(rows.filter(r => r.year === y).map(r => r.exc)) > 0).length;
  console.log(`\n  Positive-excess years: ${pos}/${years.length}. ${pos >= years.length - 1 ? 'PERSISTENT across regimes — not one hot year.' : 'CONCENTRATED — edge leans on few years; treat with caution.'}`);
  process.exit(0);
}
main();
