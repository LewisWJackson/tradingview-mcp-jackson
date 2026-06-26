/**
 * SET swing signal engine.
 *
 * Parses TradingView indicator values from a morning-brief style scan and applies
 * the rules defined in rules.json to produce per-symbol bias, setup stage,
 * key level, trigger, invalidation, and top actionable setups.
 *
 * No TradingView connection is required — this works entirely on the structured
 * JSON produced by `morning_brief` or saved as `brief-output.json`.
 */

const INDICATOR_NAMES = {
  supertrend: "Pivot Point Supertrend [SET]",
  confluence: "SET Swing Dashboard [7-Star Confluence]",
  laguerre: "Laguerre RSI Ehlers [SET]",
  hurst: "Hurst Choppiness [SET] Regime",
  costDist: "Position Cost Distribution SET",
};

const THRESHOLDS = {
  strongConfluence: 6,
  developingConfluence: 5,
  weakConfluence: 4,
  lagLongEntry: 0.15,
  lagShortEntry: 0.85,
  lagLongChase: 0.8,
  lagShortChase: 0.2,
  hurstTrending: 0.6,
  choppyHigh: 0.5,
  choppyClean: 0.4,
};

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function findStudy(scan, nameSubstring) {
  const studies = scan?.indicators?.studies || scan?.state?.studies || [];
  return studies.find((s) => s?.name?.includes(nameSubstring));
}

function getValue(study, key) {
  return parseNumber(study?.values?.[key]);
}

function extractMetrics(scan) {
  const supertrend = findStudy(scan, INDICATOR_NAMES.supertrend);
  const confluence = findStudy(scan, INDICATOR_NAMES.confluence);
  const laguerre = findStudy(scan, INDICATOR_NAMES.laguerre);
  const hurst = findStudy(scan, INDICATOR_NAMES.hurst);
  const costDist = findStudy(scan, INDICATOR_NAMES.costDist);

  const upTrend = getValue(supertrend, "Up Trend");
  const downTrend = getValue(supertrend, "Down Trend");
  const conf = getValue(confluence, "Confluence Score");
  const lagRsi = getValue(laguerre, "Laguerre RSI");
  const longEntryFlag = getValue(laguerre, "Long Entry");
  const shortEntryFlag = getValue(laguerre, "Short Entry");
  const midUp = getValue(laguerre, "Mid Up");
  const midDown = getValue(laguerre, "Mid Down");
  const hurstSmooth = getValue(hurst, "Hurst Smooth");
  const choppiness = getValue(hurst, "Choppiness (norm)");
  const peakCost = getValue(costDist, "Peak Cost Zone");

  const close = parseNumber(scan?.quote?.close);
  const last = parseNumber(scan?.quote?.last) ?? close;

  return {
    symbol: scan.symbol,
    close: last ?? close,
    supertrendDirection: upTrend !== null ? "up" : downTrend !== null ? "down" : "unknown",
    trailLevel: upTrend ?? downTrend,
    upTrend,
    downTrend,
    conf,
    lagRsi,
    longEntryFlag,
    shortEntryFlag,
    midUp,
    midDown,
    hurstSmooth,
    choppiness,
    peakCost,
  };
}

function scoreConditions(m) {
  const checks = {
    trendAlign:
      m.supertrendDirection === "up"
        ? m.close > m.trailLevel
        : m.supertrendDirection === "down"
          ? m.close < m.trailLevel
          : false,
    strongConf: m.conf !== null && m.conf >= THRESHOLDS.strongConfluence,
    lagSignal:
      (m.supertrendDirection === "up" &&
        (m.lagRsi !== null && m.lagRsi < THRESHOLDS.lagLongEntry)) ||
      (m.supertrendDirection === "down" &&
        (m.lagRsi !== null && m.lagRsi > THRESHOLDS.lagShortEntry)) ||
      m.longEntryFlag === 1 ||
      m.shortEntryFlag === 1,
    hurstTrending: m.hurstSmooth !== null && m.hurstSmooth >= THRESHOLDS.hurstTrending,
    cleanTrend: m.choppiness !== null && m.choppiness < THRESHOLDS.choppyClean,
  };

  const metCount = Object.values(checks).filter(Boolean).length;
  return { checks, metCount };
}

export function analyzeSymbol(scan) {
  const m = extractMetrics(scan);
  const { checks, metCount } = scoreConditions(m);

  // Default to neutral
  let bias = "neutral";
  let strength = "none";
  let stage = "waiting";
  let trigger = null;
  let invalidation = null;
  let notes = [];

  const isBullishBase =
    m.supertrendDirection === "up" &&
    checks.strongConf &&
    checks.hurstTrending &&
    checks.cleanTrend;

  const isBearishBase =
    m.supertrendDirection === "down" &&
    checks.strongConf &&
    checks.hurstTrending &&
    checks.cleanTrend;

  if (isBullishBase) {
    const lagEntryZone = m.lagRsi !== null && m.lagRsi < THRESHOLDS.lagLongEntry;
    const lagTriggered = m.longEntryFlag === 1;
    const allFiveMet = metCount >= 5;
    if (lagEntryZone || lagTriggered || metCount >= 4) {
      bias = "bullish";
      strength = allFiveMet ? "strong" : "normal";
      if (lagTriggered) stage = "triggered";
      else if (lagEntryZone && allFiveMet) stage = "in_trade";
      else stage = "waiting";
      trigger = lagTriggered
        ? `Long Entry flag fired (Lag RSI ${m.lagRsi?.toFixed(3)})`
        : lagEntryZone
          ? `Lag RSI ${m.lagRsi?.toFixed(3)} in long entry zone (<${THRESHOLDS.lagLongEntry})`
          : `Wait for Lag RSI to drop below ${THRESHOLDS.lagLongEntry} in Up Trend`;
      invalidation = `close below Supertrend trail ${m.trailLevel?.toFixed(2)} OR Conf drops below ${THRESHOLDS.strongConfluence}`;
    }
  } else if (isBearishBase) {
    const lagEntryZone = m.lagRsi !== null && m.lagRsi > THRESHOLDS.lagShortEntry;
    const lagTriggered = m.shortEntryFlag === 1;
    const allFiveMet = metCount >= 5;
    if (lagEntryZone || lagTriggered || metCount >= 4) {
      bias = "bearish";
      strength = allFiveMet ? "strong" : "normal";
      if (lagTriggered) stage = "triggered";
      else if (lagEntryZone && allFiveMet) stage = "in_trade";
      else stage = "waiting";
      trigger = lagTriggered
        ? `Short Entry flag fired (Lag RSI ${m.lagRsi?.toFixed(3)})`
        : lagEntryZone
          ? `Lag RSI ${m.lagRsi?.toFixed(3)} in short entry zone (>${THRESHOLDS.lagShortEntry})`
          : `Wait for Lag RSI to rise above ${THRESHOLDS.lagShortEntry} in Down Trend`;
      invalidation = `close above Supertrend trail ${m.trailLevel?.toFixed(2)} OR Conf drops below ${THRESHOLDS.strongConfluence}`;
    }
  }

  // Neutral overrides
  if (
    (m.conf !== null && m.conf <= THRESHOLDS.weakConfluence) ||
    (m.choppiness !== null && m.choppiness > THRESHOLDS.choppyHigh)
  ) {
    bias = "neutral";
    strength = "none";
    stage = "waiting";
    if (m.conf !== null && m.conf <= THRESHOLDS.weakConfluence) notes.push("Conf ≤ 4 → no edge");
    if (m.choppiness !== null && m.choppiness > THRESHOLDS.choppyHigh) notes.push("Choppy market → skip");
  }

  // Avoid chasing
  if (bias === "bullish" && m.lagRsi !== null && m.lagRsi > THRESHOLDS.lagLongChase) {
    notes.push("Lag RSI > 0.80 → do NOT chase long");
    stage = "waiting";
  }
  if (bias === "bearish" && m.lagRsi !== null && m.lagRsi < THRESHOLDS.lagShortChase) {
    notes.push("Lag RSI < 0.20 → do NOT chase short");
    stage = "waiting";
  }

  const keyLevel =
    m.trailLevel !== null
      ? `${m.supertrendDirection === "up" ? "support" : "resistance"} ${m.trailLevel.toFixed(2)}`
      : m.peakCost !== null
        ? `peak-cost ${m.peakCost.toFixed(2)}`
        : "n/a";

  return {
    symbol: m.symbol,
    close: m.close,
    bias,
    strength,
    stage,
    key_level: keyLevel,
    trigger,
    invalidation,
    metrics: {
      supertrend: m.supertrendDirection,
      trail: m.trailLevel,
      conf: m.conf,
      lagRsi: m.lagRsi,
      longEntry: m.longEntryFlag,
      shortEntry: m.shortEntryFlag,
      hurst: m.hurstSmooth,
      choppiness: m.choppiness,
      peakCost: m.peakCost,
    },
    checks,
    met_count: metCount,
    notes,
  };
}

export function analyzeSetRegime(symbols) {
  const setScan = symbols.find((s) => s.symbol === "SET:SET");
  if (!setScan) return { available: false, reason: "SET:SET not in scan" };

  const m = extractMetrics(setScan);
  const { checks, metCount } = scoreConditions(m);

  let regime = "neutral";
  if (m.supertrendDirection === "up" && checks.strongConf && checks.hurstTrending) regime = "bullish";
  if (m.supertrendDirection === "down" && checks.strongConf && checks.hurstTrending) regime = "bearish";

  return {
    available: true,
    symbol: "SET:SET",
    close: m.close,
    regime,
    supertrend: m.supertrendDirection,
    trail: m.trailLevel,
    conf: m.conf,
    hurst: m.hurstSmooth,
    choppiness: m.choppiness,
    met_count: metCount,
    note:
      regime === "bullish"
        ? "SET index in bullish regime — longs preferred"
        : regime === "bearish"
          ? "SET index in bearish regime — shorts preferred or tighten long criteria"
          : "SET index neutral/mixed — reduce size, be selective",
  };
}

export function generateSignals(briefOutput) {
  const symbols = briefOutput?.symbols_scanned || [];
  const rules = briefOutput?.rules || {};

  const analyzed = symbols.map((scan) => analyzeSymbol(scan));
  const setRegime = analyzeSetRegime(symbols);

  // Score actionable setups
  const scored = analyzed
    .filter((a) => a.symbol !== "SET:SET")
    .map((a) => {
      let score = 0;
      if (a.bias === "bullish" || a.bias === "bearish") score += 10;
      if (a.strength === "strong") score += 5;
      if (a.stage === "triggered") score += 5;
      if (a.met_count >= 4) score += 2;
      if (a.metrics.conf !== null) score += a.metrics.conf;
      return { ...a, action_score: score };
    })
    .sort((a, b) => b.action_score - a.action_score);

  const topSetups = scored.slice(0, 3);

  // Apply SET regime filter: if SET bearish, only allow longs with conf=7
  const filtered = topSetups.map((setup) => {
    const filteredSetup = { ...setup };
    if (setRegime.available && setRegime.regime === "bearish" && setup.bias === "bullish") {
      if (setup.metrics.conf !== 7) {
        filteredSetup.regime_filter = "skipped";
        filteredSetup.notes = [
          ...filteredSetup.notes,
          `SET bearish + Conf=${setup.metrics.conf} (not 7) → skip per regime filter`,
        ];
      } else {
        filteredSetup.regime_filter = "allowed";
      }
    } else if (setRegime.available && setRegime.regime === "bullish" && setup.bias === "bearish") {
      if (setup.metrics.conf !== 7) {
        filteredSetup.regime_filter = "skipped";
        filteredSetup.notes = [
          ...filteredSetup.notes,
          `SET bullish + Conf=${setup.metrics.conf} (not 7) → skip per regime filter`,
        ];
      } else {
        filteredSetup.regime_filter = "allowed";
      }
    } else {
      filteredSetup.regime_filter = "allowed";
    }
    return filteredSetup;
  });

  return {
    generated_at: new Date().toISOString(),
    rules_loaded_from: briefOutput?.rules_loaded_from || null,
    default_timeframe: briefOutput?.symbols_scanned?.[0]?.timeframe || null,
    set_regime: setRegime,
    symbols: analyzed,
    top_setups: filtered,
    summary: {
      bullish: analyzed.filter((a) => a.symbol !== "SET:SET" && a.bias === "bullish").length,
      bearish: analyzed.filter((a) => a.symbol !== "SET:SET" && a.bias === "bearish").length,
      neutral: analyzed.filter((a) => a.symbol !== "SET:SET" && a.bias === "neutral").length,
      triggered: analyzed.filter((a) => a.symbol !== "SET:SET" && a.stage === "triggered").length,
    },
    raw_rules: rules,
  };
}

export function formatBrief(briefOutput, { compact = false } = {}) {
  const signals = generateSignals(briefOutput);
  const lines = [];

  lines.push(`SET Swing Brief — ${signals.generated_at}`);
  lines.push(`Rules: ${signals.rules_loaded_from || "n/a"}`);
  lines.push(`SET Regime: ${signals.set_regime.regime?.toUpperCase() || "N/A"} | ${signals.set_regime.note || ""}`);
  lines.push(`Summary: ${signals.summary.bullish} bullish | ${signals.summary.bearish} bearish | ${signals.summary.neutral} neutral | ${signals.summary.triggered} triggered`);
  lines.push("");

  if (compact) {
    for (const s of signals.symbols) {
      if (s.symbol === "SET:SET") continue;
      lines.push(
        `${s.symbol.padEnd(12)} | ${s.bias.toUpperCase().padEnd(7)} | stage: ${s.stage.padEnd(10)} | key: ${s.key_level.padEnd(20)} | trigger: ${s.trigger || "none"}`,
      );
    }
  } else {
    lines.push("Top 3 Actionable Setups:");
    if (signals.top_setups.length === 0) {
      lines.push("  (none)");
    } else {
      for (let i = 0; i < signals.top_setups.length; i++) {
        const s = signals.top_setups[i];
        lines.push(`\n${i + 1}. ${s.symbol} — ${s.bias.toUpperCase()} ${s.strength} (${s.stage})`);
        lines.push(`   Close: ${s.close?.toFixed(2) ?? "n/a"} | Key level: ${s.key_level}`);
        lines.push(`   Trigger: ${s.trigger || "waiting"}`);
        lines.push(`   Invalidation: ${s.invalidation || "n/a"}`);
        if (s.regime_filter === "skipped") lines.push(`   ⚠️  Skipped due to SET regime filter`);
        if (s.notes.length > 0) lines.push(`   Notes: ${s.notes.join("; ")}`);
      }
    }

    lines.push("\nAll Signals:");
    for (const s of signals.symbols) {
      if (s.symbol === "SET:SET") continue;
      const note = s.notes.length ? ` | notes: ${s.notes.join("; ")}` : "";
      lines.push(
        `  ${s.symbol.padEnd(12)} ${s.bias.toUpperCase().padEnd(7)} ${s.stage.padEnd(10)} | key: ${s.key_level}${note}`,
      );
    }
  }

  return lines.join("\n");
}
