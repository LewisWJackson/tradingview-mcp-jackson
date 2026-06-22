/**
 * fills.mjs — pure book math for the real (Derayah) fill ledger.
 *
 * The fill ledger is the source of truth: an append-only list of actual buys/sells.
 * computeBook() folds it into current holdings + realized P&L; summarize() adds
 * unrealized P&L when live prices are supplied. No DB, no I/O — unit-testable in
 * isolation. The DB store (db.js → realFills) persists fills and projects the open
 * book back into the `positions` blob that decision.mjs / exit-check read.
 *
 * Convention: weighted-average cost. BUY fees fold into the cost basis; SELL fees
 * reduce proceeds. Realized P&L is recognized on each sell against the running
 * average cost (you can't sell more shares than you hold — oversells are clamped).
 */

const round = (n, d = 4) => +(+n).toFixed(d);

/**
 * Fold an ordered list of fills into an open book + realized P&L.
 * @param {Array<{sym,name?,action:'buy'|'sell',shares,price,fees?,date?}>} fills
 * @returns {{positions:Object, open:Array, realized:number, realizedBySym:Object}}
 */
export function computeBook(fills = []) {
  const pos = {};                 // sym -> { sym, name, shares, avgCost, costBasis, lastDate }
  const realizedBySym = {};
  let realized = 0;

  for (const f of fills) {
    const sym = f.sym;
    if (!sym) continue;
    const shares = +f.shares || 0;
    const price  = +f.price || 0;
    const fees   = +(f.fees || 0);
    if (!pos[sym]) pos[sym] = { sym, name: f.name || sym, shares: 0, avgCost: 0, costBasis: 0, lastDate: f.date || null };
    const p = pos[sym];
    if (f.name) p.name = f.name;
    if (f.date) p.lastDate = f.date;

    if (f.action === 'buy') {
      p.costBasis += shares * price + fees;   // buy fees fold into basis
      p.shares    += shares;
      p.avgCost    = p.shares > 0 ? p.costBasis / p.shares : 0;
    } else if (f.action === 'sell') {
      const sellShares = Math.min(shares, p.shares);   // clamp oversell
      const costOut    = p.avgCost * sellShares;
      const proceeds   = sellShares * price - fees;    // sell fees reduce proceeds
      const pnl        = proceeds - costOut;
      realized += pnl;
      realizedBySym[sym] = (realizedBySym[sym] || 0) + pnl;
      p.shares    -= sellShares;
      p.costBasis -= costOut;
      if (p.shares <= 1e-9) { p.shares = 0; p.costBasis = 0; p.avgCost = 0; }
    }
  }

  for (const p of Object.values(pos)) {
    p.shares    = round(p.shares);
    p.avgCost   = round(p.avgCost);
    p.costBasis = round(p.costBasis);
  }
  for (const k of Object.keys(realizedBySym)) realizedBySym[k] = round(realizedBySym[k], 2);

  const open = Object.values(pos).filter(p => p.shares > 1e-9);
  return { positions: pos, open, realized: round(realized, 2), realizedBySym };
}

/**
 * Add unrealized P&L to a computed book given a { sym: price } map. Unrealized is
 * summed only over open names that HAVE a live price; unpriced names are counted
 * but excluded from market value so the number stays honest.
 */
export function summarize(book, priceMap = {}) {
  let costBasisPriced = 0, marketValue = 0, costBasisAll = 0, priced = 0, unpriced = 0;
  for (const p of book.open) {
    costBasisAll += p.costBasis;
    const px = priceMap[p.sym];
    if (px != null && px > 0) { marketValue += p.shares * px; costBasisPriced += p.costBasis; priced++; }
    else unpriced++;
  }
  const unrealized = round(marketValue - costBasisPriced, 2);
  return {
    openCount: book.open.length,
    costBasis: round(costBasisAll, 2),
    marketValue: round(marketValue, 2),
    unrealized,
    realized: book.realized,
    totalPnl: round(book.realized + unrealized, 2),
    priced,
    unpriced,
  };
}
