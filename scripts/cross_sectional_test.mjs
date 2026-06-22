/**
 * cross_sectional_test.mjs — AVENUE 4: long-only cross-sectional tilt. Rank the TASI
 * universe monthly by a few INDEPENDENT factors (not the collinear 9), hold the top
 * quintile equal-weight, rebalance monthly. Does the tilt beat the equal-weight basket
 * net of cost, out-of-sample?
 *
 * Factors (each oriented so higher = expected-better), all causal (bars[0..t]):
 *   mom12_1  : return t-252→t-21 (classic 12-1 momentum, skip last month)
 *   rev1m    : −return last 21d (short-term reversal — TASI mean-reverts, prior finding)
 *   lowvol   : −stdev(daily ret last 60d) (low-volatility anomaly)
 *   mom6_1   : return t-126→t-21 (6-1 momentum)
 *
 * Benchmark = equal-weight basket (all names with data that month). Edge needs: monthly
 * excess mean>0, net of cost (quintile turnover×0.61%), t>2 on the non-overlapping
 * monthly excess series, AND positive in BOTH halves of the sample. Reports pairwise
 * rank correlation (independence) and per-quintile monotonicity.
 *
 * Survivorship: Yahoo = currently-listed names → optimistic, but benchmark eats the same
 * bias, so the long-short-ish excess is the cleaner read. Run: node scripts/cross_sectional_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const COST_RT = 0.0061, QTILE = 5;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const cum = a => a.reduce((v, r) => v * (1 + r), 1) - 1;
function maxDD(rets) { let v = 1, p = 1, dd = 0; for (const r of rets) { v *= 1 + r; if (v > p) p = v; const d = v / p - 1; if (d < dd) dd = d; } return dd; }
const cagrM = a => Math.pow(1 + cum(a), 12 / a.length) - 1;        // from monthly returns
function nwT(a, lag = 3) { const N = a.length; if (N < lag + 2) return NaN; const m = mean(a), e = a.map(x => x - m); let v = e.reduce((s, x) => s + x * x, 0) / N; for (let k = 1; k <= lag; k++) { let g = 0; for (let i = k; i < N; i++) g += e[i] * e[i - k]; g /= N; v += 2 * (1 - k / (lag + 1)) * g; } return +(m / Math.sqrt(v / N)).toFixed(2); }
function rankCorr(x, y) {  // Spearman via Pearson on ranks
  const rk = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([_, i], k) => r[i] = k); return r; };
  const rx = rk(x), ry = rk(y), mx = mean(rx), my = mean(ry);
  let n = 0, dx = 0, dy = 0; for (let i = 0; i < x.length; i++) { n += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return +(n / Math.sqrt(dx * dy)).toFixed(2);
}

async function main() {
  const syms = TASI_STOCKS.map(s => s.sym);
  const ysyms = syms.map(toYahooSym);
  console.error(`loading ${ysyms.length} symbols from cache ...`);
  await warm(ysyms, '10y');
  const data = {};
  for (let k = 0; k < syms.length; k++) {
    const b = await getBars(ysyms[k], '10y');
    if (b.length < 300) continue;
    const dates = b.map(x => iso(x.t)), closes = b.map(x => x.c);
    data[syms[k]] = { dates, closes, idx: Object.fromEntries(dates.map((d, i) => [d, i])) };
  }
  const names = Object.keys(data);
  console.error(`usable: ${names.length}`);

  // master monthly rebalance calendar = last trading day of each month (union of dates)
  const allDates = [...new Set(names.flatMap(s => data[s].dates))].sort();
  const rebal = [];
  for (let i = 0; i < allDates.length - 1; i++) if (allDates[i].slice(0, 7) !== allDates[i + 1].slice(0, 7)) rebal.push(allDates[i]);
  rebal.push(allDates.at(-1));

  const FACTORS = {
    mom12_1: (d, i) => (i >= 252 ? d.closes[i - 21] / d.closes[i - 252] - 1 : null),
    rev1m:   (d, i) => (i >= 21 ? -(d.closes[i] / d.closes[i - 21] - 1) : null),
    lowvol:  (d, i) => { if (i < 60) return null; const r = []; for (let k = i - 59; k <= i; k++) r.push(d.closes[k] / d.closes[k - 1] - 1); return -sd(r); },
    mom6_1:  (d, i) => (i >= 126 ? d.closes[i - 21] / d.closes[i - 126] - 1 : null),
  };
  const FN = Object.keys(FACTORS);

  // per-factor monthly excess series + quintile-spread series; also store cross-section for corr
  const exc = Object.fromEntries(FN.map(f => [f, []]));
  const qSpread = Object.fromEntries(FN.map(f => [f, []]));          // top quintile − bottom quintile
  const qBuckets = Object.fromEntries(FN.map(f => [f, Array.from({ length: QTILE }, () => [])]));
  const turn = Object.fromEntries(FN.map(f => [f, []]));
  const prevTop = Object.fromEntries(FN.map(f => [f, new Set()]));
  const corrAccum = Object.fromEntries(FN.map(f => [f, []]));        // pooled factor values (aligned)
  const corrNames = [];
  // absolute-return capture for the deep-dive (the BOTH-positive discipline check)
  const basketM = [];                                                 // basket abs return per month
  const absQ = Object.fromEntries(FN.map(f => [f, []]));              // top-quintile abs return
  const abs10 = Object.fromEntries(FN.map(f => [f, []]));            // top-10 abs return
  const turn10 = Object.fromEntries(FN.map(f => [f, []]));
  const prev10 = Object.fromEntries(FN.map(f => [f, new Set()]));

  for (let ri = 0; ri < rebal.length - 1; ri++) {
    const d0 = rebal[ri], d1 = rebal[ri + 1];
    // names present at both d0 and d1
    const rows = [];
    for (const s of names) { const a = data[s]; const i = a.idx[d0], j = a.idx[d1]; if (i == null || j == null) continue; const fwd = a.closes[j] / a.closes[i] - 1; const fv = {}; let ok = true; for (const f of FN) { const v = FACTORS[f](a, i); if (v == null || !isFinite(v)) { ok = false; break; } fv[f] = v; } if (!ok) continue; rows.push({ s, fwd, fv }); }
    if (rows.length < 30) continue;
    const basket = mean(rows.map(r => r.fwd));
    basketM.push(basket);
    // pooled values for correlation (z within month so cross-month comparable)
    for (const f of FN) { const vals = rows.map(r => r.fv[f]); const m = mean(vals), s2 = sd(vals); rows.forEach((r, k) => r['z_' + f] = s2 ? (vals[k] - m) / s2 : 0); }
    rows.forEach(r => { corrNames.push(1); FN.forEach(f => corrAccum[f].push(r['z_' + f])); });

    for (const f of FN) {
      const sorted = [...rows].sort((a, b) => b.fv[f] - a.fv[f]);   // high factor first
      const qn = Math.floor(sorted.length / QTILE);
      const top = sorted.slice(0, qn), bot = sorted.slice(-qn);
      const topRet = mean(top.map(r => r.fwd)), botRet = mean(bot.map(r => r.fwd));
      // turnover of top quintile
      const topSet = new Set(top.map(r => r.s));
      let changed = 0; for (const s of topSet) if (!prevTop[f].has(s)) changed++; const to = topSet.size ? changed / topSet.size : 0;
      prevTop[f] = topSet; turn[f].push(to);
      absQ[f].push(topRet);
      // top-10 concentrated (user trades few names)
      const top10 = sorted.slice(0, 10); const t10set = new Set(top10.map(r => r.s));
      let c10 = 0; for (const s of t10set) if (!prev10[f].has(s)) c10++; turn10[f].push(t10set.size ? c10 / t10set.size : 0); prev10[f] = t10set;
      abs10[f].push(mean(top10.map(r => r.fwd)));
      exc[f].push(topRet - basket);
      qSpread[f].push(topRet - botRet);
      // quintile buckets (excess vs basket) for monotonicity
      for (let q = 0; q < QTILE; q++) { const seg = sorted.slice(q * qn, (q + 1) * qn); qBuckets[f][q].push(mean(seg.map(r => r.fwd)) - basket); }
    }
  }

  const nMonths = exc[FN[0]].length;
  console.log(`\n=== AVENUE 4: CROSS-SECTIONAL long-only tilt — top quintile vs equal-weight basket ===`);
  console.log(`rebalances: ${nMonths} months | universe: ${names.length} names | ${rebal[0]} → ${rebal.at(-1)}`);
  console.log(`benchmark: equal-weight basket (names present that month) | cost: ${pct(COST_RT)} RT\n`);

  console.log(`── factor rank independence (Spearman on pooled within-month z) ──`);
  let hdr = '          '; for (const f of FN) hdr += f.padStart(9); console.log(hdr);
  for (const f of FN) { let line = f.padEnd(10); for (const g of FN) line += String(rankCorr(corrAccum[f], corrAccum[g])).padStart(9); console.log(line); }

  console.log(`\n── single-factor top-quintile, monthly excess vs basket (net of turnover cost) ──`);
  for (const f of FN) {
    const e = exc[f], avgTurn = mean(turn[f]); const costM = avgTurn * COST_RT;       // monthly cost
    const net = e.map(x => x - costM);
    const mid = Math.floor(e.length / 2);
    const h1 = net.slice(0, mid), h2 = net.slice(mid);
    const oos = mean(h1) > 0 && mean(h2) > 0;
    console.log(`  ${f.padEnd(8)} gross ${pct(mean(e)).padStart(7)}/mo  turn ${(avgTurn*100).toFixed(0)}% → cost ${pct(costM)}  NET ${pct(mean(net)).padStart(7)}/mo  t=${String(tstat(net)).padStart(5)}  spread(top-bot) ${pct(mean(qSpread[f]))}  OOS-both+? ${oos?'YES':'no'}`);
  }

  console.log(`\n── quintile monotonicity (mean monthly excess by quintile, Q1=highest factor) ──`);
  for (const f of FN) { const ms = qBuckets[f].map(b => mean(b)); console.log(`  ${f.padEnd(8)} ${ms.map((m,q)=>`Q${q+1} ${pct(m)}`).join('  ')}`); }

  console.log(`\n── annualized: best-NET single factor, compounded ──`);
  let best = null; for (const f of FN) { const costM = mean(turn[f]) * COST_RT; const net = exc[f].map(x => x - costM); const a = Math.pow(1 + cum(net), 12 / net.length) - 1; if (!best || a > best.a) best = { f, a, t: tstat(net) }; }
  console.log(`  ${best.f}: net excess CAGR over basket ${pct(best.a)}  t=${best.t}`);
  // ── DEEP-DIVE on momentum: ABSOLUTE return (both-positive discipline), NW t, cost stress, top-10, DD ──
  console.log(`\n── DEEP-DIVE: momentum factors — ABSOLUTE return, not just excess (the recurring trap) ──`);
  console.log(`  basket (equal-weight) : CAGR ${pct(cagrM(basketM))}  maxDD ${pct(maxDD(basketM))}`);
  for (const f of ['mom6_1', 'mom12_1']) {
    for (const [tag, abs, tn] of [['top-quintile(~34)', absQ[f], turn[f]], ['top-10 concentrated', abs10[f], turn10[f]]]) {
      for (const [clab, RT] of [['cost0.61%', 0.0061], ['cost1.2%(slip)', 0.012]]) {
        const costM = mean(tn) * RT; const net = abs.map(x => x - costM);
        const exNet = net.map((x, i) => x - basketM[i]);
        console.log(`  ${f} ${tag.padEnd(20)} ${clab.padEnd(14)}: ABS CAGR ${pct(cagrM(net)).padStart(8)}  maxDD ${pct(maxDD(net)).padStart(8)}  excessVSbasket ${pct(mean(exNet)*12).padStart(8)}/yr  NWt ${nwT(exNet)}`);
      }
    }
  }
  const m6net = absQ.mom6_1.map(x => x - mean(turn.mom6_1) * 0.0061);
  const m6ex = m6net.map((x, i) => x - basketM[i]);
  const absPos = cagrM(m6net) > COST_RT, exPos = mean(m6ex) > 0, sig = nwT(m6ex) > 2;
  console.log(`\nVERDICT: mom6_1 top-quintile — absolute>cost? ${absPos?'YES':'NO'} (CAGR ${pct(cagrM(m6net))}) | excess>0? ${exPos?'YES':'NO'} | NW-t>2? ${sig?'YES':'NO'} (${nwT(m6ex)}) | OOS-both+? ${(()=>{const mid=Math.floor(m6ex.length/2);return mean(m6ex.slice(0,mid))>0&&mean(m6ex.slice(mid))>0;})()?'YES':'NO'}`);
  console.log(`  ${absPos&&exPos&&sig ? 'REAL LEAD (pending survivorship haircut — momentum is the MOST survivorship-sensitive factor; this is the load-bearing caveat).' : 'Does not clear the honest bar.'}`);
  process.exit(0);
}
main();
