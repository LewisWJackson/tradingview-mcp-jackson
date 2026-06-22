# index.html mechanical split — Phase 1 design

**Date:** 2026-06-21
**Status:** approved (brainstorm), pending implementation plan
**Scope:** Extract inline CSS/JS out of `dashboard/index.html` into served static files. Behavior-identical, mechanical. No module system, no logic change, no core slicing.

## Problem

`dashboard/index.html` is 11,401 lines in one file: ~3000 lines CSS (2 `<style>` blocks), ~800 lines HTML markup, ~7500 lines JS (4 `<script>` blocks). This is the platform audit's top-flagged liability: one bad bracket kills the app, no modules/build, hard to diff/edit, no isolation. The 6316-line core script block is the worst offender.

Constraints discovered:
- **No build step / no bundler.** `index.html` is served as a raw file via `html()` in `server.mjs` (route at `path === "/" || "/index.html"`).
- **No general static route** — only `/`, `/landing`, `/screenshots/*` are served. Serving split-out assets requires a new route.
- **Only safety net = `scripts/pw-verify.mjs`** (clicks 8 tabs, asserts 0 console errors). No UI/DOM unit tests.
- All 4 script blocks share ONE global scope and execute top-to-bottom; block 2 functions are called from blocks 3/4.

## Goal / success criteria

- `index.html` reduced to ~800 lines (head + markup + asset links).
- Behavior byte-identical: extracted code unchanged except dropped wrapper tags.
- `pw-verify` 8/8 tabs, 0 console errors. Full test suite (102) still green.
- Single revertable commit.

## Non-goals (Phase 2+)

- Slicing the 6316-line core into modules/by-concern.
- ES modules / import-export.
- Any logic refactor, CSS dedup, or behavior change.

## Architecture & file layout

```
dashboard/
  index.html        ~800 lines (DOCTYPE, <head> with <link>, <body> markup, asset <script> tags)
  assets/
    app.css         <style> block 1 + block 2 concatenated (lines 10–1393 + 1399–3035, ~3000)
    auth.js         <script> block 1 (3837–4092, ~255) — login/register gate
    app-core.js     <script> block 2 (4094–10410, ~6316) — main app (kept intact)
    app-lab.js      <script> block 3 (10437–11370, ~933)
    app-init.js     <script> block 4 (11372–11399, ~27)
```

`index.html` `<head>`: `<link rel="stylesheet" href="/assets/app.css">`.
End of `<body>`, **in original order**:
`<script src="/assets/auth.js"></script>` → `app-core.js` → `app-lab.js` → `app-init.js`.

**Critical constraint — plain `<script src>`, NOT `type="module"`.** Classic script tags preserve the existing single global scope + sequential execution. Modules would make each file scope-private and break every cross-block reference. This is the linchpin of "behavior-identical".

## Serving mechanism (new static route in server.mjs)

Add one route, mirroring the existing `/screenshots/` sanitize+whitelist pattern, placed among the other GET routes (before the catch-all 404):

```js
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

Decisions:
- `replace(/[^a-zA-Z0-9._-]/g,"")` defeats `../` traversal (same defense as the screenshots route); files resolve only inside `dashboard/assets/`.
- Extension whitelist (`.css`/`.js`) → route cannot serve `.db`/`.json`/`.mjs` source.
- `Cache-Control: no-cache` → assets re-fetched each load; avoids stale-asset confusion during dev (matches index.html's current behavior). Can tighten for prod later.
- No auth — same as index.html today; the login gate is client-side in `auth.js` and must load before it runs.

## Execution procedure

1. Copy CSS block 1 + block 2 → `assets/app.css` (in order).
2. Copy each script block's inner JS → its `.js` file (no `<script>` tags).
3. Rewrite `index.html`: keep head meta/title, add `<link>`; keep all `<body>` markup; replace the 4 inline `<script>` blocks with 4 `<script src>` tags in original order.
4. Add the `/assets/` route to `server.mjs`.

## Verification gate (all must pass before commit)

- `node --check` on each extracted `.js` (catches a bad cut).
- Byte-equivalence guard: concatenated extracted JS == original inline JS (tags ignored) — proves no content change. Diff before/after.
- Restart server; run `pw-verify` → 8/8 tabs, 0 console errors (catches 404s, load-order, scope errors).
- DOM assertion per former block: login gate renders, a tab switches, Lab loads (per the dashboard-verify convention — DOM assertions + one top-of-tab shot, no mid-page scroll shots).
- Full test suite (102) green — should be untouched (no `.mjs` logic changed beyond the route).

## Risk register

| Risk | Mitigation |
|---|---|
| Load-order break | preserve exact block order + global scope (plain scripts) |
| Missing-asset 404 | caught by pw-verify console-errors |
| Path traversal in new route | sanitize + ext-whitelist |
| Stale browser cache during verify | `no-cache` header |

## Rollback

Single commit; `git revert` restores the inline `index.html` instantly.
