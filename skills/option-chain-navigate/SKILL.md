---
name: option-chain-navigate
description: Navigate to a ticker's option chain, select a specific contract, open its own 1-minute intraday candlestick chart, and save a clean native screenshot. Use when the user wants option chain data or a specific contract's chart for one of the six tickers FATTAH tracks (AAPL, MSFT, NVDA, TSLA, IBIT, META).
---

# Option Chain + Option Chart Navigation

Confirmed end-to-end on 2026-07-19 (TSLA 382.5 PUT, AAPL 335 CALL). Every step
below was verified live — either by direct automation or by the user
demonstrating it manually while screenshots were captured before/after.

**Automated scraper now exists:** `scripts/fetch_option_chain.mjs` automates
Steps 1–3 below (open chain, ±10 strikes) across all six tickers and reads
the whole grid programmatically — see its own header comment and the README's
"Standalone Scripts" section. Two things learned building it, worth folding
into any future manual navigation too:

- **The chevron next to the ticker pill is not reliably found via
  `[aria-label="Change symbol"]`.** That aria-label belongs to the *chart
  legend* text row (e.g. "NVIDIA Corporation · 15 · NASDAQ"), a different
  element than the top-left toolbar pill+chevron. Clicking an offset computed
  from it lands on the wrong toolbar button (opened "Change interval" in
  testing, not the Chart/Assets dropdown). The toolbar chevron is reliably at
  a **fixed `(170, 19)`** regardless of ticker name length — confirmed for
  both AAPL and NVDA — use that directly rather than deriving it.
- **The chain grid is a real `<table>`**, not a canvas — strike rows carry
  `data-strike="{strike}"`, and each call/put cell carries
  `data-cell-id="OPRA:{TICKER}{YYMMDD}{C|P}{STRIKE}"` directly. Read these
  attributes instead of parsing cell text or screenshots; the header row's
  cell-text order (`Strike` column index ± fixed offsets for Ask/Bid) is only
  needed for pricing, not identity.

Ad banners and hover tooltips (e.g. "Market closed") appear constantly on the
free/unpaid TradingView plan and silently intercept clicks. Run the
**Close Any Ad** snippet after every step, and if a click seems to have no
effect, screenshot first — check for an overlay before assuming the automation
is broken.

## Step 1: Load the Ticker

```
node src/cli/index.js symbol {TICKER}
```

Wait ~1s for `chart_ready: true`.

## Step 2: Open the Option Chain

The chain lives behind a small unlabeled icon immediately to the right of the
ticker name badge in the chart header — the "diamond with a candle inside"
icon. NOT the ticker name itself (opens Symbol Search instead) and NOT the
account avatar at the far left.

1. Click the action button next to the ticker badge:
   ```
   node src/cli/index.js ui mouse 170 19
   ```
   Opens a dropdown: **Chart** / FUNDAMENTALS (Financials, Documents) /
   ANALYSIS (Technicals, Seasonals, News, Forecast, Community) / **ASSETS**
   (Options, Bonds, ETFs).

2. Click "Options" under ASSETS:
   ```
   node src/cli/index.js ui mouse 220 427
   ```

3. Confirm it loaded:
   ```
   node src/cli/index.js ui find "ASSETS" -s text
   ```
   (count > 0 means the menu rendered; screenshot to confirm the chain grid
   itself, since the menu can render without the click registering — see the
   troubleshooting note below.)

These coordinates are stable across AAPL, META, TSLA in the same session, but
**re-derive live each time with `ui find` rather than trusting hardcoded
numbers** — a hidden duplicate panel in the DOM can shift the real one's
x-offset by ~50px between page loads. Search for
`aria_label: "Change symbol"` to relocate the ticker badge, then look for its
unlabeled sibling button (`class` starting `action-`) at the same y, offset
right by 52-66px.

**Troubleshooting — click "does nothing":** before assuming a coordinate is
wrong, screenshot and check for a tooltip/popup covering that exact region
(TradingView's "Market closed" status tooltip reappears often and silently
eats clicks meant for the menu underneath it). Move the mouse away
(`ui mouse 900 600`) and re-screenshot to confirm it's gone before retrying.

## Step 3: Set the Strike Range (optional)

Default ±6 strikes. Click the strikes dropdown:
```
node src/cli/index.js ui mouse 290 245
```
Presets: ±2, ±4, ±6, ±8, ±10, "Near the money (±5%)", "All strikes", "Manual
strike range". **±10 is the max clean preset** — "All strikes" returns 100+
rows and mixes in hidden greeks data if scraped programmatically. Locate a
preset live:
```
node src/cli/index.js ui find "±10 strikes" -s text
```

To see more than fits on screen, scroll the panel's own container (find it
fresh each time — the class hash changes per build):
```
node src/cli/index.js ui eval "
(function(){
  var all = Array.from(document.querySelectorAll('*'));
  var s = all.filter(function(el){ return el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 100; });
  return s.map(function(e){ return e.className; });
})()
"
node src/cli/index.js ui eval "document.querySelector('.wrapper-XXXX').scrollTop += 350"
```
Do **not** use `ui keyboard Escape` to navigate within the chain — it closes
the whole overlay and drops you back to the main chart.

## Step 4: Select a Contract

Click the Bid or Ask price cell for the strike you want (not the strike box
itself — that filters ALL expirations down to one strike instead, a different
feature). Get live coordinates first, the grid re-lays-out constantly:
```
node src/cli/index.js ui find "{price}" -s text
```

This expands an inline detail row: Price / Greeks / Misc / payoff diagram,
plus two buttons — **"Launch builder"** and **"See overview"**.

## Step 5: Click "See overview" → Option's Own Chart

```
node src/cli/index.js ui find "See overview" -s text   # get live coords
node src/cli/index.js ui mouse {x} {y}
```

**Confirmed 2026-07-19:** this navigates to the option contract's own chart —
legend reads e.g. `"TSLA OPTIONS 20 JUL 2026 PUT 382.5 · 1 · OPRA"` with real
option OHLC values (a $3-9 range, not the underlying's $300+ range). This
lands as a **line chart** on an intraday timeframe by default.

Take a screenshot here if you want the line-chart view specifically:
```
node src/cli/index.js screenshot -r full
```

**Earlier false negative, now understood:** in isolated automated testing
(no prior chain navigation, symbol set directly via CLI), clicking this same
button — and even calling its `onclick` handler directly via JS — landed on
the *underlying stock's* chart instead. The difference was session
state/navigation history, not the button itself. **Always navigate via the
chain UI (Steps 1-4) rather than jumping straight to Step 5** — going in
via the full click path is what reliably works.

## Step 6: Switch to Candlestick + Set 1-Minute Timeframe

After "See overview" lands you on the option's chart, the main chart toolbar
is now active (top-left shows the ticker symbol e.g. `TSLA260720...`, plus
the standard TradingView toolbar: Indicators, Alert, Replay, etc.).

Set the timeframe to 1 minute:
```
node src/cli/index.js timeframe 1
```

The chart type on landing was already candlestick in testing (not a separate
"Full chart" button as originally assumed — that terminology referred to
this same toolbar view, reached automatically once on the option's own
chart). If a future session lands on a line chart type instead, switch via:
```
node src/cli/index.js type Candles
```

## Step 7: Restrict the View to One Day

Use the range-preset bar at the bottom of the chart (the same row that shows
1D / 5D / 1M / 3M / 6M / YTD / 1Y / 5Y / All):
```
node src/cli/index.js ui find "1D" -s text   # get live coords, click the range-bar one specifically
node src/cli/index.js ui mouse {x} {y}
```
Confirmed working result: full single trading session (e.g. 09:00-14:45),
1-minute candles, nothing from adjacent days bleeding into view.

## Step 8: Screenshot — Use TradingView's Own Snapshot Tool, Not CDP Crop

TradingView has a native **camera icon** ("Take a snapshot") in the top
toolbar, right of Fullscreen mode, left of Trade/Publish
(`aria-label: "Take a snapshot"`). This is confirmed better than our CDP
`screenshot -r chart/full` crop — it produces a clean, watermarked,
UI-chrome-free PNG matching the style already used for the Barchart exports
in `~/Downloads/`.

```
node src/cli/index.js ui eval "
(function(){
  var btns = Array.from(document.querySelectorAll('button, [role=button]')).filter(function(b){
    var r = b.getBoundingClientRect();
    return r.y < 40 && r.x > 1000 && r.x < 1200 && r.width > 0;
  });
  var b = btns.find(function(x){ return x.getAttribute('aria-label') === 'Take a snapshot'; });
  return b ? { x: b.getBoundingClientRect().x + 18, y: 19 } : null;
})()
"
```
Then click the returned coordinates. A menu appears: Download image / Copy
image / Copy link / Open in new tab / Tweet image. Click **Download image**:
```
node src/cli/index.js ui find "Download image" -s text
node src/cli/index.js ui mouse {x} {y}
```

The file saves to `~/Downloads/` automatically, named by TradingView as
`{SYMBOL}_{YYYY-MM-DD}_{HH-MM-SS}_{hash}.png` (e.g.
`TSLA260720P382.5_2026-07-19_11-47-46_cec4f.png`). This does **not** match
the existing Barchart naming convention in that folder
(`{TICKER}_{expiry}_{strike}{C/P}_Barchart_Interactive_Chart_{date}.png`) —
rename after download if consistency with those files matters for the
FATTAH data pipeline's lineage tracking.

## Real Option Symbol Format (confirmed via URL, not guessed)

TradingView's dedicated options-chain page
(`tradingview.com/options/chain/?symbol=...`) exposes the selected contract
directly in its URL query string, which is the authoritative format:
```
OPRA:{TICKER}{YYMMDD}{C|P}{STRIKE}
```
Example confirmed live: `OPRA:TSLA260720P382.5` (put, 2-digit year/month/day,
no leading zeros, strike as plain decimal — no `_DLY` suffix, unlike an
earlier guess in this file's prior revision).

To jump straight to a known contract without clicking through the chain UI:
```
node src/cli/index.js symbol "OPRA:{TICKER}{YYMMDD}{C|P}{STRIKE}"
```
Verify it resolved with `node src/cli/index.js ohlcv --summary` — a real
option shows a small price range (e.g. 3.00-9.00), not the underlying's
actual share price. If it returns nothing or the page shows "This symbol
doesn't exist", the contract/expiration/strike combination was wrong.

**Known risk with this shortcut:** in isolated testing this path once left
the chart's internal state correctly pointing at the option (confirmed via
`ohlcv`) while the visible canvas stayed rendering stale underlying-stock
candles — a rendering desync. This was not reliably fixed by toggling
timeframe or reloading. The full chain-UI path (Steps 1-7) does not have
this problem. Prefer the full path; treat the direct-symbol shortcut as
useful only for background data pulls via `ohlcv`/`quote`, not for anything
that will be screenshotted.

## Close Any Ad

```
node src/cli/index.js ui eval "
(function(){
  var closes = Array.from(document.querySelectorAll('[aria-label*=\"lose\" i], [class*=\"close\" i]'));
  var n = 0;
  closes.forEach(function(c){ try { if (c.offsetParent) { c.click(); n++; } } catch(e){} });
  return { closedCount: n };
})()
"
```

**Caution, confirmed 2026-07-19:** this broad selector has closed the option
chain overlay's own back/close control at least once, silently kicking the
session back to the main chart right after a successful navigation. If a
step's UI unexpectedly reverts right after running this snippet, that's why
— re-screenshot before re-running it, and consider closing a specific ad by
its own text (e.g. find "Sign up. Get $250" and click only its neighboring
close icon) instead of the broad sweep when precision matters.

## The Six Tickers

FATTAH tracks: **AAPL, MSFT, NVDA, TSLA, IBIT, META** — matches
`fattah/data/{TICKER}/` in the main FATTAH repo. AAPL, META, and TSLA have
been tested directly; the workflow should generalize to the other three.
