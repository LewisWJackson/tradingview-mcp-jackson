/**
 * compounding_geometry.mjs — pure sizing-lever helpers for Test Plan #1.
 *
 * These turn the SAME momentum picks into a smarter-sized portfolio without any new
 * prediction. No I/O, no bars — pure functions, unit-tested in tests/moneypath.test.js.
 * Vol-targeting is NOT here: reuse schemeDExposure from momentum_screen.mjs (it already
 * caps gross exposure at 1, i.e. never leverages — correct for a no-leverage account).
 * Spec: docs/research/2026-06-21-test-plan-1-compounding-geometry.md
 */

/** Annualized volatility (price-swing size) of a daily-return series. null if <2 points. */
export function annualizedVol(dailyReturns, periodsPerYear = 252) {
  if (!dailyReturns || dailyReturns.length < 2) return null;
  const m = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const v = dailyReturns.reduce((a, b) => a + (b - m) ** 2, 0) / (dailyReturns.length - 1);
  return Math.sqrt(v) * Math.sqrt(periodsPerYear);
}

/**
 * Conviction weights across picks: higher momentum → higher weight (rank-linear:
 * best name gets weight ∝ N, worst ∝ 1), normalized to sum 1, then capped at maxWeight
 * with the excess redistributed to uncapped names. Falls back to equal weight when the
 * cap is mathematically infeasible (maxWeight × N < 1).
 */
export function convictionWeights(momScores, { maxWeight = 0.25 } = {}) {
  const n = momScores.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  if (maxWeight * n < 1 + 1e-12) return momScores.map(() => 1 / n); // cap infeasible

  // rank-linear weights: best momentum → rank n, worst → rank 1
  const order = momScores.map((m, i) => [m, i]).sort((a, b) => b[0] - a[0]);
  const rankW = new Array(n);
  for (let r = 0; r < n; r++) rankW[order[r][1]] = n - r;
  const sum = rankW.reduce((a, b) => a + b, 0);
  let w = rankW.map(x => x / sum);

  // iteratively cap + redistribute excess to uncapped names (proportional)
  for (let iter = 0; iter < 100; iter++) {
    const over = [];
    for (let i = 0; i < n; i++) if (w[i] > maxWeight + 1e-12) over.push(i);
    if (!over.length) break;
    let excess = 0;
    for (const i of over) { excess += w[i] - maxWeight; w[i] = maxWeight; }
    const under = [];
    for (let i = 0; i < n; i++) if (w[i] < maxWeight - 1e-12) under.push(i);
    const underSum = under.reduce((a, i) => a + w[i], 0);
    if (underSum <= 0) break;
    for (const i of under) w[i] += excess * (w[i] / underSum);
  }
  return w;
}

/**
 * Drawdown brake: a circuit breaker (no prediction). Trips when equity is more than
 * `threshold` below its running peak, cutting exposure to `brakeMult`. Releases only once
 * equity recovers to within `threshold*recoverFrac` of the peak (hysteresis stops flicker).
 * Pure state transition — caller passes current eq/peak and the prior braked flag, sized
 * BEFORE the period's return is known (no look-ahead).
 */
export function drawdownBrake({ eq, peak, braked, threshold = 0.15, recoverFrac = 0.5, brakeMult = 0.5 } = {}) {
  const dd = peak > 0 ? eq / peak - 1 : 0;
  let nowBraked = braked;
  if (!braked && dd <= -threshold) nowBraked = true;
  else if (braked && dd >= -threshold * recoverFrac) nowBraked = false;
  return { mult: nowBraked ? brakeMult : 1, braked: nowBraked };
}
