/**
 * Live-feed E2E test (Task 18).
 *
 * Spawns the real `scripts/dashboard/live_server.js` with SHADOW_MODE=1 and
 * MARKET_OPEN_OVERRIDE=1, subscribes to its `/events` SSE stream, injects a
 * synthetic fire by lowering one candidate's `entry_trigger` in
 * `scripts/scanner/coiled_spring_results.json`, and verifies:
 *
 *   1) a `fire` SSE event is emitted within ~60 s
 *   2) the event payload conforms to the strict tradePlan schema
 *   3) the fire was persisted to `data/coiled_spring_fires_YYYY-MM-DD.json`
 *
 * The test ALWAYS restores the original scanner JSON in a `try/finally`.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.resolve(__dirname, '..', 'scripts', 'dashboard', 'live_server.js');
const SCANNER_RESULTS = path.resolve(__dirname, '..', 'scripts', 'scanner', 'coiled_spring_results.json');
const FIRES_DIR = path.resolve(__dirname, '..', 'data');

// 90s test timeout: server boot + first scanner build + 3-4 poll cycles + cleanup
const TEST_TIMEOUT_MS = 90_000;

/**
 * Subscribe to an SSE stream at /events on the given port.
 * Returns { events, close } where `events` is a live array of {event, data} objects
 * and `close` aborts the connection.
 */
function subscribeSse(port) {
  const events = [];
  let buffer = '';
  let currentEvent = null;

  const req = http.get({
    hostname: 'localhost',
    port,
    path: '/events',
    headers: { Accept: 'text/event-stream' },
  }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:') && currentEvent) {
          try {
            events.push({ event: currentEvent, data: JSON.parse(line.slice(5).trim()) });
          } catch (e) {
            events.push({ event: currentEvent, data: line.slice(5).trim(), parseError: e.message });
          }
        } else if (line === '') {
          currentEvent = null;
        }
      }
    });
  });
  req.on('error', () => {});

  return {
    events,
    close: () => req.destroy(),
  };
}

/** Compute YYYY-MM-DD in America/New_York for the fire-log filename. */
function todayInET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (name) => parts.find((p) => p.type === name)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

test('live-feed E2E: synthetic fire flows from poller through SSE to fire log', { timeout: TEST_TIMEOUT_MS }, async () => {
  // Soft-skip if the scanner output is missing — env without prereqs
  if (!fs.existsSync(SCANNER_RESULTS)) {
    console.warn('SKIP: coiled_spring_results.json not present; cannot run E2E');
    return;
  }
  const originalScannerJson = fs.readFileSync(SCANNER_RESULTS, 'utf8');
  const parsed = JSON.parse(originalScannerJson);
  const allCandidates = parsed.results || parsed.top_15 || parsed.top || [];
  const candidate = allCandidates.find((c) => /alert\s+at\s+[\d.]+/i.test(c.entry_trigger || ''));
  if (!candidate) {
    console.warn('SKIP: no candidate has an actionable alert trigger');
    return;
  }

  const candidateSym = candidate.symbol;
  const PORT = '3401'; // ephemeral, hopefully not in use
  const serverEnv = {
    ...process.env,
    PORT,
    SHADOW_MODE: '1',           // suppress Windows toasts
    MARKET_OPEN_OVERRIDE: '1',  // force the poller to run regardless of clock
  };

  let child = null;
  let sseClient = null;

  try {
    // Spawn the server
    child = spawn('node', [SERVER], {
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverStdout = '';
    let serverStderr = '';
    child.stdout.on('data', (d) => { serverStdout += d.toString(); });
    child.stderr.on('data', (d) => { serverStderr += d.toString(); });

    // Wait until the server prints the SSE-ready banner (indicates listen() resolved)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server boot timed out\nSTDOUT:\n' + serverStdout + '\nSTDERR:\n' + serverStderr)), 20_000);
      const interval = setInterval(() => {
        if (serverStdout.includes('SSE:')) {
          clearTimeout(timeout); clearInterval(interval); resolve();
        }
      }, 200);
    });

    // Subscribe to SSE
    sseClient = subscribeSse(PORT);
    await sleep(500); // give the connection time to establish

    // INJECT SYNTHETIC FIRE: lower the candidate's trigger far below current price
    // so the poller's next cycle classifies it as PENDING then FIRED.
    const spiked = JSON.parse(originalScannerJson);
    const spikedCandidates = spiked.results || spiked.top_15 || spiked.top || [];
    const spikedCandidate = spikedCandidates.find((c) => c.symbol === candidateSym);
    const currentPrice = spikedCandidate.price || 100;
    const newTrigger = +(currentPrice * 0.99).toFixed(2);
    spikedCandidate.entry_trigger = `synthetic — alert at ${newTrigger}`;
    fs.writeFileSync(SCANNER_RESULTS, JSON.stringify(spiked, null, 2));

    // Poll for fire event in SSE stream (up to 60s)
    const fireDeadline = Date.now() + 60_000;
    let fireEvent = null;
    while (Date.now() < fireDeadline && !fireEvent) {
      fireEvent = sseClient.events.find((e) => e.event === 'fire' && e.data && e.data.ticker === candidateSym);
      if (!fireEvent) await sleep(1000);
    }

    assert.ok(
      fireEvent,
      `expected a fire event for ${candidateSym} within 60s. Got events: ${sseClient.events.map((e) => e.event + ':' + ((e.data && e.data.ticker) || '')).join(', ')}\nServer stderr:\n${serverStderr}`,
    );

    // Validate the fire event payload schema
    const f = fireEvent.data;
    assert.strictEqual(f.ticker, candidateSym, 'ticker matches');
    assert.ok(f.price && typeof f.price.firedPrice === 'number', 'fire event has numeric firedPrice');
    assert.ok([2, 3].includes(f.fireStrength), `fireStrength is 2 or 3 (got ${f.fireStrength})`);
    assert.ok(f.riskFlags && f.riskFlags.overallRiskBand, 'fire event has riskFlags.overallRiskBand');
    assert.ok(f.audit && typeof f.audit.activeSource === 'string', 'fire event has audit.activeSource');
    // Verify the strict tradePlan schema
    assert.ok(f.tradePlan, 'tradePlan present');
    assert.ok(f.tradePlan.stock && typeof f.tradePlan.stock === 'object', 'tradePlan.stock always an object');
    assert.ok(f.tradePlan.options && typeof f.tradePlan.options === 'object', 'tradePlan.options always an object');
    assert.strictEqual(f.tradePlan.stock.decision, null, 'stock.decision null until logic lands');
    assert.strictEqual(f.tradePlan.options.decision, null, 'options.decision null until logic lands');
    assert.strictEqual(f.tradePlan.finalDecision, null, 'finalDecision null until logic lands');
    assert.strictEqual(typeof f.tradePlan.planReason, 'string', 'planReason populated');

    // Verify the fire was persisted to the daily audit log
    const dateStr = todayInET();
    const firePath = path.join(FIRES_DIR, `coiled_spring_fires_${dateStr}.json`);
    assert.ok(fs.existsSync(firePath), `fire log not written at ${firePath}`);
    const firePersisted = JSON.parse(fs.readFileSync(firePath, 'utf8'));
    const persistedFire = firePersisted.fires.find((x) => x.ticker === candidateSym);
    assert.ok(persistedFire, 'persisted fire entry for synthetic ticker');
    assert.strictEqual(persistedFire.tradePlan.stock.decision, null, 'persisted fire has new strict schema');
  } finally {
    // Restore the original scanner output FIRST — must not be left mutated even on crash
    try {
      fs.writeFileSync(SCANNER_RESULTS, originalScannerJson);
    } catch (restoreErr) {
      console.error('CRITICAL: failed to restore scanner JSON:', restoreErr);
    }
    if (sseClient) sseClient.close();
    if (child) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const fallback = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 5000);
        child.on('exit', () => { clearTimeout(fallback); resolve(); });
      });
    }
  }
});
