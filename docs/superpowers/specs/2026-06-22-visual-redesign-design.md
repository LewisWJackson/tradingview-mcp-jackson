# Mawjah Visual Redesign — Design Spec

**Date:** 2026-06-22
**Status:** awaiting user review
**Direction chosen:** B+C hybrid (Editorial identity + Fintech polish) · design-system refresh · violet→indigo accent

## Goal

Give Mawjah a distinctive, premium quant-finance identity so it no longer reads as a generic "AI dark-dashboard template." Influence: quantango.tech (premium minimal, big display type, generous whitespace) combined with modern-SaaS polish (gradient accents, glow, smooth micro-interactions). One coherent visual pass across the whole app — **no functional/logic changes.**

## Approach

**Design-system refresh**, not a per-tab bespoke rebuild. Rework the design tokens and restyle the shared components in `app.css` (3,016 lines) + the shared render helpers. Because every tab is built from the same primitives (nav, summary tiles, tables, cards, buttons, drawer, forms), restyling the primitives propagates the new look to all 8 tabs at once — consistent, lower-risk, reviewable. Two surfaces get bespoke "hero" treatment because they carry the one validated edge: **Momentum** and **Goals** (the buy-list).

Mockups that set the target: `dashboard/mockups/direction-editorial.html` (bones) + `direction-fintech.html` (polish). Keep them as the visual reference until the redesign lands, then delete.

## Design Tokens (concrete)

Dark-only (no light mode — out of scope). Replace/extend the `:root` block in `app.css`.

```
/* Surface */
--bg:        #0a0b10;   /* app background (slightly warmer/deeper than current #040507) */
--bg-elev:   #0d0e15;   /* raised sections */
--card:      #13141c;   /* card/panel */
--card-2:    #171823;   /* nested/hover */
--line:      rgba(255,255,255,.07);
--line-2:    rgba(255,255,255,.12);

/* Text */
--text:   #f4f5fa;
--text-2: #9197ad;
--text-3: #5a607a;

/* Brand accent — violet→indigo */
--accent:    #6d5efc;
--accent-2:  #9d92ff;
--accent-grad: linear-gradient(120deg,#6d5efc,#9d92ff);
--accent-dim: rgba(109,94,252,.12);
--glow-accent: 0 6px 28px rgba(109,94,252,.28);

/* Semantic (trend direction — unchanged meaning) */
--up:   #37d399;
--down: #ff6b6b;
--warn: #fbbf24;

/* Geometry */
--radius:    14px;   /* up from 10–12 — softer, more premium */
--radius-lg: 20px;
--radius-xl: 26px;
--shadow-card:     0 1px 0 rgba(255,255,255,.04) inset, 0 10px 40px rgba(0,0,0,.55);
--shadow-elevated: 0 1px 0 rgba(255,255,255,.06) inset, 0 24px 64px rgba(0,0,0,.7);

/* Ambient: subtle radial accent glow on body (fintech polish) */
body background-image:
  radial-gradient(900px 520px at 85% -8%, rgba(109,94,252,.08), transparent 60%),
  radial-gradient(700px 480px at 0% 0%, rgba(157,146,255,.05), transparent 55%);
```

Keep the second (duplicate) `:root` override block in `app.css` (~line 1387) in sync, or collapse to one — implementation plan decides.

## Typography

- Display/UI: keep **Geist** (already loaded) — it suits the editorial direction. Numbers/code: keep **JetBrains Mono** (tabular-nums). Arabic: keep **Noto Sans Arabic**.
- Establish an explicit **type scale** (editorial hierarchy): display 44–48 / h1 30 / h2 24 / h3 19 / body 14 / small 12.5 / micro 11. Hero numbers (summary tiles, buy-list price) go large (32–48) and bold (700–800), letter-spacing −.02em.
- Section headers become larger + bolder with an uppercase letter-spaced "eyebrow" line above (the editorial motif).

## Component restyle inventory (shared → propagates to all tabs)

1. **Top nav / header** — brand mark (gradient rounded square `≈` + "Mawjah"), tab links with a quiet active state (subtle filled pill), status pills (Live with pulsing dot, Sharia ✓) as rounded chips.
2. **Summary tiles** — card with a thin top accent bar colored by semantic (up/warn/down/gradient-for-total), big hero number, uppercase micro label. (Labels already trend-state per the honesty work — preserve exactly: Strong Uptrend / Uptrend / Building / Strong Downtrend / Scanned.)
3. **Data tables** — rounded container, hairline row dividers, generous row padding, rank chips (#1 gets the gradient), monospace tabular numbers, inline mini bars (gradient) for 52w-high / momentum, quiet hover. Keep denser than the editorial mockup so Screener/Markets stay scannable.
4. **Cards / panels** — `--card`, `--radius-lg`, soft shadow, optional corner radial-glow for "hero" cards.
5. **Buttons** — primary = gradient fill + glow; secondary = bordered ghost; both `--radius`.
6. **Segmented controls / filters / style chips** — pill segments in a bordered track.
7. **Drawer (stock detail)** — apply card/型 token + the 360 pillars, exec-levels box, entry-guidance restyled to the new cards (content/copy unchanged — honesty copy preserved verbatim).
8. **Forms / inputs (Settings, Goals editor, Alerts)** — consistent input style, focus ring in accent.
9. **Badges** — trend-state, Sharia, experimental tags restyled; semantics unchanged.

## Bespoke hero treatments (high-value only)

- **Momentum tab** — editorial header (eyebrow "The one validated edge" + big headline + sub citing the combo/rebalance), hero buy-list rows, a gradient-glow "top of buy-list #1" feature card. (Matches editorial mockup.)
- **Goals tab** — Suggested Positions as premium buy-list cards (the momentum re-rank already shipped); apply the feature-card treatment + plan cells.

## Constraints (hard)

- **No functional/logic change.** Pure presentation: tokens, CSS, class/markup in render helpers. No API, no money-path, no signal logic.
- **Preserve the honesty work verbatim** — all trend-state labels, "not a buy signal / validated buy-list = Momentum tab" copy, experimental tags. The honesty CI guard must stay green.
- **RTL / Arabic preserved** — every change must work in `[dir=rtl]`; use logical properties (margin-inline, etc.), verify the Arabic toggle.
- **Both `:root` token blocks** in app.css kept consistent.
- **Accessibility** — text contrast ≥ WCAG AA on the new surfaces; focus-visible rings.

## Rollout

- Work on a branch (`feat/visual-redesign`) — likely a git worktree to keep main clean.
- Land as one coherent series of commits (tokens → shared components → hero surfaces → polish), each verified.

## Verification (per the project's standards)

- `npm run test:honesty` green (labels/copy preserved).
- `node scripts/pw-verify.mjs` → 8/8 tabs, 0 console errors, in **both LTR and RTL** (run once, toggle Arabic, run again) + `SHOT=1` screenshots for before/after.
- `npm run test:drawer` green (drawer still opens clean).
- `npm run test:money` + `test:strategy` green (should be untouched, but confirm no accidental logic edits).
- Manual: spot-check contrast + the Momentum/Goals hero surfaces.

## Out of scope

- Light mode / theming system.
- Per-tab bespoke layout beyond Momentum + Goals.
- New features, charts, or data.
- Logo/wordmark redesign beyond the simple gradient mark (can revisit later).
