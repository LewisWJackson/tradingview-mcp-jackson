/**
 * Unit tests for the SET swing signal engine.
 * No TradingView connection required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeSymbol,
  analyzeSetRegime,
  generateSignals,
  formatBrief,
} from "../src/core/signals.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeScan({
  symbol = "SET:TEST",
  close = 100,
  upTrend = 95,
  downTrend = null,
  conf = 6,
  lagRsi = 0.1,
  longEntry = 0,
  shortEntry = 0,
  hurst = 0.7,
  choppiness = 0.2,
  peakCost = 90,
} = {}) {
  const supertrendValues = {};
  if (upTrend !== null) supertrendValues["Up Trend"] = String(upTrend);
  if (downTrend !== null) supertrendValues["Down Trend"] = String(downTrend);

  return {
    symbol,
    timeframe: "1D",
    state: { studies: [] },
    indicators: {
      success: true,
      study_count: 5,
      studies: [
        { name: "Pivot Point Supertrend [SET]", values: supertrendValues },
        { name: "Position Cost Distribution SET", values: { "Peak Cost Zone": String(peakCost) } },
        { name: "SET Swing Dashboard [7-Star Confluence]", values: { "Confluence Score": String(conf) } },
        {
          name: "Laguerre RSI Ehlers [SET]",
          values: {
            "Laguerre RSI": String(lagRsi),
            "Long Entry": String(longEntry),
            "Short Entry": String(shortEntry),
            "Mid Up": "0",
            "Mid Down": "0",
          },
        },
        {
          name: "Hurst Choppiness [SET] Regime",
          values: {
            "Hurst Smooth": String(hurst),
            "Hurst Raw": String(hurst),
            "Choppiness (norm)": String(choppiness),
          },
        },
      ],
    },
    quote: {
      success: true,
      symbol: symbol.replace("SET:", "SET_DLY:"),
      close,
      last: close,
    },
  };
}

describe("SET signal engine", () => {
  it("classifies strong bullish when all 5 conditions met", () => {
    const scan = makeScan({ close: 100, upTrend: 95, conf: 6, lagRsi: 0.1, hurst: 0.7, choppiness: 0.2 });
    const result = analyzeSymbol(scan);
    assert.equal(result.bias, "bullish");
    assert.equal(result.strength, "strong");
    assert.equal(result.stage, "in_trade");
    assert.equal(result.met_count, 5);
    assert.ok(result.trigger.includes("0.1"));
    assert.ok(result.key_level.includes("95"));
  });

  it("classifies triggered when Long Entry flag is 1", () => {
    const scan = makeScan({ close: 100, upTrend: 95, conf: 6, lagRsi: 0.5, longEntry: 1, hurst: 0.7, choppiness: 0.2 });
    const result = analyzeSymbol(scan);
    assert.equal(result.bias, "bullish");
    assert.equal(result.stage, "triggered");
    assert.ok(result.trigger.includes("flag fired"));
  });

  it("classifies strong bearish when all 5 conditions met", () => {
    const scan = makeScan({ close: 90, upTrend: null, downTrend: 95, conf: 6, lagRsi: 0.9, hurst: 0.7, choppiness: 0.2 });
    const result = analyzeSymbol(scan);
    assert.equal(result.bias, "bearish");
    assert.equal(result.strength, "strong");
    assert.equal(result.stage, "in_trade");
    assert.equal(result.met_count, 5);
  });

  it("stays neutral when confluence is weak", () => {
    const scan = makeScan({ close: 100, upTrend: 95, conf: 3, lagRsi: 0.1, hurst: 0.7, choppiness: 0.2 });
    const result = analyzeSymbol(scan);
    assert.equal(result.bias, "neutral");
    assert.equal(result.strength, "none");
    assert.ok(result.notes.some((n) => n.includes("Conf")));
  });

  it("stays neutral when market is choppy", () => {
    const scan = makeScan({ close: 100, upTrend: 95, conf: 6, lagRsi: 0.1, hurst: 0.7, choppiness: 0.6 });
    const result = analyzeSymbol(scan);
    assert.equal(result.bias, "neutral");
    assert.ok(result.notes.some((n) => n.includes("Choppy")));
  });

  it("applies avoid-chasing guardrail for overbought bullish", () => {
    const scan = makeScan({ close: 100, upTrend: 95, conf: 6, lagRsi: 0.85, hurst: 0.7, choppiness: 0.2 });
    const result = analyzeSymbol(scan);
    assert.equal(result.bias, "bullish");
    assert.equal(result.stage, "waiting");
    assert.ok(result.notes.some((n) => n.includes("do NOT chase long")));
  });

  it("detects SET index bullish regime", () => {
    const setScan = makeScan({ symbol: "SET:SET", close: 1480, upTrend: 1431, conf: 7, lagRsi: 0.5, hurst: 0.83, choppiness: 0.32 });
    const regime = analyzeSetRegime([setScan]);
    assert.equal(regime.available, true);
    assert.equal(regime.regime, "bullish");
  });

  it("generateSignals produces summary and respects SET regime filter", () => {
    const setScan = makeScan({ symbol: "SET:SET", close: 1480, upTrend: 1431, conf: 7, lagRsi: 0.5, hurst: 0.83, choppiness: 0.32 });
    const bullishScan = makeScan({ symbol: "SET:BULL", close: 100, upTrend: 95, conf: 6, lagRsi: 0.1, hurst: 0.7, choppiness: 0.2 });
    const bearishScan = makeScan({ symbol: "SET:BEAR", close: 90, upTrend: null, downTrend: 95, conf: 6, lagRsi: 0.9, hurst: 0.7, choppiness: 0.2 });

    const result = generateSignals({
      symbols_scanned: [setScan, bullishScan, bearishScan],
      rules_loaded_from: "test-rules.json",
      rules: {},
    });

    assert.equal(result.summary.bullish, 1);
    assert.equal(result.summary.bearish, 1);
    assert.equal(result.set_regime.regime, "bullish");
    assert.equal(result.top_setups.length, 2);

    const bearSetup = result.top_setups.find((s) => s.symbol === "SET:BEAR");
    assert.equal(bearSetup.regime_filter, "skipped");

    const bullSetup = result.top_setups.find((s) => s.symbol === "SET:BULL");
    assert.equal(bullSetup.regime_filter, "allowed");
  });

  it("formatBrief returns human-readable text", () => {
    const setScan = makeScan({ symbol: "SET:SET", close: 1480, upTrend: 1431, conf: 7, lagRsi: 0.5, hurst: 0.83, choppiness: 0.32 });
    const bullishScan = makeScan({ symbol: "SET:BULL", close: 100, upTrend: 95, conf: 6, lagRsi: 0.1, hurst: 0.7, choppiness: 0.2 });

    const brief = formatBrief({
      symbols_scanned: [setScan, bullishScan],
      rules_loaded_from: "test-rules.json",
    });

    assert.equal(typeof brief, "string");
    assert.ok(brief.includes("SET Regime"));
    assert.ok(brief.includes("SET:BULL"));
  });

  it("works with the real brief-output.json fixture", () => {
    const raw = readFileSync(join(__dirname, "..", "brief-output.json"), "utf8").replace(/^\uFEFF/, "");
    const briefOutput = JSON.parse(raw);
    const result = generateSignals(briefOutput);

    assert.equal(result.set_regime.available, true);
    assert.equal(result.set_regime.symbol, "SET:SET");
    assert.ok(result.summary.bullish + result.summary.bearish + result.summary.neutral > 0);
    assert.equal(result.top_setups.length, 3);
  });
});
