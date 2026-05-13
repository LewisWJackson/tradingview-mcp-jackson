/**
 * Core health/discovery/launch logic.
 */
import { getClient, getTargetInfo, evaluate, setCdpPort, getCdpPort } from '../connection.js';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import net from 'net';

// Quick non-blocking TCP probe: is anything listening on (127.0.0.1, port)?
function probePort(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

// Diagnose why CDP isn't reachable: is TradingView even running? Is the port open?
// Returns a plain object suitable for surfacing in tool errors.
export async function diagnoseLocalTv(port = getCdpPort()) {
  const platform = process.platform;
  let tvPid = null;
  try {
    if (platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq TradingView.exe" /NH', { timeout: 3000 }).toString();
      const m = out.match(/TradingView\.exe\s+(\d+)/);
      if (m) tvPid = parseInt(m[1], 10);
    } else {
      // Narrow to the actual app binary, not helper renderers or this MCP server.
      const pattern = platform === 'darwin' ? '/MacOS/TradingView$' : 'tradingview';
      const out = execSync(`pgrep -f '${pattern}'`, { timeout: 3000 }).toString().trim();
      if (out) tvPid = parseInt(out.split('\n')[0], 10);
    }
  } catch { /* not running, or pgrep/tasklist missing */ }
  const cdpListening = await probePort(port);
  return { tv_running: tvPid != null, tv_pid: tvPid, cdp_port: port, cdp_listening: cdpListening };
}

// Human-readable hint derived from a diagnostic result.
export function hintForDiagnostic(diag) {
  if (!diag.tv_running && !diag.cdp_listening) {
    return 'TradingView is not running. Call tv_launch to start it with CDP enabled.';
  }
  if (diag.tv_running && !diag.cdp_listening) {
    return `TradingView (PID ${diag.tv_pid}) is running but was started without Chrome DevTools Protocol on port ${diag.cdp_port}. To fix: quit TradingView (save your layout first — tv_launch will force-kill it), then call tv_launch, or relaunch manually with --remote-debugging-port=${diag.cdp_port}.`;
  }
  if (!diag.tv_running && diag.cdp_listening) {
    return `Port ${diag.cdp_port} is in use but TradingView is not running — another Chromium/Electron process may be holding the port. Free it or pass a different port to tv_launch.`;
  }
  return `CDP is listening on port ${diag.cdp_port} but no TradingView chart target was found. Open a chart in the app (not the home screen) and retry.`;
}

export async function healthCheck() {
  await getClient();
  const target = await getTargetInfo();

  const state = await evaluate(`
    (function() {
      var result = { url: window.location.href, title: document.title };
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        result.symbol = chart.symbol();
        result.resolution = chart.resolution();
        result.chartType = chart.chartType();
        result.apiAvailable = true;
      } catch(e) {
        result.symbol = 'unknown';
        result.resolution = 'unknown';
        result.chartType = null;
        result.apiAvailable = false;
        result.apiError = e.message;
      }
      return result;
    })()
  `);

  return {
    success: true,
    cdp_connected: true,
    target_id: target.id,
    target_url: target.url,
    target_title: target.title,
    chart_symbol: state?.symbol || 'unknown',
    chart_resolution: state?.resolution || 'unknown',
    chart_type: state?.chartType ?? null,
    api_available: state?.apiAvailable ?? false,
  };
}

export async function discover() {
  const paths = await evaluate(`
    (function() {
      var results = {};
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var methods = [];
        for (var k in chart) { if (typeof chart[k] === 'function') methods.push(k); }
        results.chartApi = { available: true, path: 'window.TradingViewApi._activeChartWidgetWV.value()', methodCount: methods.length, methods: methods.slice(0, 50) };
      } catch(e) { results.chartApi = { available: false, error: e.message }; }
      try {
        var col = window.TradingViewApi._chartWidgetCollection;
        var colMethods = [];
        for (var k in col) { if (typeof col[k] === 'function') colMethods.push(k); }
        results.chartWidgetCollection = { available: !!col, path: 'window.TradingViewApi._chartWidgetCollection', methodCount: colMethods.length, methods: colMethods.slice(0, 30) };
      } catch(e) { results.chartWidgetCollection = { available: false, error: e.message }; }
      try {
        var ws = window.ChartApiInstance;
        var wsMethods = [];
        for (var k in ws) { if (typeof ws[k] === 'function') wsMethods.push(k); }
        results.chartApiInstance = { available: !!ws, path: 'window.ChartApiInstance', methodCount: wsMethods.length, methods: wsMethods.slice(0, 30) };
      } catch(e) { results.chartApiInstance = { available: false, error: e.message }; }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        var bwbMethods = [];
        if (bwb) { for (var k in bwb) { if (typeof bwb[k] === 'function') bwbMethods.push(k); } }
        results.bottomWidgetBar = { available: !!bwb, path: 'window.TradingView.bottomWidgetBar', methodCount: bwbMethods.length, methods: bwbMethods.slice(0, 20) };
      } catch(e) { results.bottomWidgetBar = { available: false, error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        results.replayApi = { available: !!replay, path: 'window.TradingViewApi._replayApi' };
      } catch(e) { results.replayApi = { available: false, error: e.message }; }
      try {
        var alerts = window.TradingViewApi._alertService;
        results.alertService = { available: !!alerts, path: 'window.TradingViewApi._alertService' };
      } catch(e) { results.alertService = { available: false, error: e.message }; }
      return results;
    })()
  `);

  const available = Object.values(paths).filter(v => v.available).length;
  const total = Object.keys(paths).length;

  return { success: true, apis_available: available, apis_total: total, apis: paths };
}

export async function uiState() {
  const state = await evaluate(`
    (function() {
      var ui = {};
      var bottom = document.querySelector('[class*="layout__area--bottom"]');
      ui.bottom_panel = { open: !!(bottom && bottom.offsetHeight > 50), height: bottom ? bottom.offsetHeight : 0 };
      var right = document.querySelector('[class*="layout__area--right"]');
      ui.right_panel = { open: !!(right && right.offsetWidth > 50), width: right ? right.offsetWidth : 0 };
      var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco');
      ui.pine_editor = { open: !!monacoEl, width: monacoEl ? monacoEl.offsetWidth : 0, height: monacoEl ? monacoEl.offsetHeight : 0 };
      var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
      ui.strategy_tester = { open: !!(stratPanel && stratPanel.offsetParent) };
      var widgetbar = document.querySelector('[data-name="widgetbar-wrap"]');
      ui.widgetbar = { open: !!(widgetbar && widgetbar.offsetWidth > 50) };
      ui.buttons = {};
      var btns = document.querySelectorAll('button');
      var seen = {};
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null || b.offsetWidth < 15) continue;
        var text = b.textContent.trim();
        var aria = b.getAttribute('aria-label') || '';
        var dn = b.getAttribute('data-name') || '';
        var label = text || aria || dn;
        if (!label || label.length > 60) continue;
        var key = label.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 40);
        if (seen[key]) continue;
        seen[key] = true;
        var rect = b.getBoundingClientRect();
        var region = 'other';
        if (rect.y < 50) region = 'top_bar';
        else if (rect.y < 90 && rect.x < 650) region = 'toolbar';
        else if (rect.x < 45) region = 'left_sidebar';
        else if (rect.x > 650 && rect.y < 100) region = 'pine_header';
        else if (rect.y > 750) region = 'bottom_bar';
        if (!ui.buttons[region]) ui.buttons[region] = [];
        ui.buttons[region].push({ label: label.substring(0, 40), disabled: b.disabled, x: Math.round(rect.x), y: Math.round(rect.y) });
      }
      ui.key_buttons = {};
      var keyLabels = {
        'add_to_chart': /add to chart/i, 'save_and_add': /save and add/i,
        'update_on_chart': /update on chart/i, 'save': /^Save(Save)?$/,
        'saved': /^Saved/, 'publish_script': /publish script/i,
        'compile_errors': /error/i, 'unsaved_version': /unsaved version/i,
      };
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        var text = b.textContent.trim();
        for (var k in keyLabels) {
          if (keyLabels[k].test(text)) {
            ui.key_buttons[k] = { text: text.substring(0, 40), disabled: b.disabled, visible: b.offsetWidth > 0 };
          }
        }
      }
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        ui.chart = { symbol: chart.symbol(), resolution: chart.resolution(), chartType: chart.chartType(), study_count: chart.getAllStudies().length };
      } catch(e) { ui.chart = { error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
        ui.replay = { available: unwrap(replay.isReplayAvailable()), started: unwrap(replay.isReplayStarted()) };
      } catch(e) { ui.replay = { error: e.message }; }
      return ui;
    })()
  `);

  return { success: true, ...state };
}

export async function launch({ port, kill_existing, force } = {}) {
  const cdpPort = port || 9222;
  // Default behaviour: be conservative about killing the user's running TradingView.
  // kill_existing controls whether we kill at all; `force` skips the "already running with CDP" short-circuit.
  const killFirst = kill_existing !== false;
  const platform = process.platform;

  // Persist the chosen port so subsequent tool calls (which go through getClient/findChartTarget)
  // hit the right port instead of the hardcoded 9222 default.
  setCdpPort(cdpPort);

  // Smart short-circuit: if TradingView is already running AND CDP is already listening on the
  // requested port, don't kill+relaunch — that would force the user to re-sign-in and lose any
  // unsaved layout state. Just report success and let the caller proceed.
  if (!force) {
    const pre = await diagnoseLocalTv(cdpPort);
    if (pre.tv_running && pre.cdp_listening) {
      return {
        success: true, platform, already_running: true, pid: pre.tv_pid,
        cdp_port: cdpPort, cdp_url: `http://localhost:${cdpPort}`, cdp_ready: true,
        note: 'TradingView was already running with CDP enabled — skipped relaunch to preserve your session. Pass { force: true } to force a restart.',
      };
    }
  }

  const pathMap = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${process.env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${process.env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${process.env.HOME}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };

  let tvPath = null;
  const candidates = pathMap[platform] || pathMap.linux;
  for (const p of candidates) {
    if (p && existsSync(p)) { tvPath = p; break; }
  }

  if (!tvPath) {
    try {
      const cmd = platform === 'win32' ? 'where TradingView.exe' : 'which tradingview';
      tvPath = execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
      if (tvPath && !existsSync(tvPath)) tvPath = null;
    } catch { /* ignore */ }
  }

  if (!tvPath && platform === 'darwin') {
    try {
      const found = execSync('mdfind "kMDItemFSName == TradingView.app" | head -1', { timeout: 5000 }).toString().trim();
      if (found) {
        const candidate = `${found}/Contents/MacOS/TradingView`;
        if (existsSync(candidate)) tvPath = candidate;
      }
    } catch { /* ignore */ }
  }

  if (!tvPath) {
    throw new Error(`TradingView not found on ${platform}. Searched: ${candidates.join(', ')}. Launch manually with: /path/to/TradingView --remote-debugging-port=${cdpPort}`);
  }

  if (killFirst) {
    try {
      if (platform === 'win32') {
        execSync('taskkill /F /IM TradingView.exe', { timeout: 5000 });
      } else if (platform === 'darwin') {
        // Narrow match: only the main app binary, not the project path (which may contain
        // "tradingview") nor helper renderers (which will exit when the parent does anyway).
        execSync("pkill -f '/MacOS/TradingView$'", { timeout: 5000 });
      } else {
        // On Linux the binary path varies; match common installation patterns but stay narrow
        // enough to not nuke unrelated processes that happen to contain "tradingview".
        execSync("pkill -f '(^|/)(TradingView|tradingview)( |$)'", { timeout: 5000 });
      }
      await new Promise(r => setTimeout(r, 1500));
    } catch { /* may not be running */ }
  }

  // Launch strategy by platform:
  //   - macOS: use `open -na` so the app goes through LaunchServices (proper Dock icon, Gatekeeper
  //     ack, no half-foregrounded state). Note: `open` exits immediately, so child.pid is the open
  //     helper, not TradingView itself — we recover the real PID via diagnoseLocalTv after CDP is up.
  //   - Windows / Linux: spawn the binary directly with the flag.
  let child;
  let appBundle = null;
  if (platform === 'darwin') {
    appBundle = tvPath.replace(/\/Contents\/MacOS\/TradingView$/, '');
    child = spawn('open', ['-na', appBundle, '--args', `--remote-debugging-port=${cdpPort}`],
      { detached: true, stdio: 'ignore' });
  } else {
    child = spawn(tvPath, [`--remote-debugging-port=${cdpPort}`], { detached: true, stdio: 'ignore' });
  }
  child.unref();

  // Cold-start TradingView Desktop (sign-in, layout restore, network warmup) routinely takes
  // 30–60 s before CDP starts accepting connections. The old 15 s budget returned success:true
  // with a warning, which most callers ignored — then the next tool call would hit a dead port.
  // We now poll up to 60 s and return success:false if CDP never comes up.
  const READY_TIMEOUT_S = 60;
  for (let i = 0; i < READY_TIMEOUT_S; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const http = await import('http');
      const ready = await new Promise((resolve) => {
        http.get(`http://localhost:${cdpPort}/json/version`, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', () => resolve(null));
      });
      if (ready) {
        const info = JSON.parse(ready);
        // On macOS, child.pid is the `open` helper which has already exited — resolve the real
        // TradingView pid via the same diagnostic helper used everywhere else.
        const realPid = platform === 'darwin'
          ? (await diagnoseLocalTv(cdpPort)).tv_pid
          : child.pid;
        return {
          success: true, platform, binary: tvPath, app_bundle: appBundle, pid: realPid,
          cdp_port: cdpPort, cdp_url: `http://localhost:${cdpPort}`,
          cdp_ready: true, waited_seconds: i + 1,
          browser: info.Browser, user_agent: info['User-Agent'],
        };
      }
    } catch { /* retry */ }
  }

  const failPid = platform === 'darwin' ? (await diagnoseLocalTv(cdpPort)).tv_pid : child.pid;
  return {
    success: false, platform, binary: tvPath, app_bundle: appBundle, pid: failPid,
    cdp_port: cdpPort, cdp_ready: false, waited_seconds: READY_TIMEOUT_S,
    error: `TradingView ${failPid ? `(PID ${failPid}) ` : ''}spawned but CDP did not start listening on port ${cdpPort} within ${READY_TIMEOUT_S}s.`,
    hint: 'The app may still be signing in or restoring layouts. Wait ~30s and call tv_health_check. If it still fails, the binary may not support --remote-debugging-port (TV < v2.14) — check Activity Monitor and relaunch manually.',
  };
}
