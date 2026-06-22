# server Foundation Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the `state` singleton → `dashboard/state.mjs` and the `json`/`html`/`readBody` helpers → `dashboard/http_util.mjs`, behavior-equivalent, so route groups can later move out verbatim.

**Architecture:** Two verbatim moves + `import` rewiring (the pattern used for the prior 3 splits). `state` is a never-reassigned singleton, so an exported `const state` preserves the shared-object reference every `state.x = …` mutation depends on — the 131 `state.` refs and 207 helper refs in server.mjs resolve via the new imports with no call-site edits. Spec: `docs/superpowers/specs/2026-06-21-server-foundation-design.md`.

**Tech Stack:** Node 22 ESM, `dashboard/server.mjs`, `scripts/pw-verify.mjs`, node:test suites.

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

## Task 1: Extract http_util.mjs (json, html, readBody)

**Files:**
- Create: `dashboard/http_util.mjs`
- Modify: `dashboard/server.mjs` (remove the 3 defs @986–1009, add import)

- [ ] **Step 1: Create the module**

Read `dashboard/server.mjs` lines 986–1009 (the `json`, `html`, `readBody` definitions). Create `dashboard/http_util.mjs`:
```javascript
// HTTP response/request helpers — extracted from server.mjs (near-pure).
import { readFileSync } from "node:fs";

export function json(res, data, status = 200) {
  // ← paste exact body from server.mjs verbatim
}

export function html(res, filePath) {
  // ← paste exact body verbatim (uses readFileSync)
}

export function readBody(req, maxBytes = 1_000_000) {
  // ← paste exact body verbatim
}
```

- [ ] **Step 2: Remove from server.mjs + import**

Delete the 3 definitions (server.mjs ~986–1009, leaving the `// ── Helpers ──` banner or removing it — your choice, cosmetic). Add after line 29 (`…from "./catalysts.mjs";`):
```javascript
import { json, html, readBody } from "./http_util.mjs";
```

- [ ] **Step 3: Residual-ref check**

Run: `grep -nE "\b(function json|function html|function readBody)\b" dashboard/server.mjs`
Expected: **no output** (no definitions remain). Then `grep -c "from \"./http_util.mjs\"" dashboard/server.mjs` → `1`.

- [ ] **Step 4: Parse + boot**

Run: `node --check dashboard/http_util.mjs && node --check dashboard/server.mjs && echo PARSE_OK`
Then the Boot check. Expected: `PARSE_OK`, `health 200` (the `/` route uses `html` → proves the import resolves), no error in log.

- [ ] **Step 5: Commit**

```bash
git add dashboard/http_util.mjs dashboard/server.mjs
git commit -m "refactor(server): extract json/html/readBody → http_util.mjs"
```

---

## Task 2: Extract state.mjs (the state singleton)

**Files:**
- Create: `dashboard/state.mjs`
- Modify: `dashboard/server.mjs` (remove `const state = {…}` @240–248, add import)

- [ ] **Step 1: Create the module**

Read `dashboard/server.mjs` lines 240–248 (the `const state = { … };` literal). Create `dashboard/state.mjs`:
```javascript
// Shared mutable app state — single source of truth, imported by server + (later) route modules.
// Never reassign `state`; only mutate its properties so all importers share one reference.
export const state = {
  // ← paste the exact literal body verbatim (scan/universe/settings/positions/virtual/score_history/alert_rules)
};
```

- [ ] **Step 2: Remove from server.mjs + import**

Delete the `const state = { … };` literal (server.mjs ~240–248). Add after line 29 (with the other dashboard imports):
```javascript
import { state } from "./state.mjs";
```

- [ ] **Step 3: Residual-ref check**

Run: `grep -nE "^const state *=" dashboard/server.mjs`
Expected: **no output** (literal gone). Then `grep -c "from \"./state.mjs\"" dashboard/server.mjs` → `1`. `state.` references throughout remain (they now resolve via the import) — do NOT edit them.

- [ ] **Step 4: Parse + boot**

Run: `node --check dashboard/state.mjs && node --check dashboard/server.mjs && echo PARSE_OK`
Then the Boot check. Expected: `PARSE_OK`, `health 200`, no error in log.

- [ ] **Step 5: Commit**

```bash
git add dashboard/state.mjs dashboard/server.mjs
git commit -m "refactor(server): extract state singleton → state.mjs"
```

---

## Task 3: Full behavior verification

**Files:** none (verification only)

- [ ] **Step 1: Restart + confirm state mutation crosses the import boundary**

Boot check (restart). Then exercise a `state` write→read path (settings save uses `readBody` + mutates `state.settings`, GET reads it back):
```bash
JWT=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('.playwright-auth.json'));console.log(j.origins[0].localStorage[0].value)")
curl -s -o /dev/null -w "settings-get %{http_code}\n" -H "Authorization: Bearer $JWT" "http://localhost:3000/api/settings"
curl -s -o /dev/null -w "settings-save %{http_code}\n" -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{"risk_percent":1.5}' "http://localhost:3000/api/settings"
curl -s -H "Authorization: Bearer $JWT" "http://localhost:3000/api/settings" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log('risk_percent ->', o.risk_percent ?? o.settings?.risk_percent)})"
```
Expected: settings-get `200`, settings-save `200`, the read-back prints `risk_percent -> 1.5` (proves the imported singleton mutated and persisted — the load-bearing correctness check).

- [ ] **Step 2: Curl the helper + state read surface**

```bash
JWT=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('.playwright-auth.json'));console.log(j.origins[0].localStorage[0].value)")
for ep in "/api/scan/results" "/api/scan/delta" "/api/positions"; do
  curl -s -o /dev/null -w "$ep %{http_code}\n" -H "Authorization: Bearer $JWT" "http://localhost:3000$ep"; done
curl -s -o /dev/null -w "/ %{http_code}\n" http://localhost:3000/
grep -c "Error\|ReferenceError" /tmp/mawjah-srv.log
```
Expected: each endpoint `200` (`json` + `state` reads working), `/` `200` (`html`), error count `0`.

- [ ] **Step 3: Logged-in smoke test**

```bash
SHOT=1 BASE=http://localhost:3000 node scripts/pw-verify.mjs 2>&1 | tail -12
```
Expected: `auth gate passed: YES`, all 8 tabs `switch:ok console-errors:0`, `✓ no app console errors across all 8 tabs`.

- [ ] **Step 4: Full test suite**

```bash
for s in test:unit test:strategy test:money; do printf "%-14s " "$s"; npm run $s 2>&1 | grep -E "^ℹ (tests|pass|fail) " | paste -sd' ' -; done
```
Expected: unit 29/29, strategy 22/22, money 78/78 — all `fail 0`.

- [ ] **Step 5: Stop the server**

```bash
lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | while read pid; do ps -p $pid -o command= | grep -q server.mjs && kill $pid; done
echo stopped
```

If any check fails, the offending module commit (Task 1 or 2) is identifiable; fix forward or `git revert` it.

---

## Notes for the executor

- **Move bodies VERBATIM** — read current server.mjs to copy exact bodies; only edits are adding `export` and the import lines. No logic changes.
- **Do NOT edit the 131 `state.` or 207 `json`/`html`/`readBody` call sites** — they resolve via the new imports unchanged.
- `node --check` does NOT catch undefined references — the boot check + the settings write→read curl (Task 3 Step 1) are the real net. Always run them.
- Do the tasks IN ORDER; each leaves server.mjs booting and committed (bisectable).
- The `.playwright-auth.json` JWT is reused for authed curls.
- If the settings route path differs (`/api/settings` 404), find it: `grep -nE 'path === "/api/settings"|/api/settings' dashboard/server.mjs` and use the actual path; the goal is any POST that mutates `state` then a GET that reads it.
