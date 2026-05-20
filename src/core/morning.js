/**
 * Morning brief core logic.
 * Scans watchlist across D1, H1 and M15 timeframes.
 * Returns structured multi-TF data + strategy candidates for Claude to apply
 * the full 7-step premarket checklist.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "./chart.js";
import * as data from "./data.js";
import { checkFundamentals } from "./fundamental.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");
const USER_DATA_DIR = resolve(join(homedir(), ".tradingview-mcp"));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertSafeRulesPath(p) {
  const resolved = resolve(p);
  const inProject =
    resolved === resolve(join(PROJECT_ROOT, "rules.json")) ||
    resolved.startsWith(resolve(PROJECT_ROOT) + "/");
  const inUserData = resolved.startsWith(USER_DATA_DIR + "/");
  if (!inProject && !inUserData) {
    throw new Error(
      `rules_path must live inside the project (${PROJECT_ROOT}) or ~/.tradingview-mcp/. Got: ${resolved}`,
    );
  }
}

function assertSafeDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(
      `Invalid date: ${dateStr}. Use YYYY-MM-DD (e.g. 2026-05-11).`,
    );
  }
}

function loadRules(rulesPath) {
  if (rulesPath) assertSafeRulesPath(rulesPath);
  const candidates = [
    rulesPath,
    join(PROJECT_ROOT, "rules.json"),
    join(homedir(), ".tradingview-mcp", "rules.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { rules: JSON.parse(readFileSync(p, "utf8")), path: p };
      } catch (e) {
        throw new Error(`Failed to parse rules.json at ${p}: ${e.message}`);
      }
    }
  }
  throw new Error(
    "No rules.json found. Copy rules.example.json to rules.json and fill in your trading rules.\n" +
      "Looked in:\n" +
      candidates.filter(Boolean).map((p) => `  - ${p}`).join("\n"),
  );
}

/** Parse locale number string "284,26" → 284.26 */
function parseNum(str) {
  if (!str || typeof str !== "string") return null;
  const clean = str.trim().split(" ")[0];
  const val = parseFloat(clean.replace(",", "."));
  return isNaN(val) ? null : val;
}

/** Extract Bollinger Bands values from study data */
function extractBB(studies) {
  const bb = studies?.studies?.find((s) => s.name === "Bollinger Bands");
  if (!bb?.values) return null;
  const basis = parseNum(bb.values.Basis);
  const upper = parseNum(bb.values.Upper);
  const lower = parseNum(bb.values.Lower);
  if (basis == null || upper == null || lower == null) return null;
  return { basis, upper, lower, width: parseFloat((upper - lower).toFixed(4)) };
}

/** Extract SMA values ordered as returned (assumed MA20, MA40, MA100, MA200) */
function extractSMAs(studies) {
  return (studies?.studies || [])
    .filter((s) => s.name === "Simple Moving Average" || s.name === "Moving Average")
    .map((s) => parseNum(s.values?.MA))
    .filter((v) => v != null);
}

/** Assess price position relative to BB middle band */
function bbPosition(price, bb) {
  if (!bb || price == null) return "unknown";
  if (price > bb.upper) return "above_upper";
  if (price < bb.lower) return "below_lower";
  if (price > bb.basis) return "above_middle";
  if (price < bb.basis) return "below_middle";
  return "at_middle";
}

/**
 * Assess MA trend order.
 * Returns: alcista | bajista | entrelazado | mixto_alcista | mixto_bajista
 */
function maOrder(price, smas) {
  if (!smas || smas.length < 4) return "insufficient_data";
  const [ma20, ma40, ma100, ma200] = smas;
  const ordered_up = ma20 > ma40 && ma40 > ma100 && ma100 > ma200;
  const ordered_dn = ma20 < ma40 && ma40 < ma100 && ma100 < ma200;
  if (ordered_up && price > ma20) return "alcista";
  if (ordered_dn && price < ma20) return "bajista";
  if (!ordered_up && !ordered_dn) return "entrelazado";
  return price > ma20 ? "mixto_alcista" : "mixto_bajista";
}

/**
 * Preliminary strategy screening based on multi-TF data.
 * Full confirmation (trendlines, M15 signals) is evaluated by Claude.
 */
function screenStrategies(price, tfData) {
  if (!price) return [];
  const candidates = [];
  const d1 = tfData.D1 || {};
  const h1 = tfData.H1 || {};
  const m15 = tfData.M15 || {};
  const NARROW = 5;

  const d1BBPos = d1.bb_position;
  const h1BBPos = h1.bb_position;
  const m15BBPos = m15.bb_position;
  const d1MAOrd = d1.ma_order;
  const h1MAOrd = h1.ma_order;
  const m15Width = m15.bb?.width;

  // STRAT-01 CALL — Cambio tendencia al alza
  if (h1BBPos === "below_middle" || h1MAOrd === "bajista" || h1MAOrd === "mixto_bajista") {
    candidates.push({
      id: "STRAT-01", position: "CALL", confidence: "setup_forming",
      note: "H1 bajista → vigilar ruptura trendline bajista H1 + cierre sobre MA20 H1 + confirmación M15 alcista",
    });
  }

  // STRAT-02 PUT — Cambio tendencia a la baja
  if (h1BBPos === "above_middle" || h1MAOrd === "alcista" || h1MAOrd === "mixto_alcista") {
    candidates.push({
      id: "STRAT-02", position: "PUT", confidence: "setup_forming",
      note: "H1 alcista → vigilar ruptura trendline alcista H1 + cierre bajo MA20 H1 + confirmación M15 bajista",
    });
  }

  // STRAT-03 PUT — Rebote punto medio D1 bajista
  const d1Bajista = d1BBPos === "below_middle" || d1MAOrd === "bajista";
  const h1Alcista = h1BBPos === "above_middle" || h1MAOrd === "alcista";
  if (d1Bajista && h1Alcista) {
    candidates.push({
      id: "STRAT-03", position: "PUT", confidence: "conditions_met",
      note: "D1 bajista + H1 en retroceso alcista → precio acercándose a BB Middle D1, vigilar rechazo",
    });
  }

  // STRAT-04/05 — Apertura fuera de Bollinger (requiere BB M15 estrecho)
  if (m15Width != null && m15Width < NARROW) {
    candidates.push({
      id: "STRAT-04", position: "PUT", confidence: "watch",
      note: `BB M15 estrecho (ancho: ${m15Width.toFixed(2)}) → vigilar GAP extremo sobre banda superior M15 en apertura`,
    });
    candidates.push({
      id: "STRAT-05", position: "CALL", confidence: "watch",
      note: `BB M15 estrecho (ancho: ${m15Width.toFixed(2)}) → vigilar GAP extremo bajo banda inferior M15 en apertura`,
    });
  }

  // STRAT-08 CALL — Cambio tendencia M15 alcista
  if (m15BBPos && ["below_middle", "below_lower", "at_middle"].includes(m15BBPos)) {
    candidates.push({
      id: "STRAT-08", position: "CALL", confidence: "watch",
      note: "M15 bajista/lateral → vigilar ruptura trendline bajista M15 + apertura sobre BB Middle M15 con volatilidad",
    });
  }

  // STRAT-09 PUT — Cambio tendencia M15 bajista
  if (m15BBPos && ["above_middle", "above_upper", "at_middle"].includes(m15BBPos)) {
    candidates.push({
      id: "STRAT-09", position: "PUT", confidence: "watch",
      note: "M15 alcista/lateral → vigilar ruptura trendline alcista M15 + apertura bajo BB Middle M15 con volatilidad",
    });
  }

  // STRAT-10/11 — Ruptura lateral mediano plazo
  if (d1MAOrd === "entrelazado") {
    candidates.push({
      id: "STRAT-10", position: "CALL", confidence: "watch",
      note: "MAs D1 entrelazadas → vigilar señal alcista potente que rompa canal en H1 con alta volatilidad BB",
    });
    candidates.push({
      id: "STRAT-11", position: "PUT", confidence: "watch",
      note: "MAs D1 entrelazadas → vigilar señal bajista potente que rompa canal en H1 con alta volatilidad BB",
    });
  }

  return candidates;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runBrief({ rules_path } = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const { watchlist = [] } = rules;

  if (!watchlist.length) {
    throw new Error(
      "rules.json watchlist is empty. Add at least one symbol to your watchlist array.",
    );
  }

  // Run fundamental filters in parallel with chart state fetch
  const [fundamentalResult, chartState] = await Promise.allSettled([
    checkFundamentals(watchlist, rules),
    chart.getState(),
  ]);
  const fundamental_filters =
    fundamentalResult.status === "fulfilled" ? fundamentalResult.value : null;
  let originalSymbol, originalTimeframe;
  if (chartState.status === "fulfilled") {
    originalSymbol = chartState.value?.symbol;
    originalTimeframe = chartState.value?.resolution;
  }

  const TIMEFRAMES = [
    { key: "D1", tf: "D" },
    { key: "H1", tf: "60" },
    { key: "M15", tf: "15" },
  ];

  const results = [];

  for (const symbol of watchlist) {
    try {
      await chart.setSymbol({ symbol });
      await new Promise((r) => setTimeout(r, 900));

      let quoteData = null;
      const tfData = {};

      for (const { key, tf } of TIMEFRAMES) {
        try {
          await chart.setTimeframe({ timeframe: tf });
          await new Promise((r) => setTimeout(r, 900));

          const [indicators, quote] = await Promise.all([
            data.getStudyValues(),
            quoteData == null ? data.getQuote({}) : Promise.resolve(null),
          ]);

          if (quote?.success) quoteData = quote;

          const price = quoteData?.last ?? quoteData?.close ?? null;
          const bb = extractBB(indicators);
          const smas = extractSMAs(indicators);

          tfData[key] = {
            bb,
            smas,
            bb_position: bb ? bbPosition(price, bb) : "no_bb_detected",
            ma_order: smas.length >= 4 ? maOrder(price, smas) : "insufficient_data",
          };
        } catch (err) {
          tfData[key] = { error: err.message };
        }
      }

      const price = quoteData?.last ?? quoteData?.close ?? null;

      results.push({
        symbol,
        quote: quoteData,
        timeframes: tfData,
        strategy_candidates: screenStrategies(price, tfData),
      });
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }

  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe) await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    rules_loaded_from: loadedFrom,
    fundamental_filters,
    rules: {
      bias_criteria: rules.bias_criteria || null,
      risk_rules: rules.risk_rules || null,
      strategies: rules.strategies || null,
      notes: rules.notes || null,
    },
    symbols_scanned: results,
    instruction: [
      "ANÁLISIS PREMARKET — Aplica el checklist de 7 pasos por ticker usando los datos multi-timeframe.",
      "FILTROS FUNDAMENTALES (verificar PRIMERO): Si fundamental_filters.fed.active=true → advertir NO operar hoy. Si fundamental_filters.earnings[ticker].active=true → advertir NO operar ese ticker. Mostrar fundamental_filters.warnings al inicio del reporte si hay alguno activo.",
      "REGLA CRÍTICA: BB es el indicador primario (50% peso). Si bb.width es muy estrecho en todos los TF = baja volatilidad = NO operar ese día.",
      "PASO 1 — BB D1: bb_position='above_middle' → Middle=PISO | 'below_middle' → Middle=TECHO. Anotar nivel bb.basis.",
      "PASO 2 — BB H1: evaluar bb_position H1. Middle H1 = punto de rebote intraday. Anotar si es techo o piso.",
      "PASO 3 — MAs D1 (peso 30%): usar ma_order para tendencia. MAs a favor tendencia = rebotes. MAs en contra = continuación.",
      "PASO 4 — MAs H1: tendencia corto plazo, rebote más cercano, indicar máx/mín reciente (requiere data_get_ohlcv en H1).",
      "PASO 5 — Trendlines: indicar al usuario trazar manualmente en gráfico BB H1.",
      "PASO 6 — Bid/Ask: recordar verificar spread antes de entrar.",
      "PASO 7 — Premarket: usar quote.last para precio. Estimar gap up/down/flat.",
      "ESTRATEGIAS: Reportar strategy_candidates con confidence='conditions_met' primero, luego 'setup_forming', luego 'watch'.",
      "OUTPUT: Bloque estructurado por ticker + tabla resumen con bias global y estrategias prioritarias al final.",
    ].join(" "),
  };
}

export function saveSession({ brief, date } = {}) {
  const dateStr = date || new Date().toISOString().split("T")[0];
  assertSafeDate(dateStr);
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  const existing = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, "utf8"))
    : {};
  const record = {
    ...existing,
    date: dateStr,
    saved_at: new Date().toISOString(),
    brief,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return { success: true, path: filePath, date: dateStr };
}

export function getSession({ date } = {}) {
  const dateStr = date || new Date().toISOString().split("T")[0];
  assertSafeDate(dateStr);
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  if (existsSync(filePath)) {
    return { success: true, ...JSON.parse(readFileSync(filePath, "utf8")) };
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const yesterdayPath = join(SESSIONS_DIR, `${yesterdayStr}.json`);

  if (existsSync(yesterdayPath)) {
    return {
      success: true,
      note: "No session for today — returning yesterday",
      ...JSON.parse(readFileSync(yesterdayPath, "utf8")),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterdayStr}`,
    sessions_dir: SESSIONS_DIR,
  };
}

/** Save the full premarket checklist report as markdown in docs/sessions/ inside the repo. */
export function savePremarketReport({ content, date } = {}) {
  if (!content || typeof content !== "string") {
    throw new Error("content is required and must be a string.");
  }
  const dateStr = date || new Date().toISOString().split("T")[0];
  assertSafeDate(dateStr);

  const sessionsDir = join(PROJECT_ROOT, "docs", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, `premarket-${dateStr}.md`);
  writeFileSync(filePath, content, "utf8");

  return { success: true, path: filePath, date: dateStr };
}
