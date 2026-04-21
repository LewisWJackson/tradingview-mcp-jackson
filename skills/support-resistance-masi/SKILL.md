---
name: support-resistance-masi
description: Chart support and resistance using the Masi Trades top-down methodology — weekly → daily → 4H → intraday. Draws horizontal lines at key levels and validates them across timeframes. Use when the user asks to chart S/R levels, identify key price levels, map support and resistance, or prepare levels for scalping/swing trading.
---

# Support & Resistance Charting (Masi Trades Method)

Top-down approach: Weekly → Daily → 4H → Intraday. Most levels should be established before reaching the lower timeframes.

## Step 1: Weekly Chart (3-Year View)

```
chart_set_timeframe("W")
chart_scroll_to_date(3 years back)
```

Identify and draw:
- Major swing highs and swing lows (wick extremes)
- Long-term trendlines from swing low origin to recent highs
- Psychological round numbers (every 50–100 pts on S&P)
- Previous resistance turned support (breakout/retest zones)

Draw each level: `draw_shape` with `horizontal_line`, label it (e.g., "W: 5800 psych").

## Step 2: Daily Chart (1-Year View)

```
chart_set_timeframe("D")
chart_scroll_to_date(1 year back)
```

Identify and draw:
- Candle clusters / consolidation bases (repeated wicks/bodies at same level)
- Gap fills and unfilled gap levels
- Refine weekly zones to more precise prices

Do NOT redraw levels already captured from weekly — only add what's new.

## Step 3: 4-Hour Chart (Swing Validation)

```
chart_set_timeframe("240")
```

- Validate or discard levels from higher timeframes
- Look for short-term S/R near trendline bounces or breakdown zones
- This is the lowest timeframe used for swing trade prep

## Step 4: Intraday (1H / 30min / 15min) — Scalping Only

Only add levels if clearly significant in real-time:
- Consistent intraday highs/lows that held multiple times
- Consolidation zones visible on current session

**Rule**: If the level isn't already present from a higher timeframe, it needs to be clearly obvious to add it here.

## Charting Rules

| What to Look For | How to Chart It |
|-----------------|-----------------|
| Wick highs/lows | `horizontal_line` at wick extreme |
| Candle base clusters | `horizontal_line` at the base/top of the cluster |
| Trendlines | `trend_line` from swing low origin → recent high |
| Round numbers (S&P every 50/100 pts) | `horizontal_line` labeled "psych" |

- Always start from the **left of the chart** and work right
- Round to nearest 5–10 pts — do not obsess over pixel-perfect placement
- Label each line with timeframe and context: `"W: 5800 psych"`, `"D: 5745 base"`, `"4H: 5720 S/R"`

## Step 5: Validate Levels

After charting all timeframes:
1. `capture_screenshot` — visual confirmation of drawn levels
2. A valid level **must show significance on at least one lower timeframe** than where it was found
3. If a weekly level shows no reaction on daily/4H, remove or de-prioritize it

## Scalping Usage (Level-to-Level)

Once levels are mapped, scalp trades target the **next level** after a break:
- Break of 5970 → target 5960
- Break of 5960 → target 5950

Confidence is highest when the level aligns across **2-min to 15-min timeframes**.

## Workflow Summary

```
1. chart_set_timeframe("W") → chart_scroll_to_date → draw weekly levels
2. chart_set_timeframe("D") → chart_scroll_to_date → add daily refinements
3. chart_set_timeframe("240") → validate, add 4H levels
4. chart_set_timeframe("60") or lower → scalp-only intraday additions
5. capture_screenshot → review and validate all levels
6. Remove levels that don't hold across timeframes
```
