# Momentum Monthly-Decision View (Harden Package) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the momentum screen into a monthly decision: BUY/HOLD/SELL vs the user's actual holdings, a strategy-state badge by the picks, and a SAR-per-name calculator.

**Architecture:** Additive. Two pure helpers (`computeTurnover`, `sarPerName`) added to `dashboard/momentum_screen.mjs` (alongside the existing `schemeDExposure`/`sizingNote`), wired into `getMomentumScreen({heldSyms})`; the `/api/lab/momentum` route injects held syms from `state.positions`; `loadMomentumScreen` in `app-lab.js` renders the badge, BUY/HOLD/SELL block, and SAR calculator. No new table.

**Tech Stack:** Node 22 ESM, `node:sqlite` via `dashboard/db.js` (`--experimental-sqlite`), `dashboard/strategy_state.mjs` (`getState`/`transitions`, already imported), `node --test`, Playwright (`scripts/pw-verify.mjs`) for the UI check.

**Spec:** `docs/superpowers/specs/2026-06-21-momentum-decision-view-design.md`.

**Confirmed code facts (from reading the files):**
- `getMomentumScreen` return object: `dashboard/momentum_screen.mjs:132-140`; `sizing` built at `:123-130`; `stateMult`/`exposure`/`realizedVol`/`seasonal` in scope there.
- Holding objects carry `sym` (`TADAWUL:${code}`), `code`, `name`, `price`, `mom6`, `ret1m`, `sharia`.
- `getState(id)` → `{ state, exposure_mult, ... }` (`strategy_state.mjs:65-69`); `transitions(id,limit)` → rows with `.reason` (`:71`).
- Route: `dashboard/server.mjs:2239-2241` (`return json(res, await getMomentumScreen());`).
- Positions: `state.positions` is an object keyed by `TADAWUL:${code}` (`server.mjs:1476`, `loadPositions` at `:249`).
- UI render fn: `loadMomentumScreen` `dashboard/assets/app-lab.js:612-659`; container `#momentum-content`.

**DB note:** `getMomentumScreen` transitively imports `db.js` (`node:sqlite`) → any script importing it (incl. the test) runs with `--experimental-sqlite`. `test:money` already passes it.

---

## Task 1: Pure helpers `computeTurnover` + `sarPerName`

**Files:**
- Modify: `dashboard/momentum_screen.mjs` (add two exports near `schemeDExposure`/`sizingNote`, ~line 47)
- Modify: `tests/moneypath.test.js` (append a describe block + import)

- [ ] **Step 1: Write the failing tests**

Add to the imports at the top of `tests/moneypath.test.js` (the file already imports from `momentum_screen.mjs`):

```javascript
import { computeTurnover, sarPerName } from '../dashboard/momentum_screen.mjs';
```

Append this block:

```javascript
describe('momentum decision helpers', () => {
  // computeTurnover: buy = pick∖held, hold = pick∩held, sell = held∖pick
  it('partitions buy/hold/sell against held positions', () => {
    const picks = ['TADAWUL:1120', 'TADAWUL:2222', 'TADAWUL:7203'];
    const held = ['TADAWUL:2222', 'TADAWUL:9999']; // hold 2222, own 9999 (no longer a pick)
    const t = computeTurnover(picks, held);
    assert.deepEqual(t.buy, ['TADAWUL:1120', 'TADAWUL:7203']);
    assert.deepEqual(t.hold, ['TADAWUL:2222']);
    assert.deepEqual(t.sell, ['TADAWUL:9999']);
  });
  it('empty held → everything is a buy, nothing to sell', () => {
    const t = computeTurnover(['TADAWUL:1120', 'TADAWUL:2222'], []);
    assert.deepEqual(t.buy, ['TADAWUL:1120', 'TADAWUL:2222']);
    assert.deepEqual(t.hold, []);
    assert.deepEqual(t.sell, []);
  });
  it('preserves pick order in buy/hold and handles empty picks', () => {
    assert.deepEqual(computeTurnover([], ['TADAWUL:1120']).sell, ['TADAWUL:1120']);
    assert.deepEqual(computeTurnover([], []), { buy: [], hold: [], sell: [] });
  });

  // sarPerName: account × exposure% / nHoldings, rounded to whole SAR
  it('sarPerName splits the deployed fraction across holdings', () => {
    const r = sarPerName({ accountSize: 100000, exposurePct: 80, nHoldings: 4 });
    assert.equal(r.perName, 20000);        // 100000×0.80/4
    assert.equal(r.totalDeployed, 80000);
    assert.equal(r.cash, 20000);
  });
  it('sarPerName handles 0 holdings and 0 exposure', () => {
    assert.deepEqual(sarPerName({ accountSize: 100000, exposurePct: 80, nHoldings: 0 }), { perName: 0, totalDeployed: 0, cash: 100000 });
    assert.deepEqual(sarPerName({ accountSize: 50000, exposurePct: 0, nHoldings: 5 }), { perName: 0, totalDeployed: 0, cash: 50000 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:money 2>&1 | grep -iE "fail|computeTurnover|sarPerName"`
Expected: FAIL — `computeTurnover`/`sarPerName` are not exported (import resolves to undefined → TypeError in the tests).

- [ ] **Step 3: Implement the helpers**

In `dashboard/momentum_screen.mjs`, after the `sizingNote` export (around line 46, before `getMomentumScreen`), add:

```javascript
/**
 * Monthly turnover vs the user's actual holdings (basis A).
 *   buy  = picks not currently held   hold = picks held   sell = held but no longer a pick
 * Operates on `TADAWUL:${code}` strings; preserves pickSyms order for buy/hold.
 */
export function computeTurnover(pickSyms, heldSyms) {
  const held = new Set(heldSyms || []);
  const picks = new Set(pickSyms || []);
  const buy = (pickSyms || []).filter(s => !held.has(s));
  const hold = (pickSyms || []).filter(s => held.has(s));
  const sell = (heldSyms || []).filter(s => !picks.has(s));
  return { buy, hold, sell };
}

/** SAR per name from account size × deployed fraction, whole-SAR rounded. nHoldings 0 → all cash. */
export function sarPerName({ accountSize = 0, exposurePct = 0, nHoldings = 0 } = {}) {
  const deployFrac = (exposurePct || 0) / 100;
  const perName = nHoldings > 0 ? Math.round(accountSize * deployFrac / nHoldings) : 0;
  const totalDeployed = perName * nHoldings;
  return { perName, totalDeployed, cash: Math.round(accountSize) - totalDeployed };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:money 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: all pass, `fail 0` (5 new tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/momentum_screen.mjs tests/moneypath.test.js
git commit -m "feat(momentum): computeTurnover + sarPerName pure helpers + tests"
```

---

## Task 2: Enrich `getMomentumScreen` response + route injection

**Files:**
- Modify: `dashboard/momentum_screen.mjs` (signature + response, ~line 48 and ~123-140)
- Modify: `dashboard/server.mjs` (route ~line 2240)

- [ ] **Step 1: Add `heldSyms` param + import `transitions`**

In `dashboard/momentum_screen.mjs`, line 18 currently:
```javascript
import { getState } from './strategy_state.mjs';
```
Change to:
```javascript
import { getState, transitions } from './strategy_state.mjs';
```

Change the function signature (line 48) from:
```javascript
export async function getMomentumScreen({ quintileFrac = 0.2, liquidFrac = 0.5, minListingDays = 504, targetVol = 0.15 } = {}) {
```
to (add `heldSyms`):
```javascript
export async function getMomentumScreen({ quintileFrac = 0.2, liquidFrac = 0.5, minListingDays = 504, targetVol = 0.15, heldSyms = [] } = {}) {
```

- [ ] **Step 2: Build turnover, state, and sizing.breakdown; add to the response**

In `dashboard/momentum_screen.mjs`, replace the `sizing` object (lines 123-130) and the `return {…}` (lines 132-140) with:

```javascript
  const sizing = {
    model: 'vol-target + seasonal sit-out (Scheme D)',
    targetVolPct: +(targetVol * 100).toFixed(0),
    realizedVolPct: realizedVol ? +(realizedVol * 100).toFixed(0) : null,
    exposurePct, cashPct: 100 - exposurePct,
    perPositionPct: +(exposurePct / Math.max(1, holdings.length)).toFixed(1),
    note: sizingNote({ exposure, exposurePct, stateMult, inSeason: seasonal.inSeason, targetVol, nHoldings: holdings.length }),
    breakdown: {
      targetVolPct: +(targetVol * 100).toFixed(0),
      realizedVolPct: realizedVol ? +(realizedVol * 100).toFixed(0) : null,
      volTargetRaw: realizedVol && realizedVol > 0 ? +Math.min(1, targetVol / realizedVol).toFixed(2) : 1,
      seasonalMult: seasonal.inSeason ? 1 : 0,
      stateMult,
      finalExposurePct: exposurePct,
    },
  };

  const turnover = computeTurnover(holdings.map(h => h.sym), heldSyms);
  // hold/sell carry name (resolve from TASI_STOCKS; fall back to code) for the UI
  const nameOf = (sym) => (TASI_STOCKS.find(s => s.sym === sym)?.name) || sym.replace('TADAWUL:', '');
  const turnoverNamed = {
    buy: turnover.buy.map(sym => holdings.find(h => h.sym === sym)),
    hold: turnover.hold.map(sym => holdings.find(h => h.sym === sym)),
    sell: turnover.sell.map(sym => ({ sym, name: nameOf(sym) })),
  };

  const st = getState('momentum-sharia');
  const strategyState = { status: st.state, exposure_mult: st.exposure_mult, reason: transitions('momentum-sharia', 1)[0]?.reason || null };

  return {
    success: true, asOf, nextRebalance,
    universe: { compliant: compliant.length, eligible: rows.length, liquid: liquid.length, holdings: holdings.length },
    params: { lookback: '6mo (skip last 1mo)', minListing: '≥2y listed', liquidFilter: 'liquid half', quintile: 'top 20%', rebalance: 'monthly', cost: '0.11% RT (Derayah)', weighting: `equal-weight (~${weight}% each)` },
    validated: { excessPerYr: '+10 to +15%/yr', absCagr: '15–25%/yr', nwT: '2.6–3.2', maxDD: '~−26% (better than basket)', caveat: 'OOS-stable; survivorship haircut ~1–1.5%/yr; confirm AAOIFI financial ratios per name before buying.' },
    seasonal,
    sizing,
    turnover: turnoverNamed,
    state: strategyState,
    holdings,
  };
```

- [ ] **Step 3: Inject held syms in the route**

In `dashboard/server.mjs`, line 2240, change:
```javascript
      return json(res, await getMomentumScreen());
```
to:
```javascript
      return json(res, await getMomentumScreen({ heldSyms: Object.keys(state.positions || {}) }));
```

- [ ] **Step 4: Parse + run the money-path suite (no behavior regressions)**

Run:
```bash
node --check dashboard/momentum_screen.mjs && node --check dashboard/server.mjs && echo PARSE_OK
npm run test:money 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: `PARSE_OK`; tests still `fail 0` (helpers already covered; this task adds no new tests).

- [ ] **Step 5: Boot + curl the enriched endpoint**

Run:
```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | while read pid; do ps -p $pid -o command= | grep -q server.mjs && kill $pid; done
sleep 1; (npm run dashboard > /tmp/mawjah-srv.log 2>&1 &); sleep 4
JWT=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('.playwright-auth.json'));console.log(j.origins[0].localStorage[0].value)")
curl -s -H "Authorization: Bearer $JWT" "http://localhost:3000/api/lab/momentum" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log('ok',o.success,'| turnover keys',Object.keys(o.turnover||{}),'| state',o.state?.status,o.state?.exposure_mult,'| breakdown',Object.keys(o.sizing?.breakdown||{}).length,'| buy',o.turnover?.buy?.length,'sell',o.turnover?.sell?.length)})"
```
Expected: `ok true | turnover keys [ 'buy', 'hold', 'sell' ] | state <status> <mult> | breakdown 6 | buy <N> sell 0` (sell 0 because `state.positions` is empty now → all picks are buy). If `.playwright-auth.json` is missing, run `node scripts/pw-auth.mjs` first ([[pw-auth-session]]).

- [ ] **Step 6: Commit**

```bash
git add dashboard/momentum_screen.mjs dashboard/server.mjs
git commit -m "feat(momentum): turnover + strategy-state + sizing breakdown in /api/lab/momentum"
```

---

## Task 3: Render badge + BUY/HOLD/SELL + SAR calculator in the UI

**Files:**
- Modify: `dashboard/assets/app-lab.js` (`loadMomentumScreen`, ~line 640-657)

- [ ] **Step 1: Add the three decision blocks to the render**

In `dashboard/assets/app-lab.js`, inside `loadMomentumScreen`, immediately AFTER the line that computes `const sz = d.sizing || {};` (line 632) add:

```javascript
    const ts = d.turnover || { buy: [], hold: [], sell: [] };
    const stt = d.state || {};
    const stColor = stt.status === 'promoted' ? 'var(--green)' : stt.status === 'decaying' ? 'var(--yellow)' : '#ff5252';
    const stateBadge = stt.status ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:7px 10px;border-radius:8px;cursor:help;background:${stColor}1a;border:1px solid ${stColor}55" title="Strategy state::An automatic governor on how hard to size this strategy. PROMOTED = full size (the edge is proven and holding). DECAYING = risk halved (recent performance slipped). RETIRED/CANDIDATE = 0% (not trusted right now). It moves down automatically if the edge weakens.">
        <span style="font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px;background:${stColor};color:#000">${String(stt.status).toUpperCase()}</span>
        <span style="font-size:10px;color:var(--text2);line-height:1.4">Effective sizing ${Math.round((stt.exposure_mult ?? 0) * 100)}% of Scheme-D${stt.reason ? ` · ${stt.reason}` : ''}</span>
      </div>` : '';
    const nm = h => `${h.name} <span style="color:var(--text3);font-weight:400">${h.code || ''}</span>`;
    const listLine = (label, arr, color, render) => `<div style="margin-bottom:5px"><span style="font-size:9px;font-weight:800;color:${color};text-transform:uppercase;letter-spacing:.5px">${label} (${arr.length})</span> <span style="font-size:11px;color:var(--text2)">${arr.length ? arr.map(render).join(', ') : '—'}</span></div>`;
    const turnoverBlock = `<div style="margin-bottom:10px;padding:8px 10px;border-radius:8px;background:var(--bg2);border:1px solid var(--border)" title="This month's trades::What to do vs what you currently hold. BUY = new picks you don't own. HOLD = picks you already own (keep them). SELL = names you own that fell out of the top list (exit). Based on your logged positions.">
        <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px">This month's trades</div>
        ${listLine('Buy', ts.buy || [], 'var(--green)', nm)}
        ${listLine('Hold', ts.hold || [], 'var(--text2)', nm)}
        ${listLine('Sell', ts.sell || [], '#ff5252', h => nm(h))}
        ${(!(ts.hold||[]).length && !(ts.sell||[]).length) ? `<div style="font-size:9px;color:var(--text3);margin-top:4px">You hold nothing in these names yet — this is your starting buy-list. Log positions to track HOLD/SELL.</div>` : ''}
      </div>`;
    const sarCalc = sz.exposurePct != null ? `<div style="margin-bottom:10px;padding:8px 10px;border-radius:8px;background:var(--bg2);border:1px solid var(--border)" title="Order-size calculator::Type your account size; it splits the invested fraction equally across the picks so you know how many Riyals to put in each name.">
        <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px">Order sizing</div>
        <label style="font-size:10px;color:var(--text2)">Account (SAR) <input id="mom-acct" type="number" value="100000" style="width:110px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 6px;font-family:'JetBrains Mono',monospace;font-size:11px"></label>
        <span id="mom-sar-out" style="font-size:11px;color:var(--text2);margin-left:8px"></span>
      </div>` : '';
```

- [ ] **Step 2: Place the blocks in the rendered HTML**

In the same function, in the `el.innerHTML = \`...\`` template, change the line that currently reads:
```javascript
      ${seasonBanner}
      ${sizingBanner}
```
to:
```javascript
      ${stateBadge}
      ${seasonBanner}
      ${sizingBanner}
      ${turnoverBlock}
      ${sarCalc}
```

- [ ] **Step 3: Wire the SAR calculator (after `el.innerHTML = …`, before the `catch`)**

In `dashboard/assets/app-lab.js`, immediately AFTER the big `el.innerHTML = \`…\`;` assignment closes (the line with the closing `\`;` right before `} catch(_)`), add:

```javascript
    const acct = document.getElementById('mom-acct'), out = document.getElementById('mom-sar-out');
    if (acct && out) {
      const recompute = () => {
        const n = (d.holdings || []).length;
        const exp = (d.sizing?.exposurePct) || 0;
        const A = +acct.value || 0;
        const perName = n > 0 ? Math.round(A * (exp / 100) / n) : 0;
        const deployed = perName * n, cash = Math.round(A) - deployed;
        out.textContent = n ? `→ ${perName.toLocaleString()} SAR/name × ${n} = ${deployed.toLocaleString()} invested, ${cash.toLocaleString()} cash` : 'no eligible picks this month';
      };
      acct.addEventListener('input', recompute);
      recompute();
    }
```
(The calculator mirrors `sarPerName`'s math client-side so it updates live as the user types; the server helper covers the same math for tests/reuse.)

- [ ] **Step 4: Boot + DOM-assertion verification**

Run:
```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | while read pid; do ps -p $pid -o command= | grep -q server.mjs && kill $pid; done
sleep 1; (npm run dashboard > /tmp/mawjah-srv.log 2>&1 &); sleep 4
SHOT=1 BASE=http://localhost:3000 node scripts/pw-verify.mjs 2>&1 | tail -14
```
Expected: auth gate passed, all 8 tabs `switch:ok console-errors:0`, `✓ no app console errors`. (If `pw-verify` doesn't deep-check the momentum tab, that's fine — the 0-console-errors across tabs + the curl in Task 2 are the net.)

- [ ] **Step 5: Targeted DOM check of the momentum tab (per [[feedback-dashboard-verify]])**

Run this Playwright snippet to assert the three new blocks render (DOM-assertion, one top-of-tab shot, no mid-scroll):

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
node -e "
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const j = JSON.parse(fs.readFileSync('.playwright-auth.json'));
  const b = await chromium.launch(); const ctx = await b.newContext({ storageState: '.playwright-auth.json' });
  const pg = await ctx.newPage();
  await pg.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await pg.evaluate(() => window.switchTab && switchTab('momentum')).catch(()=>{});
  await pg.waitForTimeout(2500);
  const html = await pg.locator('#momentum-content').innerHTML();
  const checks = {
    stateBadge: /PROMOTED|DECAYING|RETIRED|CANDIDATE/i.test(html),
    turnover: /This month's trades/.test(html),
    buyLabel: /Buy \(/.test(html),
    sarCalc: /Order sizing/.test(html) && /mom-acct/.test(html),
  };
  console.log('momentum DOM checks:', JSON.stringify(checks));
  await pg.screenshot({ path: 'screenshots/momentum-decision-view.png' });
  const errs = []; pg.on('console', m => m.type()==='error' && errs.push(m.text()));
  console.log(Object.values(checks).every(Boolean) ? 'ALL BLOCKS PRESENT' : 'MISSING A BLOCK');
  await b.close();
})();
" 2>&1 | tail -5
```
Expected: `momentum DOM checks: {"stateBadge":true,"turnover":true,"buyLabel":true,"sarCalc":true}` and `ALL BLOCKS PRESENT`; a screenshot saved. If `switchTab` isn't global, the tab may need a click via its nav element — adjust the selector, the goal is to render `#momentum-content`.

- [ ] **Step 6: Stop server + commit**

```bash
lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | while read pid; do ps -p $pid -o command= | grep -q server.mjs && kill $pid; done
git add dashboard/assets/app-lab.js screenshots/momentum-decision-view.png
git commit -m "feat(momentum): UI — state badge, BUY/HOLD/SELL block, SAR calculator"
```

---

## Notes for the executor

- **Additive only:** existing momentum fields/behaviour unchanged; `heldSyms` defaults to `[]` so any other caller still works (turnover = all-buy).
- **Run server/test with `--experimental-sqlite`** (momentum_screen → db.js). `npm run dashboard` and `npm run test:money` already include it.
- **`node --check` won't catch undefined refs** — the curl (Task 2 Step 5) and DOM check (Task 3 Step 5) are the real net.
- **Positions are empty right now**, so SELL/HOLD will be empty and the UI shows the "starting buy-list" note — that is correct, not a bug. To see SELL populate, a position keyed `TADAWUL:xxxx` must exist in `state.positions`.
- **SELL semantics:** held-but-not-a-pick (assumes positions = the strategy book), per spec. Don't "improve" it without a spec change.
- **Verification style** = DOM-assertion + one top-of-tab screenshot; skip mid-scroll shots ([[feedback-dashboard-verify]]).

## Self-review notes (author)

- **Spec coverage:** turnover vs positions ✓ (T1 helper, T2 wiring, T3 UI), SELL semantics ✓ (computeTurnover + label), state badge ✓ (T2 `state{}`, T3 badge), sizing breakdown ✓ (T2 `sizing.breakdown`, surfaced via state badge + existing banner), SAR calculator ✓ (T1 `sarPerName` + T3 live calc), empty-positions→all-buy ✓ (T1 test + T3 note), exposure 0→all cash ✓ (T1 test + calc), no new table ✓, back-compat `heldSyms=[]` ✓, unit tests ✓ (T1), DOM-assertion verify + one screenshot ✓ (T3). All spec sections mapped.
- **Consistency:** `computeTurnover(pickSyms,heldSyms)→{buy,hold,sell}` and `sarPerName({accountSize,exposurePct,nHoldings})→{perName,totalDeployed,cash}` identical across T1 def/tests and T2/T3 use; `state.status`/`exposure_mult`/`reason` consistent T2→T3; `getState().state` mapped to `state.status` (note the field rename in the response is intentional and consistent).
- **Note on SAR math duplication:** the calculator recomputes client-side (live typing) while `sarPerName` holds the canonical, unit-tested math — same formula, intentional (UI can't call the server per keystroke). If they ever diverge, `sarPerName` is the source of truth.
