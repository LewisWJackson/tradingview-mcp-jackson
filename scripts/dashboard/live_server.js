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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3333;
const OUTPUT_HTML = 'C:/Users/lam61/OneDrive/Desktop/Queen Mommy/Trading/Dashboard.html';
const BUILD_SCRIPT = path.join(__dirname, 'build_dashboard_html.js');
const OPTIONS_CACHE = path.join(__dirname, 'options_cache.json');

const REBUILD_INTERVAL_MS = 60 * 1000;       // 60 seconds
const OPTIONS_MAX_AGE_MS = 15 * 60 * 1000;   // 15 minutes
const SCANNER_MAX_AGE_MS = 30 * 60 * 1000;   // 30 minutes
const SCANNER_SCRIPT = path.join(__dirname, '..', 'scanner', 'coiled_spring_scanner.js');
const SCANNER_RESULTS = path.join(__dirname, '..', 'scanner', 'coiled_spring_results.json');

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
});
