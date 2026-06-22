/**
 * tracking.mjs — pure plan-vs-actual comparison for the operate loop.
 *
 * A "decision snapshot" captures what the strategy SAID to do for a rebalance
 * period (the top-ranked picks, the decision price, and the target SAR/shares per
 * name). compareToSnapshot() folds that against the real fill book so you can see
 * how faithfully you executed it: which plan names you actually hold (coverage),
 * how far your fill price drifted from the decision price (entry slippage), which
 * planned names you missed, and which names you hold that were NOT in the plan
 * (off-plan). No DB, no I/O — unit-testable in isolation.
 *
 * Tracking error here is execution fidelity, not return attribution: it answers
 * "did I trade the edge as designed?", which is the thing a live track record
 * needs to stay honest. Return attribution (book P&L vs a backtested basket) is a
 * separate, later layer and deliberately out of scope.
 */

const round = (n, d = 2) => +(+n).toFixed(d);

/**
 * @param {{period,asOf,picks:Array<{sym,name,rank,price,perNameSAR,targetShares}>}} snapshot
 * @param {{open:Array<{sym,name,shares,avgCost,costBasis}>}} book  (from realFills.book())
 * @returns {{rows:Array, summary:Object}|null} null when there's no snapshot
 */
export function compareToSnapshot(snapshot, book) {
  if (!snapshot || !Array.isArray(snapshot.picks)) return null;
  const open = book?.open || [];
  const openBySym = new Map(open.map(p => [p.sym, p]));
  const planSyms = new Set(snapshot.picks.map(p => p.sym));

  const rows = [];
  let heldPlan = 0, slipSum = 0, slipN = 0, intendedBasis = 0, actualBasis = 0;

  for (const pick of snapshot.picks) {
    const a = openBySym.get(pick.sym);
    const intended = pick.perNameSAR != null ? +pick.perNameSAR
                    : (+pick.targetShares || 0) * (+pick.price || 0);
    intendedBasis += intended;

    let status = 'missed', slippagePct = null, actualShares = 0, avgCost = null;
    if (a) {
      heldPlan++;
      actualShares = a.shares;
      avgCost = a.avgCost;
      actualBasis += a.costBasis;
      if (+pick.price > 0) { slippagePct = round((a.avgCost - pick.price) / pick.price * 100); slipSum += slippagePct; slipN++; }
      const tgt = +pick.targetShares || 0;
      status = (tgt && a.shares < tgt * 0.9) ? 'partial' : 'filled';
    }
    rows.push({
      sym: pick.sym, name: pick.name, rank: pick.rank ?? null,
      decisionPrice: pick.price ?? null, targetShares: pick.targetShares ?? null,
      intendedSAR: round(intended, 0), actualShares, avgCost, slippagePct, status,
    });
  }

  // Off-plan: names you hold that weren't in the plan.
  for (const p of open) {
    if (planSyms.has(p.sym)) continue;
    actualBasis += p.costBasis;
    rows.push({
      sym: p.sym, name: p.name, rank: null, decisionPrice: null, targetShares: 0,
      intendedSAR: 0, actualShares: p.shares, avgCost: p.avgCost, slippagePct: null, status: 'off_plan',
    });
  }

  const planCount = snapshot.picks.length;
  const missed  = rows.filter(r => r.status === 'missed').length;
  const partial = rows.filter(r => r.status === 'partial').length;
  const offPlan = rows.filter(r => r.status === 'off_plan').length;

  return {
    rows,
    summary: {
      period: snapshot.period ?? null,
      asOf: snapshot.asOf ?? null,
      planCount,
      held: heldPlan,           // plan names currently held (filled or partial)
      filled: heldPlan - partial,
      partial,
      missed,
      offPlan,
      coveragePct: planCount ? round(heldPlan / planCount * 100, 1) : 0,
      avgEntrySlippagePct: slipN ? round(slipSum / slipN) : null,
      intendedBasis: round(intendedBasis, 0),
      actualBasis: round(actualBasis, 0),
    },
  };
}

/**
 * Build a snapshot object from a getMomentumScreen() result + per-name sizing.
 * Pure shaper — the caller persists it. perNameSAR comes from sarPerName().perName.
 */
export function buildSnapshot({ screen, account, perNameSAR }) {
  if (!screen?.success) return null;
  return {
    period: screen.nextRebalance,
    asOf: screen.asOf,
    account: account ?? null,
    state: screen.state?.status ?? null,
    exposurePct: screen.sizing?.breakdown?.finalExposurePct ?? null,
    picks: (screen.holdings || []).map(h => ({
      sym: h.sym, code: h.code, name: h.name, rank: h.rank, price: h.price,
      perNameSAR: perNameSAR ?? null,
      targetShares: perNameSAR != null && h.price > 0 ? Math.floor(perNameSAR / h.price) : null,
    })),
  };
}
