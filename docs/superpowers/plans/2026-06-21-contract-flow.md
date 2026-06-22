# Contract-Flow (Govt/Vision-2030 Award Drift) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test whether contract awards from government / SOE / Vision-2030 counterparties, to liquid (non-micro) TASI companies, drift up over 20 trading days after announcement.

**Architecture:** Two new files reusing the PEAD/flow event-study pipeline. Pure classifier helpers in `dashboard/contract_flow.mjs` (counterparty + anti-leakage gate, unit-tested), and a by-hand research study `scripts/contract_flow_test.mjs` that reads `type='contract'` events from `catalyst_events`, classifies counterparty, filters to liquid matured awards, computes 20-day forward abnormal drift (via `index_flow.mjs` helpers vs `^TASI.SR`), and prints a govt-vs-private verdict. No new table.

**Tech Stack:** Node 22 ESM, `node:sqlite` via `dashboard/db.js` (needs `--experimental-sqlite`), `scripts/bars_cache.mjs`, `scripts/tasi_screener.mjs` (`toYahooSym`), `dashboard/index_flow.mjs` (`abnormalReturn`/`sliceByDate`), `dashboard/pead.mjs` (`mean`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-21-contract-flow-design.md`.

**Key reused conventions:**
- Contract events in `catalyst_events` (`type='contract'`), symbols `TADAWUL:${code}`, with `headline`.
- Abnormal-return + date→index helpers exist in `dashboard/index_flow.mjs`; `mean` in `dashboard/pead.mjs`.
- Research scripts (`*_test.mjs`) run by hand with `--experimental-sqlite`, NOT in `npm test`.
- Liquidity = trailing-60d `close×volume`, same as `strategy_validation.mjs`.

---

## Task 1: Pure classifier helpers + unit tests

**Files:**
- Create: `dashboard/contract_flow.mjs`
- Modify: `tests/moneypath.test.js` (append a describe block + import)

- [ ] **Step 1: Write the failing tests**

Add the import near the other imports at the top of `tests/moneypath.test.js`:

```javascript
import { classifyCounterparty, isContractHeadline } from '../dashboard/contract_flow.mjs';
```

Append this block:

```javascript
describe('contract_flow helpers', () => {
  it('classifyCounterparty tags government/SOE/Vision-2030 counterparties', () => {
    assert.equal(classifyCounterparty('Arabian Pipes Co. Announces Contracts Sign Off with Saudi Aramco'), 'govt');
    assert.equal(classifyCounterparty('Itmam Consultancy Co. Announces Project Award with Riyadh Region Municipality'), 'govt');
    assert.equal(classifyCounterparty('SRMG announces the award of a contract by the Ministry of Culture'), 'govt');
    assert.equal(classifyCounterparty('Anmat Technology received a purchase order from Saudi Electricity Company'), 'govt');
    assert.equal(classifyCounterparty('Co. announces a contract with NEOM Company'), 'govt');
  });
  it('classifyCounterparty tags private counterparties as private', () => {
    assert.equal(classifyCounterparty('Group Five Pipe Saudi Co. Announces Contract Sign Off with Esnad Al Turuq Contracting Company'), 'private');
    assert.equal(classifyCounterparty('Saudi Parts Center Co. Announces receipt of a purchase order from Al-Khorayef Industries'), 'private');
  });
  it('isContractHeadline keeps real awards, drops misfiled rows', () => {
    assert.equal(isContractHeadline('Arabian Pipes Co. Announces Contracts Sign Off with Saudi Aramco'), true);
    assert.equal(isContractHeadline('Wajd Life Trading Co. Announces Project Award with Majmaah University'), true);
    assert.equal(isContractHeadline('Atlas Elevators announces its Annual Financial results for the period ending'), false);
    assert.equal(isContractHeadline("Almuneef Company Announces the Board's Recommendation to Increase Capital"), false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:money 2>&1 | grep -iE "fail|cannot find module|contract_flow"`
Expected: FAIL — `Cannot find module '../dashboard/contract_flow.mjs'`.

- [ ] **Step 3: Implement the helpers**

Create `dashboard/contract_flow.mjs`:

```javascript
/**
 * contract_flow.mjs — pure helpers for the contract-award drift study. No I/O, no bars.
 * Unit-tested in tests/moneypath.test.js. Spec: docs/superpowers/specs/2026-06-21-contract-flow-design.md
 */

// Government / SOE / Vision-2030 counterparty terms. Match = the award comes from a public-sector
// or megaproject buyer (the retail-under-reaction hypothesis). Lowercase, substring match.
const GOVT_TERMS = [
  'aramco', 'ministry', 'municipalit', 'saudi electricity', 'national water', 'water company',
  'neom', 'public investment fund', ' pif', 'royal commission', 'national guard', 'authority',
  'university', 'government', 'tatweer', 'red sea', 'roshn', 'diriyah', 'qiddiya', 'sabic',
  'saudi railway', 'sar ', 'general organization', 'ministry of', 'governorate', 'public transport',
];

/** 'govt' if the headline names a government/SOE/Vision-2030 counterparty, else 'private'. */
export function classifyCounterparty(headline) {
  const h = (headline || '').toLowerCase();
  return GOVT_TERMS.some(t => h.includes(t)) ? 'govt' : 'private';
}

// Anti-leakage: the upstream 'contract' classifier is leaky (some rows are financial-results /
// capital-increase). Keep only headlines that actually denote an award.
const AWARD_RE = /contract|project award|project sign|awarded|award with|purchase order|sign off|signing of a|tender/i;

/** true if the headline denotes an actual contract/award (not a misfiled financial/capital row). */
export function isContractHeadline(headline) {
  return AWARD_RE.test(headline || '');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:money 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: all pass, `fail 0` (3 new tests).

> Note: `'sar '` (with trailing space) targets "Saudi Arabian Railway"/"SAR" as a counterparty token while avoiding matching the SAR currency mid-word; the trailing space + lowercasing keeps it from firing on "sar" inside other words. If a private headline trips a govt term in the real run, tighten the list — the output prints the govt/private split for a sanity spot-check.

- [ ] **Step 5: Commit**

```bash
git add dashboard/contract_flow.mjs tests/moneypath.test.js
git commit -m "feat(contract-flow): pure counterparty classifier + anti-leakage gate + tests"
```

---

## Task 2: Contract-flow event-study script

**Files:**
- Create: `scripts/contract_flow_test.mjs`

- [ ] **Step 1: Implement the study**

Create `scripts/contract_flow_test.mjs`:

```javascript
/**
 * contract_flow_test.mjs — do GOVT/Vision-2030 contract awards to LIQUID TASI companies drift up
 * over 20 trading days? Reaction to forced/under-reacted megaproject flow (alt-data layer #4).
 *
 * For each matured 'contract' catalyst (anti-leakage gated): classify counterparty (govt|private),
 * compute trailing-60d liquidity, keep the top-half-liquid set, measure 20d forward abnormal drift
 * [+1,+21] vs ^TASI. Compare govt vs private. Net 0.11% RT + slippage. NW-t, trim-one, underpowered.
 * Single 4-month window (Feb→Jun 2026). Run: node --experimental-sqlite scripts/contract_flow_test.mjs
 * Spec: docs/superpowers/specs/2026-06-21-contract-flow-design.md
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym } from './tasi_screener.mjs';
import { db } from '../dashboard/db.js';
import { sliceByDate } from '../dashboard/index_flow.mjs';
import { mean } from '../dashboard/pead.mjs';
import { classifyCounterparty, isContractHeadline } from '../dashboard/contract_flow.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const SLIP = +process.env.SLIP || 0.0015;
const DRIFT_DAYS = +process.env.DRIFT_DAYS || 20;
const MIN_N = +process.env.MIN_N || 30;
function nwT(x, L = 5) {
  const n = x.length; if (n < 3) return NaN;
  const m = mean(x), e = x.map(v => v - m);
  let v = e.reduce((s, q) => s + q * q, 0) / n;
  for (let l = 1; l <= L; l++) { let g = 0; for (let t = l; t < n; t++) g += e[t] * e[t - l]; g /= n; v += 2 * (1 - l / (L + 1)) * g; }
  const se = Math.sqrt(v / n); return se > 0 ? m / se : NaN;
}
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && +d.slice(5, 7) >= 1 && +d.slice(5, 7) <= 12 && +d.slice(8, 10) >= 1 && +d.slice(8, 10) <= 31;

function abnAligned(nC, benchC, iN, jN, iB, jB) {
  if (iN > jN || iB > jB || iN < 0 || iB < 0 || jN >= nC.length || jB >= benchC.length) return null;
  const rn = (nC[iN] > 0 && nC[jN] > 0) ? nC[jN] / nC[iN] - 1 : null;
  const rb = (benchC[iB] > 0 && benchC[jB] > 0) ? benchC[jB] / benchC[iB] - 1 : null;
  if (rn == null || rb == null) return null;
  return rn - rb;
}
function report(label, arr) {
  const d = arr.map(r => r.drift);
  const net = d.length ? mean(d) - COST_RT - 2 * SLIP : NaN;
  console.log(`  ${label.padEnd(16)} n=${String(arr.length).padStart(3)}  drift ${pct(mean(d)).padStart(7)}  net ${pct(net).padStart(7)}  NW-t ${(nwT(d) || 0).toFixed(2)}`);
  return { netMean: net, raw: d };
}

(async () => {
  const cutoff = new Date(Date.now() - (DRIFT_DAYS + 15) * 864e5).toISOString().slice(0, 10);
  const raw = db.prepare("SELECT sym, event_date, headline FROM catalyst_events WHERE type='contract'").all();
  const events = raw.filter(r => validDate(r.event_date) && r.event_date <= cutoff && isContractHeadline(r.headline));
  if (!events.length) { console.log('No matured contract-award events found.'); process.exit(0); }

  const syms = [...new Set(events.map(e => e.sym))];
  await warm(syms.map(toYahooSym).concat('^TASI.SR'), '10y');
  const ib = await getBars('^TASI.SR', '10y');
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

  const recs = []; let skipped = 0;
  for (const ev of events) {
    const b = await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 90) { skipped++; continue; }
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c), nV = b.map(x => x.v || 0);
    const aB = sliceByDate(benchDates, ev.event_date), aN = sliceByDate(nDates, ev.event_date);
    if (aB < 0 || aN < 0 || aN < 60) { skipped++; continue; }
    const drift = abnAligned(nC, benchC, aN + 1, aN + 1 + DRIFT_DAYS, aB + 1, aB + 1 + DRIFT_DAYS);
    if (drift == null) { skipped++; continue; }
    let liq = 0, m = 0; for (let k = aN - 59; k <= aN; k++) { liq += nC[k] * nV[k]; m++; }
    recs.push({ sym: ev.sym, date: ev.event_date, drift, liq: liq / m, cp: classifyCounterparty(ev.headline) });
  }

  console.log(`\nContract-flow study — contract events ${events.length}, used ${recs.length}, skipped ${skipped}`);
  console.log(`drift [+1,+${1 + DRIFT_DAYS}] vs ^TASI; cost ${(COST_RT * 100).toFixed(2)}% RT + slip ${(SLIP * 100).toFixed(2)}%/side\n`);

  // liquidity filter: keep top half by trailing liquidity
  const sorted = [...recs].sort((a, b) => b.liq - a.liq);
  const liquid = sorted.slice(0, Math.ceil(sorted.length / 2));
  const govt = liquid.filter(r => r.cp === 'govt'), priv = liquid.filter(r => r.cp === 'private');

  console.log('ALL CONTRACTS (matured, award-gated):');
  report('all', recs);
  console.log('\nLIQUID HALF, by counterparty:');
  const g = report('govt/Vision-2030', govt);
  const p = report('private', priv);
  const spread = (g.raw.length && p.raw.length) ? mean(g.raw) - mean(p.raw) : NaN;
  console.log(`  govt − private spread: ${pct(spread)}`);

  // trim-one on govt
  if (govt.length > 3) {
    const trims = govt.map((_, i) => mean(govt.filter((__, j) => j !== i).map(r => r.drift)));
    console.log(`  govt trim-one drift range: ${pct(Math.min(...trims))} … ${pct(Math.max(...trims))}`);
  }

  console.log('\nVERDICT (govt/Vision-2030, liquid):');
  if (govt.length < MIN_N) {
    console.log(`  UNDERPOWERED — only ${govt.length} liquid govt awards (<${MIN_N}); not reliable. Harvest more contract history.`);
  } else {
    const tstat = nwT(govt.map(r => r.drift));
    const pass = g.netMean > 0 && tstat > 2 && spread > 0;
    console.log(`  ${pass ? 'SIGNAL' : 'NO SIGNAL'} — net drift ${pct(g.netMean)}, NW-t ${(tstat || 0).toFixed(2)}, beats private ${spread > 0} (need net>0 AND t>2 AND spread>0 AND trim-one stable).`);
  }
})();
```

- [ ] **Step 2: Parse + run on real data**

Run:
```bash
node --check scripts/contract_flow_test.mjs && echo PARSE_OK
node --experimental-sqlite scripts/contract_flow_test.mjs 2>&1 | grep -v "ExperimentalWarning\|trace-warnings\|\[db\]"
```
Expected: `PARSE_OK`; then the study header (contract events ~150–196 after gating, used some, skipped some), an ALL block, a LIQUID-HALF govt/private block with finite numbers, a spread line, and either a real SIGNAL/NO-SIGNAL or (likely) the UNDERPOWERED banner if liquid-govt n < 30. No crash. Spot-check the govt/private split counts look sane (not everything tagged govt).

- [ ] **Step 3: Commit**

```bash
git add scripts/contract_flow_test.mjs
git commit -m "feat(contract-flow): govt-vs-private contract-award drift event study"
```

---

## Task 3: Record findings + verdict

**Files:**
- Create: `docs/research/2026-06-21-contract-flow-results.md`

- [ ] **Step 1: Capture the run**

Run: `node --experimental-sqlite scripts/contract_flow_test.mjs 2>&1 | grep -v "ExperimentalWarning\|trace-warnings\|\[db\]" | tee /tmp/contract-results.txt`
Expected: same output as Task 2 Step 2, saved.

- [ ] **Step 2: Write the results doc**

Create `docs/research/2026-06-21-contract-flow-results.md`: paste `/tmp/contract-results.txt`; state used/skipped + govt/private liquid counts + the single-window + size-unavailable caveats; give the plain-English verdict applying the spec gates (SIGNAL only if govt-liquid net drift >0, NW-t>2, beats private, trim-one stable, n≥30). If UNDERPOWERED/NO-SIGNAL, say so plainly; note this is the 4th layer tested. If by some chance SIGNAL, name the confirmation step (multi-year contract harvest). Survivorship ≈ nil.

Skeleton (fill bracketed parts from the real run — do NOT invent numbers):

```markdown
# Contract-Flow (Govt/Vision-2030 Award Drift) — Results (2026-06-21)

Alt-data layer #4. Single 4-month window (Feb→Jun 2026). Award size unavailable → counterparty cut.
Survivorship ≈ nil.

## Raw output
```
[paste /tmp/contract-results.txt]
```

## Verdict
[SIGNAL / NO SIGNAL / UNDERPOWERED] — [govt-liquid net drift, NW-t, beats-private?, trim-one, n]

## Plain-English
[Do government/Vision-2030 awards to liquid names drift? Is it real/tradeable, or noise/underpowered?
The size caveat. Where this leaves the edge hunt — 4th layer tested.]
```

- [ ] **Step 3: Commit**

```bash
git add docs/research/2026-06-21-contract-flow-results.md
git commit -m "docs(contract-flow): govt award-drift results + verdict"
```

---

## Notes for the executor

- **Run with `--experimental-sqlite`** (reads `catalyst_events` via `db.js`).
- **`node --check` won't catch undefined refs** — the real-data run (Task 2 Step 2) is the net.
- **Reuse, don't reimplement:** `sliceByDate` from `index_flow.mjs`, `mean` from `pead.mjs`; only `abnAligned`/`nwT` are script-local (consistent with the flow/PEAD studies).
- **Symbols are `TADAWUL:${code}`**; `toYahooSym` maps to the Yahoo ticker.
- **Research script, run by hand** — not in `npm test`. Only Task 1 helpers are in the suite.
- **Honesty is the product:** UNDERPOWERED or NO SIGNAL is the most likely and a perfectly valid outcome (this is the 4th layer, weakest prior). Do not tune the keyword list or filters to manufacture a signal — tune only to fix obvious misclassification, and disclose.

## Self-review notes (author)

- **Spec coverage:** counterparty classifier ✓ (T1), anti-leakage gate ✓ (T1), 20d drift [+1,+21] ✓ (T2), liquidity top-half filter ✓ (T2), matured + valid-date filter ✓ (T2), govt-vs-private + spread ✓ (T2), trim-one ✓ (T2), NW-t ✓ (T2), underpowered n<30 banner ✓ (T2), net cost+slippage ✓ (T2), no new table ✓, survivorship-nil note ✓ (T3), unit tests for pure helpers ✓ (T1), results+verdict ✓ (T3). All spec sections mapped.
- **Consistency:** `classifyCounterparty`/`isContractHeadline` signatures identical across T1 def, T1 tests, T2 use; `mean` imported from `pead.mjs` (single definition); `abnAligned`/`nwT` script-local; `--experimental-sqlite` everywhere DB is touched; `DRIFT_DAYS`/`COST_RT`/`SLIP`/`MIN_N` env-tunable, same pattern as PEAD/flow.
- **Liquidity window** needs 60 prior bars (`aN >= 60` guard) + `b.length < 90` skip, so the trailing-liquidity computation never runs off the start of the series.
