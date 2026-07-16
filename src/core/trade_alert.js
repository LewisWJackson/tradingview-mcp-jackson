/**
 * Trade alert watcher — scans the watchlist, asks Claude for a genuine
 * confidence read against the user's rules.json bias/risk criteria, and
 * notifies the user (via Pushover) when confidence crosses a threshold.
 *
 * Designed to run standalone (no live Claude Code session) via `tv alert check`
 * on a schedule (cron/launchd) — see scripts/com.tradingview-mcp.trade-alert.plist.example.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as morning from "./morning.js";
import * as capture from "./capture.js";
import * as chart from "./chart.js";
import * as data from "./data.js";
import * as tab from "./tab.js";
import { createScopedConnection } from "../connection.js";

const STATE_DIR = join(homedir(), ".tradingview-mcp");
const STATE_PATH = join(STATE_DIR, "alert_state.json");

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

const SIGNAL_SCHEMA = {
  type: "object",
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          direction: {
            type: "string",
            enum: ["bullish", "bearish", "neutral"],
          },
          confidence: {
            type: "integer",
            description: "0-100, how confident you are this is a high-conviction entry right now",
          },
          entry_timeframe: {
            type: "string",
            description: "Which of the scanned timeframes actually contains the entry trigger (e.g. the doji/BOS/sweep), not necessarily the highest one scanned",
          },
          key_level: { anyOf: [{ type: "number" }, { type: "null" }] },
          reasoning: { type: "string" },
        },
        required: [
          "symbol",
          "direction",
          "confidence",
          "entry_timeframe",
          "key_level",
          "reasoning",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["signals"],
  additionalProperties: false,
};

/**
 * Resolves which CDP connection to scan with. If a background scanner tab
 * is pinned (`tv trade-alert set-scanner-tab <index>`) and still open, scans
 * happen there via a connection scoped to that one tab — its chart flips
 * through every symbol/timeframe without ever coming to the foreground, so
 * the user's active tab never flickers. Otherwise falls back to the legacy
 * behavior of scanning directly on the foreground tab.
 */
async function resolveScanConnection() {
  const status = await tab.getScannerTab().catch(() => ({ configured: false }));
  if (status.configured && status.active) {
    return { conn: createScopedConnection(status.tab_id), scannerTab: status };
  }
  return { conn: null, scannerTab: status };
}

/**
 * Scans each watchlist symbol across every timeframe in rules.scan_timeframes
 * (falling back to just default_timeframe if unset), so the model can reason
 * about higher-timeframe bias/structure vs. lower-timeframe entry triggers —
 * standard ICT multi-timeframe confluence — instead of a single snapshot.
 */
async function scanMultiTimeframe({ rules, conn }) {
  const { watchlist = [], default_timeframe = "240", scan_timeframes } = rules;
  const timeframes =
    scan_timeframes && scan_timeframes.length
      ? scan_timeframes
      : [default_timeframe];

  // Only save/restore the original symbol when scanning the foreground tab —
  // a dedicated scanner tab is never viewed, so there's nothing to restore.
  let originalSymbol, originalTimeframe;
  if (!conn) {
    try {
      const currentState = await chart.getState();
      originalSymbol = currentState.symbol;
      originalTimeframe = currentState.resolution;
    } catch (_) {}
  }

  const results = [];
  for (const symbol of watchlist) {
    const perTimeframe = [];
    for (const timeframe of timeframes) {
      try {
        await chart.setSymbol({ symbol, conn });
        await new Promise((r) => setTimeout(r, 900));
        await chart.setTimeframe({ timeframe, conn });
        await new Promise((r) => setTimeout(r, 900));

        const [state, indicators, quote] = await Promise.all([
          chart.getState({ conn }),
          data.getStudyValues({ conn }),
          data.getQuote({ conn }),
        ]);

        perTimeframe.push({ timeframe, state, indicators, quote });
      } catch (err) {
        perTimeframe.push({ timeframe, error: err.message });
      }
    }
    results.push({ symbol, timeframes: perTimeframe });
  }

  if (!conn && originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe)
        await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  return results;
}

function loadAlertState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveAlertState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function evaluateSignals({ rules, symbolsScanned }) {
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_ALERT_MODEL || "claude-opus-4-8";
  const effort = process.env.ANTHROPIC_ALERT_EFFORT || "medium";

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: {
      effort,
      format: { type: "json_schema", schema: SIGNAL_SCHEMA },
    },
    system: [
      "You evaluate whether right now is a high-conviction trade entry, for a trader who only wants a text message when you are genuinely confident.",
      "Apply the user's bias_criteria and risk_rules literally to the indicator and price data given for each symbol — do not invent criteria that aren't there.",
      "Each symbol includes data from multiple timeframes, ordered highest to lowest. Use the higher timeframe(s) to judge overall trend/structure/bias, and the lower timeframe(s) to time the precise entry trigger (doji, BOS, liquidity sweep) — standard multi-timeframe confluence. Only call it a real setup when the timeframes agree: don't take a lower-timeframe trigger against the higher-timeframe bias.",
      "Set entry_timeframe to whichever timeframe actually shows the trigger, not just the highest one scanned.",
      "Be conservative: confidence should reflect real conviction, not enthusiasm. Most checks should NOT produce a high confidence score.",
      "direction 'neutral' means there is no actionable setup right now, regardless of confidence.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          bias_criteria: rules.bias_criteria || null,
          risk_rules: rules.risk_rules || null,
          notes: rules.notes || null,
          symbols: symbolsScanned,
        }),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error(
      `No text response from ${model} (stop_reason: ${response.stop_reason})`,
    );
  }
  const parsed = JSON.parse(textBlock.text);
  return parsed.signals.map((s) => ({
    ...s,
    confidence: Math.max(0, Math.min(100, Math.round(s.confidence))),
  }));
}

/**
 * Sends a Pushover notification, optionally with an image attached directly
 * in the request body (Pushover accepts binary attachments up to 2.5MB —
 * no public URL/tunnel needed, unlike Twilio MMS).
 */
async function sendPushover({ title, message, imagePath }) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) {
    throw new Error(
      "PUSHOVER_API_TOKEN / PUSHOVER_USER_KEY not set — see .env.example",
    );
  }

  const form = new FormData();
  form.append("token", token);
  form.append("user", user);
  form.append("title", title);
  form.append("message", message);
  if (imagePath) {
    const buffer = readFileSync(imagePath);
    form.append("attachment", new Blob([buffer], { type: "image/png" }), "chart.png");
  }

  const resp = await fetch(PUSHOVER_API_URL, { method: "POST", body: form });
  const data = await resp.json();
  if (!resp.ok || data.status !== 1) {
    throw new Error(
      `Pushover error ${resp.status}: ${data.errors ? data.errors.join(", ") : JSON.stringify(data)}`,
    );
  }
  return data;
}

export async function checkForSignals({ rules_path, dry_run = false } = {}) {
  const { rules } = morning.loadRules(rules_path);
  const { conn, scannerTab } = await resolveScanConnection();
  const scanned = await scanMultiTimeframe({ rules, conn });
  const symbolsScanned = scanned
    .map((s) => ({
      symbol: s.symbol,
      timeframes: s.timeframes.filter((t) => !t.error),
    }))
    .filter((s) => s.timeframes.length > 0);

  const scannerTabInfo = conn
    ? { used: true, tab_id: scannerTab.tab_id }
    : {
        used: false,
        note: scannerTab.configured
          ? "Configured scanner tab is no longer open — scanned on the active tab instead. Run \"tv trade-alert set-scanner-tab <index>\" to fix."
          : "No scanner tab configured — scanned on the active tab, which will flicker. Run \"tv tab new\" then \"tv trade-alert set-scanner-tab <index>\" to scan in the background instead.",
      };

  if (!symbolsScanned.length) {
    if (conn) await conn.disconnect();
    return {
      success: true,
      checked_at: new Date().toISOString(),
      dry_run,
      scanner_tab: scannerTabInfo,
      signals: [],
      texts_sent: [],
      note: "No symbols scanned successfully — nothing to evaluate.",
    };
  }

  const signals = await evaluateSignals({ rules, symbolsScanned });

  const threshold = Number(process.env.ALERT_CONFIDENCE_THRESHOLD || 85);
  const cooldownMs =
    Number(process.env.ALERT_COOLDOWN_MINUTES || 120) * 60 * 1000;
  const state = loadAlertState();
  const now = Date.now();
  const textsSent = [];

  for (const signal of signals) {
    if (signal.direction === "neutral" || signal.confidence < threshold) {
      continue;
    }

    const key = `${signal.symbol}:${signal.direction}`;
    const lastSent = state[key] ? new Date(state[key]).getTime() : 0;
    if (now - lastSent < cooldownMs) continue;

    const position = signal.direction === "bullish" ? "LONG" : "SHORT";
    const moveWord = signal.direction === "bullish" ? "up" : "down";
    const keyLevel = signal.key_level != null ? signal.key_level : "n/a";
    const entryTf = signal.entry_timeframe || rules.default_timeframe;
    const title = `${signal.symbol} — ${position} — ${signal.confidence}% (${entryTf}m)`;
    const body =
      `${signal.confidence}% probability it moves ${moveWord}. Entry timeframe: ${entryTf}. Key level: ${keyLevel}. ${signal.reasoning}`.slice(
        0,
        1024,
      );

    let photoAttached = false;

    if (!dry_run) {
      let imagePath;
      try {
        // Re-point the chart to the exact symbol+timeframe the signal fired
        // on, so the attached photo matches what triggered the alert.
        await chart.setSymbol({ symbol: signal.symbol, conn });
        await new Promise((r) => setTimeout(r, 900));
        await chart.setTimeframe({ timeframe: entryTf, conn });
        await new Promise((r) => setTimeout(r, 900));

        const shot = await capture.captureScreenshot({
          region: "chart",
          filename: `alert_${signal.symbol}_${now}`,
          conn,
        });
        if (shot.success && shot.file_path) imagePath = shot.file_path;
      } catch (err) {
        // Photo attach is best-effort — never let it block the actual alert.
        console.error(`Photo attach skipped: ${err.message}`);
      }

      await sendPushover({ title, message: body, imagePath });
      photoAttached = Boolean(imagePath);

      state[key] = new Date(now).toISOString();
    }

    textsSent.push({
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence,
      title,
      body,
      photo_attached: photoAttached,
      sent: !dry_run,
    });
  }

  if (!dry_run && textsSent.length) saveAlertState(state);
  if (conn) await conn.disconnect();

  return {
    success: true,
    checked_at: new Date().toISOString(),
    dry_run,
    threshold,
    scanner_tab: scannerTabInfo,
    signals,
    texts_sent: textsSent,
  };
}
