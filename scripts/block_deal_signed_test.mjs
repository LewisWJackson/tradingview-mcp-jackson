/**
 * block_deal_signed_test.mjs — SIGN block deals by buyer- vs seller-initiated, then test.
 *
 * A block deal has no stated direction. Microstructure proxy: compare the DEAL PRICE to
 * the stock's market price that day. Trading at a PREMIUM = an aggressive buyer paid up
 * (bullish); at a DISCOUNT = a motivated seller offloaded (bearish). Hypothesis: premium
 * deals outperform discount deals over the next ~month.
 *
 * Re-harvests Argaam capturing deal PRICE (the 12mo value-only cache lacked it), signs
 * each by premium% vs same-day close, tests forward 20-session excess + absolute vs the
 * equal-weight basket, Derayah 0.11%, BIG deals, overlap-corrected. Cache: data/block_deals_signed.json
 *
 * Run: PAGES=8 node --experimental-sqlite scripts/block_deal_signed_test.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dirname, '..', 'data', 'block_deals_signed.json');
const PAGES = +process.env.PAGES || 8, COST_RT = +process.env.COST_RT || 0.0011;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'ar,en;q=0.8', 'Referer': 'https://www.argaam.com/' };
const ARABIC_NAME_MAP = { 'الراجحي':'1120','راجحي':'1120','الأهلي السعودي':'1180','البنك الأهلي':'1180','الأهلي':'1180','بنك الرياض':'1010','الرياض':'1010','ساب':'1030','البنك السعودي الفرنسي':'1050','الفرنسي':'1050','البنك العربي الوطني':'1080','العربي الوطني':'1080','البلاد':'1140','الإنماء':'1150','انماء':'1150','السعودي للاستثمار':'1060','الجزيرة':'1020','أرامكو':'2222','ارامكو':'2222','أرامكو السعودية':'2222','سابك':'2010','تكنولوجيا':'2060','تصنيع':'2060','صحارى':'2310','بترورابغ':'2380','بترو رابغ':'2380','كيان':'2350','الاتصالات السعودية':'7010','stc':'7010','موبايلي':'7020','زين السعودية':'7030','زين':'7030','إلم':'7203','كهرباء':'5110','السعودية للكهرباء':'5110','أكوا':'2082','اكوا':'2082','المراعي':'2280','مراعي':'2280','سافولا':'2050','هرفي':'6002','التنمية الغذائية':'2281','جرير':'4190','فتيحي':'4180','إكسترا':'4003','اكسترا':'4003','الدريس':'4200','الحمادي':'4007','دلة':'4004','موواساة':'2160','مواساة':'2160','الحبيب':'4013','سليمان الحبيب':'4013','النخبة':'4005','فقيه':'4017','دار الأركان':'4300','دار أركان':'4300','إعمار':'4310','اعمار الاقتصادية':'4310','الرياض التنمية':'4150','أسمنت السعودية':'3010','الأسمنت السعودية':'3010','أسمنت ينبع':'3020','ينبع للأسمنت':'3020','أسمنت العربية':'3030','العربية للأسمنت':'3030','أسمنت المنطقة الجنوبية':'3040','الجنوبية للأسمنت':'3040','أسمنت القصيم':'3050','الكابلات السعودية':'2110','صناعات متقدمة':'2120','ألجين':'2170','الجين':'2170','الخدمات الأرضية':'4031','التعاونية':'8010','تاونية':'8010','بوبا':'8020','الراجحي للتأمين':'8230' };
const resolveArabic = a => { if (!a) return null; const n = a.trim(); if (ARABIC_NAME_MAP[n]) return ARABIC_NAME_MAP[n]; let best = null, len = 0; for (const [kw, c] of Object.entries(ARABIC_NAME_MAP)) if (n.includes(kw) && kw.length > len) { best = c; len = kw.length; } return best; };
const tdText = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim();
const ymd = d => d ? new Date(d.replace(/\//g, '-')).toISOString().slice(0, 10) : null;

function parseSummary(html, date) {
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => tdText(m[1]));
  const by = {}; let cur = null, prevQty = false;
  for (const cell of cells) { const num = parseFloat(cell);
    if (isNaN(num) || !cell.length) { const code = resolveArabic(cell); if (code) { cur = code; prevQty = false; by[code] ||= { price: 0, qty: 0, value: 0 }; } else if (cell.length > 2) { cur = null; prevQty = false; } }
    else if (cur) { const isInt = Number.isInteger(num), big = num > 1000; if (big && isInt) { by[cur].qty += num; prevQty = true; } else if (!big && !isInt && prevQty) { by[cur].value += num * 1e6; prevQty = false; } else { if (!by[cur].price) by[cur].price = num; prevQty = false; } } }
  return Object.entries(by).filter(([, d]) => d.price > 0 && d.qty > 0 && d.value > 0).map(([code, d]) => ({ sym: `TADAWUL:${code}`, value: Math.round(d.value), price: +d.price.toFixed(4), date }));
}
function parseSingle(html, title, date) {
  const m = title.match(/صفقة خاصة على (.+?) بقيمة/); if (!m) return null; const code = resolveArabic(m[1].trim()); if (!code) return null;
  let value = 0; const v = title.match(/بقيمة\s+([\d\.,]+)\s*(مليون|مليار)?/); if (v) { let x = parseFloat(v[1].replace(/,/g, '')); if (v[2] === 'مليون') x *= 1e6; else if (v[2] === 'مليار') x *= 1e9; value = x; }
  let price = 0; const sec = html.match(/كمية الصفقة[\s\S]{0,3000}?وبحسب تداول/);
  if (sec) { const nums = [...sec[0].matchAll(/>(\d[\d,\.]*)</g)].map(x => parseFloat(x[1].replace(/,/g, ''))).filter(x => !isNaN(x) && x > 0); const pc = nums.filter(x => x <= 2000 && x >= 0.5 && !Number.isInteger(x)); if (pc.length) price = pc[0]; }
  return value > 0 && price > 0 ? { sym: `TADAWUL:${code}`, value: Math.round(value), price: +price.toFixed(4), date } : null;
}

async function harvest() {
  if (existsSync(CACHE)) { const c = JSON.parse(readFileSync(CACHE, 'utf8')); if (c.pages >= PAGES) { console.error(`cached: ${c.events.length} events`); return c.events; } }
  const events = [], seen = new Set();
  for (let p = 1; p <= PAGES; p++) {
    const tag = `https://www.argaam.com/ar/tags/id/24779/${p}/%D8%A7%D9%84%D8%B5%D9%81%D9%82%D8%A7%D8%AA-%D8%A7%D9%84%D8%AE%D8%A7%D8%B5%D8%A9`;
    let html; try { html = await (await fetch(tag, { headers: HEADERS, signal: AbortSignal.timeout(25000) })).text(); } catch (e) { console.error(`p${p} fail`); continue; }
    const ids = [...new Set([...html.matchAll(/\/ar\/article\/articledetail\/id\/(\d+)/g)].map(m => m[1]))];
    console.error(`page ${p}: ${ids.length} articles`);
    for (const id of ids) { try { const r = await fetch(`https://www.argaam.com/ar/article/articledetail/id/${id}`, { headers: HEADERS, signal: AbortSignal.timeout(15000) }); if (!r.ok) continue; const ah = await r.text();
      const ld = ah.match(/"datePublished"\s*:\s*"([^"]+)"/); const date = ld ? ymd(ld[1]) : null; if (!date) continue;
      const tm = ah.match(/<title[^>]*>([^<]+)<\/title>/i); const title = tm ? tm[1].replace(/&[^;]+;/g, ' ').trim() : '';
      const got = /صفقة خاصة على .+ بقيمة/.test(title) ? [parseSingle(ah, title, date)].filter(Boolean) : parseSummary(ah, date);
      for (const d of got) { const k = d.sym + '|' + d.date; if (!seen.has(k)) { seen.add(k); events.push(d); } } } catch {} await new Promise(r => setTimeout(r, 180)); }
  }
  mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify({ pages: PAGES, events }));
  return events;
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const win = a => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '–';

async function main() {
  const events = await harvest();
  const ysyms = TASI_STOCKS.map(s => toYahooSym(s.sym)); await warm(ysyms, '10y');
  const data = {};
  for (let i = 0; i < ysyms.length; i++) { const b = await getBars(ysyms[i], '10y'); if (!b.length) continue; data[TASI_STOCKS[i].sym] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c), idx: Object.fromEntries(b.map((x, j) => [iso(x.t), j])) }; }
  const universe = Object.keys(data);
  const fwd = (sym, date, H) => { const d = data[sym]; if (!d) return null; const i = d.dates.findIndex(x => x >= date); if (i < 0) return null; const j = i + H; if (j >= d.c.length) return null; return { ex_i: i, ret: d.c[j] / d.c[i] - 1 }; };
  const closeOn = (sym, date) => { const d = data[sym]; if (!d) return null; const i = d.dates.findIndex(x => x >= date); return i < 0 ? null : d.c[i]; };
  const ewC = {}; const ew = (date, H) => { const k = date + H; if (k in ewC) return ewC[k]; const rs = []; for (const s of universe) { const f = fwd(s, date, H); if (f) rs.push(f.ret); } return ewC[k] = rs.length ? mean(rs) : null; };

  const vals = events.map(e => e.value).filter(v => v > 0).sort((a, b) => a - b);
  const medVal = vals[Math.floor(vals.length / 2)] || 0;
  const H = 20;
  // sign each BIG deal by premium% = dealPrice / same-day close - 1
  const rows = [];
  for (const e of events) { if (e.value < medVal) continue; const c = closeOn(e.sym, e.date), f = fwd(e.sym, e.date, H), bm = ew(e.date, H); if (!c || !f || bm == null || !e.price) continue; rows.push({ sym: e.sym, date: e.date, prem: e.price / c - 1, ex: f.ret - bm, abs: f.ret }); }
  rows.sort((a, b) => a.date < b.date ? -1 : 1);

  const dates = events.map(e => e.date).sort();
  console.log(`\n=== SIGNED BLOCK-DEAL TEST — premium vs discount, BIG deals, ${H}-session, Derayah ${pct(COST_RT)} ===`);
  console.log(`events ${events.length} | with price+fwd: ${rows.length} | window ${dates[0]}→${dates.at(-1)}`);

  const prem = rows.filter(r => r.prem > 0.001), disc = rows.filter(r => r.prem < -0.001), atmkt = rows.filter(r => Math.abs(r.prem) <= 0.001);
  const show = (lab, a) => console.log(`   ${lab.padEnd(22)} n=${String(a.length).padStart(4)}  excess ${pct(mean(a.map(r => r.ex))).padStart(7)}  beat ${win(a.map(r => r.ex))}  t=${tstat(a.map(r => r.ex))}  | ABS ${pct(mean(a.map(r => r.abs))).padStart(7)} net ${pct(mean(a.map(r => r.abs)) - COST_RT)}`);
  console.log(`\n── by deal price vs market (the sign) ──`);
  show('PREMIUM (buyer paid up)', prem);
  show('AT-MARKET', atmkt);
  show('DISCOUNT (seller dumped)', disc);
  const spread = mean(prem.map(r => r.ex)) - mean(disc.map(r => r.ex));
  console.log(`\n   PREMIUM − DISCOUNT excess spread: ${pct(spread)} ${spread > 0 ? '(right direction: buyers > sellers)' : '(WRONG direction)'}`);

  // overlap-corrected premium (1/sym/30d) + does signing beat unsigned?
  const lu = {}; const ocP = [];
  for (const r of prem) { const t = new Date(r.date).getTime(); if (lu[r.sym] == null || t - lu[r.sym] >= 30 * 864e5) { ocP.push(r); lu[r.sym] = t; } }
  console.log(`\n── PREMIUM deals, overlap-corrected (1/sym/30d) ──`);
  console.log(`   n=${ocP.length}  excess ${pct(mean(ocP.map(r => r.ex)))}  t=${tstat(ocP.map(r => r.ex))}  | ABS ${pct(mean(ocP.map(r => r.abs)))} net ${pct(mean(ocP.map(r => r.abs)) - COST_RT)}`);
  console.log(`   unsigned BIG baseline excess was +1.10% (oc t=2.08). Signing adds value if PREMIUM > that with t>2.`);
  process.exit(0);
}
main();
