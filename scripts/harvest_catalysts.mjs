/**
 * harvest_catalysts.mjs — harvester for the official Tadawul issuer-announcements feed.
 * Ingests via catalysts.mjs (idempotent dedup).
 *
 * HOW IT WORKS (rewritten 2026-06-21): the page renders announcements from a JSON endpoint
 * (`…NJgetAnnouncementListData=/`) via POST {datePeriod, pageNumberDb, pageSize}. We load the
 * page once HEADED (Akamai blocks headless at page load), then call that JSON API in-page with
 * the site's own jQuery — same-origin, uses the portal session, so NO captcha and NO DOM
 * scraping. `datePeriod='5 year'` returns the full ~5-year history (≈31k events) paged by
 * pageNumberDb. The AJAX url is extracted from the live getAnnouncementList function at runtime,
 * so a portal namespace change won't silently break it.
 *
 * Usage (HEADED — needs a display; needs --experimental-sqlite). Runs unattended (no captcha,
 * no Enter), so a background task is fine:
 *   HEADLESS=false node --experimental-sqlite scripts/harvest_catalysts.mjs               # full 5-year history
 *   HEADLESS=false node --experimental-sqlite scripts/harvest_catalysts.mjs --period "1 year"
 *   HEADLESS=false node --experimental-sqlite scripts/harvest_catalysts.mjs --period "1 month"   # daily top-up
 *   ENV: HEADLESS=false (default true → Akamai "Access Denied"); always pass HEADLESS=false here.
 *
 * After a harvest, re-run a study:  node --experimental-sqlite scripts/contract_flow_test.mjs
 *
 * Valid --period presets (the site's own): "1 day", "1 week", "1 month", "1 year", "5 year".
 * Requires: playwright (devDependencies).
 */
import { chromium } from 'playwright';
import { ingestCatalysts, catalystsSummary } from '../dashboard/catalysts.mjs';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
const PERIOD = arg('--period') || '5 year';        // site preset: "1 day"|"1 week"|"1 month"|"1 year"|"5 year"
const PAGE_SIZE = +(arg('--page-size') || 2000);   // rows per API call
const MAX_PAGES = +(arg('--max-pages') || 40);     // safety cap on API calls
const HEADLESS = process.env.HEADLESS !== 'false';
const URL = 'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news/issuer-announcements?locale=en';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const isDenied = (page) => page.evaluate(() => /access denied/i.test(document.body.innerText) && document.body.innerText.length < 600);

function denied() {
  console.error('\n  Akamai "Access Denied" — Tadawul blocked this browser.');
  console.error('  Run HEADED on a real desktop:  HEADLESS=false node --experimental-sqlite scripts/harvest_catalysts.mjs\n');
}

// Read the live getAnnouncementList function and pull the JSON endpoint url out of its source.
// Robust to portal namespace changes (the url is data-driven, not hard-coded here).
async function discoverAjaxUrl(page) {
  return page.evaluate(() => {
    const key = Object.keys(window).find(k => /getAnnouncementList$/.test(k) && typeof window[k] === 'function');
    if (!key) return null;
    const src = window[key].toString();
    const m = src.match(/url:\s*['"]([^'"]*getAnnouncementListData[^'"]*)['"]/);
    return m ? m[1] : null;
  });
}

// Fetch one page of announcements via the site's own jQuery $.ajax (same-origin, session-backed).
function fetchPage(page, ajaxUrl, pageNum) {
  return page.evaluate(async ({ ajaxUrl, pageNum, PERIOD, PAGE_SIZE }) => {
    const form = {
      annoucmentType: '1_-1', symbol: '', sectorDpId: '', searchType: '',
      fromDate: '', toDate: '', datePeriod: PERIOD, productType: '', advisorsList: '',
      textSearch: '', pageNumberDb: String(pageNum), pageSize: String(PAGE_SIZE),
    };
    const data = await new Promise((resolve, reject) => {
      window.$.ajax({ url: ajaxUrl, type: 'POST', data: form, success: resolve, error: (x, s, e) => reject(s + ' ' + e) });
    });
    const j = typeof data === 'string' ? JSON.parse(data) : data;
    const list = j.announcementList || [];
    return {
      totalCount: j.totalCount,
      rows: list.map(o => ({
        code: String(o.SYMBOL || o.indexSymbol || ''),
        date: (o.newsDateStr || '').split(' ')[0],   // "DD/MM/YYYY HH:MM:SS" → "DD/MM/YYYY"
        headline: String(o.SHORT_DESC || o.TITLE || '').slice(0, 240),
      })),
    };
  }, { ajaxUrl, pageNum, PERIOD, PAGE_SIZE });
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (await isDenied(page)) { denied(); await browser.close(); process.exit(1); }
  await page.waitForTimeout(8000);   // let the portal scripts (jQuery, the list fn) initialize

  const ajaxUrl = await discoverAjaxUrl(page);
  if (!ajaxUrl) {
    console.error('Could not locate the announcements JSON endpoint (page layout may have changed).');
    await browser.close(); process.exit(1);
  }
  console.error(`endpoint: ${ajaxUrl}\nperiod: "${PERIOD}", pageSize ${PAGE_SIZE}`);

  const all = [], seen = new Set();
  for (let pg = 0; pg < MAX_PAGES; pg++) {
    let res;
    try { res = await fetchPage(page, ajaxUrl, pg); }
    catch (e) { console.error(`page ${pg} error: ${e}`); break; }
    if (!res.rows.length) { console.error(`page ${pg}: empty — done`); break; }
    let added = 0;
    for (const r of res.rows) {
      const k = r.code + '|' + r.date + '|' + r.headline.slice(0, 30);
      if (r.code && r.date && r.headline && !seen.has(k)) { seen.add(k); all.push(r); added++; }
    }
    const oldest = res.rows.map(r => r.date).filter(Boolean).pop();
    console.error(`page ${pg}: ${res.rows.length} rows, +${added} uniq (total ${all.length}/${res.totalCount ?? '?'}) oldest ${oldest}`);
    if (res.rows.length < PAGE_SIZE) { console.error('last page'); break; }
  }
  await browser.close();

  const r = ingestCatalysts(all, 'tadawul');
  console.log('harvest+ingest:', JSON.stringify(r));
  console.log('db summary:', JSON.stringify(catalystsSummary()));
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
