/**
 * decision.mjs — standalone monthly decision printer for the validated Sharia-momentum edge.
 *
 * Prints this month's call WITHOUT the dashboard server: strategy state, Scheme-D sizing,
 * next rebalance date, BUY/HOLD/SELL vs your logged positions, and SAR-per-name. Reads the
 * same getMomentumScreen() the Lab tab uses, plus your real positions from the SQLite DB.
 *
 * Usage (needs --experimental-sqlite; fetches live bars for the TASI universe, ~1 min):
 *   npm run decision                 # default account SAR 100,000
 *   npm run decision -- --acct 250000
 *   DECISION_ACCT=50000 npm run decision
 *   npm run decision -- --json       # machine-readable (alerts/cron); JSON is the LAST stdout line
 *   npm run decision -- --quiet      # suppress the db boot log (--json implies --quiet)
 *   npm run --silent decision -- --json | jq      # clean pipe (--silent drops npm's own run banner)
 *   node --experimental-sqlite scripts/decision.mjs --json | jq   # or call node directly
 *   npm run decision -- --held "1120,2222"   # what-if HOLD/SELL vs these holdings (ignores DB)
 *   npm run decision -- --save               # lock this month's plan as the tracking snapshot
 *
 * Note: prices/picks are point-in-time. Re-run on the rebalance morning before trading —
 * the list can shift. Debt/cash ratios shown are indicative; confirm AAOIFI per name.
 */
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
const has = (flag) => process.argv.includes(flag);
const ACCT = +(arg('--acct') || process.env.DECISION_ACCT || 100000);
const JSON_OUT = has('--json');
const SAVE = has('--save');                  // persist this month's plan as the tracking snapshot
const QUIET = has('--quiet') || JSON_OUT;   // db.js logs "[db] migrated…" at import time
// --held "1120,2222" → what-if HOLD/SELL preview without logging positions in the DB first.
// Normalizes bare 4-digit codes to TADAWUL:xxxx (same rule as the Lab's addPosition). When
// given, it REPLACES the DB positions for this run.
export function normalizeHeld(raw) {
  return (raw || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(s => /^\d{4}$/.test(s) ? `TADAWUL:${s}` : s);
}
const HELD = normalizeHeld(arg('--held'));

// Dynamic import so we can mute the db boot log (it fires during module init, before any of
// our code would otherwise run — imported modules execute before a static importer's body).
async function loadDeps() {
  const orig = console.log;
  if (QUIET) console.log = () => {};
  try {
    const db = await import('../dashboard/db.js');
    const screen = await import('../dashboard/momentum_screen.mjs');
    const tracking = await import('../dashboard/tracking.mjs');
    return { dbPositions: db.positions, decisionSnapshots: db.decisionSnapshots,
             getMomentumScreen: screen.getMomentumScreen, sarPerName: screen.sarPerName,
             buildSnapshot: tracking.buildSnapshot };
  } finally {
    console.log = orig;
  }
}
const fmtSar = (n) => 'SAR ' + Math.round(n).toLocaleString('en-US');
const pct = (n) => (n >= 0 ? '+' : '') + (+n).toFixed(1) + '%';
// Pull "debt NN%" out of the indicative Sharia note so we can flag near-threshold names.
const debtPctOf = (s) => { const m = /debt\s*(\d+)%/i.exec(s || ''); return m ? +m[1] : null; };

function rowLine(h, perName) {
  const debt = debtPctOf(h.sharia);
  const flag = debt != null && debt >= 50 ? `  ⚠ debt ~${debt}%` : '';
  const shares = h.price > 0 ? Math.floor(perName / h.price) : 0;
  return `  #${String(h.rank).padEnd(2)} ${h.code}  ${(h.name || '').slice(0, 26).padEnd(26)} ` +
    `${String(h.price).padStart(8)}  6mo ${pct(h.mom6).padStart(7)}  1mo ${pct(h.ret1m).padStart(7)}` +
    `  ~${shares} sh${flag}`;
}

async function main() {
  const { dbPositions, decisionSnapshots, getMomentumScreen, sarPerName, buildSnapshot } = await loadDeps();
  const heldSyms = HELD.length ? HELD : Object.keys(dbPositions.getAll() || {});
  const r = await getMomentumScreen({ heldSyms });
  if (!r.success) { console.error('FAILED:', r.error); process.exit(1); }

  const exposurePct = r.sizing?.breakdown?.finalExposurePct ?? 0;
  const nHold = r.holdings.length;
  const sar = sarPerName({ accountSize: ACCT, exposurePct, nHoldings: nHold });

  // --save: persist this month's plan as the tracking snapshot (one per rebalance period).
  // Fills logged later are measured against it via `log-fill --list` / the Lab card.
  let saved = null;
  if (SAVE) {
    const snap = buildSnapshot({ screen: r, account: ACCT, perNameSAR: sar.perName });
    if (snap) saved = decisionSnapshots.save(snap);
  }

  // Machine-readable: stable shape for alerts/cron. Adds per-name share counts on top of
  // the raw screen payload; no terminal formatting.
  if (JSON_OUT) {
    const withShares = (items) => items.map((h) => ({
      ...h, shares: h.price > 0 ? Math.floor(sar.perName / h.price) : 0,
    }));
    console.log(JSON.stringify({
      asOf: r.asOf,
      nextRebalance: r.nextRebalance,
      state: r.state,
      sizing: { exposurePct, cashPct: 100 - exposurePct, breakdown: r.sizing?.breakdown, seasonal: r.seasonal },
      account: { size: ACCT, deploy: sar.totalDeployed, perName: sar.perName, cash: sar.cash },
      turnover: {
        buy: withShares(r.turnover?.buy || []),
        hold: withShares(r.turnover?.hold || []),
        sell: r.turnover?.sell || [],
      },
      holdings: r.holdings,
      validated: r.validated,
      savedSnapshot: saved || null,
    }));
    process.exit(0);
  }

  const line = '─'.repeat(78);
  console.log('\n' + line);
  console.log(`  MAWJAH — MONTHLY DECISION   (as of ${r.asOf})`);
  console.log(line);

  // State
  const st = r.state || {};
  console.log(`\n  STATE     ${String(st.status || '?').toUpperCase()}  ·  exposure ×${st.exposure_mult}`);
  if (st.reason) console.log(`            ${st.reason}`);

  // Sizing
  const bd = r.sizing?.breakdown || {};
  console.log(`\n  SIZING    deploy ${exposurePct}% of account  ·  ${100 - exposurePct}% cash`);
  console.log(`            (vol-target ${bd.targetVolPct}% / realized ${bd.realizedVolPct}% → raw ${bd.volTargetRaw}` +
    ` × season ${bd.seasonalMult} × state ${bd.stateMult})`);
  if (r.seasonal?.note) console.log(`            ${r.seasonal.note}`);

  // Money
  console.log(`\n  ACCOUNT   ${fmtSar(ACCT)}  →  deploy ${fmtSar(sar.totalDeployed)}` +
    `  ·  ${fmtSar(sar.perName)}/name  ·  ${fmtSar(sar.cash)} cash`);

  console.log(`\n  NEXT REBALANCE  ${r.nextRebalance}   (suggested monthly anchor — NOT a gate)`);
  console.log(`            The edge is the MONTHLY cycle, not the date. Starting fresh? Enter today,`);
  console.log(`            then lock to a fixed cadence (re-run on the 1st each month). The 6-month`);
  console.log(`            momentum signal is slow — today's picks ≈ the 1st's, so rushing gains little.`);

  // Trades
  const t = r.turnover || { buy: [], hold: [], sell: [] };
  const block = (label, items, withSize) => {
    console.log(`\n  ${label} (${items.length})`);
    if (!items.length) { console.log('    —'); return; }
    for (const h of items) {
      if (withSize && h.rank != null) console.log(rowLine(h, sar.perName));
      else console.log(`    ${h.code || h.sym}  ${(h.name || '').slice(0, 26)}`);
    }
  };
  block('BUY', t.buy, true);
  block('HOLD', t.hold, true);
  block('SELL', t.sell, false);

  console.log(`\n${line}`);
  console.log(`  Picks are point-in-time. ⚠ = debt ≥50% (near AAOIFI line) — confirm per name.`);
  console.log(`  Log fills (npm run log-fill -- --buy …) so next month shows real HOLD/SELL.`);
  if (saved?.ok) console.log(`  ✓ Plan saved for ${saved.period} — log-fill --list now shows Plan vs Actual.`);
  else console.log(`  Tip: add --save to lock this as the month's plan and track execution fidelity.`);
  console.log(line + '\n');
  process.exit(0);
}

// Run only when executed directly (not when imported by tests for the pure helpers).
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}
