/**
 * pead.mjs — pure helpers for the PEAD earnings-drift study. No I/O, no bars.
 * Unit-tested in tests/moneypath.test.js. Spec: docs/superpowers/specs/2026-06-21-pead-design.md
 */

export function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
}

/** 4 breakpoints (the 20/40/60/80th percentiles) splitting values into 5 groups. */
export function quantileBreakpoints(values) {
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => {
    if (!s.length) return NaN;
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
    return s[idx];
  };
  return [at(0.2), at(0.4), at(0.6), at(0.8)];
}

/** Bucket a value into 0..4 by ascending breakpoints (value <= bp[i] → bucket i; else top). */
export function assignQuintile(value, breakpoints) {
  for (let i = 0; i < breakpoints.length; i++) if (value <= breakpoints[i]) return i;
  return breakpoints.length; // = 4, the top quintile
}
