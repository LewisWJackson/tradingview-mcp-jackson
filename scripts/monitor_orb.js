#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  ORB Monitor — NQ1! live alert watcher
//  Polls TradingView via CDP every 60s, prints alerts when key levels hit.
//
//  Watches:
//    • Price breaks above EMA 21/34 squeeze  → bull continuation
//    • Price breaks below EMA 89             → pullback warning
//    • Price tags +L3 (25,433.25)            → next ORB target reached
//    • Price tags +L4 (25,498.25)            → extended target
//    • Price drops below +L2 (25,368.25)     → level lost, caution
//    • cRSI all three lines cross above 50   → momentum restored
//    • cRSI all three lines cross below 30   → oversold flush
// ─────────────────────────────────────────────────────────────────────────────
import CDP from 'chrome-remote-interface';

const INTERVAL_MS  = 60_000   // poll every 60 seconds
const ALERT_COOLDOWN = 300_000 // don't repeat same alert within 5 min

// ── Thresholds (from live chart read) ────────────────────────────────────────
const LEVELS = {
  ema21:  25420.10,
  ema34:  25419.18,
  ema89:  25399.56,
  l2:     25368.25,
  l3:     25433.25,
  l4:     25498.25,
}

// ── State ─────────────────────────────────────────────────────────────────────
const lastAlert = {}
let   prevPrice = null
let   iteration = 0

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' }) + ' ET'
}

function alert(key, msg) {
  const now = Date.now()
  if (lastAlert[key] && now - lastAlert[key] < ALERT_COOLDOWN) return
  lastAlert[key] = now
  console.log(`\n🔔 [${ts()}] ${msg}`)
}

async function poll() {
  iteration++
  let c
  try {
    const targets = await (await fetch('http://localhost:9222/json/list')).json()
    const t = targets.find(t => t.url?.includes('tradingview.com/chart'))
    if (!t) { console.log(`[${ts()}] ⚠️  No TradingView chart found`); return }

    c = await CDP({ host: 'localhost', port: 9222, target: t.id })
    await c.Runtime.enable()

    const raw = (await c.Runtime.evaluate({
      expression: `(function(){
        // Current price from price wrapper
        var pw = document.querySelector('[class*="priceWrapper"]')?.textContent || '';
        var price = parseFloat(pw.replace(/[^0-9.]/g, ''));

        // EMA values from main legend (first legend block)
        var leg = Array.from(document.querySelectorAll('[class*="legend"]'))[0]?.textContent || '';

        // cRSI legend
        var crsiEl = Array.from(document.querySelectorAll('[class*="legend"]'))
                       .find(el => el.textContent.includes('cRSI'));
        // Read each leaf child element separately to avoid numbers running together
        var crsiNums = [];
        if (crsiEl) {
          var leaves = Array.from(crsiEl.querySelectorAll('*'))
                         .filter(el => el.children.length === 0);
          leaves.forEach(function(el) {
            var txt = el.textContent.trim();
            // Only accept values that contain a decimal point (rules out "1", "14" period labels)
            if (!txt.includes('.')) return;
            var v = parseFloat(txt);
            if (!isNaN(v) && v >= 0 && v <= 100) crsiNums.push(v);
          });
        }

        // MFI legend
        var mfiEl = Array.from(document.querySelectorAll('[class*="legend"]'))
                      .find(el => el.textContent.includes('Money Flow'));
        var mfiNum = mfiEl ? parseFloat((mfiEl.textContent.match(/\\d+\\.\\d+/) || ['0'])[0]) : null;

        // Extract EMA values (5-digit numbers) from legend
        var emaVals = (leg.match(/\\d{5,6}\\.\\d+/g) || []).map(Number)
                        .filter(n => n > 24000 && n < 27000);

        return JSON.stringify({ price, crsiNums, mfiNum, emaVals: emaVals.slice(0,10) });
      })()`,
      returnByValue: true
    })).result?.value

    const parsed  = JSON.parse(raw || '{}')
    const price   = parsed.price || null
    const crsis   = parsed.crsiNums || []
    const emaVals = parsed.emaVals  || []

    if (!price || price < 20000) { console.log(`[${ts()}] ─ Could not parse price`); return }

    // Use live EMA values if parseable, else fall back to initial snapshot
    const ema21live = emaVals.find(n => Math.abs(n - LEVELS.ema21) < 30) || LEVELS.ema21
    const ema89live = emaVals.find(n => Math.abs(n - LEVELS.ema89) < 30) || LEVELS.ema89

    const squeeze = (LEVELS.ema21 + LEVELS.ema34) / 2  // midpoint of squeeze

    console.log(`[${ts()}]  Price: ${price.toFixed(2)}  |  EMA21: ${ema21live.toFixed(2)}  |  EMA89: ${ema89live.toFixed(2)}  |  cRSI: ${crsis.slice(0,3).map(v=>v.toFixed(1)).join(' / ')}`)

    // ── Alert Conditions ──────────────────────────────────────────────────────

    // Bull: price breaks above EMA 21/34 squeeze
    if (price > squeeze + 5 && prevPrice && prevPrice <= squeeze + 5)
      alert('ema_break_up', `🟢 BULL — Price broke above EMA 21/34 squeeze (${squeeze.toFixed(2)}). Current: ${price.toFixed(2)}. Target: +L3 ${LEVELS.l3}`)

    // Bear: price drops back below EMA 89
    if (price < ema89live - 3 && prevPrice && prevPrice >= ema89live - 3)
      alert('ema89_lost',  `🔴 CAUTION — Price lost EMA 89 (${ema89live.toFixed(2)}). Pullback in progress. Current: ${price.toFixed(2)}`)

    // +L3 tagged
    if (Math.abs(price - LEVELS.l3) <= 5)
      alert('l3_tag', `🎯 TARGET HIT — +L3 tagged at ${LEVELS.l3}. Price: ${price.toFixed(2)}. Watch for pause/rejection or continuation to +L4 ${LEVELS.l4}`)

    // +L4 tagged
    if (Math.abs(price - LEVELS.l4) <= 5)
      alert('l4_tag', `🎯 EXTENDED TARGET — +L4 tagged at ${LEVELS.l4}. Price: ${price.toFixed(2)}. Consider scaling out.`)

    // +L2 lost
    if (price < LEVELS.l2 - 5 && prevPrice && prevPrice >= LEVELS.l2 - 5)
      alert('l2_lost', `⚠️  LEVEL LOST — Price dropped below +L2 (${LEVELS.l2}). Bull thesis weakening. Current: ${price.toFixed(2)}`)

    // cRSI all above 50 (momentum restored)
    if (crsis.length >= 3 && crsis.slice(0,3).every(v => v > 50))
      alert('crsi_bull', `📈 cRSI — All three components above 50. Momentum restored. Price: ${price.toFixed(2)}`)

    // cRSI all below 30 (flush)
    if (crsis.length >= 3 && crsis.slice(0,3).every(v => v < 30))
      alert('crsi_flush', `📉 cRSI — All three components below 30. Oversold flush. Potential bounce setup at current: ${price.toFixed(2)}`)

    prevPrice = price

  } catch (err) {
    console.log(`[${ts()}] ⚠️  Poll error: ${err.message}`)
  } finally {
    if (c) await c.close().catch(() => {})
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
console.log('━'.repeat(60))
console.log(' ORB Monitor — NQ1! | Polling every 60s')
console.log(` Key levels → EMA squeeze: ${((LEVELS.ema21+LEVELS.ema34)/2).toFixed(2)} | +L3: ${LEVELS.l3} | +L4: ${LEVELS.l4}`)
console.log(' Ctrl+C to stop')
console.log('━'.repeat(60))

await poll()  // immediate first poll
setInterval(poll, INTERVAL_MS)
