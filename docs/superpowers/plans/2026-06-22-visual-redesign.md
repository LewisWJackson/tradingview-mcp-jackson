# Mawjah Visual Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the Mawjah dashboard to a premium "editorial + fintech-polish" identity (violet→indigo accent) via a design-system refresh — no functional/logic changes.

**Architecture:** Rework the design tokens and shared-component CSS in `dashboard/assets/app.css` so the new look propagates to all 8 tabs at once; add bespoke hero treatment to the Momentum + Goals buy-list (small CSS + render-helper markup tweaks). All RTL-safe (logical properties already used) and honesty-copy-preserving.

**Tech Stack:** Vanilla CSS custom properties, plain DOM render helpers (`app-core-*.js`, `app-lab.js`), Geist + JetBrains Mono fonts. Verification via Playwright (`scripts/pw-verify.mjs`, `scripts/pw-drawer-smoke.mjs`) + `npm run test:honesty`.

**Spec:** `docs/superpowers/specs/2026-06-22-visual-redesign-design.md`
**Visual reference:** `dashboard/mockups/direction-editorial.html` + `direction-fintech.html`

---

## Conventions for every task

- **No logic changes.** Only CSS in `app.css`, the nav markup in `index.html`, and class/wrapper markup in render helpers. Never touch API/signal/money code.
- **CSS is served live** — after editing `app.css`, just reload `http://localhost:3000` (no server restart). Ensure the dashboard server is running: `npm run dashboard` (background) — see [[pw-auth-session]] memory; `.playwright-auth.json` must exist (`node scripts/pw-auth.mjs` if not).
- **Per-task verification** (replaces unit tests — this is visual work):
  1. `node --check` is N/A for CSS; instead confirm the page still renders.
  2. Reuse this Playwright snippet to screenshot a tab + assert 0 console errors (swap the tab name):
     ```bash
     BASE=http://localhost:3000 SHOT=1 node scripts/pw-verify.mjs
     # → must print "✓ no app console errors across all 8 tabs"; screenshots land in .playwright-auth/
     ```
  3. `npm run test:honesty` must stay green whenever copy/labels are near an edit.
- **RTL:** use logical properties only (`margin-inline-*`, `padding-inline-*`, `border-inline-*`, `inset-inline-*`). Never add `margin-left`/`right`. The app toggles `document.documentElement.dir` in `setLang()` (app-core-01-i18n-fmt.js:459).
- **Commit after each task** with a `style(redesign): …` message.

---

### Task 0: Worktree + baseline screenshots

**Files:** none (setup).

- [ ] **Step 1: Create the worktree** (REQUIRED SUB-SKILL: superpowers:using-git-worktrees)

Create an isolated worktree on branch `feat/visual-redesign` off `main`. Work there for all tasks.

- [ ] **Step 2: Start the server + ensure auth**

```bash
lsof -ti:3000 | xargs kill -9 2>/dev/null; npm run dashboard > /tmp/mawjah-dash.log 2>&1 &
sleep 3; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # expect 200
ls .playwright-auth.json || node scripts/pw-auth.mjs
```

- [ ] **Step 3: Capture BEFORE screenshots**

```bash
SHOT=1 node scripts/pw-verify.mjs
mkdir -p .playwright-auth/before && cp .playwright-auth/tab-*.png .playwright-auth/before/
```
Expected: `✓ no app console errors across all 8 tabs`. Keep `before/` for comparison.

- [ ] **Step 4: Baseline test gate**

```bash
npm run test:honesty && npm run test:money && npm run test:strategy
```
Expected: honesty 2 pass · money 122 pass · strategy 23 pass. (These must stay green to the end.)

---

### Task 1: Unify + replace design tokens

**Files:**
- Modify: `dashboard/assets/app.css:2-27` (first `:root`)
- Modify: `dashboard/assets/app.css:1386-1401` (second `:root` — collapse into the first)

There are two `:root` blocks today; the second (1386-1401) overrides 11 props. Collapse to one source of truth.

- [ ] **Step 1: Replace the first `:root` block (lines 2-27) with the new token set**

```css
:root{
  /* Surface */
  --bg:#0a0b10; --bg2:#0d0e15; --card:#13141c; --card2:#171823;
  --border:rgba(255,255,255,.07); --border2:rgba(255,255,255,.12);
  /* Text */
  --text:#f4f5fa; --text2:#9197ad; --text3:#5a607a;
  /* Brand accent — violet→indigo */
  --accent:#6d5efc; --accent2:#9d92ff;
  --accent-grad:linear-gradient(120deg,#6d5efc,#9d92ff);
  --blue-dim:rgba(109,94,252,.12); --accent-dim:rgba(109,94,252,.12);
  /* Semantic (trend direction — meaning unchanged) */
  --green:#37d399; --green-dim:rgba(55,211,153,.12);
  --lime:#5fe0a8;
  --yellow:#fbbf24; --yellow-dim:rgba(251,191,36,.12);
  --orange:#ff9e64;
  --red:#ff6b6b; --red-dim:rgba(255,107,107,.12);
  /* Geometry */
  --radius:14px; --radius-lg:20px; --radius-xl:26px;
  /* Motion */
  --ease-spring:cubic-bezier(.34,1.56,.64,1); --ease-out:cubic-bezier(.16,1,.3,1); --ease-snappy:cubic-bezier(.4,0,.2,1);
  /* Glows */
  --glow-green:0 2px 14px rgba(55,211,153,.18);
  --glow-accent:0 6px 28px rgba(109,94,252,.28);
  --glow-red:0 2px 14px rgba(255,107,107,.18);
  /* Glass */
  --glass:rgba(255,255,255,.025); --glass-border:rgba(255,255,255,.07);
  /* Shadows */
  --shadow-card:0 1px 0 rgba(255,255,255,.04) inset, 0 10px 40px rgba(0,0,0,.55);
  --shadow-elevated:0 1px 0 rgba(255,255,255,.06) inset, 0 24px 64px rgba(0,0,0,.7);
}
```

- [ ] **Step 2: Delete the second `:root` block (lines 1386-1401)**

Remove the entire `:root{ … }` at ~1386-1401 (now redundant — all its props live in Step 1). Leave surrounding rules intact.

- [ ] **Step 3: Verify**

Reload `http://localhost:3000`. The whole app should shift to the violet/indigo palette with no broken colors.
```bash
SHOT=1 node scripts/pw-verify.mjs   # expect: ✓ no app console errors across all 8 tabs
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/assets/app.css
git commit -m "style(redesign): unify design tokens — violet→indigo palette, softer radius/shadows"
```

---

### Task 2: Body ambient glow + type-scale variables

**Files:**
- Modify: `dashboard/assets/app.css:29-44` (body + body::before)

- [ ] **Step 1: Update the body background to the dual radial accent glow**

In `body{ … }` (lines 29-37) replace the existing `background-image` radial-gradient (lines 34-36) with:
```css
  background-image:
    radial-gradient(900px 520px at 85% -8%, rgba(109,94,252,.08), transparent 60%),
    radial-gradient(700px 480px at 0% 0%, rgba(157,146,255,.05), transparent 55%);
  background-attachment:fixed;
```
Keep the existing `background:var(--bg)` base, font-family, min-height, line-height. Leave the `body::before` grain overlay (39-44) as-is (it complements the new look).

- [ ] **Step 2: Add type-scale custom properties to `:root`**

Append inside the `:root` block from Task 1:
```css
  --fs-display:46px; --fs-h1:30px; --fs-h2:24px; --fs-h3:19px;
  --fs-body:14px; --fs-sm:12.5px; --fs-micro:11px;
  --eyebrow-ls:.12em;
```

- [ ] **Step 3: Verify**

Reload; background should show a subtle violet glow top-right + faint indigo top-left.
```bash
SHOT=1 node scripts/pw-verify.mjs
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/assets/app.css
git commit -m "style(redesign): ambient accent glow on body + type-scale tokens"
```

---

### Task 3: Top nav / header

**Files:**
- Modify: `dashboard/assets/app.css:49-74` (header, .logo, .logo-icon, .header-right, .status-dot)
- Modify: `dashboard/index.html:126-134` (logo markup — gradient mark)

- [ ] **Step 1: Restyle the logo mark to a gradient rounded square**

Replace `.logo-icon` (app.css:60-66) with:
```css
.logo-icon{ width:30px;height:30px;border-radius:9px; background:var(--accent-grad);
  display:grid;place-items:center; color:#0b0712;font-weight:800;font-size:15px;
  box-shadow:0 4px 16px rgba(109,94,252,.35); }
```
Update `.logo` (59-67): `font-size:16px;font-weight:800;letter-spacing:-.01em;`.

- [ ] **Step 2: Ensure the logo markup uses the mark**

In `index.html:127-134`, the `.logo` contains an SVG icon + text "Mawjah". Keep the structure; if the icon is an `<svg>`, wrap/replace its container so `.logo-icon` shows the gradient square with the glyph `≈` (set text content to `≈` inside `.logo-icon` if the SVG is removed, or keep SVG but apply the gradient bg). Do NOT rename ids/classes used by JS.

- [ ] **Step 3: Header bar polish**

In `header` (49-58) confirm it keeps `position:sticky` + backdrop blur; set `border-bottom:1px solid var(--border)` and `background:rgba(10,11,16,.72)`.

- [ ] **Step 4: Verify**

```bash
SHOT=1 node scripts/pw-verify.mjs   # check .playwright-auth/tab-screener.png — gradient mark visible
npm run test:honesty
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/assets/app.css dashboard/index.html
git commit -m "style(redesign): header — gradient brand mark + refined bar"
```

---

### Task 4: Summary tiles

**Files:**
- Modify: `dashboard/assets/app.css:130-155` (`.summary-card*` + variants)
- Modify: `dashboard/assets/app.css:1615-1623` (v2 tile overrides — reconcile/remove duplication)

- [ ] **Step 1: Replace the summary-card block (130-155)**

```css
.summary-card{ position:relative; display:flex; flex-direction:column; gap:12px;
  background:var(--card); border:1px solid var(--border); border-radius:var(--radius-lg);
  padding:0; overflow:hidden; transition:transform .18s var(--ease-out),border-color .18s var(--ease-out); }
.summary-card:hover{ transform:translateY(-2px); border-color:var(--border2); }
.summary-card::before{ content:""; position:absolute; inset:0 0 auto 0; height:2px; opacity:.9; background:var(--text3); }
.summary-card-inner{ display:flex; flex-direction:column; padding:18px 18px 16px; }
.summary-card .label{ font-size:11px; text-transform:uppercase; letter-spacing:.06em; font-weight:600; color:var(--text2); }
.summary-card .value{ font-size:40px; font-weight:800; letter-spacing:-.02em; line-height:1; margin-top:8px; }
.summary-card .sublabel{ font-size:11.5px; color:var(--text3); margin-top:6px; }
/* top accent bar by semantic — labels are trend-state (Strong Uptrend/Uptrend/Building/Strong Downtrend/Scanned) */
.card-sb::before{ background:var(--green); } .card-sb .value{ color:var(--green); }
.card-buy::before{ background:var(--green); } .card-buy .value{ color:var(--text); }
.card-wch::before{ background:var(--yellow); } .card-wch .value{ color:var(--yellow); }
.card-ss::before{ background:var(--red); } .card-ss .value{ color:var(--red); }
.card-tot::before{ background:var(--accent-grad); } .card-tot .value{ color:var(--text); }
```

- [ ] **Step 2: Remove the v2 tile overrides (1615-1623)**

Delete the duplicate `.summary-card`/`.card-*` override rules at ~1615-1623 (now folded into Step 1). If any glow animation there is worth keeping, fold it into Step 1 instead — do not leave conflicting duplicate selectors.

- [ ] **Step 3: Verify the markup didn't change semantics**

`.summary-card-inner` still wraps `.label`/`.value`/`.sublabel` with ids `count-*` (index.html:172-178). No markup edit needed.
```bash
SHOT=1 node scripts/pw-verify.mjs
npm run test:honesty   # tile labels must remain Strong Uptrend/Uptrend/Building/Strong Downtrend
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/assets/app.css
git commit -m "style(redesign): summary tiles — top accent bar + hero numbers"
```

---

### Task 5: Data tables (screener)

**Files:**
- Modify: `dashboard/assets/app.css:215-240` (`.table-wrap`, `thead th`, `tbody tr`)
- Modify: `dashboard/assets/app.css:1733-1748` (v2 row bias indicators — reconcile)

- [ ] **Step 1: Restyle the table container + rows**

```css
.table-wrap{ display:flex; flex-direction:column; background:var(--card);
  border:1px solid var(--border); border-radius:var(--radius-lg); box-shadow:var(--shadow-card); overflow:auto; }
thead th{ position:sticky; top:0; z-index:2; font-size:11px; text-transform:uppercase; letter-spacing:.05em;
  color:var(--text3); font-weight:600; padding:13px 16px; background:var(--card);
  border-bottom:1px solid var(--border2); white-space:nowrap; cursor:pointer; }
tbody td{ padding:13px 16px; border-bottom:1px solid var(--border); }
tbody tr{ transition:background .14s var(--ease-out); cursor:pointer; }
tbody tr:hover{ background:rgba(255,255,255,.025); }
tbody tr:last-child td{ border-bottom:0; }
```
Keep `font-variant-numeric:tabular-nums` on numeric cells (add to `tbody td` if not present).

- [ ] **Step 2: Update the row bias indicator stripe (1733-1748)**

Keep the `border-inline-start` accent stripe pattern but recolor to the new tokens:
```css
tbody tr:has(.bias-strong-buy){ border-inline-start:2px solid var(--green); }
tbody tr:has(.bias-buy){ border-inline-start:2px solid rgba(55,211,153,.5); }
tbody tr:has(.bias-watch){ border-inline-start:2px solid var(--yellow); }
tbody tr:has(.bias-strong-sell){ border-inline-start:2px solid var(--red); }
tbody tr:has(.bias-sell){ border-inline-start:2px solid rgba(255,107,107,.5); }
```

- [ ] **Step 3: Verify (also check RTL — the stripe must flip to the right edge)**

```bash
SHOT=1 node scripts/pw-verify.mjs
```
Then RTL: open `http://localhost:3000`, toggle Arabic (the عربي button), confirm the row stripe sits on the inline-start (right) edge and nothing overflows. (Manual visual check via one screenshot.)

- [ ] **Step 4: Commit**

```bash
git add dashboard/assets/app.css
git commit -m "style(redesign): data table — rounded container, roomier rows, accent stripes"
```

---

### Task 6: Buttons + segmented controls + filter chips

**Files:**
- Modify: `dashboard/assets/app.css:87-120` (`.btn`, `.btn-primary`, `.btn-secondary`)
- Modify: `dashboard/assets/app.css:204-211` (`.filter-btn`)

- [ ] **Step 1: Primary = gradient + glow, secondary = ghost**

```css
.btn{ display:inline-flex; align-items:center; gap:7px; padding:8px 16px; border-radius:var(--radius);
  font-size:13px; font-weight:600; white-space:nowrap; border:1px solid transparent; cursor:pointer;
  transition:transform .14s var(--ease-out),opacity .14s,box-shadow .18s; }
.btn:active{ transform:scale(.97); }
.btn-primary{ background:var(--accent-grad); color:#0b0712; box-shadow:var(--glow-accent); }
.btn-primary:hover{ opacity:.92; box-shadow:0 8px 32px rgba(109,94,252,.36); }
.btn-secondary{ background:var(--glass); border-color:var(--border2); color:var(--text); }
.btn-secondary:hover{ background:rgba(255,255,255,.05); border-color:var(--accent); }
.btn:disabled{ opacity:.35; cursor:not-allowed; }
```

- [ ] **Step 2: Filter chips as pill segments**

```css
.filter-btn{ display:inline-flex; align-items:center; gap:6px; padding:7px 13px; border-radius:999px;
  border:1px solid var(--border); background:transparent; color:var(--text2); font-size:12px; font-weight:500; cursor:pointer;
  transition:.14s var(--ease-out); }
.filter-btn.active{ background:var(--accent-dim); border-color:rgba(109,94,252,.4); color:var(--text); }
.filter-btn:hover:not(.active){ color:var(--text); border-color:var(--border2); }
```

- [ ] **Step 3: Verify**

```bash
SHOT=1 node scripts/pw-verify.mjs
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/assets/app.css
git commit -m "style(redesign): buttons (gradient/ghost) + pill filter chips"
```

---

### Task 7: Generic cards/panels + badges

**Files:**
- Modify: `dashboard/assets/app.css:503-505` (`.scoring-card*`)
- Modify: `dashboard/assets/app.css:258` (`.bias-badge`) and badge rules at 379 / 402 / 1081

- [ ] **Step 1: Card/panel tokens**

```css
.scoring-card{ background:var(--card); border:1px solid var(--border); border-radius:var(--radius-lg);
  box-shadow:var(--shadow-card); overflow:hidden; }
.scoring-card-header{ padding:14px 18px; border-bottom:1px solid var(--border); background:var(--bg2);
  display:flex; align-items:center; justify-content:space-between; }
```

- [ ] **Step 2: Badge restyle (rounded, token colors)**

```css
.bias-badge{ display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:999px;
  font-size:10.5px; font-weight:700; letter-spacing:.02em; }
.cal-badge,.pos-badge,.div-badge{ border-radius:6px; }
```
Keep the per-bias color classes; only the shape/spacing changes. Do not change badge text.

- [ ] **Step 3: Verify**

```bash
SHOT=1 node scripts/pw-verify.mjs
npm run test:honesty
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/assets/app.css
git commit -m "style(redesign): cards/panels + badges to new tokens"
```

---

### Task 8: Drawer (360 card, exec levels, entry-box, crit cards, header)

**Files:**
- Modify: `dashboard/assets/app.css:314-319` (drawer tabs), `549-560` (drawer header/score), `612-630` (`.a360-*`)
- Modify: `dashboard/assets/app.css` exec-levels + entry-box + crit-card rules (search `.exec-`, `.entry-box`, `.crit-`)

- [ ] **Step 1: Drawer header + score block**

```css
.drawer-score-row{ padding:16px 18px; background:var(--glass); border:1px solid var(--border);
  border-radius:var(--radius-lg); box-shadow:var(--shadow-card); }
.drawer-score-num{ font-size:38px; font-weight:800; letter-spacing:-.02em; }
.drawer-ticker{ font-family:"JetBrains Mono",monospace; font-size:11px; color:var(--accent2); font-weight:700; }
.drawer-name{ font-size:18px; font-weight:800; letter-spacing:-.01em; }
.drawer-price{ font-size:24px; font-weight:800; font-family:"JetBrains Mono",monospace; }
```

- [ ] **Step 2: 360 pillars + confidence**

```css
.a360-card{ background:var(--card); border:1px solid var(--border); border-radius:var(--radius-lg); padding:16px; }
.a360-pillar{ background:var(--glass); border:1px solid var(--border); border-radius:var(--radius); padding:12px; }
.a360-pillar-name{ font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); }
.a360-pillar-signal{ font-size:12px; font-weight:700; }
.a360-conf-high{ background:var(--green-dim); color:var(--green); }
.a360-conf-medium{ background:var(--yellow-dim); color:var(--yellow); }
.a360-conf-low{ background:rgba(255,255,255,.06); color:var(--text2); }
```
(Pillar names are JS-set — "Technical/Fundamental/Volume Flow"; do NOT change them, honesty work renamed "Institutional"→"Volume Flow".)

- [ ] **Step 3: exec-levels + entry-box + crit cards**

Recolor these to tokens (replace any hardcoded hex/rgba with `--card`, `--border`, `--radius`, semantic vars). Example for the entry-box:
```css
.entry-box{ background:var(--accent-dim); border:1px solid rgba(109,94,252,.25); border-radius:var(--radius); padding:14px 16px; }
.entry-box-title{ color:var(--accent2); }
```
The exec stop cell stays red (`--red`), T1/T2 green (`--green`) — meaning unchanged.

- [ ] **Step 4: Verify the drawer opens clean (this is the crash-prone surface)**

```bash
npm run test:drawer    # expect ✓ drawer opened cleanly for all N sampled rows
SHOT=1 node scripts/pw-verify.mjs
npm run test:honesty   # drawer honesty copy preserved
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/assets/app.css
git commit -m "style(redesign): drawer — 360 pillars, exec levels, entry-box, score block"
```

---

### Task 9: Forms / inputs

**Files:**
- Modify: `dashboard/assets/app.css` — search `.add-criteria-input`, `.rule-select`, `.gate-input`, any `input`/`select`/`textarea` rules.

- [ ] **Step 1: Consistent input style + accent focus ring**

```css
.add-criteria-input,.rule-select,.gate-input,
input[type=text],input[type=number],input[type=password],select,textarea{
  background:var(--bg2); border:1px solid var(--border); border-radius:var(--radius);
  color:var(--text); padding:9px 12px; font-size:13px; font-family:inherit;
  transition:border-color .14s,box-shadow .14s; }
.add-criteria-input:focus,.rule-select:focus,.gate-input:focus,
input:focus,select:focus,textarea:focus{ outline:none; border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-dim); }
```
If a global `input` rule already exists, merge rather than duplicate.

- [ ] **Step 2: Verify (Settings + Goals editor + Alerts have inputs)**

```bash
SHOT=1 node scripts/pw-verify.mjs   # screenshots tab-universe (Settings), tab-goals, tab-criteria (Alerts)
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/assets/app.css
git commit -m "style(redesign): inputs/selects — consistent style + accent focus ring"
```

---

### Task 10: Momentum hero (bespoke)

**Files:**
- Modify: `dashboard/assets/app-lab.js` — `loadMomentumScreen()` (~line 612) header markup, `buildSuggestedCard(r)` (line 355)
- Modify: `dashboard/assets/app.css` — add `.mom-hero`, `.feature-card` rules (append near the suggested-card styles)

- [ ] **Step 1: Add hero + feature-card CSS**

Append to `app.css`:
```css
.mom-hero{ padding:28px 0 8px; }
.mom-hero .eyebrow{ font-size:12px; font-weight:600; letter-spacing:var(--eyebrow-ls); text-transform:uppercase; color:var(--accent2); }
.mom-hero h2{ font-size:var(--fs-h1); font-weight:800; letter-spacing:-.02em; margin-top:10px; }
.mom-hero p{ color:var(--text2); font-size:15px; margin-top:10px; max-width:560px; line-height:1.6; }
.feature-card{ border:1px solid var(--border); border-radius:var(--radius-xl); padding:28px;
  background:radial-gradient(120% 130% at 100% 0%, rgba(109,94,252,.12), transparent 52%), var(--card); }
.feature-card h3{ font-size:28px; font-weight:800; letter-spacing:-.02em; }
.suggested-card{ border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--card);
  padding:20px; transition:border-color .16s var(--ease-out),transform .16s var(--ease-out); }
.suggested-card:hover{ border-color:var(--border2); transform:translateY(-2px); }
```

- [ ] **Step 2: Add the editorial header to the Momentum tab**

In `loadMomentumScreen()` (app-lab.js ~612), where the momentum panel HTML is assembled, prepend a hero block (only wrap markup; pull existing values like the combo label + nextRebalance that the endpoint already returns):
```js
const hero = `<div class="mom-hero">
  <div class="eyebrow">The one validated edge</div>
  <h2>This month's momentum buy-list</h2>
  <p>${res.universe?.liquid ?? ''} liquid Sharia names screened · top quintile · ranked by the 6-month-momentum × 52-week-high combo${res.nextRebalance ? ` · next rebalance ${res.nextRebalance}` : ''}.</p>
</div>`;
```
Insert `hero` at the top of the panel's innerHTML string. Do NOT change any data/logic — only prepend markup.

- [ ] **Step 3: Verify**

```bash
SHOT=1 node scripts/pw-verify.mjs   # inspect .playwright-auth/tab-momentum.png — hero header + cards
npm run test:honesty
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/assets/app.css dashboard/assets/app-lab.js
git commit -m "style(redesign): Momentum tab hero header + feature buy-list cards"
```

---

### Task 11: Goals hero (bespoke)

**Files:**
- Modify: `dashboard/assets/app-lab.js` — `buildSuggestedCard(r)` (line 355) + the Goals panel header in `renderGoalsPanel`/`loadGoalsPanel`
- Reuse the `.feature-card` / `.suggested-card` CSS from Task 10 (no new CSS unless needed).

- [ ] **Step 1: Apply feature-card treatment to the #1 Goals suggestion**

In `buildSuggestedCard(r)`, when `r.tier === 'enter'` and it's the first card, add the `feature-card` class to the wrapper (keep `suggested-card` for the rest). Only a class addition — no logic change. The honesty copy ("Buy List", "buy at next monthly rebalance", "Illustrative levels") stays verbatim.

- [ ] **Step 2: Verify**

```bash
SHOT=1 node scripts/pw-verify.mjs   # inspect tab-goals.png
npm run test:honesty
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/assets/app-lab.js
git commit -m "style(redesign): Goals buy-list — feature-card treatment for top pick"
```

---

### Task 12: Full verification + cleanup + finish

**Files:**
- Delete: `dashboard/mockups/` (reference no longer needed once landed) — optional, confirm with reviewer first.

- [ ] **Step 1: Full LTR sweep**

```bash
SHOT=1 node scripts/pw-verify.mjs
```
Expected: `✓ no app console errors across all 8 tabs`.

- [ ] **Step 2: Full RTL sweep**

Open `http://localhost:3000`, toggle Arabic (عربي), then:
```bash
SHOT=1 node scripts/pw-verify.mjs
```
Manually compare 2-3 `.playwright-auth/tab-*.png` against `before/` — confirm no overflow, stripes/margins flipped correctly, hero text readable in Arabic.

- [ ] **Step 3: Drawer + money/strategy + honesty gates**

```bash
npm run test:drawer
npm run test:honesty && npm run test:money && npm run test:strategy
```
Expected: drawer clean · honesty 2 · money 122 · strategy 23 — all green (logic untouched).

- [ ] **Step 4: Contrast spot-check**

Eyeball `--text2`/`--text3` on `--card`/`--bg` in the screenshots; bump `--text2`/`--text3` lightness if any label is hard to read (AA target).

- [ ] **Step 5: Remove mockups (after reviewer confirms)**

```bash
git rm -r dashboard/mockups
git commit -m "chore: remove redesign reference mockups (redesign landed)"
```

- [ ] **Step 6: Finish the branch** (REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch)

Run that skill to verify tests, present merge options, execute the choice.

---

## Self-Review

**Spec coverage:**
- Tokens → Task 1 ✓ · Type scale → Task 2 ✓ · Ambient glow → Task 2 ✓
- Nav/brand mark → Task 3 ✓ · Tiles → Task 4 ✓ · Tables → Task 5 ✓ · Buttons/segments/chips → Task 6 ✓ · Cards/badges → Task 7 ✓ · Drawer → Task 8 ✓ · Forms → Task 9 ✓
- Momentum hero → Task 10 ✓ · Goals hero → Task 11 ✓
- Constraints (no logic change, honesty preserved, RTL, both :root blocks, a11y) → enforced in conventions + Task 1 Step 2 (collapse blocks) + Task 12 (RTL + contrast) ✓
- Rollout (worktree) → Task 0 ✓ · Verification (pw-verify LTR+RTL, honesty, drawer, money/strategy) → Task 12 ✓
- Out-of-scope (light mode, per-tab bespoke beyond Momentum/Goals) → respected ✓

**Placeholder scan:** none — every CSS step has concrete values; the two "search for selector" steps (Task 8 Step 3, Task 9) name the exact class names to find because their line numbers weren't enumerated in recon. Acceptable (engineer greps the named class).

**Consistency:** token names (`--accent-grad`, `--card2`, `--accent-dim`, `--fs-*`) are defined in Task 1/2 and reused verbatim in later tasks. Class names (`.feature-card`, `.suggested-card`, `.mom-hero`) defined in Task 10 and reused in Task 11.

**Note on TDD:** this is presentation-only work with no pure-function output to unit-test; verification is visual (Playwright screenshots + 0-console-errors) plus the existing honesty/drawer/money/strategy gates that guard against accidental logic/copy regressions. That is the correct test strategy here.
