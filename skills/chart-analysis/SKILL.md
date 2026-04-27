---
name: chart-analysis
description: Analyze a chart — set up symbol/timeframe, add indicators, scroll to key dates, annotate, and screenshot. Use when the user wants technical analysis or chart review.
---

# Chart Analysis Workflow

You are performing technical analysis on a TradingView chart.

## Step 1: Set Up the Chart

1. `chart_set_symbol` — switch to the requested symbol
2. `chart_set_timeframe` — set the appropriate timeframe
3. Wait for the chart to load (the tool handles this)
4. `chart_get_state` — read back symbol, timeframe, chart type, AND the list of currently loaded indicators with their entity IDs. Cache these IDs for the rest of the session — you will need them to remove indicators later, and re-fetching is wasted work.

## Step 2: Add Indicators

Use `chart_manage_indicator` to add studies. **TradingView requires the FULL name** (e.g., "RSI" alone fails):

- "Relative Strength Index" (RSI)
- "Moving Average Exponential" (EMA)
- "Moving Average" (SMA)
- "MACD"
- "Bollinger Bands"
- "Volume"
- "Volume Weighted Average Price" (VWAP)
- "Average True Range" (ATR)
- "Average Directional Index" (ADX)
- "Stochastic RSI"

After adding, use `indicator_set_inputs` to customize settings (e.g., change EMA length to 200).

## Step 3: Navigate to Key Areas

- `chart_scroll_to_date` — jump to a specific date of interest
- `chart_set_visible_range` — zoom to a specific date window
- `chart_get_visible_range` — check what's currently visible

## Step 4: Annotate

Use drawing tools to mark up the chart:
- `draw_shape` with `horizontal_line` for support/resistance
- `draw_shape` with `trend_line` for trend channels (needs two points)
- `draw_shape` with `text` for annotations

## Step 5: Capture and Analyze

1. `capture_screenshot` — screenshot the annotated chart
2. `data_get_study_values` — **primary tool** to read current numeric values from all loaded indicators (RSI, MACD, BBands, EMAs, etc.). Always call this before reporting indicator readings — do not estimate from chart visuals.
3. `data_get_ohlcv` — pull recent price data. **Always pass `summary: true`** unless you specifically need individual bars; the summary form returns compact stats (high, low, range, change%, last 5 bars) and avoids context bloat. Use `count: 20` for quick analysis, `count: 100` for deeper work.
4. `quote_get` — current real-time price (does not depend on chart TF, more reliable than OHLCV for current price)
5. `symbol_info` — symbol metadata (exchange, type, session)

### Custom Pine indicators (KhanSaab, SMC, etc.)

Custom indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()` — these are **invisible** to `data_get_study_values`. If the chart has any custom Pine indicator, also call:

- `data_get_pine_lines` — horizontal price levels (deduplicated, sorted high→low)
- `data_get_pine_labels` — text annotations with prices ("PDH 24550", "Bias Long ✓", entry/SL labels)
- `data_get_pine_tables` — dashboard rows (session stats, bull/bear scores, bias)
- `data_get_pine_boxes` — order block / FVG zones as {high, low}

Use the `study_filter` parameter to target one indicator by name substring (e.g., `study_filter: "Sniper"`) and avoid scanning all studies unnecessarily.

### Symbol-mismatch guard

After `chart_set_symbol`, the chart may take a beat to settle. The bridge already verifies the symbol on subsequent reads (`expectedSymbol` guard returns `_symbolMismatch: true` when the chart is still on the previous ticker). If you see `_symbolMismatch` in any tool result, do **not** report that data — re-issue the read after a short wait, or re-call `chart_set_symbol`.

## Step 6: Report

Provide the analysis:
- Current price and recent range (from `quote_get` + `data_get_ohlcv` summary)
- Key support/resistance levels identified (combine drawn lines + Pine line/label outputs)
- Indicator readings (RSI overbought/oversold, MACD crossover, ADX trend strength, etc.) — sourced from `data_get_study_values`, not estimated
- Overall bias (bullish/bearish/neutral) with reasoning

## Cleanup

If you added indicators the user didn't ask for, remove them:
- `chart_manage_indicator` with action "remove" and the entity_id from your Step 1 cache
- `draw_clear` to remove all drawings if they were temporary
