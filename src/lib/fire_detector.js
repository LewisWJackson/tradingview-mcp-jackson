/**
 * Fire detector state machine: ARMED → PENDING → FIRED.
 *
 * Configurable:
 *   confirmPolls        Required consecutive above-trigger observations before FIRED (default 2)
 *   hysteresisPct       % below trigger price must reach before re-arming (default 0.5)
 *   maxFiresPerDay      Cap per ticker per trading day (default 2)
 *   staleQuoteMaxAgeMs  Quotes older than this are ignored for state transitions (default 5000)
 */

export function createFireDetector({
  confirmPolls = 2,
  hysteresisPct = 0.5,
  maxFiresPerDay = 2,
  staleQuoteMaxAgeMs = 5000,
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
      tickers.set(symbol, {
        ...emptyState(symbol, state.trigger),
        ...state,
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
   *   { fired: boolean, firedPrice?, confirmPollCount?, firstCrossObservedAt? }
   */
  function observe(symbol, { price, quoteAgeMs = 0, fireSuppressed = false, timestamp = new Date() }) {
    const s = tickers.get(symbol);
    if (!s) return { fired: false };
    s.lastPrice = price;

    // Stale guard: block any state promotion when the quote is old.
    // Reset pending so we re-confirm with fresh data.
    if (quoteAgeMs > staleQuoteMaxAgeMs || fireSuppressed) {
      s.lastSuppression = { reason: fireSuppressed ? 'source_stale' : 'quote_stale', at: timestamp.toISOString() };
      if (s.state === 'PENDING') {
        s.state = 'ARMED';
        s.pendingSince = null;
        s.confirmsSeen = 0;
      }
      return { fired: false };
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
      }
      return { fired: false };
    }

    if (price < s.trigger) {
      // Below trigger — reset to ARMED
      if (s.state === 'PENDING') {
        s.state = 'ARMED';
        s.pendingSince = null;
        s.confirmsSeen = 0;
        s.firstCrossObservedAt = null;
      }
      return { fired: false };
    }

    // price >= trigger
    if (s.state === 'ARMED') {
      s.state = 'PENDING';
      s.pendingSince = timestamp.toISOString();
      s.firstCrossObservedAt = timestamp.toISOString();
      s.confirmsSeen = 1;
      return { fired: false };
    }

    // s.state === 'PENDING'
    s.confirmsSeen++;
    if (s.confirmsSeen >= confirmPolls) {
      if (s.firesToday >= maxFiresPerDay) {
        // Daily cap — suppress
        s.lastSuppression = { reason: 'daily_cap', at: timestamp.toISOString() };
        // Promote to FIRED anyway so we don't keep confirming; will only re-fire after hysteresis reset
        s.state = 'FIRED';
        s.firedEventId = null;
        return { fired: false };
      }
      s.state = 'FIRED';
      s.firesToday++;
      return {
        fired: true,
        firedPrice: price,
        confirmPollCount: confirmPolls,
        firstCrossObservedAt: s.firstCrossObservedAt,
        confirmedAt: timestamp.toISOString(),
      };
    }
    return { fired: false };
  }

  /** Reset all tickers' daily-fire counters (called at start of each trading day). */
  function resetDailyCounters() {
    for (const s of tickers.values()) s.firesToday = 0;
  }

  return { upsertTicker, removeTicker, restoreState, observe, getState, snapshot, resetDailyCounters };
}
