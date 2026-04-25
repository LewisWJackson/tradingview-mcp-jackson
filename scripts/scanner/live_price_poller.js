/**
 * Live price poller — orchestrates quote-source chain + fire detector + risk flags.
 *
 * Designed for injection: the server wires real dependencies; tests wire mocks.
 *
 * Each tick():
 *   1. Skip if market closed (isMarketOpen() === false).
 *   2. Sync the detector's ticker set with the latest scanner candidates
 *      (upserts new ones, removes ones that fell off the list).
 *   3. Fetch quotes via the injected chain (which handles fallback + audit metadata).
 *   4. For each candidate:
 *        a. Evaluate risk flags BEFORE detector observe so riskBand can flow
 *           into strengthContext (used to decide Level 2 vs Level 3 fires).
 *        b. Call detector.observe() — edge-triggered: only emits a fired=true
 *           on the FIRED transition, never on sustained above-trigger ticks.
 *        c. If fired, build the full event with chain audit metadata
 *           (activeSource, degraded, sourceAttempts) plus fireStrength,
 *           strengthBreakdown, and risk flags, then invoke onFire().
 */

import { createFireDetector } from '../../src/lib/fire_detector.js';
import { evaluateRiskFlags } from '../../src/lib/risk_flags.js';

export function createLivePoller({
  getCandidates,      // () => { candidates: [...], scanRunId?: string }
  chain,              // quote-source chain (createQuoteChain output)
  onFire,             // (event) => void
  onTick,             // optional (tickerSnapshot) => void — per-symbol heartbeat
  onError,            // (err) => void
  isMarketOpen,       // () => boolean
  getMarketContext,   // optional () => { vix, spxChangePct, qqqChangePct, regimeMultiplier, vixRegime }
  detectorOptions,    // passed through to createFireDetector
}) {
  const detector = createFireDetector(detectorOptions);
  let pollSequence = 0;
  let lastCandidateSet = new Set();

  function syncCandidates() {
    const c = getCandidates();
    const current = new Set(c.candidates.map(x => x.symbol));
    for (const cand of c.candidates) {
      detector.upsertTicker({ symbol: cand.symbol, trigger: cand.trigger });
    }
    for (const sym of lastCandidateSet) {
      if (!current.has(sym)) detector.removeTicker(sym);
    }
    lastCandidateSet = current;
    return c;
  }

  async function tick() {
    if (!isMarketOpen()) return { skipped: 'market_closed' };
    pollSequence++;

    const { candidates, scanRunId } = syncCandidates();
    if (!candidates.length) return { skipped: 'no_candidates' };

    const symbols = candidates.map(c => c.symbol);
    let fetchResult;
    try {
      fetchResult = await chain.fetchQuotes(symbols);
    } catch (err) {
      onError?.({ type: 'fetch_error', error: err.message });
      return { skipped: 'fetch_error' };
    }

    const now = new Date();
    const marketContext = getMarketContext ? getMarketContext() : {};

    for (const cand of candidates) {
      const quote = fetchResult.quotes[cand.symbol];
      if (!quote || quote.price == null) {
        onTick?.({ symbol: cand.symbol, price: null, stale: true });
        continue;
      }

      // Evaluate risk flags BEFORE observing, so we can pass `strengthContext`
      // to the detector (riskBand affects whether a fire is Level 2 or Level 3).
      const risk = evaluateRiskFlags({
        scannerRow: cand.raw ?? { details: cand.details ?? {}, notes: cand.notes ?? '' },
        quote,
        recentNewsCount24h: cand.recentNewsCount24h ?? 0,
        atr14: cand.atr14 ?? null,
      });

      // strengthContext: the detector uses this only at the FIRED-transition moment.
      // We pass it on every observe so it's available whenever the fire happens.
      const strengthContext = {
        volumeExpansion: cand.volumeExpansion ?? false,
        relativeStrength: cand.relativeStrength ?? false,
        cleanStructure: cand.cleanStructure ?? false,
        riskBand: risk.overallRiskBand,
      };

      const result = detector.observe(cand.symbol, {
        price: quote.price,
        quoteAgeMs: quote.quoteAgeMs,
        fireSuppressed: quote.fireSuppressed,
        timestamp: now,
        strengthContext,
      });

      // Emit the post-observe snapshot so consumers see the state AFTER this tick,
      // not the prior tick's state.
      onTick?.({
        symbol: cand.symbol,
        price: quote.price,
        trigger: cand.trigger,
        source: quote.quoteSource,
        state: detector.getState(cand.symbol)?.state,
        fireStrength: result.fireStrength,
      });

      if (result.fired) {
        // Trade-plan contract (§15). Schema is locked and always-present; values are
        // null until generation logic lands post-ship. planReason is a human-readable
        // string explaining why no real plan exists, or null when one is populated.
        const chainDegraded = fetchResult.degraded === true
          || (fetchResult.activeSource && fetchResult.activeSource !== 'yahoo');
        const planReason = chainDegraded
          ? `Degraded quote source (${fetchResult.activeSource || 'unknown'}) — no trade plan generated. Verify on broker before acting.`
          : 'Trade plan generation logic not yet implemented (schema reserved).';

        const tradePlan = {
          stock: {
            entryPrice: null,
            stopLoss: null,
            takeProfit1: null,
            takeProfit2: null,
            takeProfit3: null,
            riskPerShare: null,
            rewardPotential: null,
            riskRewardRatio: null,
            decision: null,
          },
          options: {
            strategy: null,
            strike: null,
            expiration: null,
            premium: null,
            breakEven: null,
            probabilityOfTouch: null,
            capitalRequired: null,
            decision: null,
          },
          finalDecision: null,
          planReason,
        };

        const event = {
          ticker: cand.symbol,
          trigger: {
            level: cand.trigger,
            source: 'scanner_v3',
            scanRunId,
            entryTriggerText: cand.triggerText,
          },
          price: {
            firedPrice: quote.price,
            bid: quote.bid,
            ask: quote.ask,
            spreadAbsolute: quote.spreadAbsolute,
            spreadPctOfPrice: quote.spreadPctOfPrice,
            quoteSource: quote.quoteSource,
            quoteAgeMs: quote.quoteAgeMs,
            openToday: quote.openToday,
            prevClose: quote.prevClose,
            dayChangePct: quote.prevClose
              ? +(((quote.price - quote.prevClose) / quote.prevClose) * 100).toFixed(2)
              : null,
            gapFromPrevClose: quote.prevClose
              ? +(((quote.openToday - quote.prevClose) / quote.prevClose) * 100).toFixed(3)
              : null,
          },
          debounce: {
            confirmPollCount: result.confirmPollCount,
            firstCrossObservedAt: result.firstCrossObservedAt,
            confirmedAt: result.confirmedAt,
            latencyFromFirstCrossMs:
              result.firstCrossObservedAt && result.confirmedAt
                ? new Date(result.confirmedAt) - new Date(result.firstCrossObservedAt)
                : null,
          },
          setup: {
            confidence: cand.confidence,
            confidenceBand: cand.confidenceBand,
            setupType: cand.setupType,
            compositeScore: cand.compositeScore ?? null,
            probabilityScore: cand.probabilityScore,
            rank: cand.rank,
          },
          marketContext,
          riskFlags: risk,
          fireStrength: result.fireStrength,
          strengthBreakdown: result.strengthBreakdown,
          audit: {
            activeSource: fetchResult.activeSource,
            degraded: fetchResult.degraded,
            sourceAttempts: fetchResult.sourceAttempts,
          },
          tradePlan,
          pollSequence,
          timestamp: now.toISOString(),
        };
        onFire?.(event);
      }
    }
    return { polled: true, pollSequence };
  }

  return { tick, detector };
}
