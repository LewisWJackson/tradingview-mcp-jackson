# Strategy State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rule-driven governor that moves each trading strategy through `candidate→promoted→decaying→retired` based on accumulated evidence, auto-reducing risk and feeding its verdict into live Scheme-D sizing.

**Architecture:** A pure `decide()` function (state + evidence → next state) holds all logic and is unit-tested exhaustively. Thin DB wrappers persist current state (`strategy_state`) and an append-only audit log (`strategy_transitions`). `strategy_validation.mjs` produces the evidence (lifetime + rolling + current drawdown); the daily grade tick applies auto transitions; `momentum_screen.mjs` multiplies Scheme-D exposure by the stored `exposure_mult`. Manual promotion is a confirmed API action.

**Tech Stack:** Node `node:sqlite` (`DatabaseSync`), ES modules, `node --test`, existing http server in `dashboard/server.mjs`.

**Spec:** `docs/superpowers/specs/2026-06-17-strategy-state-machine-design.md`

---

## File Structure

- **Create** `dashboard/strategy_state.mjs` — pure `decide()` + config + DB persistence (`getState`, `evaluate`, `promote`, `allStates`).
- **Create** `tests/strategy_state.test.js` — exhaustive unit tests for `decide()` + gate.
- **Modify** `dashboard/db.js` — add `strategy_state` + `strategy_transitions` tables to the `db.exec` schema block.
- **Modify** `dashboard/strategy_validation.mjs` — add rolling-window + current-drawdown evidence to each strategy object.
- **Modify** `dashboard/server.mjs` — call `evaluate()` in the daily grade tick; extend `GET /api/lab/strategy`; add `POST /api/lab/strategy/promote`.
- **Modify** `dashboard/index.html` — state badge, Promote button, transition timeline, effective-exposure line in the Strategy Edge card.

---

## Task 1: Schema — state + transitions tables

**Files:**
- Modify: `dashboard/db.js` (inside the existing `db.exec(\`...\`)` schema block, after the `signal_outcomes` table ~line 195)

- [ ] **Step 1: Add the two tables to the schema block**

In `dashboard/db.js`, find the `db.exec(\`` schema string and add, after the `signal_outcomes` CREATE TABLE:

```sql
  CREATE TABLE IF NOT EXISTS strategy_state (
    strategy_id   TEXT PRIMARY KEY,
    state         TEXT NOT NULL,
    since         TEXT,
    evidence      TEXT,
    exposure_mult REAL NOT NULL DEFAULT 0,
    updated_at    TEXT
  );
  CREATE TABLE IF NOT EXISTS strategy_transitions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    from_state  TEXT,
    to_state    TEXT NOT NULL,
    reason      TEXT,
    actor       TEXT NOT NULL,
    evidence    TEXT,
    at          TEXT NOT NULL
  );
```

- [ ] **Step 2: Verify the schema loads**

Run: `node --experimental-sqlite -e "import('./dashboard/db.js').then(({db})=>{console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\" AND name LIKE \"strategy_%\"').all())})"`
Expected: prints `[ { name: 'strategy_state' }, { name: 'strategy_transitions' } ]` (order may vary).

- [ ] **Step 3: Commit**

```bash
git add dashboard/db.js
git commit -m "feat(db): strategy_state + strategy_transitions tables"
```

---

## Task 2: Pure decision logic + config (TDD)

**Files:**
- Create: `dashboard/strategy_state.mjs`
- Test: `tests/strategy_state.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/strategy_state.test.js`:

```js
/**
 * Unit tests for the strategy state machine decision logic (pure, no DB).
 * Run: node --test tests/strategy_state.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decide, gateMet, exposureFor, CFG } from '../dashboard/strategy_state.mjs';

// baseline evidence that PASSES the promotion gate
const pass = { n: 30, t: 2.9, halfT1: 2.3, halfT2: 1.8, netMean: 0.012, rollMean: 0.012, rollT: 2.5, roll18Mean: 0.011, currentDD: -0.05 };

describe('gateMet', () => {
  it('passes a clean strategy', () => assert.equal(gateMet(pass, CFG), true));
  it('fails on too few periods', () => assert.equal(gateMet({ ...pass, n: 20 }, CFG), false));
  it('fails on t<=2', () => assert.equal(gateMet({ ...pass, t: 1.9 }, CFG), false));
  it('fails on weak half', () => assert.equal(gateMet({ ...pass, halfT2: 1.0 }, CFG), false));
  it('fails on negative net', () => assert.equal(gateMet({ ...pass, netMean: -0.001 }, CFG), false));
});

describe('exposureFor', () => {
  it('maps states to multipliers', () => {
    assert.equal(exposureFor('promoted'), 1.0);
    assert.equal(exposureFor('decaying'), 0.5);
    assert.equal(exposureFor('candidate'), 0);
    assert.equal(exposureFor('retired'), 0);
  });
});

describe('decide — manual up (no auto-apply)', () => {
  it('candidate meeting gate is RECOMMENDED promote, not auto-applied', () => {
    const r = decide('candidate', pass);
    assert.equal(r.state, 'candidate');           // not auto-changed
    assert.equal(r.recommendedAction, 'promote');
    assert.equal(r.actor, null);
    assert.equal(r.exposureMult, 0);
  });
  it('candidate failing gate gets no recommendation', () => {
    const r = decide('candidate', { ...pass, t: 1.0 });
    assert.equal(r.recommendedAction, null);
  });
});

describe('decide — auto risk-down', () => {
  it('promoted decays on rolling-12 negative', () => {
    const r = decide('promoted', { ...pass, rollMean: -0.003 });
    assert.equal(r.state, 'decaying');
    assert.equal(r.actor, 'auto');
    assert.equal(r.exposureMult, 0.5);
  });
  it('promoted decays on rolling t<1', () => {
    const r = decide('promoted', { ...pass, rollT: 0.8 });
    assert.equal(r.state, 'decaying');
  });
  it('promoted decays on DD < -20%', () => {
    const r = decide('promoted', { ...pass, currentDD: -0.22 });
    assert.equal(r.state, 'decaying');
  });
  it('retires on rolling-18 negative (sustained)', () => {
    const r = decide('promoted', { ...pass, roll18Mean: -0.002 });
    assert.equal(r.state, 'retired');
    assert.equal(r.exposureMult, 0);
  });
  it('retires on DD <= -30% circuit-breaker regardless of rolling', () => {
    const r = decide('promoted', { ...pass, currentDD: -0.31 });
    assert.equal(r.state, 'retired');
    assert.equal(r.actor, 'auto');
  });
  it('decaying retires on DD floor', () => {
    const r = decide('decaying', { ...pass, currentDD: -0.31 });
    assert.equal(r.state, 'retired');
  });
});

describe('decide — no auto up', () => {
  it('retired with recovered rolling is RECOMMENDED, not auto-promoted', () => {
    const r = decide('retired', { ...pass, rollT: 2.6, rollMean: 0.01 });
    assert.equal(r.state, 'retired');
    assert.equal(r.recommendedAction, 'promote');
    assert.equal(r.actor, null);
  });
  it('healthy promoted stays promoted, full exposure', () => {
    const r = decide('promoted', pass);
    assert.equal(r.state, 'promoted');
    assert.equal(r.exposureMult, 1.0);
    assert.equal(r.actor, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/strategy_state.test.js`
Expected: FAIL — `Cannot find module '../dashboard/strategy_state.mjs'`.

- [ ] **Step 3: Write the pure logic (DB-free part of the module)**

Create `dashboard/strategy_state.mjs`:

```js
/**
 * strategy_state.mjs — the strategy lifecycle governor.
 *
 * Pure decision logic (decide/gateMet/exposureFor) + thin DB persistence.
 * Asymmetric: the machine only AUTO-moves a strategy DOWN (cut risk); every move
 * UP (add risk), including recovery, requires a confirmed user action.
 * Spec: docs/superpowers/specs/2026-06-17-strategy-state-machine-design.md
 */

export const CFG = {
  PROMOTE_MIN_N: 24, PROMOTE_T: 2.0, PROMOTE_HALF_T: 1.5,
  ROLL_WINDOW: 12, DECAY_ROLL_T: 1.0, DECAY_DD: -0.20,
  RETIRE_WINDOW: 18, RETIRE_DD: -0.30,
};

const EXPOSURE = { promoted: 1.0, decaying: 0.5, candidate: 0, retired: 0 };
export const exposureFor = (state) => EXPOSURE[state] ?? 0;

export function gateMet(ev, cfg = CFG) {
  return ev.n >= cfg.PROMOTE_MIN_N && ev.t > cfg.PROMOTE_T &&
    ev.halfT1 > cfg.PROMOTE_HALF_T && ev.halfT2 > cfg.PROMOTE_HALF_T && ev.netMean > 0;
}

// Pure: given current state + evidence, return resulting state after AUTO risk-down,
// plus a manual up-recommendation if applicable. Never auto-applies an up-move.
export function decide(currentState, ev, cfg = CFG) {
  let state = currentState, actor = null, reason = null;
  const pc = v => (v * 100).toFixed(2) + '%';

  if (currentState === 'promoted' || currentState === 'decaying') {
    if (ev.currentDD <= cfg.RETIRE_DD) {
      state = 'retired'; actor = 'auto'; reason = `drawdown ${pc(ev.currentDD)} ≤ ${pc(cfg.RETIRE_DD)} circuit-breaker`;
    } else if (ev.roll18Mean != null && ev.roll18Mean < 0) {
      state = 'retired'; actor = 'auto'; reason = `rolling-${cfg.RETIRE_WINDOW} excess ${pc(ev.roll18Mean)} < 0 (sustained)`;
    } else if (currentState === 'promoted' &&
      (ev.rollMean < 0 || (ev.rollT != null && ev.rollT < cfg.DECAY_ROLL_T) || ev.currentDD < cfg.DECAY_DD)) {
      state = 'decaying'; actor = 'auto';
      reason = `rolling-${cfg.ROLL_WINDOW} weakening (mean ${pc(ev.rollMean)}, t ${ev.rollT}, DD ${pc(ev.currentDD)})`;
    }
  }

  let recommendedAction = null;
  if (state === 'candidate') {
    if (gateMet(ev, cfg)) recommendedAction = 'promote';
  } else if (state === 'decaying' || state === 'retired') {
    if (ev.rollT != null && ev.rollT > cfg.PROMOTE_T && ev.rollMean > 0) recommendedAction = 'promote'; // recovery
  }

  return { state, exposureMult: exposureFor(state), actor, reason, recommendedAction };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/strategy_state.test.js`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add dashboard/strategy_state.mjs tests/strategy_state.test.js
git commit -m "feat(lab): pure strategy state-machine decision logic + tests"
```

---

## Task 3: Persistence — getState / evaluate / promote / allStates

**Files:**
- Modify: `dashboard/strategy_state.mjs` (append DB layer)

- [ ] **Step 1: Append the persistence layer**

Add to the bottom of `dashboard/strategy_state.mjs`:

```js
import { db } from './db.js';

const _get = db.prepare('SELECT * FROM strategy_state WHERE strategy_id=?');
const _upsert = db.prepare(`
  INSERT INTO strategy_state (strategy_id, state, since, evidence, exposure_mult, updated_at)
  VALUES (@id, @state, @since, @evidence, @mult, @at)
  ON CONFLICT(strategy_id) DO UPDATE SET
    state=@state, since=@since, evidence=@evidence, exposure_mult=@mult, updated_at=@at`);
const _log = db.prepare(`
  INSERT INTO strategy_transitions (strategy_id, from_state, to_state, reason, actor, evidence, at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

// Read current persisted state (defaults to candidate / exposure 0 if unseen).
export function getState(id) {
  const r = _get.get(id);
  if (!r) return { strategy_id: id, state: 'candidate', exposure_mult: 0, since: null };
  return r;
}

export function transitions(id, limit = 10) {
  return db.prepare('SELECT * FROM strategy_transitions WHERE strategy_id=? ORDER BY id DESC LIMIT ?').all(id, limit);
}

function write(id, toState, mult, reason, actor, ev) {
  const at = new Date().toISOString();
  const cur = _get.get(id);
  _upsert.run({ id, state: toState, since: at.slice(0, 10), evidence: JSON.stringify(ev || {}), mult, at });
  _log.run(id, cur ? cur.state : null, toState, reason, actor, JSON.stringify(ev || {}), at);
}

// Apply AUTO risk-down transitions for one strategy given fresh evidence.
// Returns { state, exposure_mult, recommendedAction, changed }.
export function evaluate(id, ev, cfg = CFG) {
  const cur = getState(id);
  const d = decide(cur.state, ev, cfg);
  const changed = d.state !== cur.state;
  if (changed && d.actor === 'auto') write(id, d.state, d.exposureMult, d.reason, 'auto', ev);
  else if (!_get.get(id)) write(id, cur.state, exposureFor(cur.state), 'initialized', 'auto', ev); // seed row
  return { state: d.state, exposure_mult: exposureFor(d.state), recommendedAction: d.recommendedAction, changed };
}

// MANUAL up-transition (user-confirmed). Re-checks eligibility; returns {ok,error?}.
export function promote(id, ev, cfg = CFG) {
  const cur = getState(id);
  const eligible = cur.state === 'candidate'
    ? gateMet(ev, cfg)
    : (cur.state === 'decaying' || cur.state === 'retired') && ev.rollT != null && ev.rollT > cfg.PROMOTE_T && ev.rollMean > 0;
  if (!eligible) return { ok: false, error: 'Promotion gate not met' };
  write(id, 'promoted', 1.0, 'manual promotion (user-confirmed)', 'user', ev);
  return { ok: true, state: 'promoted', exposure_mult: 1.0 };
}

export function allStates() {
  return db.prepare('SELECT * FROM strategy_state').all();
}
```

- [ ] **Step 2: Smoke-test persistence against the DB**

Run:
```bash
node --experimental-sqlite -e "
import('./dashboard/strategy_state.mjs').then(m=>{
  const ev={n:30,t:2.9,halfT1:2.3,halfT2:1.8,netMean:0.012,rollMean:0.012,rollT:2.5,roll18Mean:0.011,currentDD:-0.05};
  console.log('eval1',m.evaluate('test-strat',ev));            // candidate, recommend promote
  console.log('promote',m.promote('test-strat',ev));            // -> promoted
  console.log('eval2',m.evaluate('test-strat',{...ev,currentDD:-0.31})); // auto retire
  console.log('log',m.transitions('test-strat').map(t=>t.from_state+'->'+t.to_state+'/'+t.actor));
});"
```
Expected: eval1 state `candidate` recommendedAction `promote`; promote `{ok:true,state:'promoted'}`; eval2 `changed:true,state:'retired'`; log shows `promoted->retired/auto`, `candidate->promoted/user`, … (most recent first).

- [ ] **Step 3: Clean up the test row**

Run: `node --experimental-sqlite -e "import('./dashboard/db.js').then(({db})=>{db.prepare('DELETE FROM strategy_state WHERE strategy_id=?').run('test-strat');db.prepare('DELETE FROM strategy_transitions WHERE strategy_id=?').run('test-strat');console.log('cleaned')})"`
Expected: prints `cleaned`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/strategy_state.mjs
git commit -m "feat(lab): strategy_state persistence (evaluate/promote/log)"
```

---

## Task 4: Evidence — rolling windows + current drawdown

**Files:**
- Modify: `dashboard/strategy_validation.mjs`

- [ ] **Step 1: Compute rolling + current-DD and attach to the strategy object**

In `dashboard/strategy_validation.mjs`, after the existing `const grade = gradeStatus(...)` line and before building `out`, insert:

```js
  // Rolling-window evidence for the state machine (most recent periods).
  const exArr = ex; // periods' excess, chronological
  const tail = (k) => exArr.slice(Math.max(0, exArr.length - k));
  const rollMean = mean(tail(12));
  const rollT = tstat(tail(12));
  const roll18Mean = mean(tail(18));
  // current drawdown = equity now vs running peak of compounded abs equity
  let ceq = 1, cpk = 1, curDD = 0;
  for (const r of abs) { ceq *= 1 + r; cpk = Math.max(cpk, ceq); }
  curDD = cpk > 0 ? ceq / cpk - 1 : 0;
  const evidence = {
    n: periods.length, t: +(t || 0).toFixed(2),
    halfT1: +(tstat(h1) || 0).toFixed(2), halfT2: +(tstat(h2) || 0).toFixed(2),
    netMean: +(mean(ex) || 0).toFixed(5),
    rollMean: +(rollMean || 0).toFixed(5), rollT: +(rollT || 0).toFixed(2),
    roll18Mean: +(roll18Mean || 0).toFixed(5),
    currentDD: +(curDD).toFixed(4),
  };
```

- [ ] **Step 2: Add `evidence` to the pushed strategy object**

In the same file, in the `strategies: [{ ... }]` object, add a field after `yearly,`:

```js
      yearly,
      evidence,
```

- [ ] **Step 3: Verify the endpoint payload carries evidence**

Run (server must be running):
```bash
KEY=$(grep DASHBOARD_API_KEY .env | cut -d= -f2); curl -s "http://localhost:3000/api/lab/strategy" -H "x-api-key: $KEY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).strategies[0].evidence))"
```
Expected: an object with `n, t, halfT1, halfT2, netMean, rollMean, rollT, roll18Mean, currentDD`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/strategy_validation.mjs
git commit -m "feat(lab): rolling-window + current-drawdown evidence for the state machine"
```

---

## Task 5: Wire evaluate() into the strategy payload + daily tick

**Files:**
- Modify: `dashboard/strategy_validation.mjs` (apply state on read)
- Modify: `dashboard/server.mjs` (daily tick already calls grading ~line 597)

- [ ] **Step 1: Apply the state machine inside getStrategyValidation**

In `dashboard/strategy_validation.mjs`, add at the top with the other imports:

```js
import { evaluate, getState, transitions } from './strategy_state.mjs';
```

Then, where the per-strategy object is built, replace the static `status`/`statusWhy` fields by running the machine. After computing `evidence` (Task 4) and before `out`, add:

```js
  const stRes = evaluate('momentum-sharia', evidence);
  const st = getState('momentum-sharia');
```

In the strategy object, replace `status: grade.status, statusWhy: grade.why,` with:

```js
      status: st.state, statusWhy: grade.why,
      exposure_mult: st.exposure_mult,
      recommendedAction: stRes.recommendedAction,
      transitions: transitions('momentum-sharia', 6).map(t => ({ from: t.from_state, to: t.to_state, actor: t.actor, reason: t.reason, at: t.at.slice(0, 10) })),
```

- [ ] **Step 2: Verify state persists and is returned**

Run (server running):
```bash
KEY=$(grep DASHBOARD_API_KEY .env | cut -d= -f2); curl -s "http://localhost:3000/api/lab/strategy" -H "x-api-key: $KEY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s).strategies[0];console.log('state',m.status,'mult',m.exposure_mult,'rec',m.recommendedAction)})"
```
Expected: `state candidate mult 0 rec promote` (momentum meets the gate but is candidate until manually promoted).

- [ ] **Step 3: Commit**

```bash
git add dashboard/strategy_validation.mjs
git commit -m "feat(lab): run state machine on strategy read; expose state/exposure/transitions"
```

---

## Task 6: API — promote endpoint

**Files:**
- Modify: `dashboard/server.mjs` (near the `/api/lab/strategy` GET route)

- [ ] **Step 1: Add the POST promote route**

In `dashboard/server.mjs`, immediately after the `GET /api/lab/strategy` route block, add:

```js
  // Manual promotion (user-confirmed up-transition). Re-checks the gate server-side.
  if (path === '/api/lab/strategy/promote' && method === 'POST') {
    try {
      const body = await readBody(req);
      const id = body.id;
      if (!id) return json(res, { ok: false, error: 'id required' }, 400);
      const val = await getStrategyValidation();
      const strat = (val.strategies || []).find(s => s.id === id);
      if (!strat) return json(res, { ok: false, error: 'unknown strategy' }, 404);
      const { promote } = await import('./strategy_state.mjs');
      return json(res, promote(id, strat.evidence));
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
```

- [ ] **Step 2: Verify promote then revert**

Run (server running):
```bash
KEY=$(grep DASHBOARD_API_KEY .env | cut -d= -f2)
curl -s -X POST "http://localhost:3000/api/lab/strategy/promote" -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"id":"momentum-sharia"}'
```
Expected: `{"ok":true,"state":"promoted","exposure_mult":1}`.
Then revert for a clean slate: `node --experimental-sqlite -e "import('./dashboard/db.js').then(({db})=>{db.prepare('DELETE FROM strategy_state WHERE strategy_id=?').run('momentum-sharia');db.prepare('DELETE FROM strategy_transitions WHERE strategy_id=?').run('momentum-sharia');console.log('reset')})"`

- [ ] **Step 3: Commit**

```bash
git add dashboard/server.mjs
git commit -m "feat(lab): POST /api/lab/strategy/promote (gate-checked manual promotion)"
```

---

## Task 7: UI — state badge, Promote button, transition timeline, effective exposure

**Files:**
- Modify: `dashboard/index.html` (the `loadLabStrategy()` render function)

- [ ] **Step 1: Add Promote button + timeline to the Strategy Edge card**

In `dashboard/index.html`, inside `loadLabStrategy()`, in the per-strategy card template, after the `lab-regime-strip` status line, insert:

```js
        ${s.recommendedAction === 'promote' ? `<div style="margin-top:8px"><button class="btn btn-primary" style="font-size:11px;padding:4px 12px" onclick="promoteStrategy('${s.id}')" title="Promote::The strategy cleared the gate (real, significant, stable). Click to deploy it at full Scheme-D sizing. Cutting back later is automatic; adding risk needs this click.">▲ Promote to live (${s.exposure_mult > 0 ? 'increase' : 'deploy'})</button></div>` : ''}
        ${(s.transitions && s.transitions.length) ? `<div style="font-size:9px;color:var(--text3);margin-top:8px;line-height:1.6">History: ${s.transitions.map(t => `${t.at} ${t.from || '—'}→${t.to} <span style="opacity:.7">(${t.actor})</span>`).join(' · ')}</div>` : ''}
        <div style="font-size:10px;color:var(--text2);margin-top:6px">Effective exposure now: <strong>${Math.round((s.exposure_mult || 0) * 100)}%</strong> of Scheme-D sizing (state: ${s.status}).</div>
```

- [ ] **Step 2: Add the promote handler**

In `dashboard/index.html`, immediately after the `loadLabStrategy` function, add:

```js
async function promoteStrategy(id) {
  if (!confirm('Promote this strategy to live (full Scheme-D sizing)? Risk-reduction stays automatic; this confirms adding risk.')) return;
  const r = await fetch('/api/lab/strategy/promote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) { alert('Could not promote: ' + (r.error || 'error')); return; }
  loadLabStrategy();
}
```

- [ ] **Step 3: Verify logged-in render is clean**

Run: `node scripts/pw-auth.mjs && node scripts/pw-verify.mjs`
Expected: `✓ no app console errors across all 8 tabs`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/index.html
git commit -m "feat(lab): strategy state UI — promote button, transition timeline, effective exposure"
```

---

## Task 8: Sizing feedback — exposure_mult composes with Scheme D

**Files:**
- Modify: `dashboard/momentum_screen.mjs`

- [ ] **Step 1: Multiply Scheme-D exposure by the strategy's state multiplier**

In `dashboard/momentum_screen.mjs`, add near the top imports:

```js
import { getState } from './strategy_state.mjs';
```

Then in the sizing block, after `let exposure = ...; if (!seasonal.inSeason) exposure = 0;` and before `const exposurePct = ...`, insert:

```js
  // State-machine governor: candidate/retired→0, decaying→×0.5, promoted→×1.0
  const stateMult = getState('momentum-sharia').exposure_mult;
  exposure = exposure * stateMult;
```

- [ ] **Step 2: Reflect the governor in the sizing note**

In the same `sizing` object, change the `note` for the non-zero branch to mention the state, and the zero branch to explain candidate:

Replace the `note: exposure === 0 ? ... : ...` with:

```js
    note: exposure === 0
      ? (stateMult === 0
          ? `Strategy not live yet (state-machine status: candidate/retired) — 0% deployed. Promote it in the Lab's Strategy Edge card to go live.`
          : `Weak month — model says HOLD CASH (0% invested).`)
      : `Put ${exposurePct}% of the account to work (≈${(exposurePct / Math.max(1, holdings.length)).toFixed(1)}% per name), keep ${100 - exposurePct}% cash. Sizing caps risk to a ${(targetVol * 100).toFixed(0)}% volatility budget${stateMult < 1 ? ' and is HALVED because the strategy is decaying' : ''}.`,
```

- [ ] **Step 3: Verify exposure is 0 while candidate, full after promote**

Run (server running):
```bash
KEY=$(grep DASHBOARD_API_KEY .env | cut -d= -f2)
curl -s "http://localhost:3000/api/lab/momentum" -H "x-api-key: $KEY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('exposure',JSON.parse(s).sizing.exposurePct+'%'))"
# expect 0% (candidate). Then promote and re-check:
curl -s -X POST "http://localhost:3000/api/lab/strategy/promote" -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"id":"momentum-sharia"}' >/dev/null
curl -s "http://localhost:3000/api/lab/momentum" -H "x-api-key: $KEY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('after promote',JSON.parse(s).sizing.exposurePct+'%'))"
```
Expected: first `0%`, after promote a non-zero % (the Scheme-D number, e.g. ~88%).

- [ ] **Step 4: Commit**

```bash
git add dashboard/momentum_screen.mjs
git commit -m "feat(momentum): Scheme-D exposure governed by strategy state machine"
```

---

## Task 9: Full regression + self-review

**Files:** none (verification only)

- [ ] **Step 1: Unit tests green**

Run: `node --test tests/strategy_state.test.js`
Expected: all PASS.

- [ ] **Step 2: Existing unit suite still green**

Run: `npm run test:unit`
Expected: pass count unchanged or higher, 0 fail.

- [ ] **Step 3: Logged-in smoke test**

Run: `node scripts/pw-verify.mjs`
Expected: `✓ no app console errors across all 8 tabs`.

- [ ] **Step 4: Decide momentum's live state**

Leave momentum **promoted** (if you want it live) or reset to candidate:
`node --experimental-sqlite -e "import('./dashboard/db.js').then(({db})=>{db.prepare('DELETE FROM strategy_state WHERE strategy_id=?').run('momentum-sharia');db.prepare('DELETE FROM strategy_transitions WHERE strategy_id=?').run('momentum-sharia');console.log('reset to candidate')})"`

- [ ] **Step 5: Final commit (if any tweaks)**

```bash
git add -A && git commit -m "test(lab): regression pass for strategy state machine" || echo "nothing to commit"
```

---

## Self-Review (run after writing, fix inline)

- **Spec coverage:** states ✓ (Task 2/3) · asymmetric auto-down/manual-up ✓ (decide + promote) · rolling+DD triggers ✓ (Task 2/4) · two tables ✓ (Task 1) · sizing feedback ✓ (Task 8) · API ✓ (Task 6) · UI badge/button/timeline ✓ (Task 7) · tests ✓ (Task 2).
- **Type consistency:** `decide()` returns `{state, exposureMult, actor, reason, recommendedAction}` used consistently; persistence returns `exposure_mult` (snake) at the DB/API boundary, `exposureMult` (camel) inside the pure fn — boundary is intentional and consistent within each layer.
- **No placeholders:** all steps carry real code + exact verify commands.
