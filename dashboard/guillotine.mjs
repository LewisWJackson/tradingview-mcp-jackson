/**
 * guillotine.mjs — the ONE bar a signal must clear to earn "validated".
 *
 * Hard lesson (contract-flow, 2026-06-21): a pooled Newey-West t-stat is NOT proof. NW removes
 * serial correlation but NOT cross-sectional clustering — many names reacting to the same event
 * or month inflate a pooled t (the 9-pt score's pooled t=3.89 was really 0.74; contract-flow's
 * 2.94 was really 0.90). The only honest test is to trade the signal as a PORTFOLIO with ONE
 * observation per non-overlapping rebalance period, measure EXCESS vs an equal-weight basket,
 * and take the t-stat on that per-period series — it absorbs the clustering.
 *
 * This module is the shared, pure implementation of that verdict. Pass it the per-period excess
 * series (portfolio return − equal-weight basket return, one value per non-overlapping period).
 * No I/O. Unit-tested in tests/moneypath.test.js.
 */

export const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
export const sd = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
export const tstat = (a) => a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;

/**
 * The gate. Given the per-period EXCESS series (and optionally the per-period ABSOLUTE portfolio
 * series and a comparator/control excess series), return the verdict.
 *
 * PASS = enough periods AND positive mean excess AND per-period t > minT AND (if a control is
 * given) the signal beats its control. This is the bar momentum cleared (t=3.60) and the 9-pt
 * score + contract-flow failed.
 *
 * @param {number[]} excess  per-period excess returns (portfolio − equal-weight basket)
 * @param {object}  [opts]
 * @param {number}  [opts.minT=2]      significance bar on the per-period t
 * @param {number}  [opts.minPeriods=12]  refuse to rule on too-few periods
 * @param {number[]} [opts.abs]        per-period absolute portfolio returns (for context; if given,
 *                                     PASS also requires positive mean absolute — no relative-only edges)
 * @param {number[]} [opts.controlExcess]  a control signal's per-period excess (e.g. private vs govt);
 *                                     if given, PASS also requires mean(excess) > mean(controlExcess)
 * @returns {{periods,excessPerPeriod,t,absPerPeriod,beatsControl,pass,reason}}
 */
export function portfolioGuillotine(excess, opts = {}) {
  const { minT = 2, minPeriods = 12, abs = null, controlExcess = null } = opts;
  const periods = excess.length;
  const m = mean(excess);
  const t = tstat(excess);
  const absM = abs && abs.length ? mean(abs) : null;
  const beatsControl = controlExcess && controlExcess.length ? m > mean(controlExcess) : null;

  const reasons = [];
  if (periods < minPeriods) reasons.push(`only ${periods} periods (<${minPeriods}) — underpowered`);
  if (!(m > 0)) reasons.push(`excess not positive (${(m * 100).toFixed(2)}%)`);
  if (!(t > minT)) reasons.push(`per-period t ${isNaN(t) ? 'NaN' : t.toFixed(2)} ≤ ${minT}`);
  if (absM != null && !(absM > 0)) reasons.push(`absolute return not positive (${(absM * 100).toFixed(2)}%) — relative-only`);
  if (beatsControl === false) reasons.push('does not beat its control');

  const pass = reasons.length === 0;
  return {
    periods, excessPerPeriod: m, t, absPerPeriod: absM, beatsControl,
    pass,
    reason: pass
      ? `PASS — excess ${(m * 100).toFixed(2)}%/pd, per-period t ${t.toFixed(2)} > ${minT} (cross-clustering-robust)`
      : `FAIL — ${reasons.join('; ')}`,
  };
}
