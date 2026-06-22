/**
 * index_flow.mjs — pure helpers for the MSCI index-flow event study. No I/O, no bars.
 * Unit-tested in tests/moneypath.test.js. Spec: docs/superpowers/specs/2026-06-21-msci-index-flow-design.md
 */

/** Simple return of a close-price array over inclusive index window [i, j]. null if invalid. */
export function windowReturn(closes, i, j) {
  if (!Array.isArray(closes) || i < 0 || j < 0 || i >= closes.length || j >= closes.length) return null;
  const a = closes[i], b = closes[j];
  if (!(a > 0) || !(b > 0)) return null;
  return b / a - 1;
}

/** Abnormal return = name window return minus benchmark window return (same index window). */
export function abnormalReturn(nameCloses, benchCloses, i, j) {
  const rn = windowReturn(nameCloses, i, j);
  const rb = windowReturn(benchCloses, i, j);
  if (rn == null || rb == null) return null;
  return rn - rb;
}

/** Index in an ascending ISO-date array of the first date on-or-after target. -1 if past the end. */
export function sliceByDate(dates, target) {
  if (!Array.isArray(dates) || !dates.length) return -1;
  for (let k = 0; k < dates.length; k++) if (dates[k] >= target) return k;
  return -1;
}
