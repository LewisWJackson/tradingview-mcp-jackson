// Standalone click + drawing-delete capture daemon for TradingView Desktop.
//
// Push-based via CDP Runtime.addBinding. The page calls window.tvClickPush(json)
// from its click handler and from a 1Hz drawing-delete watcher; CDP delivers
// each payload as a Runtime.bindingCalled event, which we append to a JSONL log.
//
// Usage:
//   npm run clicks                                       # default logs/clicks.jsonl
//   npm run clicks -- --log /tmp/foo.jsonl               # custom path via flag
//   npm run clicks -- /tmp/foo.jsonl                     # custom path positional
//   CLICKS_LOG_PATH=/tmp/foo.jsonl npm run clicks        # custom path via env
//   CDP_PORT=9223 npm run clicks                         # custom CDP port
//
// Precedence: --log flag > positional arg > CLICKS_LOG_PATH env > default.
//
// Run TradingView with --remote-debugging-port=9222 first (the MCP's
// `tv_launch` tool sets this up automatically).

import CDP from "chrome-remote-interface";
import { mkdirSync, createWriteStream } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { log: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log" || a === "-l" || a === "-o") {
      out.log = argv[++i];
    } else if (a.startsWith("--log=")) {
      out.log = a.slice("--log=".length);
    } else if (a === "-h" || a === "--help") {
      out.help = true;
    } else if (!a.startsWith("-") && out.log === null) {
      out.log = a;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(
    [
      "Usage: node clicks-daemon.js [--log <path>] [path]",
      "",
      "Options:",
      "  --log, -l, -o <path>   JSONL log file (default: ./logs/clicks.jsonl)",
      "  -h, --help             Show this help",
      "",
      "Env vars:",
      "  CLICKS_LOG_PATH        Same as --log",
      "  CDP_HOST               TradingView CDP host (default: localhost)",
      "  CDP_PORT               TradingView CDP port (default: 9222)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const CDP_HOST = process.env.CDP_HOST || "localhost";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const LOG_PATH = resolve(
  args.log || process.env.CLICKS_LOG_PATH || join(__dirname, "logs", "clicks.jsonl"),
);
const BINDING = "tvClickPush";
const DRAWING_WATCH_INTERVAL_MS = 2000;
const VIEWPORT_WATCH_INTERVAL_MS = 2000;

// Page-side installer. Idempotent (guarded by __tvClicksInstalled). The handler
// looks up the chart fresh on each click so symbol/timeframe changes are picked
// up automatically without re-binding.
const INSTALL_SCRIPT = `(function install() {
  // Registry-based teardown: any prior daemon run shares this list, so a
  // re-install always evicts every handler that came before it.
  if (!Array.isArray(window.__tvClicksHandlers)) window.__tvClicksHandlers = [];
  window.__tvClicksHandlers.forEach(function(h) {
    try { document.removeEventListener('click', h, true); } catch (e) {}
  });
  window.__tvClicksHandlers.length = 0;
  window.__tvClicksInstalled = true;
  if (window.__tvDrawingsWatcher) {
    try { clearInterval(window.__tvDrawingsWatcher); } catch (e) {}
    window.__tvDrawingsWatcher = null;
  }
  if (window.__tvViewportWatcher) {
    try { clearInterval(window.__tvViewportWatcher); } catch (e) {}
    window.__tvViewportWatcher = null;
  }

  function findChart() {
    try {
      var v = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV;
      return v ? v.value() : null;
    } catch (e) { return null; }
  }

  function findPaneForTarget(chart, target) {
    try {
      var pws = chart._chartWidget.paneWidgets();
      for (var i = 0; i < pws.length; i++) {
        var el = pws[i].getElement && pws[i].getElement();
        if (el && el.contains(target)) return { pw: pws[i], index: i };
      }
    } catch (e) {}
    return null;
  }

  function translate(chart, ev) {
    var out = {
      symbol: null, resolution: null,
      candle_time: null, candle_iso: null,
      bar_index: null, price: null,
      pane_index: null, future: false,
      is_candle_click: false, candle_ohlcv: null,
    };
    if (!chart) return out;
    try {
      out.symbol = chart.symbol();
      out.resolution = chart.resolution();
      var cw = chart._chartWidget;
      var ts = cw.model().timeScale();
      var paneInfo = findPaneForTarget(chart, ev.target);

      var rect = null;
      if (paneInfo) rect = paneInfo.pw.getElement().getBoundingClientRect();
      if (!rect) {
        var w = ev.target.closest && ev.target.closest('.chart-gui-wrapper');
        if (w) rect = w.getBoundingClientRect();
      }
      if (!rect) return out;

      var localX = ev.clientX - rect.left;
      var localY = ev.clientY - rect.top;
      var floatIdx = ts.coordinateToFloatIndex(localX);
      var idx = Math.round(floatIdx);
      var tp = ts.indexToTimePoint(idx);
      var ct = (tp && tp.timestamp != null) ? tp.timestamp : tp;

      out.bar_index = idx;
      out.candle_time = ct;
      if (typeof ct === 'number' && isFinite(ct)) {
        out.candle_iso = new Date(ct * 1000).toISOString();
      }

      try {
        var baseIdx = ts.baseIndex();
        if (typeof baseIdx === 'number' && idx > baseIdx) out.future = true;
      } catch (e) {}

      if (paneInfo) {
        out.pane_index = paneInfo.index;
        try {
          var ms = cw.model().mainSeries();
          var ps = ms.priceScale();
          if (ps && typeof ps.coordinateToPrice === 'function') {
            out.price = ps.coordinateToPrice(localY, ms.firstValue && ms.firstValue());
          }
        } catch (e) {}
      }

      // Fetch the candle at bar_index from the main series. Provided regardless
      // of pane (useful temporal context for volume / sub-pane clicks too).
      try {
        var ms2 = cw.model().mainSeries();
        var bars = ms2.bars();
        var v = bars.valueAt(idx);
        if (v) {
          out.candle_ohlcv = {
            open: v[1], high: v[2], low: v[3], close: v[4],
            volume: (v[5] != null ? v[5] : 0),
          };
          // is_candle_click is strict: only true when click was on the main
          // candle pane and the price falls within the [low, high] wick range.
          if (out.pane_index === 0 && typeof out.price === 'number'
              && out.price >= v[3] && out.price <= v[2]) {
            out.is_candle_click = true;
          }
        }
      } catch (e) {}
    } catch (e) {}
    return out;
  }

  function btnName(b) {
    return b === 0 ? 'left' : b === 1 ? 'middle' : b === 2 ? 'right' : 'other';
  }

  function snapshotDrawing(d) {
    var info = {
      drawing_id: null, drawing_name: null, drawing_title: null,
      drawing_symbol: null, drawing_points: null,
    };
    try { info.drawing_id = d.id(); } catch (e) {}
    try { info.drawing_name = d.name(); } catch (e) {}
    try { info.drawing_title = d.title(); } catch (e) {}
    try { info.drawing_symbol = d.symbol(); } catch (e) {}
    try { info.drawing_points = d.points(); } catch (e) {}
    return info;
  }

  function handler(ev) {
    if (!ev.target || !ev.target.closest) return;
    if (!ev.target.closest('.chart-gui-wrapper')) return;
    var clickTs = Date.now();
    var modifiers = {
      shift: !!ev.shiftKey, alt: !!ev.altKey,
      meta: !!ev.metaKey, ctrl: !!ev.ctrlKey,
    };
    var x = ev.clientX, y = ev.clientY;
    var btn = btnName(ev.button);
    var t = translate(findChart(), ev);
    var payload = {
      ts: clickTs,
      type: ev.type,
      button: btn,
      x: x, y: y,
      modifiers: modifiers,
      symbol: t.symbol,
      resolution: t.resolution,
      candle_time: t.candle_time,
      candle_iso: t.candle_iso,
      bar_index: t.bar_index,
      price: t.price,
      pane_index: t.pane_index,
      future: t.future,
      is_candle_click: t.is_candle_click,
      candle_ohlcv: t.candle_ohlcv,
    };
    try { if (window.tvClickPush) window.tvClickPush(JSON.stringify(payload)); } catch (e) {}

    // Drawing detection: TradingView processes the click on the same tick;
    // by the next macrotask the selection reflects whatever drawing got hit.
    setTimeout(function() {
      try {
        var chart = findChart();
        if (!chart) return;
        var sel = chart._chartWidget.model().selection();
        var lines = (typeof sel.lineDataSources === 'function') ? sel.lineDataSources() : [];
        for (var i = 0; i < lines.length; i++) {
          var info = snapshotDrawing(lines[i]);
          info.ts = clickTs;
          info.type = 'drawing_click';
          info.button = btn;
          info.x = x; info.y = y;
          info.modifiers = modifiers;
          info.symbol = t.symbol;
          info.resolution = t.resolution;
          try { if (window.tvClickPush) window.tvClickPush(JSON.stringify(info)); } catch (e) {}
        }
      } catch (e) {}
    }, 60);
  }

  window.__tvClicksHandlers.push(handler);
  document.addEventListener('click', handler, true);

  // Drawing-delete watcher: enumerates line tools every 2s and diffs
  // against last-known IDs. dataSources() lives on the inner model
  // (chart._chartWidget.model().model()), same path used by src/core/data.js.
  // Line tools have points(); studies don't, which is how we filter.
  function listDrawings(chart) {
    var out = new Map();
    if (!chart || !chart._chartWidget) return out;
    try {
      var sources = chart._chartWidget.model().model().dataSources();
      for (var i = 0; i < sources.length; i++) {
        var src = sources[i];
        try {
          if (typeof src.points !== 'function') continue;
          var pts = src.points();
          if (!Array.isArray(pts)) continue;
          var id = (typeof src.id === 'function') ? src.id() : null;
          if (id != null) out.set(id, src);
        } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  var knownDrawings = new Map();
  var lastSymbol = null;

  function tickDrawings() {
    try {
      var chart = findChart();
      if (!chart) return;
      var sym = null; try { sym = chart.symbol(); } catch (e) {}
      var res = null; try { res = chart.resolution(); } catch (e) {}
      var current = listDrawings(chart);

      // Symbol change: drawings can be symbol-scoped, so the diff is noise.
      // Reset baseline silently instead of emitting false deletes.
      if (sym !== lastSymbol) {
        lastSymbol = sym;
        var fresh = new Map();
        current.forEach(function(src, id) { fresh.set(id, snapshotDrawing(src)); });
        knownDrawings = fresh;
        return;
      }

      knownDrawings.forEach(function(snap, id) {
        if (current.has(id)) return;
        var payload = {};
        Object.keys(snap).forEach(function(k) { payload[k] = snap[k]; });
        payload.ts = Date.now();
        payload.type = 'drawing_delete';
        payload.symbol = sym;
        payload.resolution = res;
        try { if (window.tvClickPush) window.tvClickPush(JSON.stringify(payload)); } catch (e) {}
      });

      var next = new Map();
      current.forEach(function(src, id) {
        next.set(id, knownDrawings.get(id) || snapshotDrawing(src));
      });
      knownDrawings = next;
    } catch (e) {}
  }

  try {
    var c0 = findChart();
    if (c0) {
      try { lastSymbol = c0.symbol(); } catch (e) {}
      listDrawings(c0).forEach(function(src, id) {
        knownDrawings.set(id, snapshotDrawing(src));
      });
    }
  } catch (e) {}

  // Exposed for the daemon's one-shot startup inventory query.
  window.__tvGetDrawings = function() {
    try {
      var chart = findChart();
      if (!chart) return { symbol: null, resolution: null, drawings: [] };
      var sym = null; try { sym = chart.symbol(); } catch (e) {}
      var res = null; try { res = chart.resolution(); } catch (e) {}
      var out = [];
      listDrawings(chart).forEach(function(src) {
        out.push(snapshotDrawing(src));
      });
      return { symbol: sym, resolution: res, drawings: out };
    } catch (e) { return { symbol: null, resolution: null, drawings: [] }; }
  };

  window.__tvDrawingsWatcher = setInterval(tickDrawings, ${DRAWING_WATCH_INTERVAL_MS});

  // Viewport-change watcher: emits when visible time range or main-pane
  // visible price range changes. Diff-suppressed; floats rounded to avoid
  // jitter. First emission after chart-ready records the starting viewport.
  function readViewport(chart) {
    var v = {
      time_from: null, time_to: null,
      time_from_iso: null, time_to_iso: null,
      price_top: null, price_bottom: null,
    };
    if (!chart) return v;
    try {
      var r = (typeof chart.getVisibleRange === 'function') ? chart.getVisibleRange() : null;
      if (r && typeof r.from === 'number' && typeof r.to === 'number') {
        v.time_from = r.from;
        v.time_to = r.to;
        v.time_from_iso = new Date(r.from * 1000).toISOString();
        v.time_to_iso = new Date(r.to * 1000).toISOString();
      }
    } catch (e) {}
    try {
      var cw = chart._chartWidget;
      var pws = cw.paneWidgets();
      if (pws && pws.length > 0) {
        var rect = pws[0].getElement().getBoundingClientRect();
        var ms = cw.model().mainSeries();
        var ps = ms.priceScale();
        var fv = (ms.firstValue && ms.firstValue()) || null;
        if (ps && typeof ps.coordinateToPrice === 'function' && rect && rect.height > 0) {
          var top = ps.coordinateToPrice(0, fv);
          var bot = ps.coordinateToPrice(rect.height, fv);
          if (typeof top === 'number' && isFinite(top)) v.price_top = +top.toFixed(8);
          if (typeof bot === 'number' && isFinite(bot)) v.price_bottom = +bot.toFixed(8);
        }
      }
    } catch (e) {}
    return v;
  }

  var lastViewport = null;

  function viewportsEqual(a, b) {
    if (!a || !b) return false;
    return a.time_from === b.time_from
        && a.time_to === b.time_to
        && a.price_top === b.price_top
        && a.price_bottom === b.price_bottom;
  }

  function tickViewport() {
    try {
      var chart = findChart();
      if (!chart) return;
      var sym = null; try { sym = chart.symbol(); } catch (e) {}
      var res = null; try { res = chart.resolution(); } catch (e) {}
      var v = readViewport(chart);
      if (v.time_from == null) return;
      if (viewportsEqual(lastViewport, v)) return;
      lastViewport = v;
      var payload = {
        ts: Date.now(),
        type: 'viewport_change',
        symbol: sym,
        resolution: res,
        time_from: v.time_from,
        time_to: v.time_to,
        time_from_iso: v.time_from_iso,
        time_to_iso: v.time_to_iso,
        price_top: v.price_top,
        price_bottom: v.price_bottom,
      };
      try { if (window.tvClickPush) window.tvClickPush(JSON.stringify(payload)); } catch (e) {}
    } catch (e) {}
  }

  window.__tvViewportWatcher = setInterval(tickViewport, ${VIEWPORT_WATCH_INTERVAL_MS});
})();`;

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return (
    targets.find(
      (t) => t.type === "page" && /tradingview\.com\/chart/i.test(t.url),
    ) || targets.find((t) => t.type === "page" && /tradingview/i.test(t.url))
  );
}

function log(msg) {
  process.stderr.write(`[clicks-daemon] ${msg}\n`);
}

async function main() {
  const target = await findChartTarget();
  if (!target) {
    throw new Error(
      "No TradingView chart target on CDP. Is TradingView open with a chart and --remote-debugging-port=" +
        CDP_PORT +
        "?",
    );
  }

  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  const { Runtime, Page } = client;

  await Runtime.enable();
  await Page.enable();
  await Runtime.addBinding({ name: BINDING });
  await Page.addScriptToEvaluateOnNewDocument({ source: INSTALL_SCRIPT });
  await Runtime.evaluate({ expression: INSTALL_SCRIPT });

  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const stream = createWriteStream(LOG_PATH, { flags: "a" });

  stream.write(
    JSON.stringify({
      event: "daemon_started",
      ts: Date.now(),
      target_url: target.url,
      target_id: target.id,
      cdp: `${CDP_HOST}:${CDP_PORT}`,
    }) + "\n",
  );

  // One-shot startup inventory of existing drawings. Retries briefly in case
  // the chart widget is still initializing when we connect.
  let inventory = { symbol: null, resolution: null, drawings: [] };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await Runtime.evaluate({
        expression:
          "JSON.stringify(window.__tvGetDrawings ? window.__tvGetDrawings() : { symbol: null, resolution: null, drawings: [] })",
        returnByValue: true,
      });
      inventory = JSON.parse(r.result?.value || '{"drawings":[]}');
      if (inventory.symbol) break;
    } catch (e) {
      log(`inventory probe failed (attempt ${attempt + 1}): ${e.message}`);
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, 500));
  }
  const invTs = Date.now();
  for (const d of inventory.drawings || []) {
    stream.write(
      JSON.stringify({
        ts: invTs,
        type: "drawing_initial",
        symbol: inventory.symbol,
        resolution: inventory.resolution,
        ...d,
      }) + "\n",
    );
  }
  log(
    `initial inventory: ${(inventory.drawings || []).length} drawing(s) on ${inventory.symbol || "unknown"}`,
  );

  let count = 0;
  Runtime.bindingCalled(({ name, payload }) => {
    if (name !== BINDING) return;
    try {
      JSON.parse(payload);
    } catch (e) {
      log(`bad payload skipped: ${e.message}`);
      return;
    }
    stream.write(payload + "\n");
    count++;
    if (count <= 5 || count % 25 === 0) {
      log(`captured ${count} clicks → ${LOG_PATH}`);
    }
  });

  log(`connected to ${target.url}`);
  log(`logging to ${LOG_PATH}`);
  log(`Ctrl+C to stop`);

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${sig}, shutting down (${count} clicks captured)`);
    stream.write(
      JSON.stringify({ event: "daemon_stopped", ts: Date.now(), captured: count }) + "\n",
    );
    await new Promise((r) => stream.end(r));
    try {
      await client.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise(() => {});
}

main().catch((err) => {
  process.stderr.write(`[clicks-daemon] fatal: ${err.message}\n`);
  process.exit(1);
});
