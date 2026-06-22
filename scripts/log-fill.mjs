/**
 * log-fill.mjs — log ACTUAL Derayah fills into the real ledger and read the book.
 *
 * Closes the loop on the monthly decision: after you place orders from
 * `npm run decision`, record what actually filled here. The ledger projects into
 * the `positions` blob, so next month's `decision` shows real HOLD/SELL, and the
 * realized P&L accrues into a live track record.
 *
 * Usage (needs --experimental-sqlite):
 *   npm run log-fill -- --sym 1120 --buy  --shares 100 --price 95.4
 *   npm run log-fill -- --sym 1120 --sell --shares 100 --price 102.0 --fees 1.2
 *   npm run log-fill -- --sym 1120 --buy  --shares 50 --price 96 --date 2026-07-01 --note "tranche 2"
 *   npm run log-fill -- --list                         # ledger + open book + realized P&L
 *   npm run log-fill -- --list --prices "1120:102,2222:30"   # add unrealized P&L at given prices
 *   npm run log-fill -- --remove 7                     # delete fill #7 (correction)
 *   npm run log-fill -- --list --json                  # machine-readable (JSON = last stdout line)
 *
 * Bare 4-digit codes normalize to TADAWUL:xxxx (same rule as decision --held).
 * Fees are optional and fold into cost basis (buys) / reduce proceeds (sells).
 */
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
const has = (flag) => process.argv.includes(flag);

const JSON_OUT = has('--json');
const QUIET    = has('--quiet') || JSON_OUT;

async function loadDeps() {
  const orig = console.log;
  if (QUIET) console.log = () => {};
  try {
    const db = await import('../dashboard/db.js');
    const fills = await import('../dashboard/fills.mjs');
    const tracking = await import('../dashboard/tracking.mjs');
    return { realFills: db.realFills, decisionSnapshots: db.decisionSnapshots,
             summarize: fills.summarize, compareToSnapshot: tracking.compareToSnapshot };
  } finally {
    console.log = orig;
  }
}

const fmt = (n) => (n >= 0 ? '+' : '−') + Math.abs(Math.round(n)).toLocaleString('en-US');
const pct1 = (n) => (n >= 0 ? '+' : '−') + Math.abs(+n).toFixed(1) + '%';   // slippage keeps a decimal
const sar = (n) => 'SAR ' + Math.round(n).toLocaleString('en-US');

// "1120:102,2222:30" → { 'TADAWUL:1120': 102, 'TADAWUL:2222': 30 }
function parsePrices(raw) {
  const out = {};
  for (const pair of (raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [sym, px] = pair.split(':');
    if (!sym || px == null) continue;
    const s = /^\d{4}$/.test(sym.trim()) ? `TADAWUL:${sym.trim()}` : sym.trim();
    out[s] = +px;
  }
  return out;
}

function printList(realFills, summarize, decisionSnapshots, compareToSnapshot) {
  const ledger = realFills.getAll();
  const book   = realFills.book();
  const prices = parsePrices(arg('--prices'));
  const sum    = summarize(book, prices);
  const snapshot = decisionSnapshots.getLatest();
  const track    = snapshot ? compareToSnapshot(snapshot, book) : null;

  if (JSON_OUT) {
    console.log(JSON.stringify({ ledger, open: book.open, realized: book.realized, realizedBySym: book.realizedBySym, summary: sum, tracking: track }));
    return;
  }

  const line = '─'.repeat(78);
  console.log('\n' + line);
  console.log('  MAWJAH — REAL FILL LEDGER');
  console.log(line);

  console.log(`\n  LEDGER (${ledger.length})`);
  if (!ledger.length) console.log('    — no fills logged yet. Log one with --buy/--sell.');
  for (const f of ledger) {
    const tag = f.action === 'buy' ? 'BUY ' : 'SELL';
    const note = f.note ? `  · ${f.note}` : '';
    console.log(`    #${String(f.id).padEnd(3)} ${f.date}  ${tag} ${String(f.shares).padStart(6)} ${f.sym.replace('TADAWUL:', '').padEnd(8)} @ ${String(f.price).padStart(8)}  fees ${f.fees || 0}${note}`);
  }

  console.log(`\n  OPEN BOOK (${book.open.length})`);
  if (!book.open.length) console.log('    — flat. No open positions.');
  for (const p of book.open) {
    const px = prices[p.sym];
    const upl = px != null ? `  mkt ${String(px).padStart(7)}  uPL ${fmt(p.shares * (px - p.avgCost))}` : '  (no live price)';
    console.log(`    ${p.sym.replace('TADAWUL:', '').padEnd(8)} ${(p.name || '').slice(0, 22).padEnd(22)} ${String(p.shares).padStart(6)} sh  avg ${String(p.avgCost).padStart(8)}  basis ${sar(p.costBasis).padStart(12)}${upl}`);
  }

  console.log(`\n  P&L`);
  console.log(`    realized    ${sar(sum.realized)}  (${fmt(sum.realized)})`);
  if (sum.priced) {
    console.log(`    unrealized  ${sar(sum.unrealized)}  (${fmt(sum.unrealized)})  · ${sum.priced} priced${sum.unpriced ? `, ${sum.unpriced} unpriced` : ''}`);
    console.log(`    total       ${sar(sum.totalPnl)}  (${fmt(sum.totalPnl)})`);
  } else if (book.open.length) {
    console.log(`    unrealized  — pass --prices "1120:102,…" for live MTM`);
  }
  console.log(`    open basis  ${sar(sum.costBasis)}`);

  // Plan vs Actual — execution fidelity against the saved decision snapshot.
  if (track) {
    const s = track.summary;
    console.log(`\n  PLAN vs ACTUAL   (plan for ${s.period}, as of ${s.asOf})`);
    console.log(`    coverage ${s.coveragePct}%  ·  ${s.held}/${s.planCount} plan names held` +
      (s.missed ? `  ·  ${s.missed} missed` : '') + (s.partial ? `  ·  ${s.partial} partial` : '') +
      (s.offPlan ? `  ·  ${s.offPlan} off-plan` : ''));
    if (s.avgEntrySlippagePct != null) console.log(`    avg entry slippage ${pct1(s.avgEntrySlippagePct)} vs decision price` +
      `  ·  intended ${sar(s.intendedBasis)} → actual ${sar(s.actualBasis)}`);
    const tag = { filled: '✓ filled ', partial: '~ partial', missed: '✗ missed ', off_plan: '! offplan' };
    for (const row of track.rows) {
      const slip = row.slippagePct != null ? `slip ${pct1(row.slippagePct)}` : '';
      const rank = row.rank != null ? `#${String(row.rank).padEnd(2)}` : '   ';
      console.log(`    ${tag[row.status]} ${rank} ${(row.sym || '').replace('TADAWUL:', '').padEnd(8)} ` +
        `tgt ${String(row.targetShares ?? '—').padStart(5)} sh @ ${String(row.decisionPrice ?? '—').padStart(7)}  ` +
        `held ${String(row.actualShares).padStart(5)} @ ${String(row.avgCost ?? '—').padStart(7)}  ${slip}`);
    }
  }

  console.log('\n' + line);
  console.log('  Fills are the source of truth. `npm run decision` now reads these as HOLD/SELL.');
  if (!track) console.log('  Save a plan to track execution: npm run decision -- --save');
  console.log(line + '\n');
}

async function main() {
  const { realFills, summarize, decisionSnapshots, compareToSnapshot } = await loadDeps();

  // --remove N
  const rm = arg('--remove');
  if (rm != null) {
    const r = realFills.remove(+rm);
    if (JSON_OUT) console.log(JSON.stringify(r));
    else console.log(r.removed ? `Removed fill #${rm}.` : `No fill #${rm}.`);
    process.exit(0);
  }

  // --list (default when no buy/sell)
  const isBuy = has('--buy'), isSell = has('--sell');
  if (has('--list') || (!isBuy && !isSell)) {
    printList(realFills, summarize, decisionSnapshots, compareToSnapshot);
    process.exit(0);
  }

  // log a fill
  const sym = arg('--sym');
  if (!sym) { console.error('ERROR: --sym required (e.g. --sym 1120)'); process.exit(1); }
  const r = realFills.log({
    sym,
    name:   arg('--name'),
    action: isBuy ? 'buy' : 'sell',
    shares: +arg('--shares'),
    price:  +arg('--price'),
    fees:   +(arg('--fees') || 0),
    date:   arg('--date'),
    note:   arg('--note'),
  });
  if (r.error) { console.error('ERROR:', r.error); process.exit(1); }

  if (JSON_OUT) { console.log(JSON.stringify(r)); process.exit(0); }
  const f = r.fill;
  console.log(`\n  Logged #${r.id}: ${f.action.toUpperCase()} ${f.shares} ${f.sym.replace('TADAWUL:', '')} @ ${f.price}${f.fees ? ` (fees ${f.fees})` : ''} on ${f.date}`);
  console.log(`  Open book: ${r.book.open.length} position(s) · realized P&L ${sar(r.book.realized)}`);
  console.log(`  Run \`npm run log-fill -- --list\` for the full book.\n`);
  process.exit(0);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}
