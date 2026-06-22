# Mawjah — Multi-Market Trading Screener

**Mawjah** (موجة, "wave") is a self-hosted screener and decision-support dashboard for swing
traders who follow several markets at once. It reads live data from a locally running
TradingView Desktop instance, scores every symbol in its universe against a consistent set of
technical criteria, and surfaces the highest-conviction opportunities — across Saudi (TASI),
US equities, ETFs, crypto, and commodities — in a single ranked view.

## Objective

Most retail traders juggle one watchlist per market and re-judge each chart by eye. Mawjah
replaces that with one repeatable process: **scan the whole universe, score it the same way
every time, rank it, and track whether the signals actually worked.** The goal is to turn a
scattered, discretionary routine into an evidence-based, auditable workflow — without sending
any data off the machine.

## What It Does

- **Unified screening** across five markets (TASI, US Equity, ETF, Crypto, Commodities) from a
  single scan, filterable by sector, style, signal tier, and Sharia compliance.
- **Consistent scoring** — a 9-point swing/position model (or 8-point breakout) built from an
  EMA stack (13/34/89/200), RSI, MACD, volume, VWAP, and the 200 EMA. Each symbol also gets a
  normalized 0–100 composite score and auto-detected **style tags** (Momentum, Trend, Breakout,
  Recovery, Pullback).
- **Signal tiers** — Strong Buy / Buy / Watch / Strong Sell, with thresholds tied to the
  scoring model so the labels stay consistent across markets.
- **Quant layer** — Hurst exponent (trend persistence), ATR percentile rank, VWAP, plus a whale
  / accumulation read from MFI, OBV trend, and volume Z-score.
- **Accuracy Lab** — every Strong signal is logged automatically, its outcome (stop / target /
  expiry) is tracked over a 14-day window, and the results roll up into hit-rate insights by
  style and market. The platform grades its own calls.
- **Goals** — a personal trading profile that filters and ranks suggestions by composite score,
  risk/reward, and the Lab's measured edge.
- **Virtual Portfolio** — paper trading with realistic costs (0.31% TASI brokerage commission,
  0.1% elsewhere) so performance reflects real friction.
- **Alerts** — price-level alerts on any screened symbol.
- **Dual view** — a full data table for experienced users (Pro), and a plain-language card view
  with a market-mood summary and inline explainers for newcomers (Guide). Bilingual labels
  (English / Arabic) and a USD / SAR currency toggle.

## Default Watchlist

The bundled watchlist spans all three core markets and seeds the scan and morning-brief
workflow:

| Symbol | Instrument | Market |
|--------|-----------|--------|
| `TADAWUL:TASI` | Tadawul All Share Index | Saudi |
| `TADAWUL:2222` | Saudi Aramco | Saudi |
| `TADAWUL:1120` | Al Rajhi Bank | Saudi |
| `TADAWUL:2010` | SABIC | Saudi |
| `NASDAQ:AAPL` | Apple | US Equity |
| `NASDAQ:NVDA` | Nvidia | US Equity |
| `NASDAQ:QQQ` | Invesco QQQ (Nasdaq-100 ETF) | US Equity / ETF |
| `BITSTAMP:BTCUSD` | Bitcoin | Crypto |
| `BITFINEX:XRPUSD` | XRP | Crypto |

## How It Works

```
TradingView Desktop (local) ──CDP──> Mawjah server (Node) ──> SQLite ──> Browser dashboard
```

Mawjah connects to TradingView Desktop over the Chrome DevTools Protocol, pulls OHLCV and
indicator data, runs all scoring and analytics locally in a Node server, and persists results
to a local SQLite database. The dashboard auto-scans the universe three times per trading day
during market hours, so signals stay fresh without manual refreshes. All processing happens on
your machine — nothing is sent to a third party.

## Who It's For

A retail swing trader who actively follows multiple markets — particularly someone trading the
Saudi market alongside US and crypto names — and who wants one consistent, reviewable process
instead of judging each chart independently. Useful both to experienced traders (Pro view, full
metrics) and to those still learning (Guide view, plain-language signals).

---

*Mawjah is the dashboard layer of this project. It is built on the
[TradingView MCP](../README.md) bridge and requires a running TradingView Desktop app with a
valid TradingView subscription. Not affiliated with TradingView Inc. or Anthropic.*
