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
| Macro / news context | ✅ v4 (2026-07-15) | Pine has no live internet access, so this is a manually-maintained layer: a `macroBias` input (Bullish/Bearish/Neutral, second row in the BIAS table, tooltip carries a free-text `macroNote`) plus up to 3 hand-entered high-impact event times (`event1Time`..`event3Time` + labels) that draw a vertical marker/label when reached and shade a `blackoutMins`-long no-trade background after each — reinforcing the `rules.json` risk rule of not trading around high-impact news. Current defaults reflect 2026-07-15 research: `macroBias` = Bullish (cooling US CPI + dovish Fed Chair Warsh testimony pressuring USD, i.e. GBP-supportive), with events set to the Jul 14 CPI release, Jul 14 Fed Chair testimony, and Jul 17 prelim consumer sentiment. **Needs manual refresh** — nothing here updates itself as new data comes out. |

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
- Macro/news layer (v4) is inherently manual — Pine can't call out to the web, so `macroBias`/`macroNote`/event times are a snapshot of whatever research was done at edit time, not a live feed. Re-run the research and update the inputs periodically (or wire up a note in `rules.json`'s `notes` field and cross-reference it here) rather than trusting stale defaults.
- v4 was verified with `tv pine check` (server-side compile, 0 errors/0 warnings) but **not** pushed into the live on-chart copy in TradingView's cloud — the CDP-attached desktop window in that session was too narrow (1094×677 logical px) for TradingView's bottom widget bar to open Pine Editor at all (`bottomWidgetBar._enabledWidgetsConfigs` came back empty even after `activateScriptEditorTab`/dialog-button clicks). Run the normal `pine-develop` push/compile loop from a normally-sized window to get this onto the live chart.

## Real-time behavior (added 2026-07-15)

- Doji, FVG, and liquidity-sweep detection already react on every realtime tick by default (Pine indicators recalculate the still-forming bar on each price update) — no code gate was holding them to bar-close.
- Fixed a latent repaint bug: confirmed-BOS and FVG object creation (`line.new`/`box.new`) used live `close`/`high`/`low` inside a one-shot condition with no per-bar guard, so a price chopping back and forth around the level within a single unconfirmed bar could fire the condition on more than one tick and stack duplicate lines/boxes for what should be a single event. Added `bar_index`-based one-shot guards (`lastBullBosBar`/`lastBearBosBar`/`lastBullFvgBar`/`lastBearFvgBar`) — reacts on the first tick the condition trips, never duplicates. Order Block creation is nested under BOS so it inherited the fix for free.
- Added a genuinely lag-free live swing high/low (rolling `ta.highest`/`ta.lowest`) and a "live BOS" marker built on it, since the confirmed pivots are structurally lagged by `swingLen` bars — see the table above.

## Next steps (add to as the project grows)

- (add new requirements here as they come up)
