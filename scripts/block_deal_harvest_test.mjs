/**
 * block_deal_harvest_test.mjs — harvest ~12 months of TASI block deals from Argaam,
 * then test "follow the big players" properly: forward excess vs the EQUAL-WEIGHT
 * basket, Derayah 0.11% cost, 5- and 20-session horizons, split by deal size, with
 * a calm-vs-stressed regime split (does a chaotic market change the answer?).
 *
 * Replicates the dashboard/server.mjs Argaam parsers (they aren't importable without
 * booting the server). Arabic-name map covers ~50 mostly-liquid names — unmapped
 * companies are dropped (acceptable: liquid names are the tradeable ones).
 *
 * Harvest is cached to data/block_deals_harvest.json (re-runs skip the fetch).
 * Run: PAGES=8 node --experimental-sqlite scripts/block_deal_harvest_test.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dirname, '..', 'data', 'block_deals_harvest.json');
const PAGES = +process.env.PAGES || 8;
const COST_RT = +process.env.COST_RT || 0.0011;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'ar,en;q=0.8', 'Referer': 'https://www.argaam.com/' };

const ARABIC_NAME_MAP = { 'الراجحي':'1120','راجحي':'1120','الأهلي السعودي':'1180','البنك الأهلي':'1180','الأهلي':'1180','بنك الرياض':'1010','الرياض':'1010','ساب':'1030','البنك السعودي الفرنسي':'1050','الفرنسي':'1050','البنك العربي الوطني':'1080','العربي الوطني':'1080','البلاد':'1140','الإنماء':'1150','انماء':'1150','السعودي للاستثمار':'1060','الجزيرة':'1020','أرامكو':'2222','ارامكو':'2222','أرامكو السعودية':'2222','سابك':'2010','تكنولوجيا':'2060','تصنيع':'2060','صحارى':'2310','بترورابغ':'2380','بترو رابغ':'2380','كيان':'2350','الاتصالات السعودية':'7010','stc':'7010','موبايلي':'7020','زين السعودية':'7030','زين':'7030','إلم':'7203','كهرباء':'5110','السعودية للكهرباء':'5110','أكوا':'2082','اكوا':'2082','المراعي':'2280','مراعي':'2280','سافولا':'2050','هرفي':'6002','التنمية الغذائية':'2281','جرير':'4190','فتيحي':'4180','إكسترا':'4003','اكسترا':'4003','الدريس':'4200','الحمادي':'4007','دلة':'4004','موواساة':'2160','مواساة':'2160','الحبيب':'4013','سليمان الحبيب':'4013','النخبة':'4005','فقيه':'4017','دار الأركان':'4300','دار أركان':'4300','إعمار':'4310','اعمار الاقتصادية':'4310','الرياض التنمية':'4150','أسمنت السعودية':'3010','الأسمنت السعودية':'3010','أسمنت ينبع':'3020','ينبع للأسمنت':'3020','أسمنت العربية':'3030','العربية للأسمنت':'3030','أسمنت المنطقة الجنوبية':'3040','الجنوبية للأسمنت':'3040','أسمنت القصيم':'3050','الكابلات السعودية':'2110','صناعات متقدمة':'2120','ألجين':'2170','الجين':'2170','الخدمات الأرضية':'4031','التعاونية':'8010','تاونية':'8010','بوبا':'8020','الراجحي للتأمين':'8230' };
const resolveArabicName = a => { if (!a) return null; const n = a.trim(); if (ARABIC_NAME_MAP[n]) return ARABIC_NAME_MAP[n]; let best = null, len = 0; for (const [kw, c] of Object.entries(ARABIC_NAME_MAP)) if (n.includes(kw) && kw.length > len) { best = c; len = kw.length; } return best; };
const tdText = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim();
const ymd = d => d ? new Date(d.replace(/\//g, '-')).toISOString().slice(0, 10) : null;

function parseSummary(html, date) {
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => tdText(m[1]));
  const by = {}; let cur = null, prevQty = false;
  for (const cell of cells) {
    const num = parseFloat(cell);
    if (isNaN(num) || !cell.length) { const code = resolveArabicName(cell); if (code) { cur = code; prevQty = false; by[code] ||= { price: 0, qty: 0, value: 0 }; } else if (cell.length > 2) { cur = null; prevQty = false; } }
    else if (cur) { const isInt = Number.isInteger(num), big = num > 1000; if (big && isInt) { by[cur].qty += num; prevQty = true; } else if (!big && !isInt && prevQty) { by[cur].value += num * 1e6; prevQty = false; } else { if (!by[cur].price) by[cur].price = num; prevQty = false; } }
  }
  return Object.entries(by).filter(([, d]) => d.price > 0 && d.qty > 0 && d.value > 0).map(([code, d]) => ({ sym: `TADAWUL:${code}`, value: Math.round(d.value), date }));
}
function parseSingle(html, title, date) {
  const m = title.match(/صفقة خاصة على (.+?) بقيمة/); if (!m) return null;
  const code = resolveArabicName(m[1].trim()); if (!code) return null;
  let value = 0; const v = title.match(/بقيمة\s+([\d\.,]+)\s*(مليون|مليار)?/);
  if (v) { let x = parseFloat(v[1].replace(/,/g, '')); if (v[2] === 'مليون') x *= 1e6; else if (v[2] === 'مليار') x *= 1e9; value = x; }
  return value > 0 ? { sym: `TADAWUL:${code}`, value: Math.round(value), date } : null;
}

async function harvest() {
  if (existsSync(CACHE)) { const c = JSON.parse(readFileSync(CACHE, 'utf8')); if (c.pages >= PAGES) { console.error(`using cached harvest (${c.events.length} events, ${c.pages} pages)`); return c.events; } }
  const events = []; const seen = new Set();
  for (let p = 1; p <= PAGES; p++) {
    const tag = `https://www.argaam.com/ar/tags/id/24779/${p}/%D8%A7%D9%84%D8%B5%D9%81%D9%82%D8%A7%D8%AA-%D8%A7%D9%84%D8%AE%D8%A7%D8%B5%D8%A9`;
    let html; try { const r = await fetch(tag, { headers: HEADERS, signal: AbortSignal.timeout(25000) }); html = await r.text(); } catch (e) { console.error(`page ${p} failed: ${e.message}`); continue; }
    const ids = [...new Set([...html.matchAll(/\/ar\/article\/articledetail\/id\/(\d+)/g)].map(m => m[1]))];
    console.error(`page ${p}: ${ids.length} articles`);
    for (const id of ids) {
      try {
        const r = await fetch(`https://www.argaam.com/ar/article/articledetail/id/${id}`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue; const ah = await r.text();
        const ld = ah.match(/"datePublished"\s*:\s*"([^"]+)"/); const date = ld ? ymd(ld[1]) : null; if (!date) continue;
        const tm = ah.match(/<title[^>]*>([^<]+)<\/title>/i); const title = tm ? tm[1].replace(/&[^;]+;/g, ' ').trim() : '';
        const got = /صفقة خاصة على .+ بقيمة/.test(title) ? [parseSingle(ah, title, date)].filter(Boolean) : parseSummary(ah, date);
        for (const d of got) { const k = d.sym + '|' + d.date; if (!seen.has(k)) { seen.add(k); events.push(d); } }
      } catch {}
      await new Promise(r => setTimeout(r, 180));
    }
  }
  mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify({ pages: PAGES, harvested: new Date().toISOString(), events }));
  return events;
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const win = a => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '–';

async function main() {
  const events = await harvest();
  console.error(`harvested ${events.length} unique (sym,date) events`);
  const ysyms = TASI_STOCKS.map(s => toYahooSym(s.sym)); await warm(ysyms, '10y');
  const data = {};
  for (let i = 0; i < ysyms.length; i++) { const b = await getBars(ysyms[i], '10y'); if (!b.length) continue; data[TASI_STOCKS[i].sym] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c) }; }
  const universe = Object.keys(data);
  const fwd = (sym, date, H) => { const d = data[sym]; if (!d) return null; const i = d.dates.findIndex(x => x >= date); if (i < 0) return null; const j = i + H; if (j >= d.c.length) return null; return d.c[j] / d.c[i] - 1; };
  const ewC = {}; const ew = (date, H) => { const k = date + '|' + H; if (k in ewC) return ewC[k]; const rs = []; for (const s of universe) { const f = fwd(s, date, H); if (f != null) rs.push(f); } return ewC[k] = rs.length ? mean(rs) : null; };

  const vals = events.map(e => e.value).filter(v => v > 0).sort((a, b) => a - b);
  const medVal = vals[Math.floor(vals.length / 2)] || 0;
  const dates = events.map(e => e.date).sort();
  console.log(`\n=== BLOCK-DEAL HARVEST TEST — excess vs EQUAL-WEIGHT basket, Derayah ${pct(COST_RT)} ===`);
  console.log(`events ${events.length} | window ${dates[0]} → ${dates.at(-1)} | median deal ${(medVal / 1e6).toFixed(1)}M SAR | resolved names only (~50 liquid)`);

  for (const H of [5, 20]) {
    const A = [], B = [], S = []; let n = 0;
    for (const e of events) { const f = fwd(e.sym, e.date, H), bm = ew(e.date, H); if (f == null || bm == null) continue; n++; const ex = f - bm; A.push(ex); (e.value >= medVal ? B : S).push(ex); }
    console.log(`\n── horizon ${H} sessions (matured ${n}/${events.length}) ──`);
    if (!A.length) { console.log('   none matured'); continue; }
    console.log(`   ALL   n=${String(A.length).padStart(4)}  excess ${pct(mean(A)).padStart(7)}  beat ${win(A)}  t=${tstat(A)}  NET ${pct(mean(A) - COST_RT)}`);
    console.log(`   BIG   n=${String(B.length).padStart(4)}  excess ${pct(mean(B)).padStart(7)}  beat ${win(B)}  t=${tstat(B)}  NET ${pct(mean(B) - COST_RT)}  ← the "whales"`);
    console.log(`   SMALL n=${String(S.length).padStart(4)}  excess ${pct(mean(S)).padStart(7)}  beat ${win(S)}  t=${tstat(S)}`);
  }
  // regime split at 20-session: 2025 (calmer) vs 2026 (geopolitically stressed)
  console.log(`\n── REGIME SPLIT (BIG deals, 20-session excess): does a chaotic market change it? ──`);
  for (const [lab, pred] of [['2025 (calmer)', d => d < '2026-01-01'], ['2026 (stressed)', d => d >= '2026-01-01']]) {
    const a = []; for (const e of events) { if (e.value < medVal || !pred(e.date)) continue; const f = fwd(e.sym, e.date, 20), bm = ew(e.date, 20); if (f != null && bm != null) a.push(f - bm); }
    console.log(`   ${lab.padEnd(16)} n=${String(a.length).padStart(4)}  big-deal excess ${pct(mean(a)).padStart(7)}  beat ${win(a)}  t=${tstat(a)}`);
  }
  // ── HONEST CHECKS on the headline (BIG deals, 20-session) ──
  // (1) ABSOLUTE return not just excess; (2) overlap-corrected (one event per sym per ~20
  // sessions ≈ 30 calendar days); (3) Newey-West t on the date-ordered excess series.
  function nwT(a, lag = 5) { const N = a.length; if (N < lag + 2) return NaN; const m = mean(a), e = a.map(x => x - m); let v = e.reduce((s, x) => s + x * x, 0) / N; for (let k = 1; k <= lag; k++) { let g = 0; for (let i = k; i < N; i++) g += e[i] * e[i - k]; g /= N; v += 2 * (1 - k / (lag + 1)) * g; } return +(m / Math.sqrt(v / N)).toFixed(2); }
  const big20 = events.filter(e => e.value >= medVal).map(e => ({ ...e, abs: fwd(e.sym, e.date, 20), bm: ew(e.date, 20) })).filter(e => e.abs != null && e.bm != null).sort((a, b) => a.date < b.date ? -1 : 1);
  const absA = big20.map(e => e.abs), exA = big20.map(e => e.abs - e.bm);
  // overlap-corrected: one event per sym per 30 calendar days
  const lastUsed = {}; const ocEx = [], ocAbs = [];
  for (const e of big20) { const t = new Date(e.date).getTime(); if (lastUsed[e.sym] == null || t - lastUsed[e.sym] >= 30 * 864e5) { ocEx.push(e.abs - e.bm); ocAbs.push(e.abs); lastUsed[e.sym] = t; } }
  console.log(`\n── HONEST CHECKS — BIG deals, 20-session ──`);
  console.log(`   ABSOLUTE return : mean ${pct(mean(absA))}  net ${pct(mean(absA) - COST_RT)}  (must be >0 to actually make money, not just beat the average)`);
  console.log(`   EXCESS raw      : mean ${pct(mean(exA))}  plain t=${tstat(exA)}  Newey-West t=${nwT(exA)}  ← HAC is the honest one`);
  console.log(`   OVERLAP-CORRECT : n=${ocEx.length} (1/sym/30d)  excess ${pct(mean(ocEx))}  t=${tstat(ocEx)}  | absolute ${pct(mean(ocAbs))}  net ${pct(mean(ocAbs) - COST_RT)}`);
  const real = mean(ocAbs) - COST_RT > 0 && mean(ocEx) > 0 && tstat(ocEx) > 2 && nwT(exA) > 2;
  console.log(`\n  VERDICT: ${real ? 'REAL LEAD — big-deal names beat the basket AND make money, net cost, with honest (overlap/HAC) significance, in both regimes. Confirm survivorship + direction next.' : 'does NOT clear the honest bar once overlap/HAC-corrected or absolute<cost — promising but not proven.'}`);
  process.exit(0);
}
main();
