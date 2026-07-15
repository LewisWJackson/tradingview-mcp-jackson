# ICT Concepts + Doji Scanner — Strategy Spec

Living spec for Keagan's custom GBP/USD chart-analysis project, built on top of this MCP server. Keep this file updated as requirements are added — this is an ongoing, multi-session build.

## Instrument

- Primary chart: **GBPUSD** spot forex. Use `OANDA:GBPUSD` (or another retail forex feed) — do **not** use bare `GBPUSD` or `FX:GBPUSD` in `chart_set_symbol`/`tv symbol --set`, it resolves to `CME_DL:6BU2026` (British Pound *futures*, a different instrument) on this account, likely because of a linked futures broker. Always verify with `tv state` after setting the symbol and confirm the title bar / exchange reads `OANDA` (or your preferred forex broker), not `CME`.

## Implementation

The indicator is developed via the `pine-develop` skill workflow (`node scripts/pine_push.js` / `pine_pull.js`) working out of `scripts/current.pine` (gitignored scratch buffer), and is loaded onto the chart as **"ICT Concepts + Doji Scanner [Keagan]"**. The persisted, version-controlled copy of the source lives at [`indicators/ict-concepts-doji-scanner.pine`](indicators/ict-concepts-doji-scanner.pine) — when you finish an editing session, copy `scripts/current.pine` over that file (`cp scripts/current.pine indicators/ict-concepts-doji-scanner.pine`) so the real deliverable doesn't just live in TradingView's cloud and the gitignored scratch file.

Architecture decision: everything is detected and drawn **natively in Pine Script** (not computed in JS + `draw_shape`), so it redraws live as the chart updates and matches how this repo's other custom indicators already work.

### Structure / ICT concepts (all toggleable via indicator inputs)

| Concept | Status | Logic |
|---|---|---|
| Trend bias (uptrend/downtrend/range) | ✅ v1 | Compares last two confirmed swing highs/lows (HH/HL = uptrend, LH/LL = downtrend), shown in a top-right table |
| Break of Structure (BOS) | ✅ v1 | `close` crosses the last confirmed swing high/low |
| Liquidity sweep | ✅ v1 | Wick trades beyond a swing high/low but closes back inside it; only flags once per level |
| Fair Value Gap (FVG) | ✅ v1 | Classic 3-candle imbalance (`low > high[2]` / `high < low[2]`); box extends right only while unmitigated, freezes once price trades back through it |
| Order Block | ✅ v1 (simplified) | Last opposite-colour candle before a BOS impulse, searched back up to `obLookback` bars; box freezes once mitigated (price closes back through it) |
| Equilibrium / premium-discount | ✅ v1 | 50% midpoint of the current swing range (last swing high ↔ last swing low), with shaded premium/discount zones |
| Live (unconfirmed) swing high/low + live BOS | ✅ v2 (2026-07-15) | Rolling `ta.highest`/`ta.lowest` over a `swingLen`-derived window — no right-side confirmation bars needed, so it reacts intrabar instead of lagging `swingLen` bars behind the confirmed pivots above. Plotted as dotted yellow/orange circles; a "BOS?" triangle marks when price crosses it live. Toggle via `showLiveSwing` / `showLiveBOS`. |
| Previous Day/Week High-Low (PDH/PDL/PWH/PWL) | ✅ v3 (2026-07-15) | Non-repainting via `request.security(..., [high[1], low[1]], lookahead=barmerge.lookahead_off)` on `"D"`/`"W"` — always the last *completed* day/week. Silver dashed lines for day, blue dotted for week, each labeled and extending from the start of that day/week to the current bar. Toggle via `showPDHL` / `showPWHL`. |
| Session highs/lows (Asia/London/NY) | ✅ v3 (2026-07-15) | Tracks the running high/low while each session (`input.session`, default Asia 1900-0400 / London 0300-1200 / NY 0800-1700, all America/New_York) is active; the line freezes and keeps extending right once the session ends, until the next occurrence resets it. Purple/blue/orange lines labeled "ASIA H/L", "LDN H/L", "NY H/L". Toggle via `showSessions`. |

### Doji patterns (exact set requested, each with its own show/hide input)

| Pattern | Status |
|---|---|
| Green Doji | ✅ v1 |
| Red Doji | ✅ v1 |
| Green Long-Legged Doji | ✅ v1 |
| Red Long-Legged Doji | ✅ v1 |
| Green Cross Doji | ✅ v1 |
| Red Inverted Cross Doji | ✅ v1 |
| Green Dragonfly Doji | ✅ v1 |
| Red Gravestone Doji | ✅ v1 |

Classification is mutually exclusive per candle, checked in priority order: **Dragonfly > Gravestone > Cross (symmetric wicks) > Long-Legged (long but asymmetric wicks) > plain Doji (fallback)**. Thresholds are tunable via inputs (`dojiBodyMaxPct`, `oppWickMaxPct`, `longLeggedWickMinPct`, `crossSymTolPct`) — the defaults are a reasonable starting point, not backtested.

Only the exact 8 color/shape combos above are marked (e.g. red dragonfly and green gravestone are *not* marked) because that's what was asked for. The classification variables already compute the shape for any color, so adding the mirror combos later is a one-line change per pattern if wanted.

## Known caveats / not yet done

- Order Block detection is a simplified heuristic (nearest opposite-colour candle before a BOS), not full ICT nuance (no distinction between breaker blocks, mitigation blocks, propulsion blocks, etc.)
- No backtesting/statistics on any of these signals yet — purely visual markup
- No alerts wired up for any of these conditions yet
- Second instrument mentioned early on ("pound is the main one, second is GBP/USD") was clarified to mean GBPUSD is the only instrument for now — revisit if a second pair/cross is actually wanted later
- Doji thresholds are heuristic defaults — tune `dojiBodyMaxPct` / `oppWickMaxPct` / `longLeggedWickMinPct` / `crossSymTolPct` against real chart examples
- Session windows (Asia/London/NY) default to commonly-used ET ranges (1900-0400 / 0300-1200 / 0800-1700) — tune via the `showSessions` group's session inputs if Keagan's actual trading hours differ.
- Confirmed swing/BOS/Order Block structure still has an inherent `swingLen`-bar confirmation lag — `ta.pivothigh`/`ta.pivotlow` need that many bars *after* a pivot to validate it, which is fundamental to what ICT means by a "confirmed" swing, not a bug. The v2 live/unconfirmed layer (see table above) is the workaround for wanting a same-tick reaction; it can relabel which bar was the "swing" as new bars arrive, since it's provisional by design.

## Real-time behavior (added 2026-07-15)

- Doji, FVG, and liquidity-sweep detection already react on every realtime tick by default (Pine indicators recalculate the still-forming bar on each price update) — no code gate was holding them to bar-close.
- Fixed a latent repaint bug: confirmed-BOS and FVG object creation (`line.new`/`box.new`) used live `close`/`high`/`low` inside a one-shot condition with no per-bar guard, so a price chopping back and forth around the level within a single unconfirmed bar could fire the condition on more than one tick and stack duplicate lines/boxes for what should be a single event. Added `bar_index`-based one-shot guards (`lastBullBosBar`/`lastBearBosBar`/`lastBullFvgBar`/`lastBearFvgBar`) — reacts on the first tick the condition trips, never duplicates. Order Block creation is nested under BOS so it inherited the fix for free.
- Added a genuinely lag-free live swing high/low (rolling `ta.highest`/`ta.lowest`) and a "live BOS" marker built on it, since the confirmed pivots are structurally lagged by `swingLen` bars — see the table above.

## Performance fix (2026-07-15)

- Found and fixed a real drawing-object churn bug: the Equilibrium/premium-discount line+boxes, PDH/PDL/PWH/PWL lines+labels, and the Asia/London/NY session H/L lines+labels were all being `line.delete()`/`box.delete()`'d and rebuilt from scratch on **every single bar** (not just when their values actually changed) — across the whole chart history on load and on every realtime tick. That's the classic Pine anti-pattern the docs warn against; it's very likely what "not running smoothly" was pointing at (flicker/lag on lower timeframes, extra load on every tick).
- Rewired all three to the idiomatic pattern: create the line/box/label objects once (`var ... = na`, create only when `na`), then move them in place on every other bar with `line.set_xy1`/`set_xy2`, `box.set_lefttop`/`set_rightbottom`, `label.set_x`/`set_y` instead of deleting and recreating. PDH/PWH and the session levels now only actually delete+recreate on the bar a new day/week/session instance begins (a handful of times a day) instead of every bar.
- Also dropped the redundant `var bool obFound*` flags in the Order Block search loops in favor of an early `break` once the nearest opposite-colour candle is found, instead of always scanning the full `obLookback` range.
- Visual behavior is unchanged — same lines, same values, same freeze-on-mitigation semantics — this is purely an internal efficiency fix. Verified via `tv pine analyze` (0 issues) and `tv pine check` (compiled successfully, 0 errors/0 warnings). Live in-app push (`tv pine set`) hit the known Monaco-fiber-tree fragility noted above and couldn't be used to visually re-confirm on this pass — worth a manual re-check in the TradingView Pine Editor next session.

## Next steps (add to as the project grows)

- (add new requirements here as they come up)
- Re-confirm the performance fix visually in the live Pine Editor once the `pine_push`/`pine_pull` Monaco-fiber fragility isn't blocking (see caveat above)
- Alerts still not wired up for BOS/FVG/sweep/OB conditions (carried over from "Known caveats")
