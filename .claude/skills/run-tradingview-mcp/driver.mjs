#!/usr/bin/env node
/**
 * driver.mjs — agent harness for tradingview-mcp.
 *
 * This project has no UI of its own: it is a CDP client that drives a live
 * TradingView chart running in Chrome on port 9222. So "running the app"
 * means (a) a Chrome tab on tradingview.com/chart with CDP open, and
 * (b) this repo's code talking to it.
 *
 * This driver wraps the parts that are fiddly to get right by hand:
 *   - verifying the chart target is actually alive AND has resolved data
 *     (the CLI happily reports success against a dead/stale series)
 *   - dismissing the anonymous-session signup modal that covers the chart
 *   - switching symbols in a way that actually works when logged out
 *   - adding a study and making its values readable
 *   - one-shot MCP tool calls over stdio without hanging on an open pipe
 *
 * Usage:  node .claude/skills/run-tradingview-mcp/driver.mjs <cmd> [args]
 * Run with no args for the command list.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import CDP from 'chrome-remote-interface';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');   // <repo>/.claude/skills/run-… → <repo>
const PORT = 9222;
const SHOTS = join(ROOT, 'screenshots');

const log = (...a) => console.log(...a);
const die = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- connection

async function findChartTarget() {
  let targets;
  try {
    targets = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  } catch {
    die(`no CDP on port ${PORT}. Start it:\n` +
        `  powershell -ExecutionPolicy Bypass -File start-tradingview-cdp.ps1`);
  }
  const t = targets.find(x => x.type === 'page' && /tradingview\.com\/chart/i.test(x.url));
  if (!t) {
    die('CDP is up but no tradingview.com/chart tab exists.\n' +
        '  Open one:  curl -s -X PUT "http://localhost:9222/json/new?https://www.tradingview.com/chart/"');
  }
  return t;
}

async function withClient(fn) {
  const target = await findChartTarget();
  const client = await CDP({ host: 'localhost', port: PORT, target: target.id });
  try {
    await client.Runtime.enable();
    await client.Page.enable();
    return await fn(client, target);
  } finally {
    try { await client.close(); } catch {}
  }
}

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result?.value;
}

// -------------------------------------------------------- in-page expressions

/**
 * The single source of truth for "is this chart actually usable".
 *
 * chart.symbol() returns whatever was last *requested*, not what resolved —
 * so it lies after a failed symbol switch. mainSeries().symbolInfo() is the
 * honest signal: null means the symbol never loaded and the bars on screen
 * still belong to the previous symbol.
 */
const PROBE = `(() => {
  const out = { authed: !document.documentElement.classList.contains('is-not-authenticated') };
  try {
    const ch = window.TradingViewApi._activeChartWidgetWV.value();
    const ms = ch._chartWidget.model().mainSeries();
    out.requested = ch.symbol();
    out.resolution = ch.resolution();
    let si = null; try { si = ms.symbolInfo(); } catch {}
    out.resolved = si ? (si.full_name || si.name) : null;
    out.description = si ? si.description : null;
    out.status = ms.status ? ms.status() : null;
    out.bars = ms.bars().size();
    const last = ms.bars().last();
    out.last = last ? last.value[4] : null;
    out.panes = ch._chartWidget.model().model().panes().map(p => p.height());
  } catch (e) { out.error = String(e).slice(0, 200); }
  return out;
})()`;

/** Remove the anonymous "Look first / Then leap" modal + its scroll lock. */
const DISMISS = `(() => {
  const root = document.getElementById('overlap-manager-root');
  let removed = 0;
  if (root) {
    [...root.children].forEach(c => {
      if (c.querySelector('[data-dialog-name="gopro"]')) { c.remove(); removed++; }
    });
  }
  // "Press and hold to see detailed chart values" onboarding tooltip
  [...document.querySelectorAll('button')]
    .filter(b => /got it/i.test(b.textContent || ''))
    .forEach(b => { b.click(); removed++; });
  document.body.classList.remove('i-no-scroll');
  return { removed, stillOpen: !!document.querySelector('[data-dialog-name="gopro"]') };
})()`;

/**
 * Give every zero-height pane real height so its study reports values.
 *
 * Height must be REDISTRIBUTED, not added. setPaneHeight() does not shrink
 * its siblings: if the pane heights end up summing past the chart container,
 * the layout collapses — every <canvas> resets to its default 300x150 and the
 * chart renders blank while still reporting correct data. So we take the
 * space out of the main pane by hand and keep the total fixed.
 */
const FIX_PANES = `(() => {
  const ch = window.TradingViewApi._activeChartWidgetWV.value();
  const m = ch._chartWidget.model().model();
  const panes = m.panes();
  const before = panes.map(p => p.height());
  const total = before.reduce((a, b) => a + b, 0) || 1000;
  const empty = panes.filter((p, i) => i > 0 && p.height() === 0);
  let fixed = 0;
  if (empty.length) {
    const each = Math.round(total * 0.25 / empty.length);
    empty.forEach(p => { m.setPaneHeight(p, each); fixed++; });
    // reclaim the space from the main pane so the total is unchanged
    m.setPaneHeight(panes[0], Math.max(100, before[0] - each * empty.length));
  }
  const after = m.panes().map(p => p.height());
  return { fixed, before, after, total, newTotal: after.reduce((a, b) => a + b, 0) };
})()`;

const STUDY_VALUES = `(() => {
  const ch = window.TradingViewApi._activeChartWidgetWV.value();
  return ch._chartWidget.model().model().panes().flatMap(p =>
    p.dataSources().map(s => { try { return s.title ? s.title(true) : null; } catch { return null; } })
  ).filter(Boolean);
})()`;

// -------------------------------------------------------------------- commands

async function cmdCheck() {
  await withClient(async (client, target) => {
    const p = await evaluate(client, PROBE);
    log(JSON.stringify({ target_url: target.url, ...p }, null, 2));
    if (p.error) die('TradingViewApi not reachable: ' + p.error);
    if (!p.resolved) {
      die('chart target is alive but no symbol has resolved (status=' + p.status + ').\n' +
          '  The bars on screen are stale. Re-seat the symbol:\n' +
          '    node .claude/skills/run-tradingview-mcp/driver.mjs symbol NASDAQ:NVDA');
    }
    log(`\nOK — ${p.resolved} @ ${p.resolution} · ${p.bars} bars · last ${p.last}` +
        (p.authed ? '' : '  (anonymous session)'));
  });
}

async function cmdDismiss() {
  await withClient(async (client) => {
    const r = await evaluate(client, DISMISS);
    log(JSON.stringify(r));
    if (r.stillOpen) die('gopro modal survived removal');
  });
}

/**
 * Set the symbol by navigating the tab to ?symbol=…
 *
 * chart.setSymbol() / `tv symbol X` do NOT work on an anonymous session:
 * they return success, chart.symbol() starts echoing the new ticker, and the
 * series silently keeps the old symbol's bars forever (status 2, symbolInfo
 * null). A page navigation re-resolves the symbol properly.
 */
async function cmdSymbol(sym) {
  if (!sym) die('usage: driver.mjs symbol <EXCHANGE:TICKER>');
  await withClient(async (client) => {
    const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;
    await client.Page.navigate({ url });
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      let p;
      try { p = await evaluate(client, PROBE); } catch { continue; }
      if (p.resolved) {
        await evaluate(client, DISMISS);
        log(JSON.stringify({ resolved: p.resolved, description: p.description,
                             resolution: p.resolution, bars: p.bars, last: p.last }, null, 2));
        return;
      }
    }
    die(`symbol ${sym} never resolved after 60s`);
  });
}

async function cmdShot(label = 'shot') {
  await withClient(async (client) => {
    // Chrome does not paint canvases in a background tab: the chart renders
    // blank (every <canvas> stuck at its default 300x150) while every data
    // tool still returns correct values. Foreground the tab before capturing.
    try { await client.Page.bringToFront(); } catch {}
    let vis = 'hidden';
    for (let i = 0; i < 10 && vis !== 'visible'; i++) {
      await sleep(400);
      vis = await evaluate(client, 'document.visibilityState');
    }
    if (vis !== 'visible') {
      console.error(`WARN: tab is "${vis}" — chart canvas will be blank. ` +
                    'Un-minimize the Chrome window.');
    }
    await sleep(1500);   // let the canvas repaint at full size after foregrounding
    await evaluate(client, DISMISS);
    const p = await evaluate(client, PROBE);
    const { data } = await client.Page.captureScreenshot({ format: 'png' });
    mkdirSync(SHOTS, { recursive: true });
    const safe = String(p.resolved || 'unresolved').replace(/[^A-Za-z0-9]+/g, '_');
    const file = join(SHOTS, `${label}_${safe}_${p.resolution || 'x'}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    log(JSON.stringify({ file, symbol: p.resolved, resolution: p.resolution,
                         bytes: Buffer.from(data, 'base64').length }, null, 2));
  });
}

/**
 * Add a study, then repair the pane so its values are readable.
 *
 * Studies added this way are model-only: `tv values` will report them, but
 * they are NOT drawn on the canvas and never appear in the legend. Do not
 * expect to see them in a screenshot.
 */
async function cmdStudy(...nameParts) {
  const name = nameParts.join(' ');
  if (!name) die('usage: driver.mjs study "Relative Strength Index"');
  await withClient(async (client) => {
    const added = await evaluate(client, `(async () => {
      const ch = window.TradingViewApi._activeChartWidgetWV.value();
      const e = await ch.createStudy(${JSON.stringify(name)}, false, false);
      return { entity: e };
    })()`, true);
    await sleep(3000);
    const panes = await evaluate(client, FIX_PANES);
    await sleep(1500);
    const titles = await evaluate(client, STUDY_VALUES);
    log(JSON.stringify({ added, panes, studies: titles }, null, 2));
  });
}

async function cmdPanes() {
  await withClient(async (client) => log(JSON.stringify(await evaluate(client, FIX_PANES), null, 2)));
}

/**
 * One-shot MCP tool call over stdio.
 *
 * The server never exits on its own, so a naive `printf … | node src/server.js`
 * hangs forever waiting for EOF that the reader never sees. We resolve on the
 * matching response id and kill the child.
 */
async function cmdMcp(tool, argsJson = '{}') {
  if (!tool) die('usage: driver.mjs mcp <tool_name> [\'{"json":"args"}\']');
  let parsed;
  try { parsed = JSON.parse(argsJson); } catch { die('args must be valid JSON: ' + argsJson); }

  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')],
                      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
         params: { protocolVersion: '2024-11-05', capabilities: {},
                   clientInfo: { name: 'driver', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
         params: { name: tool, arguments: parsed } });

  const code = await new Promise((resolveP) => {
    let buf = '';
    const timer = setTimeout(() => { child.kill(); console.error('FAIL: MCP call timed out (60s)'); resolveP(1); }, 60000);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== 2) continue;
        clearTimeout(timer);
        if (m.error) { console.error(JSON.stringify(m.error, null, 2)); child.kill(); return resolveP(1); }
        log(m.result?.content?.[0]?.text ?? JSON.stringify(m.result, null, 2));
        child.kill();
        return resolveP(0);
      }
    });
    child.on('exit', () => { clearTimeout(timer); resolveP(0); });
  });
  process.exit(code);
}

/** Full end-to-end: connect → dismiss → switch symbol → study → screenshot. */
async function cmdSmoke(sym = 'NASDAQ:NVDA') {
  log('1/5 check');   await cmdCheck().catch(() => log('  (unresolved — symbol step will fix)'));
  log('2/5 dismiss'); await cmdDismiss();
  log('3/5 symbol');  await cmdSymbol(sym);
  log('4/5 study');   await cmdStudy('Relative Strength Index');
  log('5/5 shot');    await cmdShot('smoke');
  log('\nSMOKE OK');
}

// ------------------------------------------------------------------ dispatch

const [cmd, ...rest] = process.argv.slice(2);
const table = {
  check: cmdCheck, dismiss: cmdDismiss, symbol: cmdSymbol, shot: cmdShot,
  study: cmdStudy, panes: cmdPanes, mcp: cmdMcp, smoke: cmdSmoke,
};

if (!cmd || !table[cmd]) {
  log(`driver.mjs <cmd> [args]

  check              verify CDP + chart target + that a symbol actually resolved
  dismiss            remove the anonymous signup modal covering the chart
  symbol <SYM>       switch symbol via page navigation (the only way that works
                     logged out) and wait until it truly resolves
  study "<Name>"     add a study and repair its zero-height pane
  panes              repair zero-height panes (makes study values readable)
  shot [label]       screenshot to screenshots/<label>_<symbol>_<tf>.png
  mcp <tool> [json]  one-shot MCP tool call over stdio
  smoke [SYM]        full end-to-end run

Run from the repo root.`);
  process.exit(cmd ? 1 : 0);
}

table[cmd](...rest).catch(e => die(e.message));
