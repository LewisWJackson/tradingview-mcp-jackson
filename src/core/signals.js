/**
 * SET swing signal engine.
 *
 * Parses TradingView indicator values from a morning-brief style scan and applies
 * the rules defined in rules.json to produce per-symbol bias, setup stage,
 * key level, trigger, invalidation, and top actionable setups.
 *
 * Supports both the original SET-tuned indicator names and simplified variants
 * (e.g. "Simple Supertrend", "Simple LaRSI"). Auto-detects common scales.
 *
 * No TradingView connection is required — this works entirely on the structured
 * JSON produced by `morning_brief` or saved as `brief-output.json`.
 */

const INDICATOR_MATCHERS = {
  supertrend: ["Supertrend", "Pivot Point Supertrend"],
  confluence: ["Confluence Score", "7-Star Confluence", "Confluence"],
  laguerre: ["LaRSI", "Laguerre RSI"],
  hurst: ["Market Regime", "Hurst Choppiness", "Choppiness Regime"],
  costDist: ["Position Cost", "Peak Cost"],
};

const VALUE_KEYS = {
  supertrendUp: ["Up Trend", "Support", "Trail"],
  supertrendDown: ["Down Trend", "Resistance", "Trail"],
  supertrendBuyFlag: ["BUY", "Buy", "Long Entry"],
  supertrendSellFlag: ["SELL", "Sell", "Short Entry"],
  confluenceScore: ["Confluence Score", "Score"],
  lagRsi: ["Laguerre RSI", "LaRSI"],
  lagBuyFlag: ["Long Entry", "BUY", "Buy"],
  lagSellFlag: ["Short Entry", "SELL", "Sell"],
  hurstSmooth: ["Hurst Smooth", "Hurst"],
  choppiness: ["Choppiness (norm)", "Chop"],
  peakCost: ["Peak Cost Zone", "Peak Cost"],
};

const DEFAULT_SCALES = {
  lagRsiScale: 1,
  chopScale: 1,
  confStrong: 6,
  confWeak: 4,
};

const THRESHOLDS = {
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

function findStudy(scan, matchers) {
  const studies = scan?.indicators?.studies || scan?.state?.studies || [];
  for (const m of matchers) {
    const found = studies.find((s) => s?.name?.includes(m));
    if (found) return found;
  }
  return undefined;
}

function getValue(study, ...keys) {
  for (const key of keys) {
    const v = parseNumber(study?.values?.[key]);
    if (v !== null) return v;
  }
  return null;
}

function detectScales(symbols) {
  let maxConf = 0;
  let maxLagRsi = 0;
  let maxChop = 0;
  let maxHurst = 0;

  for (const scan of symbols) {
    const m = extractRawMetrics(scan);
    if (m.conf !== null) maxConf = Math.max(maxConf, m.conf);
    if (m.lagRsi !== null) maxLagRsi = Math.max(maxLagRsi, m.lagRsi);
    if (m.choppiness !== null) maxChop = Math.max(maxChop, m.choppiness);
    if (m.hurstSmooth !== null) maxHurst = Math.max(maxHurst, m.hurstSmooth);
  }

  // LaRSI and Chop are usually either 0-1 or 0-100.
  const lagRsiScale = maxLagRsi > 1 ? 100 : 1;
  const chopScale = maxChop > 1 ? 100 : 1;

  // Confluence could be 0-7 or 0-10 (or 0-100 in simplified variants).
  let confStrong = 6;
  let confWeak = 4;
  if (maxConf > 7 && maxConf <= 10) {
    confStrong = 8;
    confWeak = 5;
  } else if (maxConf > 10) {
    confStrong = 80;
    confWeak = 50;
  }

  return {
    lagRsiScale,
    chopScale,
    confStrong,
    confWeak,
    detected: { maxConf, maxLagRsi, maxChop, maxHurst },
  };
}

function extractRawMetrics(scan) {
  const supertrend = findStudy(scan, INDICATOR_MATCHERS.supertrend);
  const confluence = findStudy(scan, INDICATOR_MATCHERS.confluence);
  const laguerre = findStudy(scan, INDICATOR_MATCHERS.laguerre);
  const hurst = findStudy(scan, INDICATOR_MATCHERS.hurst);
  const costDist = findStudy(scan, INDICATOR_MATCHERS.costDist);

  const upTrend = getValue(supertrend, ...VALUE_KEYS.supertrendUp);
  const downTrend = getValue(supertrend, ...VALUE_KEYS.supertrendDown);
  const stBuyFlag = getValue(supertrend, ...VALUE_KEYS.supertrendBuyFlag);
  const stSellFlag = getValue(supertrend, ...VALUE_KEYS.supertrendSellFlag);

  const conf = getValue(confluence, ...VALUE_KEYS.confluenceScore);

  const lagRsi = getValue(laguerre, ...VALUE_KEYS.lagRsi);
  const lagBuyFlag = getValue(laguerre, ...VALUE_KEYS.lagBuyFlag);
  const lagSellFlag = getValue(laguerre, ...VALUE_KEYS.lagSellFlag);

  const hurstSmooth = getValue(hurst, ...VALUE_KEYS.hurstSmooth);
  const choppiness = getValue(hurst, ...VALUE_KEYS.choppiness);

  const peakCost = getValue(costDist, ...VALUE_KEYS.peakCost);

  const close = parseNumber(scan?.quote?.close);
  const last = parseNumber(scan?.quote?.last) ?? close;

  return {
    symbol: scan.symbol,
    close: last ?? close,
    upTrend,
    downTrend,
    stBuyFlag,
    stSellFlag,
    conf,
    lagRsi,
    lagBuyFlag,
    lagSellFlag,
    hurstSmooth,
    choppiness,
    peakCost,
  };
}

function normalizeMetrics(raw, scales) {
  const m = { ...raw };

  if (m.lagRsi !== null && scales.lagRsiScale > 1) {
    m.lagRsi = m.lagRsi / scales.lagRsiScale;
  }
  if (m.choppiness !== null && scales.chopScale > 1) {
    m.choppiness = m.choppiness / scales.chopScale;
  }

  // Determine supertrend direction.
  // Prefer explicit BUY/SELL flags, then price vs trail.
  let trailLevel = null;
  if (m.upTrend !== null) trailLevel = m.upTrend;
  else if (m.downTrend !== null) trailLevel = m.downTrend;

  let direction = "unknown";
  if (m.stBuyFlag !== null && m.stBuyFlag > 0) direction = "up";
  else if (m.stSellFlag !== null && m.stSellFlag > 0) direction = "down";
  else if (trailLevel !== null && m.close !== null) {
    direction = m.close > trailLevel ? "up" : "down";
  }

  m.supertrendDirection = direction;
  m.trailLevel = trailLevel;
  m.longEntryFlag = m.lagBuyFlag !== null && m.lagBuyFlag > 0 ? 1 : 0;
  m.shortEntryFlag = m.lagSellFlag !== null && m.lagSellFlag > 0 ? 1 : 0;

  return m;
}

function scoreConditions(m, scales) {
  const checks = {
    trendAlign:
      m.supertrendDirection === "up"
        ? m.close > m.trailLevel
        : m.supertrendDirection === "down"
          ? m.close < m.trailLevel
          : false,
    strongConf: m.conf !== null && m.conf >= scales.confStrong,
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

export function analyzeSymbol(scan, scales = DEFAULT_SCALES) {
  const raw = extractRawMetrics(scan);
  const m = normalizeMetrics(raw, scales);
  const { checks, metCount } = scoreConditions(m, scales);

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
        ? `Long Entry flag fired (LaRSI ${m.lagRsi?.toFixed(3)})`
        : lagEntryZone
          ? `LaRSI ${m.lagRsi?.toFixed(3)} in long entry zone (<${THRESHOLDS.lagLongEntry})`
          : `Wait for LaRSI to drop below ${THRESHOLDS.lagLongEntry} in Up Trend`;
      invalidation = `close below Supertrend trail ${m.trailLevel?.toFixed(2)} OR Conf drops below ${scales.confStrong}`;
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
        ? `Short Entry flag fired (LaRSI ${m.lagRsi?.toFixed(3)})`
        : lagEntryZone
          ? `LaRSI ${m.lagRsi?.toFixed(3)} in short entry zone (>${THRESHOLDS.lagShortEntry})`
          : `Wait for LaRSI to rise above ${THRESHOLDS.lagShortEntry} in Down Trend`;
      invalidation = `close above Supertrend trail ${m.trailLevel?.toFixed(2)} OR Conf drops below ${scales.confStrong}`;
    }
  }

  // Neutral overrides
  if (
    (m.conf !== null && m.conf <= scales.confWeak) ||
    (m.choppiness !== null && m.choppiness > THRESHOLDS.choppyHigh)
  ) {
    bias = "neutral";
    strength = "none";
    stage = "waiting";
    if (m.conf !== null && m.conf <= scales.confWeak) notes.push(`Conf ≤ ${scales.confWeak} → no edge`);
    if (m.choppiness !== null && m.choppiness > THRESHOLDS.choppyHigh) notes.push("Choppy market → skip");
  }

  // Avoid chasing
  if (bias === "bullish" && m.lagRsi !== null && m.lagRsi > THRESHOLDS.lagLongChase) {
    notes.push("LaRSI > 0.80 → do NOT chase long");
    stage = "waiting";
  }
  if (bias === "bearish" && m.lagRsi !== null && m.lagRsi < THRESHOLDS.lagShortChase) {
    notes.push("LaRSI < 0.20 → do NOT chase short");
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

export function analyzeSetRegime(symbols, scales = DEFAULT_SCALES) {
  const setScan = symbols.find((s) => s.symbol === "SET:SET");
  if (!setScan) return { available: false, reason: "SET:SET not in scan" };

  const raw = extractRawMetrics(setScan);
  const m = normalizeMetrics(raw, scales);
  const { checks, metCount } = scoreConditions(m, scales);

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

  const scales = detectScales(symbols);
  const analyzed = symbols.map((scan) => analyzeSymbol(scan, scales));
  const setRegime = analyzeSetRegime(symbols, scales);

  // Score actionable setups
  const scored = analyzed
    .filter((a) => a.symbol !== "SET:SET")
    .map((a) => {
      let score = 0;
      if (a.bias === "bullish" || a.bias === "bearish") score += 10;
      if (a.strength === "strong") score += 5;
      if (a.stage === "triggered") score += 5;
      if (a.met_count >= 4) score += 2;
      if (a.metrics.conf !== null) score += Math.min(a.metrics.conf, 10);
      return { ...a, action_score: score };
    })
    .sort((a, b) => b.action_score - a.action_score);

  const topSetups = scored.slice(0, 3);

  // Apply SET regime filter: if SET bearish, only allow longs with conf=7 (or max scale)
  const confRequiredForCounterTrend = scales.confStrong >= 8 ? 10 : 7;
  const filtered = topSetups.map((setup) => {
    const filteredSetup = { ...setup };
    if (setRegime.available && setRegime.regime === "bearish" && setup.bias === "bullish") {
      if (setup.metrics.conf < confRequiredForCounterTrend) {
        filteredSetup.regime_filter = "skipped";
        filteredSetup.notes = [
          ...filteredSetup.notes,
          `SET bearish + Conf=${setup.metrics.conf?.toFixed(2)} → skip per regime filter`,
        ];
      } else {
        filteredSetup.regime_filter = "allowed";
      }
    } else if (setRegime.available && setRegime.regime === "bullish" && setup.bias === "bearish") {
      if (setup.metrics.conf < confRequiredForCounterTrend) {
        filteredSetup.regime_filter = "skipped";
        filteredSetup.notes = [
          ...filteredSetup.notes,
          `SET bullish + Conf=${setup.metrics.conf?.toFixed(2)} → skip per regime filter`,
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
    scale_detection: scales.detected,
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
  lines.push(`Scales detected: Conf max=${signals.scale_detection.maxConf}, LaRSI max=${signals.scale_detection.maxLagRsi}, Chop max=${signals.scale_detection.maxChop}, Hurst max=${signals.scale_detection.maxHurst}`);
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
