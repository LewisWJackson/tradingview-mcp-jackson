/**
 * pw-verify.mjs — logged-in smoke test: click through every dashboard tab and report
 * any JS console errors + screenshot each. This is the verification that gate-only checks
 * could never do — it exercises the authenticated Portfolio/Markets/Lab/Signals panels.
 *
 * Prereq: run `node scripts/pw-auth.mjs` first to mint .playwright-auth.json.
 * Env: BASE (default http://localhost:3000), HEADED=1 to watch, SHOT=1 to save screenshots.
 *
 * Run: node scripts/pw-verify.mjs
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://localhost:3000';
const STATE = join(ROOT, '.playwright-auth.json');
const SHOTDIR = join(ROOT, '.playwright-auth');

// tab id -> switchTab() name (internal names; momentum = Signals tab)
const TABS = [
  ['screener', 'Screener'], ['momentum', 'Signals'], ['markets', 'Markets'],
  ['positions', 'Portfolio'], ['lab', 'Lab'], ['goals', 'Goals'],
  ['criteria', 'Alerts'], ['universe', 'Settings'],
];
// console errors we ignore (pre-existing, unrelated to app JS)
const IGNORE = [/favicon\.ico/, /\/api\/events/];

async function main() {
  if (!existsSync(STATE)) { console.error(`✗ No ${STATE}. Run: node scripts/pw-auth.mjs`); process.exit(1); }
  if (process.env.SHOT) mkdirSync(SHOTDIR, { recursive: true });
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const url = (m.location && m.location().url) || '';
    const blob = m.text() + ' ' + url;
    if (IGNORE.some(re => re.test(blob))) return;   // pre-existing (favicon, SSE /api/events 401)
    errors.push({ tab: cur, text: m.text() });
  });
  page.on('pageerror', e => errors.push({ tab: cur, text: 'PAGEERROR: ' + e.message }));

  let cur = 'load';
  // Not 'networkidle' — the SSE /api/events stream stays open, so the network
  // never goes idle and the wait would time out. Use domcontentloaded + a settle.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // confirm we're past the gate (avatar present, gate hidden)
  const loggedIn = await page.evaluate(() => !!document.querySelector('#user-avatar-btn') || !document.querySelector('#mwj-submit-btn')?.offsetParent);
  console.log(`auth gate passed: ${loggedIn ? 'YES' : 'NO (still on login)'}`);

  const results = [];
  for (const [id, label] of TABS) {
    cur = label;
    const before = errors.length;
    // click the REAL nav button (passes `this` to switchTab) — only some buttons have ids
    let ok = true;
    try { await page.click(`button.tab[onclick^="switchTab('${id}'"]`, { timeout: 4000 }); }
    catch (e) { ok = 'CLICK-FAIL: ' + e.message.split('\n')[0]; }
    await page.waitForTimeout(1200);
    if (process.env.SHOT) await page.screenshot({ path: join(SHOTDIR, `tab-${id}.png`) }).catch(() => {});
    const newErr = errors.length - before;
    results.push({ label, switched: ok === true ? 'ok' : ok, errors: newErr });
    console.log(`  ${label.padEnd(10)} switch:${ok === true ? 'ok ' : ok} console-errors:${newErr}`);
  }

  await browser.close();
  console.log(`\n${errors.length ? '✗ ' + errors.length + ' app console error(s):' : '✓ no app console errors across all ' + TABS.length + ' tabs'}`);
  for (const e of errors) console.log(`   [${e.tab}] ${e.text}`);
  process.exit(errors.length ? 1 : 0);
}
main();
