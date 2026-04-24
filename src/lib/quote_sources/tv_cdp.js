/**
 * TradingView Desktop CDP quote client.
 *
 * Fallback source for the live feed. Requires TradingView Desktop running with
 * --remote-debugging-port=9222 and the symbol visible in the user's TV
 * watchlist (TV only keeps live quotes for symbols it's subscribed to).
 *
 * Only used when Yahoo degrades. Per-symbol calls, not a batch — TV's internal
 * API is one-at-a-time. That's fine for 15 symbols at 15s cadence (~1s total).
 *
 * Phase B contract:
 * - When dataCore.getQuote(sym) returns null (symbol not watched in TV),
 *   quotes[sym] = null. Auditable, not silent.
 * - When dataCore.getQuote(sym) throws, the failure is captured per-symbol in
 *   `failed[]` with { symbol, error, kind }. The function does NOT throw on
 *   partial failures — it only throws when ALL symbols fail (i.e. CDP itself
 *   is unreachable).
 * - All-symbol failure throws a typed Error with `kind = 'source_unreachable'`,
 *   `source = 'tv_cdp'`, `status = null` (CDP is not HTTP).
 *
 * Source attribution lives at the chain layer (Task 7); this module deliberately
 * does NOT stamp `quoteSource: 'tv_cdp'` onto each row — the chain does, after
 * deciding which source actually answered.
 */

/**
 * @param {string[]} symbols - tickers to quote (Yahoo format accepted; strips prefixes)
 * @param {object}   options
 * @param {object}   options.dataCore - injected getter with { getQuote(symbol): Promise<quote|null> }.
 *                                      In production this is src/core/data.js's getQuote wrapper.
 * @returns {Promise<{quotes: Object, fetchedAt: Date, failed: Array, missing: string[]}>}
 */
export async function tvCdpFetchQuotes(symbols, { dataCore }) {
  const fetchedAt = new Date();
  const quotes = {};
  const failed = [];

  for (const sym of symbols) {
    try {
      const raw = await dataCore.getQuote(sym);
      if (!raw) {
        quotes[sym] = null;
        continue;
      }
      const bid = raw.bid ?? null;
      const ask = raw.ask ?? null;
      const price = raw.last ?? raw.close ?? null;
      const spreadAbsolute = (bid != null && ask != null) ? +(ask - bid).toFixed(4) : null;
      const spreadPctOfPrice = (spreadAbsolute != null && price) ? +((spreadAbsolute / price) * 100).toFixed(2) : null;
      const epoch = raw.time ?? null;
      quotes[sym] = {
        symbol: sym,
        price, bid, ask, spreadAbsolute, spreadPctOfPrice,
        averageDailyVolume10Day: null,
        volume: raw.volume ?? null,
        prevClose: raw.prevClose ?? null,
        openToday: raw.open ?? null,
        marketTimeEpochSec: epoch,
        marketTimeIso: epoch ? new Date(epoch * 1000).toISOString() : null,
      };
    } catch (err) {
      failed.push({
        symbol: sym,
        error: err.message,
        kind: err.kind ?? null,
        source: 'tv_cdp',
      });
    }
  }

  if (failed.length === symbols.length && symbols.length > 0) {
    const err = new Error(`TV CDP all-symbol failure: ${failed[0].error}`);
    err.kind = 'source_unreachable';
    err.source = 'tv_cdp';
    err.status = null;
    err.sourceFailures = failed;
    throw err;
  }

  // `missing` mirrors the Yahoo client contract. In practice it should always
  // be [] here because we explicitly write `quotes[sym] = null` for null
  // responses — but compute it anyway so the chain has a uniform shape.
  const missing = symbols.filter(s => !(s in quotes) && !failed.some(f => f.symbol === s));

  return { quotes, fetchedAt, failed, missing };
}
