/**
 * Fire detector state machine: ARMED → PENDING → FIRED.
 *
 * Configurable:
 *   confirmPolls        Required consecutive above-trigger observations before FIRED (default 2)
 *   hysteresisPct       % below trigger price must reach before re-arming (default 0.5)
 *   maxFiresPerDay      Cap per ticker per trading day (default 2)
 *   staleQuoteMaxAgeMs  Quotes older than this are ignored for state transitions (default 5000)
 *
 * Fire Strength Levels (additional to state machine, not a replacement):
 *   null — ARMED (idle, below trigger)
 *   1 — WATCH (PENDING — informational, not a trade action)
 *   2 — CONFIRMED (FIRED — standard alert)
 *   3 — HIGH CONVICTION (FIRED — priority alert: all technical signals + green risk)
 */

/**
 * Compute the upgrade-eligible fire strength level given a strengthContext.
 * Returns 3 iff all three technical signals are true AND risk band is green.
 * Otherwise returns 2 (default for any confirmed fire with context).
 */
function computeFireStrength(ctx) {
  if (!ctx) return 2;
  const allTechnicalsGreen =
    ctx.volumeExpansion === true &&
    ctx.relativeStrength === true &&
    ctx.cleanStructure === true;
  if (allTechnicalsGreen && ctx.riskBand === 'green') return 3;
  return 2;
}

/**
 * Build the strengthBreakdown object that ships on a fire event.
 * Explains why a fire was awarded its strength so consumers can reason about it.
 */
function summarizeStrength(ctx, finalLevel) {
  if (!ctx) {
    return { reason: 'no_context_default_level_2' };
  }
  const hasVolumeExpansion = ctx.volumeExpansion === true;
  const hasRelativeStrength = ctx.relativeStrength === true;
  const hasCleanStructure = ctx.cleanStructure === true;
  const riskBand = ctx.riskBand || 'unknown';
  const wouldHaveBeenLevel3 =
    hasVolumeExpansion && hasRelativeStrength && hasCleanStructure;
  const downgradedByRisk = wouldHaveBeenLevel3 && riskBand !== 'green';
  return {
    hasVolumeExpansion,
    hasRelativeStrength,
    hasCleanStructure,
    riskBand,
    wouldHaveBeenLevel3,
    downgradedByRisk,
  };
}

export function createFireDetector({
  confirmPolls = 2,
  hysteresisPct = 0.5,
  maxFiresPerDay = 2,
  // 30s default tolerates Yahoo's regularMarketTime lag on low-volume tickers
  // (often 5-30s behind wall-clock). Quotes older than this are treated as
  // stale and cannot promote state. Override per-deployment if needed.
  staleQuoteMaxAgeMs = 30_000,
} = {}) {
  /** @type {Map<string, object>} */
  const tickers = new Map();

  function emptyState(symbol, trigger) {
    return {
      symbol, trigger,
      state: 'ARMED',        // ARMED | PENDING | FIRED
      lastPrice: null,
      pendingSince: null,
      confirmsSeen: 0,
      firstCrossObservedAt: null,
      firedEventId: null,
      firesToday: 0,
      lastSuppression: null,
      fireStrength: null,    // null | 1 (WATCH) | 2 (CONFIRMED) | 3 (HIGH CONVICTION)
      lastFireLevel: null,   // Last emitted FIRE-level strength (used to preserve across cap re-fires)
    };
  }

  function upsertTicker({ symbol, trigger }) {
    const existing = tickers.get(symbol);
    if (existing) {
      existing.trigger = trigger;
      return;
    }
    tickers.set(symbol, emptyState(symbol, trigger));
  }

  function removeTicker(symbol) { tickers.delete(symbol); }

  function restoreState(persistedTickers) {
    for (const [symbol, state] of Object.entries(persistedTickers)) {
      // Defensive coalesce: legacy snapshots may have fireStrength/lastFireLevel
      // explicitly undefined; empty state's nulls should win in that case.
      tickers.set(symbol, {
        ...emptyState(symbol, state.trigger),
        ...state,
        fireStrength: state.fireStrength ?? null,
        lastFireLevel: state.lastFireLevel ?? null,
      });
    }
  }

  function getState(symbol) { return tickers.get(symbol); }

  function snapshot() {
    const out = {};
    for (const [symbol, state] of tickers) out[symbol] = { ...state };
    return out;
  }

  /**
   * Observe a new quote for a ticker. Returns:
   *   { fired: boolean, fireStrength: null|1|2|3, firedPrice?, confirmPollCount?,
   *     firstCrossObservedAt?, confirmedAt?, strengthBreakdown? }
   */
  function observe(symbol, {
    price,
    quoteAgeMs = 0,
    fireSuppressed = false,
    timestamp = new Date(),
    strengthContext = null,
  }) {
    const s = tickers.get(symbol);
    if (!s) return { fired: false, fireStrength: null };
    s.lastPrice = price;

    // Stale guard: block any state promotion when the quote is old.
    // Reset pending so we re-confirm with fresh data.
    if (quoteAgeMs > staleQuoteMaxAgeMs || fireSuppressed) {
      s.lastSuppression = { reason: fireSuppressed ? 'source_stale' : 'quote_stale', at: timestamp.toISOString() };
      if (s.state === 'PENDING') {
        s.state = 'ARMED';
        s.pendingSince = null;
        s.confirmsSeen = 0;
        s.fireStrength = null;
      }
      // FIRED state and existing fireStrength are preserved untouched.
      return { fired: false, fireStrength: s.fireStrength };
    }

    if (s.state === 'FIRED') {
      // Check hysteresis for potential re-arm
      const hysBand = s.trigger * (1 - hysteresisPct / 100);
      if (price < hysBand) {
        // Pull back enough to re-arm
        s.state = 'ARMED';
        s.pendingSince = null;
        s.confirmsSeen = 0;
        s.firstCrossObservedAt = null;
        s.fireStrength = null;
        return { fired: false, fireStrength: null };
      }
      return { fired: false, fireStrength: s.fireStrength };
    }

    if (price < s.trigger) {
      // Below trigger — reset to ARMED
      if (s.state === 'PENDING') {
        s.state = 'ARMED';
        s.pendingSince = null;
        s.confirmsSeen = 0;
        s.firstCrossObservedAt = null;
        s.fireStrength = null;
      }
      return { fired: false, fireStrength: null };
    }

    // price >= trigger
    if (s.state === 'ARMED') {
      s.state = 'PENDING';
      s.pendingSince = timestamp.toISOString();
      s.firstCrossObservedAt = timestamp.toISOString();
      s.confirmsSeen = 1;
      s.fireStrength = 1; // WATCH
      return { fired: false, fireStrength: 1 };
    }

    // s.state === 'PENDING'
    s.confirmsSeen++;
    if (s.confirmsSeen >= confirmPolls) {
      if (s.firesToday >= maxFiresPerDay) {
        // Daily cap — suppress emission but transition to FIRED so we don't keep confirming.
        // PRESERVE the prior fired-level strength (lastFireLevel) rather than the
        // transient PENDING value — capped re-fires should not downgrade or wipe
        // the original fire's strength.
        s.lastSuppression = { reason: 'daily_cap', at: timestamp.toISOString() };
        s.state = 'FIRED';
        s.firedEventId = null;
        if (s.lastFireLevel != null) s.fireStrength = s.lastFireLevel;
        return { fired: false, fireStrength: s.fireStrength };
      }
      s.state = 'FIRED';
      s.firesToday++;
      const level = computeFireStrength(strengthContext);
      s.fireStrength = level;
      s.lastFireLevel = level;
      const strengthBreakdown = summarizeStrength(strengthContext, level);
      return {
        fired: true,
        fireStrength: level,
        firedPrice: price,
        confirmPollCount: confirmPolls,
        firstCrossObservedAt: s.firstCrossObservedAt,
        confirmedAt: timestamp.toISOString(),
        strengthBreakdown,
      };
    }
    // Still PENDING, awaiting more confirmations
    return { fired: false, fireStrength: 1 };
  }

  /** Reset all tickers' daily-fire counters (called at start of each trading day). */
  function resetDailyCounters() {
    for (const s of tickers.values()) s.firesToday = 0;
  }

  return { upsertTicker, removeTicker, restoreState, observe, getState, snapshot, resetDailyCounters };
}
