# app-core.js Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slice `dashboard/assets/app-core.js` (6309 lines) into 8 contiguous plain-`<script>` files by concern, in original order, with zero behavior change.

**Architecture:** A one-shot deterministic node builder (`scripts/split_core.mjs`) asserts the 7 cut-line markers, writes 8 slices from exact line ranges, rewrites index.html to load them in order, and deletes app-core.js. Plain `<script src>` preserves the single shared global scope (51 inline onclick handlers depend on it). No server change — the existing `/assets/` route already serves `.js`. Spec: `docs/superpowers/specs/2026-06-21-app-core-split-design.md`.

**Tech Stack:** Node 22 (`node:fs`), existing `dashboard/server.mjs` `/assets/` route, `scripts/pw-verify.mjs`, node:test suites.

**Boundary line map (1-indexed, verified 2026-06-21 against the 6309-line file):**
| Slice | File | Lines | Cut-line marker (exact start text) |
|---|---|---|---|
| 1 | app-core-01-i18n-fmt.js | 1–790 | (file start) |
| 2 | app-core-02-screener.js | 791–1244 | `function switchTab(name,btn){` |
| 3 | app-core-03-panels.js | 1245–1887 | `const calCache={};` |
| 4 | app-core-04-table-drawer-nav.js | 1888–2897 | `function shariaHtml(sym){` |
| 5 | app-core-05-markets-portfolio.js | 2898–3946 | `const divCache={};` |
| 6 | app-core-06-drawer-analysis.js | 3947–4943 | `function get360TechPillar(r) {` |
| 7 | app-core-07-drawer-scan-init.js | 4944–5640 | `function openDrawer(r){` |
| 8 | app-core-08-feeds-misc.js | 5641–6309 | `const TYPE_LABELS = { fed:'Fed',` |

---

## Task 1: Snapshot the original for the equivalence guard

**Files:**
- Create: `dashboard/assets/app-core.js.orig` (untracked working copy)

- [ ] **Step 1: Copy + record line count**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
cp dashboard/assets/app-core.js dashboard/assets/app-core.js.orig
wc -l dashboard/assets/app-core.js.orig
```
Expected: `6309 dashboard/assets/app-core.js.orig`

- [ ] **Step 2: Confirm untracked**

```bash
git status --short dashboard/assets/app-core.js.orig
```
Expected: `?? dashboard/assets/app-core.js.orig`. Do NOT git add it.

---

## Task 2: Write the builder script

**Files:**
- Create: `scripts/split_core.mjs` (untracked, one-shot)

- [ ] **Step 1: Write the builder**

```javascript
// scripts/split_core.mjs — one-shot: slice dashboard/assets/app-core.js into 8 plain-script files.
// Asserts every cut-line marker; aborts (writes nothing) if any assumption is wrong.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'dashboard', 'assets', 'app-core.js');
const INDEX = join(ROOT, 'dashboard', 'index.html');
const lines = readFileSync(CORE, 'utf8').split('\n');

// 1-indexed cut starts → marker prefixes. Slice boundaries derived from these.
const cuts = [
  { line: 791,  marker: 'function switchTab(name,btn){',      file: 'app-core-02-screener.js' },
  { line: 1245, marker: 'const calCache={};',                 file: 'app-core-03-panels.js' },
  { line: 1888, marker: 'function shariaHtml(sym){',          file: 'app-core-04-table-drawer-nav.js' },
  { line: 2898, marker: 'const divCache={};',                 file: 'app-core-05-markets-portfolio.js' },
  { line: 3947, marker: 'function get360TechPillar(r) {',     file: 'app-core-06-drawer-analysis.js' },
  { line: 4944, marker: 'function openDrawer(r){',            file: 'app-core-07-drawer-scan-init.js' },
  { line: 5641, marker: "const TYPE_LABELS = { fed:'Fed',",   file: 'app-core-08-feeds-misc.js' },
];
for (const c of cuts) {
  const got = lines[c.line - 1];
  if (!got.startsWith(c.marker)) throw new Error(`line ${c.line}: expected start ${JSON.stringify(c.marker)}, got ${JSON.stringify(got)}`);
}

// Build 8 slices: starts at [1, 791, 1245, 1888, 2898, 3947, 4944, 5641], ends are next start-1 (last = EOF).
const starts = [1, ...cuts.map(c => c.line)];
const files = ['app-core-01-i18n-fmt.js', ...cuts.map(c => c.file)];
const sliceText = (i) => {
  const a = starts[i] - 1;                                 // 0-indexed inclusive
  const b = (i + 1 < starts.length) ? starts[i + 1] - 1 : lines.length; // exclusive
  return lines.slice(a, b).join('\n');
};
for (let i = 0; i < files.length; i++) {
  writeFileSync(join(ROOT, 'dashboard', 'assets', files[i]), sliceText(i));
}

// Rewrite index.html: replace the single app-core.js script tag with 8 in order.
let html = readFileSync(INDEX, 'utf8');
const oldTag = '<script src="/assets/app-core.js"></script>';
if (!html.includes(oldTag)) throw new Error(`index.html: '${oldTag}' not found`);
const newTags = files.map(f => `<script src="/assets/${f}"></script>`).join('\n');
html = html.replace(oldTag, newTags);
writeFileSync(INDEX, html);

// Delete the now-split monolith.
unlinkSync(CORE);
console.log(`OK: wrote ${files.length} slices, rewrote index.html, deleted app-core.js`);
```

- [ ] **Step 2: Confirm untracked**

```bash
git status --short scripts/split_core.mjs
```
Expected: `?? scripts/split_core.mjs`. Do NOT git add it.

---

## Task 3: Run the builder

**Files:**
- Modify: `dashboard/index.html` (script tags), delete `dashboard/assets/app-core.js`
- Create: `dashboard/assets/app-core-0{1..8}-*.js`

- [ ] **Step 1: Run it**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
node scripts/split_core.mjs
```
Expected: `OK: wrote 8 slices, rewrote index.html, deleted app-core.js`
If it throws `line N: expected start ...`, STOP — a cut marker moved. Restore with `cp dashboard/assets/app-core.js.orig dashboard/assets/app-core.js`, re-derive the boundary lines (`grep -nE '^function switchTab|^const calCache=|^function shariaHtml|^const divCache=|^function get360TechPillar|^function openDrawer|^const TYPE_LABELS' dashboard/assets/app-core.js.orig`), update the `cuts` line numbers, and retry.

- [ ] **Step 2: Sanity-check sizes**

```bash
wc -l dashboard/assets/app-core-0*.js
ls dashboard/assets/app-core.js 2>&1 | grep -q "No such file" && echo "app-core.js deleted OK"
```
Expected: 8 files summing to ~6309 lines (~790, 454, 643, 1010, 1049, 997, 697, 669); `app-core.js deleted OK`.

---

## Task 4: Byte-equivalence guard (the "test")

**Files:** none (verification only)

- [ ] **Step 1: Assert concat of the 8 slices === original app-core.js**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
node --input-type=module -e '
import { readFileSync } from "node:fs";
const orig = readFileSync("dashboard/assets/app-core.js.orig","utf8");
const files = ["app-core-01-i18n-fmt.js","app-core-02-screener.js","app-core-03-panels.js","app-core-04-table-drawer-nav.js","app-core-05-markets-portfolio.js","app-core-06-drawer-analysis.js","app-core-07-drawer-scan-init.js","app-core-08-feeds-misc.js"];
const concat = files.map(f=>readFileSync("dashboard/assets/"+f,"utf8")).join("\n");
if (concat !== orig) { console.error("MISMATCH: concatenated slices != original"); process.exit(1); }
console.log("EQUIVALENCE OK — 8 slices concatenate to the exact original");
'
```
Expected: `EQUIVALENCE OK — 8 slices concatenate to the exact original`
If MISMATCH: STOP, restore `app-core.js` from `.orig`, `git checkout dashboard/index.html`, investigate (likely a join/boundary error).

- [ ] **Step 2: Each slice parses**

```bash
for f in dashboard/assets/app-core-0*.js; do node --check "$f" && echo "$(basename $f) OK"; done
```
Expected: 8 lines, each `... OK`. (Syntax only; cross-file globals are not resolved by --check, which is correct.)

- [ ] **Step 3: index.html links all 8 in order, no app-core.js**

```bash
grep -nE '/assets/app-core-0[0-9]' dashboard/index.html
grep -c '/assets/app-core\.js"' dashboard/index.html
```
Expected: 8 lines in numeric order 01→08; second command prints `0`.

---

## Task 5: Live verification

**Files:** none (verification only)

- [ ] **Step 1: Restart the dashboard**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | while read pid; do ps -p $pid -o command= | grep -q server.mjs && kill $pid; done
sleep 1
(npm run dashboard > /tmp/mawjah-core-split.log 2>&1 &)
sleep 3
curl -s -o /dev/null -w "health %{http_code}\n" http://localhost:3000/
```
Expected: `health 200`

- [ ] **Step 2: All 8 slices serve with JS MIME**

```bash
for f in 01-i18n-fmt 02-screener 03-panels 04-table-drawer-nav 05-markets-portfolio 06-drawer-analysis 07-drawer-scan-init 08-feeds-misc; do
  curl -s -o /dev/null -w "app-core-$f.js %{http_code} %{content_type}\n" http://localhost:3000/assets/app-core-$f.js; done
curl -s -o /dev/null -w "old app-core.js %{http_code}\n" http://localhost:3000/assets/app-core.js
```
Expected: each slice `200 text/javascript; charset=utf-8`; old `app-core.js` `404`.

- [ ] **Step 3: Logged-in smoke test (the real safety net)**

```bash
SHOT=1 BASE=http://localhost:3000 node scripts/pw-verify.mjs 2>&1 | tail -12
```
Expected: `auth gate passed: YES`, all 8 tabs `switch:ok console-errors:0`, `✓ no app console errors across all 8 tabs`.
If ANY tab has console-errors > 0: STOP — likely a load-order break or a global that landed in the wrong slice. Restore `app-core.js` from `.orig`, `git checkout dashboard/index.html`, re-examine the failing tab's functions. Do not commit.

- [ ] **Step 4: Full suite unaffected**

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

## Task 6: Clean up and commit

**Files:**
- Delete: `dashboard/assets/app-core.js.orig`, `scripts/split_core.mjs` (one-shot artifacts)
- Commit: new 8 slices, deleted `app-core.js`, modified `index.html`

- [ ] **Step 1: Remove one-shot artifacts**

```bash
cd /Users/mohammedal-sudani/tradingview-mcp-jackson
rm dashboard/assets/app-core.js.orig scripts/split_core.mjs
```

- [ ] **Step 2: Stage outputs**

```bash
git add -A dashboard/assets/ dashboard/index.html
git status --short
```
Expected: 8 new `app-core-0N-*.js`, deleted `app-core.js`, modified `index.html`. No `.orig`/`split_core.mjs` present.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(dashboard): split app-core.js into 8 concern files (Phase 2)

Slice the 6309-line app-core.js into 8 contiguous plain-<script> files in
original order (app-core-01-i18n-fmt … 08-feeds-misc), loaded in sequence from
index.html. Plain scripts preserve the single shared global scope, so the 51
inline onclick handlers keep working unchanged. Byte-identical (the 8 slices
concatenate to the exact original). No server change — /assets/ already serves
.js.

Verified: byte-equivalence guard passed; node --check clean on all 8; each
serves as text/javascript, old app-core.js 404s; pw-verify 8/8 tabs 0 console
errors; full suite (unit 29, strategy 22, money 51) green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
Expected: commit succeeds — 10 files changed (8 new, 1 deleted, 1 modified).

---

## Notes for the executor

- **Do not** convert to `type="module"` — breaks the shared global scope the 51 inline onclick handlers depend on. Plain `<script src>` only.
- **Do not** reorder the slices — numeric order 01→08 == original file order; reordering risks load-time top-level dependencies.
- If a cut-marker assertion fails in Task 3, the line numbers are stale (app-core.js changed since 2026-06-21). Re-derive boundaries via the grep in Task 3 Step 1 and update the builder's `cuts` line numbers before retrying.
- The `.orig` snapshot is the rollback during the run; after commit, `git revert`.
