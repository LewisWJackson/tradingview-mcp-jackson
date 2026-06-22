# index.html Mechanical Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the inline CSS and JS from `dashboard/index.html` (11,401 lines) into served static asset files, leaving index.html as ~markup-only, with zero behavior change.

**Architecture:** A one-shot deterministic node builder (`scripts/split_index.mjs`) asserts the exact `<style>`/`<script>` boundary lines, writes the inner content to `dashboard/assets/{app.css,auth.js,app-core.js,app-lab.js,app-init.js}`, and rebuilds index.html by substituting each block in-situ with a `<link>`/`<script src>` one-liner. A new sanitized `/assets/` route in `server.mjs` serves the files. Plain `<script src>` (not ES modules) preserves the single shared global scope and execution order, so behavior is byte-identical. The builder is untracked and deleted after a successful run; only the assets + rewritten index.html + server route are committed.

**Tech Stack:** Node 22 (`node:fs`), the existing `dashboard/server.mjs` HTTP server, `scripts/pw-verify.mjs` (Playwright smoke test), node:test suites.

**Boundary line map (1-indexed, verified 2026-06-21):**
| Block | Open tag line | Close tag line | Inner lines |
|---|---|---|---|
| style 1 | 10 | 1393 | 11–1392 |
| style 2 | 1399 | 3035 | 1400–3034 |
| script 1 (auth) | 3837 | 4092 | 3838–4091 |
| script 2 (core) | 4094 | 10410 | 4095–10409 |
| script 3 (lab) | 10437 | 11370 | 10438–11369 |
| script 4 (init) | 11372 | 11399 | 11373–11398 |

Kept-in-place segments: 1–9 (head), 1394–1398 (comment between styles), 3036–3836 (head close + body markup), 4093 (blank), 10411–10436 (glossary/checklist/mwj-tt markup), 11371 (blank), 11400–end (`</body></html>`).

---

## Task 1: Snapshot the original for the equivalence guard

**Files:**
- Create: `dashboard/index.html.orig` (untracked working copy)

- [ ] **Step 1: Copy the current file**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
cp dashboard/index.html dashboard/index.html.orig
wc -l dashboard/index.html.orig
```
Expected: `11401 dashboard/index.html.orig`

- [ ] **Step 2: Confirm it is ignored, not staged**

```bash
git status --short dashboard/index.html.orig
```
Expected: shows `?? dashboard/index.html.orig` (untracked). Do NOT git add it.

---

## Task 2: Write the builder script

**Files:**
- Create: `scripts/split_index.mjs` (untracked, one-shot)

- [ ] **Step 1: Write the builder**

```javascript
// scripts/split_index.mjs — one-shot: split dashboard/index.html into served assets.
// Asserts every boundary tag; aborts (writes nothing) if any assumption is wrong.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'dashboard', 'index.html');
const ASSETS = join(ROOT, 'dashboard', 'assets');
const lines = readFileSync(SRC, 'utf8').split('\n');

// 1-indexed boundary lines → 0-indexed array positions.
const at = (n) => lines[n - 1];
const must = (n, tag) => { if (at(n).trim() !== tag) throw new Error(`line ${n}: expected ${tag}, got ${JSON.stringify(at(n))}`); };
must(10, '<style>'); must(1393, '</style>');
must(1399, '<style>'); must(3035, '</style>');
must(3837, '<script>'); must(4092, '</script>');
must(4094, '<script>'); must(10410, '</script>');
must(10437, '<script>'); must(11370, '</script>');
must(11372, '<script>'); must(11399, '</script>');

// slice(a,b) is 0-indexed, end-exclusive. inner(L1,L2) = source lines L1..L2 inclusive.
const inner = (l1, l2) => lines.slice(l1 - 1, l2).join('\n');

const cssText = inner(11, 1392) + '\n' + inner(1400, 3034);
const authJs  = inner(3838, 4091);
const coreJs  = inner(4095, 10409);
const labJs   = inner(10438, 11369);
const initJs  = inner(11373, 11398);

mkdirSync(ASSETS, { recursive: true });
writeFileSync(join(ASSETS, 'app.css'), cssText);
writeFileSync(join(ASSETS, 'auth.js'), authJs);
writeFileSync(join(ASSETS, 'app-core.js'), coreJs);
writeFileSync(join(ASSETS, 'app-lab.js'), labJs);
writeFileSync(join(ASSETS, 'app-init.js'), initJs);

// Rebuild index.html: keep non-block segments verbatim, substitute each block in-situ.
const seg = (l1, l2) => lines.slice(l1 - 1, l2);     // inclusive segment as array
const out = [
  ...seg(1, 9),                                       // head up to before <style>
  '<link rel="stylesheet" href="/assets/app.css">',
  ...seg(1394, 1398),                                 // comment between the two style blocks
  // style block 2 dropped (its CSS is in app.css)
  ...seg(3036, 3836),                                 // </head><body> + markup up to before script 1
  '<script src="/assets/auth.js"></script>',
  ...seg(4093, 4093),                                 // blank line between scripts 1 and 2
  '<script src="/assets/app-core.js"></script>',
  ...seg(10411, 10436),                               // glossary/checklist/mwj-tt markup
  '<script src="/assets/app-lab.js"></script>',
  ...seg(11371, 11371),                               // blank line between scripts 3 and 4
  '<script src="/assets/app-init.js"></script>',
  ...seg(11400, lines.length),                        // </body></html>
];
writeFileSync(SRC, out.join('\n'));
console.log(`OK: wrote 5 assets + rebuilt index.html (${out.length} lines, was ${lines.length})`);
```

- [ ] **Step 2: Confirm it is untracked**

```bash
git status --short scripts/split_index.mjs
```
Expected: `?? scripts/split_index.mjs`. Do NOT git add it.

---

## Task 3: Run the builder

**Files:**
- Modify: `dashboard/index.html` (rewritten)
- Create: `dashboard/assets/{app.css,auth.js,app-core.js,app-lab.js,app-init.js}`

- [ ] **Step 1: Run it**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
node scripts/split_index.mjs
```
Expected: `OK: wrote 5 assets + rebuilt index.html (~850 lines, was 11401)` (exact count printed; anything in the 820–870 range is fine)
If it throws `line N: expected ...`, STOP — a boundary moved; do not proceed. Restore with `cp dashboard/index.html.orig dashboard/index.html` and re-check line numbers.

- [ ] **Step 2: Sanity-check sizes**

```bash
wc -l dashboard/index.html dashboard/assets/*.js dashboard/assets/app.css
```
Expected (approx): index.html ~850, app.css ~3018, auth.js ~254, app-core.js ~6315, app-lab.js ~932, app-init.js ~26.

---

## Task 4: Byte-equivalence guard (the "test")

**Files:** none (verification only)

- [ ] **Step 1: Assert each asset equals the original inner range**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
node --input-type=module -e '
import { readFileSync } from "node:fs";
const o = readFileSync("dashboard/index.html.orig","utf8").split("\n");
const inner = (a,b)=>o.slice(a-1,b).join("\n");
const rd = f=>readFileSync("dashboard/assets/"+f,"utf8");
const chk=(name,got,exp)=>{ if(got!==exp){console.error("MISMATCH "+name);process.exit(1);} };
chk("app.css", rd("app.css"), inner(11,1392)+"\n"+inner(1400,3034));
chk("auth.js", rd("auth.js"), inner(3838,4091));
chk("app-core.js", rd("app-core.js"), inner(4095,10409));
chk("app-lab.js", rd("app-lab.js"), inner(10438,11369));
chk("app-init.js", rd("app-init.js"), inner(11373,11398));
console.log("EQUIVALENCE OK — all asset bytes match original inner ranges");
'
```
Expected: `EQUIVALENCE OK — all asset bytes match original inner ranges`
If MISMATCH: STOP, restore from `.orig`, investigate.

- [ ] **Step 2: Confirm index.html links all five assets in order**

```bash
grep -nE '/assets/(app\.css|auth\.js|app-core\.js|app-lab\.js|app-init\.js)' dashboard/index.html
```
Expected: 5 lines, in order app.css, auth.js, app-core.js, app-lab.js, app-init.js. No remaining inline `<style>`/`<script>` (without src):
```bash
grep -cE '^<style>|^<script>$' dashboard/index.html
```
Expected: `0`

- [ ] **Step 3: JS parses**

```bash
for f in auth app-core app-lab app-init; do node --check dashboard/assets/$f.js && echo "$f OK"; done
```
Expected: `auth OK` / `app-core OK` / `app-lab OK` / `app-init OK`. (CSS has no parser; covered by pw-verify rendering.)

---

## Task 5: Add the /assets/ route to the server

**Files:**
- Modify: `dashboard/server.mjs` (add route near the `/screenshots/` route, ~line 1852)

- [ ] **Step 1: Find the screenshots route as the insertion anchor**

```bash
grep -n 'path.startsWith("/screenshots/")' dashboard/server.mjs
```
Expected: one line (~1853). Insert the new route immediately BEFORE it.

- [ ] **Step 2: Add the route**

Insert this block immediately before the `// Serve screenshot files` comment:

```javascript
  // Serve dashboard static assets (css/js split out of index.html)
  if (path.startsWith("/assets/") && method === "GET") {
    const filename = path.slice("/assets/".length).replace(/[^a-zA-Z0-9._-]/g, ""); // strip path-traversal
    const ext = filename.slice(filename.lastIndexOf("."));
    const TYPES = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    if (!TYPES[ext]) { res.writeHead(404); return res.end("Not found"); }
    const fp = join(__dirname, "assets", filename);
    if (!existsSync(fp)) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[ext], "Cache-Control": "no-cache" });
    return res.end(readFileSync(fp));
  }

```

- [ ] **Step 3: Server parses**

```bash
node --check dashboard/server.mjs && echo "server OK"
```
Expected: `server OK`

---

## Task 6: Live verification

**Files:** none (verification only)

- [ ] **Step 1: Restart the dashboard on current code**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | while read pid; do ps -p $pid -o command= | grep -q server.mjs && kill $pid; done
sleep 1
(npm run dashboard > /tmp/mawjah-split.log 2>&1 &)
sleep 3
curl -s -o /dev/null -w "health %{http_code}\n" http://localhost:3000/
```
Expected: `health 200`

- [ ] **Step 2: Assets serve with correct MIME + 404 for junk**

```bash
for f in app.css auth.js app-core.js app-lab.js app-init.js; do
  curl -s -o /dev/null -w "$f %{http_code} %{content_type}\n" http://localhost:3000/assets/$f; done
curl -s -o /dev/null -w "traversal %{http_code}\n" "http://localhost:3000/assets/..%2f..%2fserver.mjs"
curl -s -o /dev/null -w "badext %{http_code}\n" "http://localhost:3000/assets/mawjah.db"
```
Expected: each asset `200` with `text/css` or `text/javascript`; traversal `404`; badext `404`.

- [ ] **Step 3: Logged-in smoke test (the real safety net)**

```bash
SHOT=1 BASE=http://localhost:3000 node scripts/pw-verify.mjs 2>&1 | tail -12
```
Expected: `auth gate passed: YES`, all 8 tabs `switch:ok console-errors:0`, `✓ no app console errors across all 8 tabs`.
If ANY tab shows console-errors > 0: STOP — likely a load-order or missing-asset issue. Restore `index.html` from `.orig`, restore `server.mjs` via `git checkout`, investigate.

- [ ] **Step 4: Full test suite unaffected**

```bash
for s in test:unit test:strategy test:money; do printf "%-14s " "$s"; npm run $s 2>&1 | grep -E "^ℹ (tests|pass|fail) " | paste -sd' ' -; done
```
Expected: unit 29/29, strategy 22/22, money 51/51 — all `fail 0`.

- [ ] **Step 5: Stop the server**

```bash
lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | while read pid; do ps -p $pid -o command= | grep -q server.mjs && kill $pid; done
echo stopped
```

---

## Task 7: Clean up and commit

**Files:**
- Delete: `dashboard/index.html.orig`, `scripts/split_index.mjs` (one-shot artifacts)
- Commit: `dashboard/index.html`, `dashboard/assets/*`, `dashboard/server.mjs`

- [ ] **Step 1: Remove one-shot artifacts**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
rm dashboard/index.html.orig scripts/split_index.mjs
```

- [ ] **Step 2: Stage only the real outputs**

```bash
git add dashboard/index.html dashboard/assets/app.css dashboard/assets/auth.js dashboard/assets/app-core.js dashboard/assets/app-lab.js dashboard/assets/app-init.js dashboard/server.mjs
git status --short
```
Expected: 6 new/modified under `dashboard/` (5 new assets + modified index.html + modified server.mjs), nothing else. Confirm no `.orig`/`split_index.mjs` staged.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(dashboard): split index.html into served static assets (Phase 1)

Extract the two <style> blocks → assets/app.css and the four <script> blocks →
assets/{auth,app-core,app-lab,app-init}.js, linked from index.html via plain
<link>/<script src> (NOT modules — preserves the single shared global scope and
execution order, so behavior is byte-identical). index.html drops 11,401 → ~803
lines. Add a sanitized /assets/ route (path-traversal strip + css/js ext
whitelist + no-cache) mirroring the /screenshots/ route.

Verified: asset bytes equal the original inner ranges; /assets/ serves correct
MIME, 404s traversal + non-whitelisted ext; pw-verify 8/8 tabs 0 console errors;
full suite (unit 29, strategy 22, money 51) green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
Expected: commit succeeds, 7 files changed (1 modified index.html, 1 modified server.mjs, 5 new assets).

---

## Notes for the executor

- **Do not** convert to `type="module"` — it breaks the shared global scope. Plain `<script src>` only.
- **Do not** reorder the four scripts — auth → app-core → app-lab → app-init, matching the original.
- If any boundary assertion in Task 3 fails, the line numbers in this plan are stale (index.html changed since 2026-06-21). Re-run the `grep -nE '^<style>|^</style>|^<script>$|^</script>$' dashboard/index.html` boundary scan and update the builder's `must(...)` lines + ranges before retrying.
- The `.orig` snapshot is the rollback for the equivalence guard during the run; after commit, `git revert` is the rollback.
