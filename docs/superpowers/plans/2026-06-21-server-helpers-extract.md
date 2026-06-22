# server.mjs Helper Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract 4 cleanly-decoupled helper clusters out of `dashboard/server.mjs` (4065 lines) into focused flat modules, behavior-equivalent.

**Architecture:** Move verbatim function/constant definitions into `dashboard/{notify,macro,news,signal_format}.mjs`, `export` them, and `import` them back into server.mjs. Two functions that read the module-level `state` object are parameterized instead (`getEarningsCalendar`→`finnhubToken`, `computeDelta`→`scoreHistory`). The `createServer` dispatcher + 97 routes stay. No import cycles (modules import nothing from server.mjs). Spec: `docs/superpowers/specs/2026-06-21-server-helpers-extract-design.md`.

**Tech Stack:** Node 22 ESM, existing `dashboard/server.mjs`, `scripts/pw-verify.mjs`, node:test suites.

**General procedure per module task (apply to Tasks 1–4):**
1. Create the new module file; paste the named definitions VERBATIM from server.mjs (read current file to copy exact bodies); prefix each top-level decl with `export `.
2. Delete those same definitions from server.mjs.
3. Add the `import {…} from "./<mod>.mjs";` line in server.mjs immediately after line 29 (`…from "./catalysts.mjs";`), grouped with the other dashboard imports.
4. Residual-ref check: `grep -nE "\b(<sym1>|<sym2>|…)\b" dashboard/server.mjs` — every hit must be either the new import line or a legitimate use now resolved by it (i.e. no leftover definition). Zero hits outside the import line for any symbol you did NOT import means fine; any used symbol must appear in the import.
5. `node --check dashboard/server.mjs` and `node --check dashboard/<mod>.mjs` → both clean.
6. Boot check (Task helper below) → health 200, no load error.
7. Commit.

**Boot check (used in several tasks):**
```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | while read pid; do ps -p $pid -o command= | grep -q server.mjs && kill $pid; done
sleep 1
(npm run dashboard > /tmp/mawjah-srv.log 2>&1 &)
sleep 3
curl -s -o /dev/null -w "health %{http_code}\n" http://localhost:3000/
tail -5 /tmp/mawjah-srv.log
```
Expected: `health 200`, log shows `TASI Strategy Dashboard` / `http://localhost:3000`, no `Error`/`ReferenceError`.

---

## Task 1: Extract notify.mjs (sendTelegram)

**Files:**
- Create: `dashboard/notify.mjs`
- Modify: `dashboard/server.mjs` (remove `sendTelegram` def @56, add import)

- [ ] **Step 1: Create the module**

Read `dashboard/server.mjs` lines 56–65 (the `async function sendTelegram(token, chatId, text) { … }` definition). Create `dashboard/notify.mjs`:
```javascript
// Telegram notifications — extracted from server.mjs (pure; no shared state).
export async function sendTelegram(token, chatId, text) {
  // ← paste the exact body from server.mjs verbatim
}
```

- [ ] **Step 2: Remove from server.mjs + import**

Delete the `sendTelegram` definition (server.mjs ~56–65). Add after line 29:
```javascript
import { sendTelegram } from "./notify.mjs";
```

- [ ] **Step 3: Residual-ref check**

Run: `grep -nE "\bsendTelegram\b" dashboard/server.mjs`
Expected: only the new `import` line + the call sites (4 total uses), NO `function sendTelegram`.

- [ ] **Step 4: Parse + boot**

Run: `node --check dashboard/notify.mjs && node --check dashboard/server.mjs && echo PARSE_OK`
Then run the Boot check. Expected: `PARSE_OK`, `health 200`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/notify.mjs dashboard/server.mjs
git commit -m "refactor(server): extract sendTelegram → notify.mjs"
```

---

## Task 2: Extract macro.mjs (MACRO_EVENTS, getUpcomingEvents)

**Files:**
- Create: `dashboard/macro.mjs`
- Modify: `dashboard/server.mjs` (remove `MACRO_EVENTS` @174 + `getUpcomingEvents` @245, add import)

- [ ] **Step 1: Create the module**

Read server.mjs lines 174–244 (`const MACRO_EVENTS = [ … ];`) and 245–254 (`function getUpcomingEvents(daysAhead = 21) { … }`). Create `dashboard/macro.mjs`:
```javascript
// Macro calendar events — extracted from server.mjs (pure data + fn).
export const MACRO_EVENTS = [
  // ← paste verbatim
];
export function getUpcomingEvents(daysAhead = 21) {
  // ← paste verbatim
}
```

- [ ] **Step 2: Remove from server.mjs + import**

Delete both definitions. Add after line 29:
```javascript
import { MACRO_EVENTS, getUpcomingEvents } from "./macro.mjs";
```

- [ ] **Step 3: Residual-ref check**

Run: `grep -nE "\b(MACRO_EVENTS|getUpcomingEvents)\b" dashboard/server.mjs`
Expected: the import line + any route uses; NO `const MACRO_EVENTS =` / `function getUpcomingEvents`. If `MACRO_EVENTS` is not referenced anywhere except the import, drop it from the import to avoid an unused import (keep `getUpcomingEvents`).

- [ ] **Step 4: Parse + boot**

Run: `node --check dashboard/macro.mjs && node --check dashboard/server.mjs && echo PARSE_OK`
Then Boot check. Expected: `PARSE_OK`, `health 200`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/macro.mjs dashboard/server.mjs
git commit -m "refactor(server): extract macro calendar → macro.mjs"
```

---

## Task 3: Extract news.mjs (news cache + fetchGoogleNews + getEarningsCalendar w/ token param)

**Files:**
- Create: `dashboard/news.mjs`
- Modify: `dashboard/server.mjs` (remove `getEarningsCalendar` @128, `newsCache` @142, `NEWS_TTL` @143, `fetchGoogleNews` @145; add import; update 2 earnings call sites)

- [ ] **Step 1: Create the module**

Read server.mjs: `getEarningsCalendar` (128–140ish), `newsCache` (142), `NEWS_TTL` (143), `fetchGoogleNews` (145–172ish). Create `dashboard/news.mjs`:
```javascript
// News + earnings calendar — extracted from server.mjs. Owns its cache; no shared state.
const newsCache = new Map();
const NEWS_TTL  = 30 * 60 * 1000;

export async function fetchGoogleNews(query, hl = 'en', gl = 'SA', ceid = 'SA:en') {
  // ← paste verbatim
}

// finnhubToken was previously read from state.settings?.finnhub_token; now a param.
export async function getEarningsCalendar(sym, finnhubToken) {
  // ← paste verbatim, BUT replace the internal line
  //     const token = state.settings?.finnhub_token;
  //   with
  //     const token = finnhubToken;
}
```
Note: `newsCache`/`NEWS_TTL` stay module-private (used only by `fetchGoogleNews`); export only the two functions.

- [ ] **Step 2: Remove from server.mjs + import**

Delete the 4 definitions. Add after line 29:
```javascript
import { fetchGoogleNews, getEarningsCalendar } from "./news.mjs";
```

- [ ] **Step 3: Update the 2 earnings call sites to pass the token**

server.mjs line ~1748: `const event = await getEarningsCalendar(sym);`
→ `const event = await getEarningsCalendar(sym, state.settings?.finnhub_token);`

server.mjs line ~2834: `try { earningsEvent = await getEarningsCalendar(sym); } catch (_) {}`
→ `try { earningsEvent = await getEarningsCalendar(sym, state.settings?.finnhub_token); } catch (_) {}`

- [ ] **Step 4: Residual-ref check**

Run: `grep -nE "\b(getEarningsCalendar|fetchGoogleNews|newsCache|NEWS_TTL)\b" dashboard/server.mjs`
Expected: import line + 2 (now token-passing) `getEarningsCalendar` calls + any `fetchGoogleNews` route calls; NO definitions, NO `newsCache`/`NEWS_TTL` (they moved, module-private). NO call to `getEarningsCalendar(sym)` without a second arg.

- [ ] **Step 5: Parse + boot + curl earnings**

Run: `node --check dashboard/news.mjs && node --check dashboard/server.mjs && echo PARSE_OK`
Then Boot check, then exercise the earnings + news paths:
```bash
JWT=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('.playwright-auth.json'));console.log(j.origins[0].localStorage[0].value)")
curl -s -o /dev/null -w "macro %{http_code}\n" -H "Authorization: Bearer $JWT" "http://localhost:3000/api/macro"
```
Expected: `PARSE_OK`, `health 200`, macro route `200`. (Macro route internally builds earnings via getEarningsCalendar for the calendar; a 200 with no server 500 in `/tmp/mawjah-srv.log` confirms the token param threads.)

- [ ] **Step 6: Commit**

```bash
git add dashboard/news.mjs dashboard/server.mjs
git commit -m "refactor(server): extract news + earnings → news.mjs (token as param)"
```

---

## Task 4: Extract signal_format.mjs (format/compute cluster + computeDelta w/ scoreHistory param)

**Files:**
- Create: `dashboard/signal_format.mjs`
- Modify: `dashboard/server.mjs` (remove `tickerDisplay` @53, `BIAS_RANK` @367, `BEAR_BIASES` @368, `resolveSignalLabel` @375, `computeVelocity` @384, `sectorOf` @397, `getCritPasses` @422, `CRIT_LABELS` @435, `computeDelta` @444; add import; update 1 computeDelta call site)

- [ ] **Step 1: Create the module**

Read server.mjs and copy these definitions VERBATIM into `dashboard/signal_format.mjs`, each prefixed with `export `:
- `function tickerDisplay(sym)` (53)
- `const BIAS_RANK = { … }` (367)
- `const BEAR_BIASES = new Set([ … ])` (368)
- `function resolveSignalLabel(bias, regime, isHolding)` (375)
- `function computeVelocity(hist)` (384)
- `function sectorOf(sym)` (397)
- `function getCritPasses(r)` (422)
- `const CRIT_LABELS = { … }` (435)
- `function computeDelta(newResults, prevResults)` (444) → see Step 1b

```javascript
// Signal formatting + delta/velocity compute — extracted from server.mjs. Pure (state-free).
export function tickerDisplay(sym) { /* verbatim */ }
export const BIAS_RANK = { /* verbatim */ };
export const BEAR_BIASES = new Set([ /* verbatim */ ]);
export function resolveSignalLabel(bias, regime, isHolding) { /* verbatim */ }
export function computeVelocity(hist) { /* verbatim */ }
export function sectorOf(sym) { /* verbatim */ }
export function getCritPasses(r) { /* verbatim */ }
export const CRIT_LABELS = { /* verbatim */ };
export function computeDelta(newResults, prevResults, scoreHistory) { /* verbatim, see 1b */ }
```

- [ ] **Step 1b: Parameterize computeDelta's state read**

Inside the moved `computeDelta`, the line (server.mjs ~475):
`const hist = state.score_history[r.sym] || [];`
→ `const hist = (scoreHistory || {})[r.sym] || [];`
(`scoreHistory` is the new 3rd param; CRIT-cluster callees `getCritPasses`/`BEAR_BIASES`/`BIAS_RANK` are co-located in this module, so they resolve internally.)

- [ ] **Step 2: Remove from server.mjs + import**

Delete all 9 definitions. Add after line 29:
```javascript
import { tickerDisplay, BIAS_RANK, BEAR_BIASES, resolveSignalLabel, computeVelocity, sectorOf, getCritPasses, CRIT_LABELS, computeDelta } from "./signal_format.mjs";
```
(Import the full set — all are referenced by routes that stay: `BEAR_BIASES` 8×, `computeVelocity` 6×, `sectorOf` 5×, `tickerDisplay` 5×, etc.)

- [ ] **Step 3: Update the computeDelta call site**

server.mjs line ~1224:
`state.scan.delta = computeDelta(results, prev?.results || []);`
→ `state.scan.delta = computeDelta(results, prev?.results || [], state.score_history);`

- [ ] **Step 4: Residual-ref check**

Run: `grep -nE "\b(tickerDisplay|BIAS_RANK|BEAR_BIASES|resolveSignalLabel|computeVelocity|sectorOf|getCritPasses|CRIT_LABELS|computeDelta)\b" dashboard/server.mjs`
Expected: the import line + route call sites; NO definitions remain; the `computeDelta` call passes the 3rd arg. If `grep -nE "\b(BIAS_RANK|CRIT_LABELS)\b" dashboard/server.mjs` shows ONLY the import line (no other use), drop that symbol from the import to avoid an unused import.

- [ ] **Step 5: Parse + boot + curl scan-delta path**

Run: `node --check dashboard/signal_format.mjs && node --check dashboard/server.mjs && echo PARSE_OK`
Then Boot check, then:
```bash
JWT=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('.playwright-auth.json'));console.log(j.origins[0].localStorage[0].value)")
curl -s -o /dev/null -w "scan-results %{http_code}\n" -H "Authorization: Bearer $JWT" "http://localhost:3000/api/scan/results"
curl -s -o /dev/null -w "scan-delta %{http_code}\n"   -H "Authorization: Bearer $JWT" "http://localhost:3000/api/scan/delta"
```
Expected: `PARSE_OK`, `health 200`, both routes `200`, no 500 in `/tmp/mawjah-srv.log`.

- [ ] **Step 6: Commit**

```bash
git add dashboard/signal_format.mjs dashboard/server.mjs
git commit -m "refactor(server): extract signal format/delta cluster → signal_format.mjs (scoreHistory as param)"
```

---

## Task 5: Full behavior verification

**Files:** none (verification only)

- [ ] **Step 1: Server line count dropped**

Run: `wc -l dashboard/server.mjs`
Expected: ~3745 (down from 4065).

- [ ] **Step 2: Restart + logged-in smoke test**

Boot check (restart), then:
```bash
SHOT=1 BASE=http://localhost:3000 node scripts/pw-verify.mjs 2>&1 | tail -12
```
Expected: `auth gate passed: YES`, all 8 tabs `switch:ok console-errors:0`, `✓ no app console errors across all 8 tabs`.

- [ ] **Step 3: Curl the affected endpoints**

```bash
JWT=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('.playwright-auth.json'));console.log(j.origins[0].localStorage[0].value)")
for ep in "/api/scan/results" "/api/scan/delta" "/api/macro" "/api/markets/overview"; do
  curl -s -o /dev/null -w "$ep %{http_code}\n" -H "Authorization: Bearer $JWT" "http://localhost:3000$ep"; done
grep -c "Error\|ReferenceError" /tmp/mawjah-srv.log
```
Expected: each endpoint `200` (or its normal status, not 500); error count `0`.

- [ ] **Step 4: Full test suite**

```bash
for s in test:unit test:strategy test:money; do printf "%-14s " "$s"; npm run $s 2>&1 | grep -E "^ℹ (tests|pass|fail) " | paste -sd' ' -; done
```
Expected: unit 29/29, strategy 22/22, money 51/51 — all `fail 0`.

- [ ] **Step 5: Stop the server**

```bash
lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | while read pid; do ps -p $pid -o command= | grep -q server.mjs && kill $pid; done
echo stopped
```

If any check fails, the offending module commit (Tasks 1–4) is identifiable; fix forward or `git revert` that commit.

---

## Notes for the executor

- **Move bodies VERBATIM** — read the current server.mjs to copy exact function bodies; the only content edits are the 2 documented signature/state changes (`getEarningsCalendar` token, `computeDelta` scoreHistory) and adding `export`.
- **`node --check` does NOT catch undefined references** (syntax only). The boot check + endpoint curls are the real net for a missed import — always run them.
- If a residual-ref check finds a moved symbol still referenced with no import covering it, add it to that module's import list.
- Do the tasks IN ORDER; each leaves server.mjs booting and committed (bisectable).
- The `.playwright-auth.json` JWT is reused for authed curls (same token pw-verify uses).
