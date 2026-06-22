// Signal formatting + delta/velocity compute — extracted from server.mjs. Pure (state-free).

export function tickerDisplay(sym) { const i = sym.indexOf(":"); return i >= 0 ? sym.slice(i + 1) : sym; }

export const BIAS_RANK = { "STRONG BUY":0,"BUY":1,"WATCH":2,"SKIP":3,"AVOID":4,"SELL":5,"STRONG SELL":6 };
export const BEAR_BIASES = new Set(["STRONG SELL","SELL","AVOID"]);

// ── Signal Label Resolution ───────────────────────────────────────────────────
// Maps raw STRONG SELL bias to a context-aware label.
// STRONG BUY is unchanged — it is unambiguous in all markets.
// regime: 'bull' | 'neutral' | 'bear'
// isHolding: boolean — whether the user has an active position in this sym
export function resolveSignalLabel(bias, regime, isHolding) {
  if (bias !== 'STRONG SELL') return bias;
  if (isHolding) {
    return regime === 'bear' ? 'EXIT NOW' : 'EXIT';
  }
  return regime === 'bear' ? 'AVOID' : 'SKIP';
}

// ── Score velocity: 3-scan linear regression slope ────────────────────────────
export function computeVelocity(hist) {
  const pts = hist.slice(-3).map(h => h.s);
  if (pts.length < 2) return { slope: 0, direction: 'stable' };
  const n = pts.length, mx = (n - 1) / 2;
  const my = pts.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  pts.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
  const slope = den ? +(num / den).toFixed(2) : 0;
  const direction = slope >= 0.5 ? 'rising' : slope <= -0.5 ? 'falling' : 'stable';
  return { slope, direction };
}

// ── Sector classifier (rule-based, TASI code ranges) ─────────────────────────
export function sectorOf(sym) {
  const m = sym.match(/(\d+)$/);
  if (!m) {
    if (sym.includes('BTC') || sym.includes('ETH') || sym.includes('XRP')) return 'Crypto';
    if (sym.includes('TVC:') || sym.includes('NYMEX:') || sym.includes('COMEX:')) return 'Commodity';
    return 'US Equity';
  }
  const c = parseInt(m[1]);
  if (c >= 1010 && c <= 1180 && c < 1200) return 'Banking';
  if (c === 2222 || c === 2381 || c === 2382) return 'Energy';
  if ([2080,2082,2083,5110].includes(c)) return 'Utilities';
  if ([4007,4004,2160,4013,4005,4017,4341,4009,4338].includes(c)) return 'Healthcare';
  if ([4300,4310,4150,4323].includes(c)) return 'Real Estate';
  if ([4110,4040,4261,4262,4263,4264].includes(c)) return 'Transport';
  if ([2280,2050,6002,2281,6070,2270,2100].includes(c) || (c >= 6001 && c <= 6099)) return 'Food & Agri';
  if (c >= 7000 && c <= 7299) return 'Telecom & Tech';
  if (c >= 8000 && c <= 8300) return 'Insurance';
  if (c >= 3000 && c <= 3199) return 'Cement';
  if ([4190,4180,4003,4200,4260,4001,4006,4050,4051,4163,4240].includes(c)) return 'Retail';
  if (c >= 2010 && c <= 2399) return 'Petrochem';
  if (c >= 1200 && c <= 1330) return 'Industrial';
  if (c >= 1800 && c <= 1840) return 'Consumer';
  return 'Other';
}

export function getCritPasses(r) {
  const { ema13, ema34, ema89, ema200 } = r.emas || {};
  const bear = BEAR_BIASES.has(r.bias);
  return {
    emaStack: bear ? (ema13 < ema34 && ema34 < ema89) : (ema13 > ema34 && ema34 > ema89),
    ema200:   bear ? r.price < ema200 : r.price > ema200,
    rsi:      bear ? (r.rsi > 22 && r.rsi <= 48) : (r.rsi >= 52 && r.rsi < 78),
    macd:     bear ? r.macd_hist < 0 : r.macd_hist > 0,
    vol:      r.vol_ratio >= 1.2,
    vwap:     r.above_vwap != null ? (bear ? !r.above_vwap : r.above_vwap) : false,
  };
}

export const CRIT_LABELS = {
  emaStack: { pts: 2, bull: "EMA stack aligned (13>34>89)", bear: "EMA stack inverted (13<34<89)" },
  ema200:   { pts: 2, bull: "Price above EMA 200",         bear: "Price below EMA 200" },
  rsi:      { pts: 2, bull: "RSI in momentum zone (52–78)", bear: "RSI in weak zone (22–48)" },
  macd:     { pts: 1, bull: "MACD histogram positive",      bear: "MACD histogram negative" },
  vol:      { pts: 1, bull: "Volume above 1.2×",            bear: "Volume above 1.2×" },
  vwap:     { pts: 1, bull: "Price above 20-day VWAP",      bear: "Price below 20-day VWAP" },
};

export function computeDelta(newResults, prevResults, scoreHistory) {
  if (!prevResults?.length) return [];
  const prevMap = new Map(prevResults.map(r => [r.sym, r]));
  return newResults
    .map(r => {
      const prev = prevMap.get(r.sym);
      if (!prev) return null;
      const prevRank = BIAS_RANK[prev.bias] ?? 3;
      const currRank = BIAS_RANK[r.bias] ?? 3;
      if (prev.bias === r.bias && r.score === prev.score) return null;

      const prevCrit = getCritPasses(prev);
      const currCrit = getCritPasses(r);
      const bear = BEAR_BIASES.has(r.bias);
      const criteria_changes = Object.keys(CRIT_LABELS).map(key => {
        const was = !!prevCrit[key];
        const now = !!currCrit[key];
        if (was === now) return null;
        const { pts, bull, bear: bearLabel } = CRIT_LABELS[key];
        return { key, label: bear ? bearLabel : bull, pts, was, now };
      }).filter(Boolean);

      // Detect rapid direction reversal (e.g. STRONG SELL → BUY in one scan)
      const prevBearish = BEAR_BIASES.has(prev.bias);
      const currBearish = BEAR_BIASES.has(r.bias);
      const prevBullish = ['STRONG BUY','BUY','WATCH'].includes(prev.bias);
      const currBullish = ['STRONG BUY','BUY','WATCH'].includes(r.bias);
      const crossed_direction = (prevBearish && currBullish) || (prevBullish && currBearish);
      const rapid_reversal = crossed_direction && prev.score >= 5;

      // Count consecutive scans in previous direction from score history
      const hist = (scoreHistory || {})[r.sym] || [];
      let prev_streak = 0;
      for (let i = hist.length - 1; i >= 0; i--) {
        const h = hist[i];
        const hBear = BEAR_BIASES.has(h.b);
        if ((prevBearish && hBear) || (prevBullish && !hBear && !BEAR_BIASES.has(h.b))) {
          prev_streak++;
        } else break;
      }

      const prev_metrics = {
        rsi:       prev.rsi,
        macd_hist: prev.macd_hist,
        vol_ratio: prev.vol_ratio,
        price:     prev.price,
        emas:      prev.emas,
      };

      // Score trajectory over last 3 scans (to show trend direction)
      const trajectory = hist.slice(-3).map(h => ({ d: h.d, s: h.s, b: h.b }));

      return {
        sym: r.sym, name: r.name,
        prev_bias: prev.bias, curr_bias: r.bias,
        prev_score: prev.score, curr_score: r.score,
        score_delta: r.score - prev.score,
        direction: currRank < prevRank ? "improved" : "degraded",
        criteria_changes,
        prev_metrics,
        rapid_reversal,
        prev_streak,      // how many scans stock was in its previous direction
        trajectory,       // last 3 scan scores for context
      };
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.score_delta) - Math.abs(a.score_delta));
}
