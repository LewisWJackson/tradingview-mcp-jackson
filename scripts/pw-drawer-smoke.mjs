/**
 * pw-drawer-smoke.mjs — open the stock drawer for a sample of scan rows and assert
 * it renders without throwing. Catches the class of bug that static checks miss:
 * the drawer's _oppCache ReferenceError (2026-06-22) aborted every drawer open and
 * was only visible at runtime. This is the regression guard for that.
 *
 * Covers every bias bucket (bull / bear / watch) because the 360 synthesis branches
 * on bias — a crash can hide in a single branch.
 *
 * Prereq: a running dashboard on BASE + `node scripts/pw-auth.mjs` for .playwright-auth.json.
 * Env: BASE (default http://localhost:3000), HEADED=1 to watch.
 *
 * Run: node scripts/pw-drawer-smoke.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://localhost:3000';
const STATE = join(ROOT, '.playwright-auth.json');
const IGNORE = [/favicon\.ico/, /\/api\/events/];   // pre-existing, unrelated to drawer JS
const PER_BIAS = 3;                                  // sample up to N rows per bias bucket
const MAX_ROWS = 18;                                 // overall cap for speed

async function main() {
  if (!existsSync(STATE)) { console.error(`✗ No ${STATE}. Run: node scripts/pw-auth.mjs`); process.exit(1); }
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  let cur = 'load';
  const consoleErrors = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const url = (m.location && m.location().url) || '';
    if (IGNORE.some(re => re.test(m.text() + ' ' + url))) return;
    consoleErrors.push({ sym: cur, text: m.text() });
  });
  page.on('pageerror', e => consoleErrors.push({ sym: cur, text: 'PAGEERROR: ' + e.message }));

  // Not 'networkidle' — the SSE /api/events stream stays open, so the network
  // never goes idle. Wait for the scan data to populate instead.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof scanData !== 'undefined' && scanData.length > 0,
    null, { timeout: 15000 }).catch(() => {});

  // Build a bias-balanced sample of symbols from the live scan.
  const sample = await page.evaluate(({ perBias, maxRows }) => {
    if (typeof scanData === 'undefined' || !scanData.length) return [];
    const buckets = {};
    for (const r of scanData) {
      const b = r.bias || 'UNKNOWN';
      (buckets[b] ||= []).push(r.sym);
    }
    const out = [];
    for (const b of Object.keys(buckets)) out.push(...buckets[b].slice(0, perBias));
    return out.slice(0, maxRows);
  }, { perBias: PER_BIAS, maxRows: MAX_ROWS });

  if (!sample.length) {
    console.error('✗ No scan rows on the page — run a scan first, then re-run this smoke test.');
    await browser.close();
    process.exit(1);
  }

  const failures = [];
  for (const sym of sample) {
    cur = sym;
    const before = consoleErrors.length;
    // Call the real openDrawer; report any synchronous throw.
    const thrown = await page.evaluate((s) => {
      try { openDrawer(scanData.find(x => x.sym === s) || { sym: s }); return null; }
      catch (e) { return e.message; }
    }, sym);
    await page.waitForTimeout(350);
    // Render assertion: the drawer header populated for this symbol.
    const rendered = await page.evaluate(() => {
      const t = document.getElementById('d-ticker')?.textContent || '';
      return t.trim().length > 0;
    });
    const newErr = consoleErrors.length - before;
    if (thrown) failures.push(`${sym}: threw "${thrown}"`);
    else if (!rendered) failures.push(`${sym}: drawer did not render (empty #d-ticker)`);
    else if (newErr) failures.push(`${sym}: ${newErr} console error(s)`);
    console.log(`  ${sym.padEnd(16)} ${thrown ? '✗ throw' : rendered ? (newErr ? '⚠ console-err' : 'ok') : '✗ no-render'}`);
  }

  await browser.close();
  if (failures.length || consoleErrors.length) {
    console.log(`\n✗ drawer smoke FAILED (${sample.length} rows tested):`);
    for (const f of failures) console.log(`   ${f}`);
    for (const e of consoleErrors) console.log(`   [${e.sym}] ${e.text}`);
    process.exit(1);
  }
  console.log(`\n✓ drawer opened cleanly for all ${sample.length} sampled rows (no throw, rendered, 0 console errors)`);
  process.exit(0);
}
main();
