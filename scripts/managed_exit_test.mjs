/**
 * managed_exit_test.mjs — does the 9-pt STRONG BUY make money when you MANAGE the trade
 * (target / stop / trailing-stop / timeout) instead of a dumb fixed hold?
 *
 * Reuses dashboard/backtest.mjs simulateTrades: enter when bullish_score >= minScore,
 * stop −1.5×ATR, target1 +1.5×ATR (then trail 1×ATR from breakeven), target2 +3×ATR,
 * timeout at holdBars. Cost = Derayah 0.11% RT (COST_RT env). Pools trades across the
 * whole TASI universe over ~2y (cache) and reports the honest money numbers.
 *
 * Run: COST_RT=0.0011 node --experimental-sqlite scripts/managed_exit_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { runBacktest } from '../dashboard/backtest.mjs';

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = x => isNaN(x) ? '—' : (x).toFixed(2) + '%';

async function main() {
  const ysyms = TASI_STOCKS.map(s => toYahooSym(s.sym));
  console.error(`loading ${ysyms.length} symbols ...`); await warm(ysyms, '10y');

  for (const minScore of [7, 8, 9]) {
    const all = [];
    let basketRets = [];
    for (const ys of ysyms) {
      const b = await getBars(ys, '10y');
      if (b.length < 260) continue;
      const bars = b.map(x => ({ time: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v }));
      // buy&hold of this name over the same window (context)
      basketRets.push((bars.at(-1).close / bars[0].close - 1) * 100);
      try {
        const r = runBacktest(bars, { minScore, holdBars: 40 });
        if (r.trades?.length) for (const t of r.trades) {
          const risk = (t.rawEntry - t.stop) / t.rawEntry;            // fraction risked
          const R = risk > 0 ? (t.pct / 100) / risk : null;            // R-multiple
          all.push({ pct: t.pct, R, outcome: t.outcome });
        }
      } catch {}
    }
    if (!all.length) { console.log(`minScore ${minScore}: no trades`); continue; }
    const pcts = all.map(t => t.pct);
    const Rs = all.map(t => t.R).filter(x => x != null);
    const wins = pcts.filter(x => x > 0), losses = pcts.filter(x => x <= 0);
    const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -losses.reduce((a, b) => a + b, 0);
    const PF = grossLoss ? grossWin / grossLoss : Infinity;
    const expectancyR = mean(Rs);
    const byOutcome = {};
    for (const t of all) (byOutcome[t.outcome] ||= []).push(t.pct);

    console.log(`\n=== MANAGED-EXIT 9-pt STRONG BUY  (minScore ${minScore}, stop/target/trail, Derayah cost) ===`);
    console.log(`  trades: ${all.length}  | win rate: ${(wins.length / all.length * 100).toFixed(0)}%`);
    console.log(`  avg net return / trade: ${pct(mean(pcts))}   median: ${pct(med(pcts))}`);
    console.log(`  avg R-multiple / trade: ${expectancyR.toFixed(2)}R   (profit measured in units of risk; >0 = edge)`);
    console.log(`  profit factor: ${PF.toFixed(2)}   (wins$ ÷ losses$; >1 = profitable)`);
    console.log(`  context — buy&hold avg per name over window: ${pct(mean(basketRets))}`);
    console.log(`  by exit reason:`);
    for (const [o, a] of Object.entries(byOutcome).sort((x, y) => y[1].length - x[1].length))
      console.log(`     ${o.padEnd(9)} n=${String(a.length).padStart(4)}  avg ${pct(mean(a))}`);
    const verdict = mean(pcts) > 0 && PF > 1 && expectancyR > 0;
    console.log(`  VERDICT: ${verdict ? 'MANAGED EXITS MAKE MONEY — different story, investigate.' : 'still loses money even with target/stop/trail management — confirms no harvestable edge.'}`);
  }
  process.exit(0);
}
main();
