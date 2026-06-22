/**
 * one_factor_test.mjs — does the 9-point STRONG BUY beat the one-line rule
 * `price > 200-EMA`? And can EITHER pick individual winners, or only work as a
 * statistical tilt? 20-session horizon, excess vs equal-weight TASI basket, no lookahead.
 *
 * Run: node scripts/one_factor_test.mjs
 */
import {
  fetchYahooOHLCV, toYahooSym, TASI_STOCKS,
  emaArray, calcRsi, macdHist, volumeCheck, calcVWAP, calcOBVTrend, findSRLevels, scoreBias,
} from './tasi_screener.mjs';

const H = 20, COST_RT = 0.0061, MIN_HISTORY = 210;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

function strongBuyAt(b, idx, idxChg63) {
  const s = (a) => a.slice(0, idx + 1);
  const closes = s(b.closes), highs = s(b.highs), lows = s(b.lows), volumes = s(b.volumes);
  if (closes.length < 50) return false;
  const price = closes.at(-1);
  const emas = { ema13: emaArray(closes,13).at(-1), ema34: emaArray(closes,34).at(-1), ema89: emaArray(closes,89).at(-1), ema200: emaArray(closes,200).at(-1) };
  const rsScore = (idxChg63 != null && closes.length >= 64) ? ((price-closes.at(-64))/closes.at(-64)*100 - idxChg63) : null;
  const sc = scoreBias(emas, calcRsi(closes,14), macdHist(closes), volumeCheck(volumes,true), price, 'swing', rsScore,
    { srLevels: findSRLevels(highs,lows,closes,5), avgVolume: volumes.slice(-20).reduce((a,c)=>a+(c||0),0)/20,
      rsScore60d: rsScore, isExtended:false, vwap20: calcVWAP(highs,lows,closes,volumes,20), obv_trend: calcOBVTrend(closes,volumes,20), isTasi:true });
  return sc.bias === 'STRONG BUY' && sc.score >= 7;
}
const above200 = (b, idx) => { const c = b.closes.slice(0, idx+1); return c.length >= 200 && c.at(-1) > emaArray(c,200).at(-1); };

const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : NaN;
const sd = a => { if (a.length<2) return NaN; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)); };
const med = a => { if(!a.length) return NaN; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const t = a => a.length>1 ? +(mean(a)/(sd(a)/Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => (x*100).toFixed(2)+'%';
const win = a => a.length ? (a.filter(x=>x>0).length/a.length*100).toFixed(0)+'%' : '–';

async function main() {
  const syms = TASI_STOCKS.map(s=>s.sym);
  const data = {};
  for (const sym of syms) {
    try { const bb = await fetchYahooOHLCV(toYahooSym(sym),'1d',520); if (bb.length<MIN_HISTORY) continue;
      const dates = bb.map(x=>iso(x.time));
      data[sym] = { dates, closes:bb.map(x=>x.close), highs:bb.map(x=>x.high), lows:bb.map(x=>x.low), volumes:bb.map(x=>x.volume), di:Object.fromEntries(dates.map((d,i)=>[d,i])) };
    } catch {}
  }
  const ib = await fetchYahooOHLCV('^TASI.SR','1d',520);
  const idxDates = ib.map(x=>iso(x.time)), idxClose = ib.map(x=>x.close);
  const usable = Object.keys(data);

  const ewCache = {};
  const ew = (date) => { if (date in ewCache) return ewCache[date]; const rs=[]; for (const s of usable){const d=data[s];const i=d.di[date];if(i==null||i+H>=d.closes.length)continue;rs.push(d.closes[i+H]/d.closes[i]-1);} return ewCache[date]=rs.length?mean(rs):null; };

  const last = idxDates.length-1-H, first = Math.max(MIN_HISTORY, idxDates.length-252-H);
  const idxEMA200 = emaArray(idxClose, 200);     // market-regime gate
  const sb = [], ema = [], sbRaw = [], basketRaw = [];
  const sbRawMktUp = [], sbRawMktDown = [];      // STRONG BUY raw return, split by market regime
  for (let di=first; di<=last; di++) {
    const date = idxDates[di]; const bench = ew(date); if (bench==null) continue;
    basketRaw.push(bench);
    const marketUp = idxClose[di] > idxEMA200[di];
    const idxChg63 = di>=63 ? (idxClose[di]-idxClose[di-63])/idxClose[di-63]*100 : null;
    for (const sym of usable) { const d=data[sym]; const i=d.di[date]; if (i==null||i<MIN_HISTORY||i+H>=d.closes.length) continue;
      const raw = d.closes[i+H]/d.closes[i]-1;
      const ex = raw - bench;
      if (strongBuyAt(d,i,idxChg63)) { sb.push(ex); sbRaw.push(raw); (marketUp?sbRawMktUp:sbRawMktDown).push(raw); }
      if (above200(d,i)) ema.push(ex);
    }
  }

  console.log(`\n=== 9-point STRONG BUY vs one-line "price > 200-EMA"  (H=${H} sessions, excess vs equal-weight basket) ===\n`);
  const row = (name,a)=>console.log(`  ${name.padEnd(22)} n=${String(a.length).padStart(5)}  excess ${pct(mean(a)).padStart(7)}  net ${pct(mean(a)-COST_RT).padStart(7)}  median ${pct(med(a)).padStart(7)}  hit ${win(a)}  t=${t(a)}  per-trade σ=${pct(sd(a))}`);
  row('STRONG BUY (9-pt)', sb);
  row('price > 200-EMA', ema);
  console.log(`\nINDIVIDUAL-NAME REALITY (what you'd feel per pick):`);
  console.log(`  STRONG BUY: mean edge ${pct(mean(sb))} but per-trade σ ${pct(sd(sb))} → signal-to-noise ${(mean(sb)/sd(sb)).toFixed(3)}`);
  console.log(`  → one pick's outcome is ~${(sd(sb)/Math.abs(mean(sb))).toFixed(0)}× the size of the edge. The edge only exists across many trades.`);
  console.log(`\n  Does the 9-pt score beat the 1-line rule? ${mean(sb) > mean(ema) ? 'marginally' : 'NO — the one-liner is as good or better'} (Δ ${pct(mean(sb)-mean(ema))})`);

  // ── The two probabilities the user wants shown side by side ──
  const pAbs   = sbRaw.filter(x=>x>0).length / sbRaw.length;       // % of picks that made money
  const pBeat  = sb.filter(x=>x>0).length / sb.length;            // % that beat buy-and-hold basket
  const pMktUp = basketRaw.filter(x=>x>0).length / basketRaw.length;
  console.log(`\n=== THE TWO PROBABILITIES (per STRONG BUY pick, ${H}-session) ===`);
  console.log(`  % made ABSOLUTE profit (any gain)      : ${(pAbs*100).toFixed(0)}%   mean raw return ${pct(mean(sbRaw))}`);
  console.log(`  % BEAT buy-and-hold (the honest one)   : ${(pBeat*100).toFixed(0)}%`);
  console.log(`  (context: basket was up ${(pMktUp*100).toFixed(0)}% of those windows — that's the bull-market tailwind)`);
  console.log(`\n=== YOUR 4-POSITION REALITY ===`);
  const rho = 0.5; const nPos = 4;
  const portSigma = sd(sbRaw) * Math.sqrt((1 + (nPos-1)*rho)/nPos);
  const edgePerMonth = mean(sb);
  console.log(`  Per-pick σ ${pct(sd(sbRaw))}. With 4 correlated TASI names (ρ≈${rho}), portfolio σ ≈ ${pct(portSigma)}/month.`);
  console.log(`  Monthly edge ≈ ${pct(edgePerMonth)} vs noise ${pct(portSigma)} → you will NOT feel it in your own P&L.`);
  const monthsToDetect = Math.round((2*portSigma/Math.max(edgePerMonth,1e-6))**2);
  console.log(`  Months of trading to prove the edge is real at your scale (t=2): ~${monthsToDetect}. Judge it via the validation spine (pools ALL signals), not your account.`);

  console.log(`\n=== MARKET-REGIME GATE: take STRONG BUY only when TASI index > its 200-EMA ===`);
  const pUp = sbRawMktUp.filter(x=>x>0).length/(sbRawMktUp.length||1);
  const pDn = sbRawMktDown.filter(x=>x>0).length/(sbRawMktDown.length||1);
  console.log(`  Market UP   : n=${sbRawMktUp.length}  ABSOLUTE mean ${pct(mean(sbRawMktUp))}  profit ${(pUp*100).toFixed(0)}%  t=${t(sbRawMktUp)}`);
  console.log(`  Market DOWN : n=${sbRawMktDown.length}  ABSOLUTE mean ${pct(mean(sbRawMktDown))}  profit ${(pDn*100).toFixed(0)}%  t=${t(sbRawMktDown)}`);
  console.log(`  Verdict: ${mean(sbRawMktUp) > 0 ? 'gating on a rising market turns ABSOLUTE return POSITIVE — harvestable.' : 'even gated on a rising market, absolute return is not positive.'}`);
  process.exit(0);
}
main();
