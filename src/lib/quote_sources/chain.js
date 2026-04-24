/**
 * Fallback chain orchestrator: tries quote sources in priority order.
 *
 * Phase B linchpin module — composes Yahoo (Task 5) + TV CDP (Task 6) behind a
 * uniform contract. Each "source" is { name, fetch(symbols): Promise<{quotes, fetchedAt}> }.
 *
 * Priorities:
 * 1. Source attribution on every quote — `quoteSource` is stamped HERE
 *    (the chain), never inside the underlying source modules.
 * 2. Typed errors from sources flow through unchanged so the chain can audit
 *    the failure mode (rate_limit / timeout / source_unreachable / etc.).
 * 3. Per-source consecutive-failure counts. When a source exceeds
 *    flipAfterFailures, the chain flips to the next priority source.
 * 4. Periodic recovery probe re-tests the primary; on success, flips back.
 * 5. When ALL sources fail, the chain serves last-known quotes from an
 *    internal cache with quoteSource='stale' and fireSuppressed=true so the
 *    fire detector skips stale data. The chain NEVER throws in this case —
 *    the dashboard must stay alive during outages.
 *
 * Return shape (always includes audit trail):
 *   { quotes, fetchedAt, activeSource, degraded, sourceAttempts, error? }
 *   - sourceAttempts: [{ name, ok, error: { kind, status, message } | null }]
 *
 * Consumed by Task 10's live poller every 15s; probe() runs every 5min when
 * degraded.
 */

export function createQuoteChain({ sources, flipAfterFailures = 5, probeIntervalMs = 5 * 60_000 }) {
  if (!sources || !sources.length) {
    throw new Error('createQuoteChain: need at least one source');
  }

  let activeIdx = 0;
  const failureCounts = sources.map(() => 0);
  const cache = new Map(); // symbol -> { quote, source, cachedAt }
  let lastProbeAt = 0;

  function activeSource() { return sources[activeIdx]; }
  function activeSourceName() { return sources[activeIdx].name; }

  async function tryFetch(source, symbols) {
    const out = await source.fetch(symbols);
    const now = Date.now();
    for (const sym of Object.keys(out.quotes)) {
      const q = out.quotes[sym];
      if (q == null) continue;
      const marketTime = q.marketTimeIso ? new Date(q.marketTimeIso).getTime() : now;
      q.quoteSource = source.name;
      q.quoteAgeMs = Math.max(0, now - marketTime);
      cache.set(sym, { quote: { ...q }, source: source.name, cachedAt: now });
    }
    return out;
  }

  function recordAttempt(attempts, source, err) {
    attempts.push({
      name: source.name,
      ok: !err,
      error: err
        ? {
            kind: err.kind ?? null,
            status: err.status ?? null,
            message: err.message,
          }
        : null,
    });
  }

  async function fetchQuotes(symbols) {
    const attempts = [];

    // Try the active source first.
    try {
      const out = await tryFetch(activeSource(), symbols);
      failureCounts[activeIdx] = 0;
      recordAttempt(attempts, activeSource(), null);
      return {
        ...out,
        activeSource: activeSourceName(),
        degraded: activeIdx > 0, // still degraded if not on primary
        sourceAttempts: attempts,
      };
    } catch (err) {
      failureCounts[activeIdx]++;
      recordAttempt(attempts, activeSource(), err);

      // Flip to next source if threshold hit and a next source exists.
      if (failureCounts[activeIdx] >= flipAfterFailures && activeIdx < sources.length - 1) {
        activeIdx++;
        try {
          const out = await tryFetch(activeSource(), symbols);
          failureCounts[activeIdx] = 0;
          recordAttempt(attempts, activeSource(), null);
          return {
            ...out,
            activeSource: activeSourceName(),
            degraded: true, // flipped, so degraded
            sourceAttempts: attempts,
          };
        } catch (err2) {
          failureCounts[activeIdx]++;
          recordAttempt(attempts, activeSource(), err2);
          // If still more sources behind us, keep cascading.
          while (failureCounts[activeIdx] >= flipAfterFailures && activeIdx < sources.length - 1) {
            activeIdx++;
            try {
              const out = await tryFetch(activeSource(), symbols);
              failureCounts[activeIdx] = 0;
              recordAttempt(attempts, activeSource(), null);
              return {
                ...out,
                activeSource: activeSourceName(),
                degraded: true,
                sourceAttempts: attempts,
              };
            } catch (errN) {
              failureCounts[activeIdx]++;
              recordAttempt(attempts, activeSource(), errN);
            }
          }
          return serveStale(symbols, err2, attempts);
        }
      }

      // No flip available (already on last source) — serve stale.
      if (activeIdx === sources.length - 1) {
        return serveStale(symbols, err, attempts);
      }

      // Still have flip budget but haven't hit threshold — propagate so caller
      // retries on next cycle. The next call will count toward the threshold.
      throw err;
    }
  }

  function serveStale(symbols, underlyingErr, attempts = []) {
    const now = Date.now();
    const quotes = {};
    for (const sym of symbols) {
      const entry = cache.get(sym);
      if (!entry) {
        quotes[sym] = null;
        continue;
      }
      // Prefer market-time-based age (matches tryFetch semantics). Fall back
      // to cache-insertion time if the cached row lacks a marketTimeIso.
      const marketTime = entry.quote.marketTimeIso
        ? new Date(entry.quote.marketTimeIso).getTime()
        : entry.cachedAt;
      quotes[sym] = {
        ...entry.quote,
        quoteSource: 'stale',
        quoteAgeMs: Math.max(0, now - marketTime),
        fireSuppressed: true,
      };
    }
    return {
      quotes,
      fetchedAt: new Date(now),
      activeSource: 'stale',
      degraded: true,
      sourceAttempts: attempts,
      error: underlyingErr?.message || 'all sources failed',
    };
  }

  async function probe(symbols) {
    if (activeIdx === 0) return { flipped: false, reason: 'already_primary' };
    if (Date.now() - lastProbeAt < probeIntervalMs) {
      return { flipped: false, reason: 'probe_throttled' };
    }
    lastProbeAt = Date.now();
    try {
      await tryFetch(sources[0], symbols);
      activeIdx = 0;
      failureCounts.fill(0);
      return { flipped: true, restoredSource: sources[0].name };
    } catch (err) {
      return { flipped: false, reason: 'probe_failed', error: err.message };
    }
  }

  function cachePrime(symbol, quote, sourceName) {
    cache.set(symbol, { quote: { ...quote }, source: sourceName, cachedAt: Date.now() });
  }

  return { fetchQuotes, probe, activeSourceName, cachePrime };
}
