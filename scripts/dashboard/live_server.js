// Live dashboard server — serves Dashboard.html over localhost and rebuilds on a smart schedule.
//
// Usage: node scripts/dashboard/live_server.js
//
// Schedule:
//   - Options chains: cached, refreshed every 15 minutes
//   - News (Yahoo RSS + Google News): refreshed every 2 minutes (part of rebuild)
//   - Everything else (brief, xlsx data): refreshed every 60 seconds
//
// Opens http://localhost:3333 in your browser.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { createSseBroadcaster } from '../../src/lib/sse_broadcaster.js';
import { getMarketMode } from '../../src/lib/market_hours.js';
import { readCandidates } from '../../src/lib/candidate_reader.js';
import { createFireLog } from '../../src/lib/fire_events.js';
import { createStateStore } from '../../src/lib/poller_state.js';
import { fetchQuotes as yahooFetch } from '../../src/lib/quote_sources/yahoo.js';
import { tvCdpFetchQuotes } from '../../src/lib/quote_sources/tv_cdp.js';
import { createQuoteChain } from '../../src/lib/quote_sources/chain.js';
import { createLivePoller } from '../scanner/live_price_poller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT != null ? parseInt(process.env.PORT, 10) : 3333;
const OUTPUT_HTML = 'C:/Users/lam61/OneDrive/Desktop/Queen Mommy/Trading/Dashboard.html';
const BUILD_SCRIPT = path.join(__dirname, 'build_dashboard_html.js');
const OPTIONS_CACHE = path.join(__dirname, 'options_cache.json');

const REBUILD_INTERVAL_MS = 60 * 1000;       // 60 seconds
const OPTIONS_MAX_AGE_MS = 15 * 60 * 1000;   // 15 minutes
const SCANNER_MAX_AGE_MS = 30 * 60 * 1000;   // 30 minutes
const SCANNER_SCRIPT = path.join(__dirname, '..', 'scanner', 'coiled_spring_scanner.js');
const SCANNER_RESULTS = path.join(__dirname, '..', 'scanner', 'coiled_spring_results.json');

const POLL_INTERVAL_MS = 15 * 1000;
const STATE_SNAPSHOT_INTERVAL_MS = 60 * 1000;
const FIRES_BASE_DIR = path.join(__dirname, '..', '..', 'data');
const POLLER_STATE_PATH = path.join(FIRES_BASE_DIR, 'poller_state.json');

// Shadow mode flag — when SHADOW_MODE=1, fire events still broadcast and persist
// but Task 16 will use this to suppress Windows toasts on the dashboard side.
const SHADOW_MODE = process.env.SHADOW_MODE === '1';

// ─── Helpers ───

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

/** Check if options_cache.json exists and is younger than OPTIONS_MAX_AGE_MS */
function isOptionsCacheFresh() {
  try {
    const stat = fs.statSync(OPTIONS_CACHE);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < OPTIONS_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** Check if coiled_spring_results.json exists and is younger than SCANNER_MAX_AGE_MS */
function isScannerFresh() {
  try {
    const stat = fs.statSync(SCANNER_RESULTS);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < SCANNER_MAX_AGE_MS;
  } catch {
    return false;
  }
}

let scanning = false;

/** Run the coiled spring scanner in the background */
function runScanner() {
  if (scanning) {
    log('scanner already running, skipping');
    return;
  }
  scanning = true;
  log('🌀 scanner: starting coiled spring scan...');
  const startTime = Date.now();

  execFile('node', [SCANNER_SCRIPT, '--top=15'], { cwd: path.dirname(SCANNER_SCRIPT), maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
    scanning = false;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (err) {
      log(`🌀 scanner: FAILED (${elapsed}s): ${err.message}`);
      return;
    }
    // Extract the results summary line
    const resultsLine = stdout.split('\n').find(l => l.includes('Universe:')) || '';
    log(`🌀 scanner: done (${elapsed}s) ${resultsLine.trim()}`);
  });
}

// ─── Build logic ───

let building = false;
let buildCount = 0;

// SSE subscribers registry — Task 12 will pump events into this.
const sse = createSseBroadcaster();

function rebuild() {
  if (building) {
    log('build already in progress, skipping');
    return;
  }
  building = true;
  buildCount++;
  const buildNum = buildCount;

  const skipOptions = isOptionsCacheFresh();
  const env = { ...process.env };
  if (skipOptions) {
    env.SKIP_OPTIONS = '1';
    log(`#${buildNum} rebuilding (options cached, skipping fetch)...`);
  } else {
    log(`#${buildNum} rebuilding (fetching fresh options)...`);
  }

  const startTime = Date.now();

  // Spawn the build script as a child process
  const child = execFile('node', [BUILD_SCRIPT], { env, cwd: __dirname, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
    building = false;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (err) {
      log(`#${buildNum} FAILED (${elapsed}s): ${err.message}`);
      if (stderr) console.error(stderr);
      return;
    }
    log(`#${buildNum} done (${elapsed}s)`);
    if (stdout.trim()) {
      // Indent build output
      for (const line of stdout.trim().split('\n')) {
        console.log(`  | ${line}`);
      }
    }
  });
}

// ─── HTTP server ───

function serveHtml(req, res) {
  if (req.url === '/events') {
    sse.handleClient(req, res);
    return;
  }
  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  let html;
  try {
    html = fs.readFileSync(OUTPUT_HTML, 'utf-8');
  } catch (e) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Dashboard not built yet. Waiting for first build...');
    return;
  }

  // Replace the 900s meta refresh with 60s for live serving
  html = html.replace(
    /<meta\s+http-equiv="refresh"\s+content="\d+"\s*\/?>/i,
    '<meta http-equiv="refresh" content="60">'
  );

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ─── Quote chain ──────────────────────────────────────────────────────────
const yahooSource = {
  name: 'yahoo',
  async fetch(symbols) {
    return await yahooFetch(symbols);
  },
};

// TV CDP dataCore is loaded lazily so the live server doesn't require
// TradingView Desktop to be running just to boot up.
let dataCoreCache = null;
async function getDataCore() {
  if (!dataCoreCache) {
    try {
      const mod = await import('../../src/core/data.js');
      // src/core/data.js exports a `data` object or similar — fall back to a no-op
      // if the export shape doesn't match our expectation.
      dataCoreCache = mod.data || mod.default || { async getQuote() { return null; } };
    } catch {
      dataCoreCache = { async getQuote() { return null; } };
    }
  }
  return dataCoreCache;
}

const tvCdpSource = {
  name: 'tv_cdp',
  async fetch(symbols) {
    const dc = await getDataCore();
    return await tvCdpFetchQuotes(symbols, { dataCore: dc });
  },
};

const quoteChain = createQuoteChain({
  sources: [yahooSource, tvCdpSource],
  flipAfterFailures: 5,
});

// ─── Fire log + state store ───────────────────────────────────────────────
const fireLog = createFireLog({ baseDir: FIRES_BASE_DIR });
const stateStore = createStateStore({ filePath: POLLER_STATE_PATH });

// ─── Live poller ──────────────────────────────────────────────────────────
const livePoller = createLivePoller({
  getCandidates: () => readCandidates(SCANNER_RESULTS),
  chain: quoteChain,
  // When MARKET_OPEN_OVERRIDE=1 (test-only), Yahoo returns the last regular-session
  // close timestamp, so quoteAgeMs would be hours/days and the stale guard would
  // suppress every fire. Bump the stale threshold to effectively infinite for tests.
  detectorOptions: process.env.MARKET_OPEN_OVERRIDE === '1'
    ? { staleQuoteMaxAgeMs: Number.MAX_SAFE_INTEGER }
    : undefined,
  isMarketOpen: () => {
    // Test-only override: lets tests force the poller to run regardless of clock.
    if (process.env.MARKET_OPEN_OVERRIDE === '1') return true;
    const m = getMarketMode();
    return m.mode === 'REGULAR' || m.mode === 'PRE_WARM' || m.mode === 'CLOSE_CAPTURE';
  },
  getMarketContext: () => ({}),
  onFire: (event) => {
    const stored = fireLog.recordFire(event);
    sse.broadcast('fire', stored);
    const mode = getMarketMode().mode;
    const suppressedReason = SHADOW_MODE ? 'shadow' : (mode === 'PRE_WARM' ? 'pre_warm' : null);
    log(`🎯 FIRE ${event.ticker} L${event.fireStrength} @ ${event.price.firedPrice} (trigger ${event.trigger.level}) band=${event.riskFlags.overallRiskBand}${suppressedReason ? ' [suppressed: ' + suppressedReason + ']' : ''}`);
  },
  onTick: (snapshot) => {
    sse.broadcast('tick', snapshot);
  },
  onError: (err) => {
    sse.broadcast('source_status', {
      status: 'degraded',
      ...err,
      activeSource: quoteChain.activeSourceName(),
    });
  },
});

// Restore state on startup — single read (avoid double file-read race)
(function restoreOnBoot() {
  const persisted = stateStore.read();
  if (stateStore.isFresh() && persisted.tickers) {
    livePoller.detector.restoreState(persisted.tickers);
    log(`[poller] restored state for ${Object.keys(persisted.tickers).length} tickers`);
  } else {
    log('[poller] no fresh state to restore — starting cold');
  }
})();

const server = http.createServer(serveHtml);

server.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(56));
  console.log(`  Dashboard live server`);
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log(`  Rebuild:  every ${REBUILD_INTERVAL_MS / 1000}s (quotes, news, yields, indices)`);
  console.log(`  Options:  cached, refreshed every ${OPTIONS_MAX_AGE_MS / 60000} min`);
  console.log(`  Scanner:  coiled spring scan every ${SCANNER_MAX_AGE_MS / 60000} min`);
  console.log(`  News:     refreshed every rebuild`);
  console.log(`  SSE:      /events endpoint ready (0 subscribers)`);
  console.log(`  Poller:   every ${POLL_INTERVAL_MS / 1000}s during market hours`);
  console.log(`  State:    snapshot every ${STATE_SNAPSHOT_INTERVAL_MS / 1000}s → ${POLLER_STATE_PATH}`);
  console.log(`  Fires:    audit log → ${FIRES_BASE_DIR}`);
  console.log(`  Shadow:   ${SHADOW_MODE ? 'ON (toasts will be suppressed by Task 16)' : 'OFF'}`);
  console.log(`  Output:   ${OUTPUT_HTML}`);
  console.log('='.repeat(56));
  console.log('');

  // Run scanner immediately if stale, then first build
  if (!isScannerFresh()) {
    runScanner();
  }
  rebuild();

  // Schedule recurring rebuilds + scanner checks
  setInterval(() => {
    if (!isScannerFresh()) {
      runScanner();
    }
    rebuild();
  }, REBUILD_INTERVAL_MS);

  // Live price polling — fires SSE events to subscribed dashboards
  setInterval(async () => {
    try {
      const res = await livePoller.tick();
      if (res.polled) {
        sse.broadcast('scan_refreshed', {
          lastPoll: new Date().toISOString(),
          activeSource: quoteChain.activeSourceName(),
          pollSequence: res.pollSequence,
        });
      }
    } catch (err) {
      log(`[poller] tick error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  // Periodic state snapshot for crash recovery
  setInterval(() => {
    stateStore.write({
      asOf: new Date().toISOString(),
      tickers: livePoller.detector.snapshot(),
      circuitBreaker: { status: 'closed', consecutiveFailures: 0, openedAt: null },
    });
  }, STATE_SNAPSHOT_INTERVAL_MS);

  // Reset daily fire counters on PRE_WARM transition each trading day
  let prevMarketMode = null;
  setInterval(() => {
    const m = getMarketMode().mode;
    if (m === 'PRE_WARM' && prevMarketMode !== 'PRE_WARM') {
      livePoller.detector.resetDailyCounters();
      log('[poller] daily fire counters reset (PRE_WARM transition)');
    }
    prevMarketMode = m;
  }, 60_000);
});
