// Replay a clicks-daemon JSONL log onto a live TradingView chart.
//
// Real-time replay: preserves wall-clock deltas between events from `ts`.
// Drawings present at session start (`drawing_initial`) are pre-plotted
// before the walk begins. Drawing creates are inferred from the first
// occurrence of a `drawing_id` in a `drawing_click` event (the daemon
// emits no explicit create event). Each `click` event drops a marker:
// a red rectangle around the candle for `is_candle_click`, a grey
// dashed vertical line at `candle_time` otherwise.
//
// Usage:
//   node replay-clicks.js <log-path>             # real-time replay
//   node replay-clicks.js <log-path> --clear     # remove our markers at end
//   node replay-clicks.js <log-path> --no-switch # skip symbol/timeframe switch
//
// Prereq: TradingView Desktop running with --remote-debugging-port=9222.

import { readFileSync } from "fs";
import * as connection from "./src/connection.js";
import * as chart from "./src/core/chart.js";
import * as drawing from "./src/core/drawing.js";

function parseArgs(argv) {
  const out = { logPath: null, clear: false, noSwitch: false };
  for (const a of argv) {
    if (a === "--clear") out.clear = true;
    else if (a === "--no-switch") out.noSwitch = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!a.startsWith("-") && !out.logPath) out.logPath = a;
  }
  return out;
}

function usage() {
  process.stdout.write(
    [
      "Usage: node replay-clicks.js <log-path> [--clear] [--no-switch]",
      "",
      "  --clear      Remove drawings/markers created by this run before exit",
      "  --no-switch  Don't auto-switch chart symbol/timeframe from the log",
      "",
    ].join("\n"),
  );
}

function log(msg) {
  process.stderr.write(`[replay] ${msg}\n`);
}

function parseLog(path) {
  const text = readFileSync(path, "utf8");
  const events = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj.event === "daemon_started" || obj.event === "daemon_stopped") continue;
    if (!obj.type || obj.ts == null) continue;
    events.push(obj);
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

// Accept ISO string or unix seconds; return unix seconds (number).
function toUnixSeconds(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
}

function barSeconds(resolution) {
  if (!resolution) return 60;
  const r = String(resolution).toUpperCase();
  if (r === "D" || r === "1D") return 86400;
  if (r === "W" || r === "1W") return 604800;
  if (r === "M" || r === "1M") return 2592000;
  const n = parseInt(r, 10);
  return isFinite(n) && n > 0 ? n * 60 : 60;
}

// Captured TV display names → draw_shape's `shape` arg.
const SHAPE_MAP = {
  Rectangle: { shape: "rectangle", points: 2 },
  Trendline: { shape: "trend_line", points: 2 },
  "Trend Line": { shape: "trend_line", points: 2 },
  "Horizontal Line": { shape: "horizontal_line", points: 1 },
  "Vertical Line": { shape: "vertical_line", points: 1 },
};

function mapShape(name) {
  return SHAPE_MAP[name] || null;
}

function pointHasTime(p) {
  return p && typeof p.time === "number" && isFinite(p.time);
}

function pickPoints(drawingPoints, n) {
  if (!Array.isArray(drawingPoints) || drawingPoints.length < n) return null;
  const usable = drawingPoints.filter(pointHasTime);
  if (usable.length < n) return null;
  return usable.slice(0, n).map((p) => ({ time: p.time, price: p.price }));
}

async function recreateDrawing(d) {
  const m = mapShape(d.drawing_name);
  if (!m) {
    log(`skip unsupported drawing "${d.drawing_name}" (id=${d.drawing_id})`);
    return null;
  }
  const pts = pickPoints(d.drawing_points, m.points);
  if (!pts) return null;
  const args = {
    shape: m.shape,
    point: pts[0],
    point2: m.points === 2 ? pts[1] : undefined,
  };
  try {
    const res = await drawing.drawShape(args);
    return res?.entity_id || null;
  } catch (err) {
    log(`drawShape failed for ${d.drawing_name} id=${d.drawing_id}: ${err.message}`);
    return null;
  }
}

async function dispatch(ev, state) {
  if (ev.type === "viewport_change") {
    const from = toUnixSeconds(ev.time_from ?? ev.time_from_iso);
    const to = toUnixSeconds(ev.time_to ?? ev.time_to_iso);
    if (!from || !to || from === 0 || to === 0 || to <= from) return;
    try {
      await chart.setVisibleRange({ from, to });
    } catch (err) {
      log(`setVisibleRange failed: ${err.message}`);
    }
    return;
  }

  if (ev.type === "drawing_click") {
    if (state.drawingMap.has(ev.drawing_id)) return;
    const eid = await recreateDrawing(ev);
    if (eid) {
      state.drawingMap.set(ev.drawing_id, eid);
      state.createdEntities.push(eid);
      log(`drawing created: ${ev.drawing_name} ${ev.drawing_id} → ${eid}`);
    }
    return;
  }

  if (ev.type === "drawing_delete") {
    const eid = state.drawingMap.get(ev.drawing_id);
    if (!eid) {
      log(`drawing_delete: no mapping for captured id=${ev.drawing_id} (was it in initial?)`);
      return;
    }
    try {
      await drawing.removeOne({ entity_id: eid });
      state.drawingMap.delete(ev.drawing_id);
      log(`drawing deleted: ${ev.drawing_id} (was ${eid})`);
    } catch (err) {
      log(`removeOne failed for ${eid}: ${err.message}`);
    }
    return;
  }

  if (ev.type === "click") {
    const ts = toUnixSeconds(ev.candle_time ?? ev.candle_iso);
    if (!ts) return;
    try {
      if (ev.is_candle_click && ev.candle_ohlcv) {
        const half = Math.max(1, Math.floor(barSeconds(ev.resolution) / 2));
        const res = await drawing.drawShape({
          shape: "rectangle",
          point: { time: ts - half, price: ev.candle_ohlcv.high },
          point2: { time: ts + half, price: ev.candle_ohlcv.low },
          overrides: JSON.stringify({
            linecolor: "#ff4d4d",
            linewidth: 1,
            backgroundColor: "rgba(255,77,77,0.18)",
          }),
        });
        if (res?.entity_id) state.markerEntities.push(res.entity_id);
      } else {
        const res = await drawing.drawShape({
          shape: "vertical_line",
          point: { time: ts, price: ev.price ?? 0 },
          overrides: JSON.stringify({
            linecolor: "#888888",
            linewidth: 1,
            linestyle: 2,
          }),
        });
        if (res?.entity_id) state.markerEntities.push(res.entity_id);
      }
    } catch (err) {
      log(`click marker failed at ts=${ts}: ${err.message}`);
    }
    return;
  }

  // drawing_initial is pre-plotted; anything else is unknown.
  if (ev.type !== "drawing_initial") {
    log(`unknown event type: ${ev.type}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.logPath) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const events = parseLog(args.logPath);
  log(`loaded ${events.length} events from ${args.logPath}`);
  if (events.length === 0) {
    log("nothing to replay");
    process.exit(0);
  }

  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  log(`event mix: ${JSON.stringify(counts)}`);

  await connection.connect();
  log("connected to TradingView via CDP");

  const state = {
    drawingMap: new Map(),    // captured drawing_id → our entity_id
    createdEntities: [],      // entity_ids we created for drawings
    markerEntities: [],       // entity_ids we created for click markers
  };

  let shuttingDown = false;
  const cleanup = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down: ${reason}`);
    if (args.clear) {
      const all = [...state.markerEntities, ...state.drawingMap.values()];
      log(`clearing ${all.length} drawings created by this run`);
      for (const id of all) {
        try { await drawing.removeOne({ entity_id: id }); } catch {}
      }
    }
    try { await connection.disconnect(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  // Switch to the log's symbol/timeframe.
  const firstWithSymbol = events.find((e) => e.symbol);
  if (!args.noSwitch && firstWithSymbol) {
    log(`switching to ${firstWithSymbol.symbol} ${firstWithSymbol.resolution}`);
    try { await chart.setSymbol({ symbol: firstWithSymbol.symbol }); }
    catch (err) { log(`setSymbol failed: ${err.message}`); }
    try { await chart.setTimeframe({ timeframe: String(firstWithSymbol.resolution) }); }
    catch (err) { log(`setTimeframe failed: ${err.message}`); }
  }

  // Pre-plot drawings present at session start.
  const initials = events.filter((e) => e.type === "drawing_initial");
  log(`pre-plotting ${initials.length} initial drawing(s)`);
  for (const d of initials) {
    const eid = await recreateDrawing(d);
    if (eid) {
      state.drawingMap.set(d.drawing_id, eid);
      state.createdEntities.push(eid);
    }
  }

  // Real-time walk. Use the first non-marker event's ts as t0.
  const walked = events.filter((e) => e.type !== "drawing_initial");
  if (walked.length === 0) {
    await cleanup("nothing to walk");
    return;
  }

  const t0 = walked[0].ts;
  const startedAt = Date.now();
  log(`starting real-time replay (${walked.length} events, span=${((walked[walked.length-1].ts - t0)/1000).toFixed(1)}s)`);

  for (let i = 0; i < walked.length; i++) {
    const ev = walked[i];
    const target = startedAt + (ev.ts - t0);
    const wait = target - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await dispatch(ev, state);
    if ((i + 1) % 10 === 0 || i === walked.length - 1) {
      log(`${i + 1}/${walked.length} events dispatched`);
    }
  }

  log("replay complete");
  await cleanup("done");
}

main().catch(async (err) => {
  process.stderr.write(`[replay] fatal: ${err.stack || err.message}\n`);
  try { await connection.disconnect(); } catch {}
  process.exit(1);
});
