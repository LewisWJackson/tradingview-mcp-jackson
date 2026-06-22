/**
 * crypto_tsmom_test.mjs — PRE-REGISTERED single edge test.
 *
 * Hypothesis (Moskowitz-Ooi-Pedersen time-series / absolute momentum, NOT tuned here):
 *   Long the asset when daily close > 200-day SMA, FLAT (cash, 0 return) when close <= SMA.
 *   Long-only, no shorting, no leverage. Cost 0.20% per switch (entry or exit). Cash earns 0.
 *
 * Assets: BTC-USD, ETH-USD — individually and pooled (equal-weight when both long).
 * Benchmark: buy-and-hold the same asset(s).
 *
 * PRE-REGISTERED GATE (PASS requires ALL):
 *   1. Net Sharpe (annualized, daily) >= 0.8
 *   2. Beats buy-and-hold on Sharpe
 *   3. maxDrawdown reduced by >= 30% vs buy-and-hold
 *   4. Holds in BOTH halves of the sample
 *
 * KILL by default. ONE lookback (200d) decides the verdict. 100d/50d are INFORMATIONAL ONLY.
 *
 * Run: node --experimental-sqlite scripts/crypto_tsmom_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';

const LOOKBACK = 200;          // pre-registered, the only lookback that decides the verdict
const INFO_LOOKBACKS = [100, 50]; // informational footnote only
const COST = 0.0020;           // 0.20% per switch
const TRADING_DAYS = 365;      // crypto trades every calendar day
const RANGE = '10y';

// --- metric helpers -------------------------------------------------------
function dailyReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i - 1] - 1);
  return r;
}
function sma(closes, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += closes[k];
  return s / n;
}
function annVol(rets) {
  const n = rets.length;
  if (n < 2) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / n;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return Math.sqrt(v) * Math.sqrt(TRADING_DAYS);
}
function sharpe(rets) {
  const n = rets.length;
  if (n < 2) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(TRADING_DAYS);
}
function cagr(rets, days) {
  let eq = 1;
  for (const r of rets) eq *= (1 + r);
  const years = days / TRADING_DAYS;
  if (years <= 0 || eq <= 0) return 0;
  return Math.pow(eq, 1 / years) - 1;
}
function maxDD(rets) {
  let eq = 1, peak = 1, mdd = 0;
  for (const r of rets) {
    eq *= (1 + r);
    if (eq > peak) peak = eq;
    const dd = eq / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  return mdd; // negative
}
function stats(rets, days) {
  return { cagr: cagr(rets, days), vol: annVol(rets), sharpe: sharpe(rets), maxDD: maxDD(rets) };
}

/**
 * Build strategy daily returns for one asset.
 * Point-in-time: position for day t->t+1 is decided by close[t] vs SMA(closes, t, lookback)
 * (only past+current closes). Cost charged on the day a switch happens.
 * Returns { ret: [daily strat ret], pos: [0/1 position applied to each day's return], bh: [buy&hold ret] }
 * aligned so index j corresponds to the return earned over day (start+j) -> (start+j+1).
 */
function buildStrat(closes, lookback) {
  const ret = [], pos = [], bh = [];
  let prevPos = 0;
  // first usable signal is at i = lookback-1 (SMA defined); we earn the return into i+1
  for (let i = lookback - 1; i < closes.length - 1; i++) {
    const s = sma(closes, i, lookback);
    const p = closes[i] > s ? 1 : 0;            // decided on close[i], applied to i->i+1
    const mktRet = closes[i + 1] / closes[i] - 1;
    let r = p * mktRet;
    if (p !== prevPos) r -= COST;               // switch cost (entry or exit)
    ret.push(r);
    pos.push(p);
    bh.push(mktRet);
    prevPos = p;
  }
  return { ret, pos, bh };
}

function half(arr) {
  const mid = Math.floor(arr.length / 2);
  return [arr.slice(0, mid), arr.slice(mid)];
}

function evalGate(strat, bh, days) {
  const sFull = stats(strat, days);
  const bFull = stats(bh, days);
  const [s1, s2] = half(strat);
  const [b1, b2] = half(bh);
  const halfDays = Math.floor(days / 2);
  const sH1 = stats(s1, halfDays), sH2 = stats(s2, halfDays);
  const bH1 = stats(b1, halfDays), bH2 = stats(b2, halfDays);

  const ddReduction = bFull.maxDD === 0 ? 0 : 1 - (sFull.maxDD / bFull.maxDD); // both negative

  // half-pass: in EACH half, strat Sharpe >= 0.8 AND beats B&H Sharpe AND DD reduced >=30%
  const halfPass = (s, b) => s.sharpe >= 0.8 && s.sharpe > b.sharpe &&
    (b.maxDD !== 0 && (1 - s.maxDD / b.maxDD) >= 0.30);
  const h1ok = halfPass(sH1, bH1);
  const h2ok = halfPass(sH2, bH2);

  const g1 = sFull.sharpe >= 0.8;
  const g2 = sFull.sharpe > bFull.sharpe;
  const g3 = ddReduction >= 0.30;
  const g4 = h1ok && h2ok;
  const pass = g1 && g2 && g3 && g4;

  return { sFull, bFull, sH1, sH2, bH1, bH2, ddReduction, g1, g2, g3, g4, h1ok, h2ok, pass };
}

const pct = (x) => (x * 100).toFixed(1) + '%';
const f2 = (x) => x.toFixed(2);

async function main() {
  await warm(['BTC-USD', 'ETH-USD'], RANGE);
  const btc = await getBars('BTC-USD', RANGE);
  const eth = await getBars('ETH-USD', RANGE);
  if (!btc.length || !eth.length) { console.error('No data'); process.exit(1); }

  const assets = { BTC: btc, ETH: eth };
  const results = {};

  // span report
  for (const [name, bars] of Object.entries(assets)) {
    console.log(`${name} span: ${iso(bars[0].t)} -> ${iso(bars.at(-1).t)} (${bars.length} bars)`);
  }

  // --- per-asset (200d) ---
  for (const [name, bars] of Object.entries(assets)) {
    const closes = bars.map(b => b.c);
    const { ret, bh } = buildStrat(closes, LOOKBACK);
    results[name] = evalGate(ret, bh, ret.length);
  }

  // --- pooled: equal-weight the two; each asset contributes 0.5*its strat return per day ---
  // Align on common date range. Build per-asset strat ret keyed by date, then combine.
  function stratByDate(bars, lookback) {
    const closes = bars.map(b => b.c);
    const m = new Map();
    let prevPos = 0;
    for (let i = lookback - 1; i < closes.length - 1; i++) {
      const s = sma(closes, i, lookback);
      const p = closes[i] > s ? 1 : 0;
      const mktRet = closes[i + 1] / closes[i] - 1;
      let r = p * mktRet;
      if (p !== prevPos) r -= COST;
      m.set(bars[i + 1].t, { strat: r, bh: mktRet });
      prevPos = p;
    }
    return m;
  }
  function pooled(lookback) {
    const ms = Object.values(assets).map(b => stratByDate(b, lookback));
    // common dates = present in all
    const dates = [...ms[0].keys()].filter(t => ms.every(m => m.has(t))).sort((a, b) => a - b);
    const sRet = [], bRet = [];
    for (const t of dates) {
      let s = 0, b = 0;
      for (const m of ms) { const e = m.get(t); s += 0.5 * e.strat; b += 0.5 * e.bh; }
      sRet.push(s); bRet.push(b);
    }
    return { sRet, bRet, dates };
  }
  const poolMain = pooled(LOOKBACK);
  results.POOLED = evalGate(poolMain.sRet, poolMain.bRet, poolMain.sRet.length);
  results.POOLED._span = `${iso(poolMain.dates[0])} -> ${iso(poolMain.dates.at(-1))} (${poolMain.dates.length} days)`;

  // --- print verdict table ---
  console.log('\n=== PRE-REGISTERED 200d TSMOM — VERDICT ===\n');
  const printRow = (name, R) => {
    const s = R.sFull, b = R.bFull;
    console.log(`--- ${name} ---`);
    console.log(`  STRATEGY  CAGR ${pct(s.cagr)}  Sharpe ${f2(s.sharpe)}  maxDD ${pct(s.maxDD)}  vol ${pct(s.vol)}`);
    console.log(`  BUY&HOLD  CAGR ${pct(b.cagr)}  Sharpe ${f2(b.sharpe)}  maxDD ${pct(b.maxDD)}  vol ${pct(b.vol)}`);
    console.log(`  Halves(strat Sharpe): H1 ${f2(R.sH1.sharpe)} vs B&H ${f2(R.bH1.sharpe)} | H2 ${f2(R.sH2.sharpe)} vs B&H ${f2(R.bH2.sharpe)}`);
    console.log(`  Gate: [Sharpe>=0.8 ${R.g1?'Y':'N'}] [beats B&H ${R.g2?'Y':'N'}] [DD-30% ${R.g3?'Y':'N'} (red ${pct(R.ddReduction)})] [both halves ${R.g4?'Y':'N'} (H1 ${R.h1ok?'Y':'N'}/H2 ${R.h2ok?'Y':'N'})]`);
    console.log(`  ==> ${R.pass ? 'PASS' : 'FAIL'}\n`);
  };
  for (const name of ['BTC', 'ETH', 'POOLED']) printRow(name, results[name]);

  // --- informational footnote: 100d / 50d (NOT the pre-registered spec) ---
  console.log('=== INFORMATIONAL ONLY (not the pre-registered spec, not used for verdict) ===');
  for (const lb of INFO_LOOKBACKS) {
    for (const [name, bars] of Object.entries(assets)) {
      const closes = bars.map(b => b.c);
      const { ret, bh } = buildStrat(closes, lb);
      const R = evalGate(ret, bh, ret.length);
      console.log(`  ${name} ${lb}d: strat Sharpe ${f2(R.sFull.sharpe)} (B&H ${f2(R.bFull.sharpe)}), DDred ${pct(R.ddReduction)} -> ${R.pass?'PASS':'FAIL'}`);
    }
    const p = pooled(lb);
    const R = evalGate(p.sRet, p.bRet, p.sRet.length);
    console.log(`  POOLED ${lb}d: strat Sharpe ${f2(R.sFull.sharpe)} (B&H ${f2(R.bFull.sharpe)}), DDred ${pct(R.ddReduction)} -> ${R.pass?'PASS':'FAIL'}`);
  }

  // expose for doc generation
  globalThis.__results = { results, btcSpan: `${iso(btc[0].t)} -> ${iso(btc.at(-1).t)}`, ethSpan: `${iso(eth[0].t)} -> ${iso(eth.at(-1).t)}` };
}

main();
