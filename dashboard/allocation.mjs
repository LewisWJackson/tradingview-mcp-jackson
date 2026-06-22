// ════════════════════════════════════════════════════════════════════════════
// Multi-asset allocation policy — pure module (no I/O).
//
// A configurable fixed-weight allocation across three sleeves:
//   TASI momentum / US-Sharia equity / gold.
//
// Validated by docs/research/2026-06-22-multi-asset-allocation.md:
//   50/30/20 quarterly rebalancing improved Sharpe 0.60 → 1.05,
//   maxDD −19.5% → −13.0%, +1.0%/yr rebalance premium (~5y sample, 2020–2026).
//   Honest caveat: gold's run flatters the period; weights are the user's to set.
// ════════════════════════════════════════════════════════════════════════════

export const DEFAULT_WEIGHTS = { tasi_momentum: 0.50, us_sharia: 0.30, gold: 0.20 };

export const SLEEVES = [
  { key: 'tasi_momentum', label: 'TASI Momentum',    note: 'Your Saudi momentum book (the validated edge)' },
  { key: 'us_sharia',     label: 'US-Sharia Equity', note: 'SPUS / HLAL' },
  { key: 'gold',          label: 'Gold',             note: 'GLD / SGOL / physical' },
];

// HOLD if the SAR delta for a sleeve is within this fraction of total book value.
const HOLD_BAND = 0.005; // 0.5%

// normalizeWeights(w): clamp each weight ≥ 0, then renormalize so they sum to 1.
// Guarantees the UI can never persist a broken (negative / non-summing) policy.
// If every weight is ≤ 0 (or missing), fall back to DEFAULT_WEIGHTS.
export function normalizeWeights(w = {}) {
  const keys = SLEEVES.map(s => s.key);
  const clamped = {};
  let sum = 0;
  for (const k of keys) {
    const v = Math.max(0, Number(w[k]) || 0);
    clamped[k] = v;
    sum += v;
  }
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  const out = {};
  for (const k of keys) out[k] = clamped[k] / sum;
  return out;
}

// computeRebalance({ values, weights }):
//   values  = { key: number SAR } current holdings per sleeve.
//   weights = target weights (normalized internally).
// Returns { total, sleeves:[...], maxDriftPct }.
// total = 0 (all zeros) → targets shown, no BUY/SELL actions.
export function computeRebalance({ values = {}, weights = DEFAULT_WEIGHTS } = {}) {
  const w = normalizeWeights(weights);
  const keys = SLEEVES.map(s => s.key);

  const current = {};
  let total = 0;
  for (const k of keys) {
    const v = Math.max(0, Number(values[k]) || 0);
    current[k] = v;
    total += v;
  }

  const holdThreshold = total * HOLD_BAND;
  let maxDriftPct = 0;

  const sleeves = SLEEVES.map(s => {
    const k = s.key;
    const cur = current[k];
    const targetPct = w[k];
    const currentPct = total > 0 ? cur / total : 0;
    const targetValue = total * targetPct;
    const drift = currentPct - targetPct;          // signed fraction (over/under)
    const delta = targetValue - cur;               // signed SAR to reach target

    let action = 'HOLD';
    if (total > 0 && Math.abs(delta) >= holdThreshold) {
      action = delta > 0 ? 'BUY' : 'SELL';
    }

    const driftPct = Math.abs(drift) * 100;
    if (driftPct > maxDriftPct) maxDriftPct = driftPct;

    return {
      key: k,
      label: s.label,
      note: s.note,
      current: cur,
      currentPct,
      targetPct,
      targetValue,
      drift,
      delta,
      action,
      amount: Math.abs(delta),   // abs SAR to BUY/SELL (0 on HOLD/total=0)
    };
  });

  return { total, sleeves, maxDriftPct };
}
