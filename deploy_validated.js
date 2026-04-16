import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import CDP from 'chrome-remote-interface';

try { mkdirSync('screenshots', {recursive: true}); } catch(e) {}

const c = await CDP({host:'localhost', port:9222});
await c.Runtime.enable();
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('═══════════════════════════════════════════════════════════════');
console.log('  ☁️  CLOUD RIDER v2 — VALIDATION BUILD');
console.log('  $10,000 capital | 1% risk per trade | ATR-based sizing');
console.log('═══════════════════════════════════════════════════════════════\n');

// Step 1: Set source
const pine = readFileSync('cloud_rider_validated.pine', 'utf8');
const setOK = await c.Runtime.evaluate({expression: `
  (function() {
    var wrapper = document.querySelector('[class*="editorWrapper"]');
    var fiberKey = Object.keys(wrapper).find(function(k) { return k.startsWith('__reactFiber'); });
    var node = wrapper[fiberKey];
    for (var i = 0; i < 80; i++) {
      if (!node) break;
      var props = node.memoizedProps || node.pendingProps;
      if (props && props.monacoEnv) {
        props.monacoEnv.editor.getEditors()[0].getModel().setValue(${JSON.stringify(pine)});
        return true;
      }
      node = node.return;
    }
    return false;
  })()
`, returnByValue: true});
console.log('Source set:', setOK.result.value);
if (!setOK.result.value) { await c.close(); process.exit(1); }
await sleep(500);

// Step 2: Save script
const saveBtn = await c.Runtime.evaluate({expression: `
  (function() {
    var el = document.querySelector('[title="Save script"]');
    if (el) { el.click(); return 'saved'; }
    return 'no save';
  })()
`, returnByValue: true});
console.log('Save:', saveBtn.result.value);
await sleep(5000);

// Step 3: Check for errors
const errors = await c.Runtime.evaluate({expression: `
  (function() {
    var els = document.querySelectorAll('[class*="selectable"]');
    var recent = [];
    for (var i = Math.max(0, els.length - 5); i < els.length; i++) {
      recent.push(els[i].textContent.trim());
    }
    return recent;
  })()
`, returnByValue: true});
console.log('Logs:', errors.result.value);

const hasError = errors.result.value.some(l => l.includes('Error'));
if (hasError) {
  console.log('\n⛔ COMPILATION ERRORS — fixing...');
  await c.close();
  process.exit(1);
}

// Step 4: Remove old strategy and add new one
await c.Runtime.evaluate({expression: `
  (function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    chart.getAllStudies().forEach(function(s) {
      if (s.name !== 'Volume') chart.removeEntity(s.id);
    });
  })()
`});
await sleep(1000);

// Click Add to chart
const addBtn = await c.Runtime.evaluate({expression: `
  (function() {
    var el = document.querySelector('[title="Add to chart"]');
    if (el) { el.click(); return 'clicked'; }
    return 'not found';
  })()
`, returnByValue: true});
console.log('Add to chart:', addBtn.result.value);
await sleep(12000);

// Verify
const verify = await c.Runtime.evaluate({expression: `
  (function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var el = document.querySelector('[class*="layout__area--bottom"]');
    return {
      studies: chart.getAllStudies().map(function(s){return s.name}),
      bottom: el ? el.textContent.substring(0, 300) : 'none'
    };
  })()
`, returnByValue: true});
console.log('Studies:', verify.result.value.studies);
console.log('Bottom:', verify.result.value.bottom.substring(0, 200));

const deployed = verify.result.value.studies.some(s => s.includes('CLOUD RIDER') || s.includes('Validated'));
if (!deployed) {
  console.log('\n⛔ Strategy not deployed. Check errors above.');
  await c.close();
  process.exit(1);
}

// ═══════ BACKTEST — Tier 1 + Tier 2 assets ═══════
const tests = [
  // TIER 1 — Weekly (best combination of sample + PF + DD)
  {symbol: 'AMEX:SPY',        res: 'W',  label: 'SPY Weekly'},
  {symbol: 'BATS:QQQ',        res: 'W',  label: 'QQQ Weekly'},
  {symbol: 'BITSTAMP:BTCUSD', res: 'W',  label: 'BTC Weekly'},
  // TIER 2 — Weekly
  {symbol: 'FX:EURUSD',       res: 'W',  label: 'EURUSD Weekly'},
  {symbol: 'BITSTAMP:ETHUSD', res: 'W',  label: 'ETH Weekly'},
  {symbol: 'TVC:GOLD',        res: 'W',  label: 'GOLD Weekly'},
  // Monthly validation (hypothesis check)
  {symbol: 'BATS:QQQ',        res: 'M',  label: 'QQQ Monthly'},
  {symbol: 'AMEX:SPY',        res: 'M',  label: 'SPY Monthly'},
  {symbol: 'TVC:GOLD',        res: 'M',  label: 'GOLD Monthly'},
  {symbol: 'BITSTAMP:BTCUSD', res: 'M',  label: 'BTC Monthly'},
  // Commodity check (expected weak)
  {symbol: 'TVC:SILVER',      res: 'W',  label: 'SILVER Weekly'},
  {symbol: 'TVC:USOIL',       res: 'W',  label: 'OIL Weekly'},
];

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  RISK-NORMALIZED BACKTEST ($10K, 1% risk/trade)');
console.log('═══════════════════════════════════════════════════════════════\n');
console.log('  Asset             Trades  WR       PF      W/L     MaxDD%   AvgTrade  Sharpe   Range');
console.log('  ─────────────────────────────────────────────────────────────────────────────────────');

const results = [];
for (const test of tests) {
  process.stdout.write(`  ${test.label.padEnd(18)}`);

  await c.Runtime.evaluate({expression: `(function(){ var ch = window.TradingViewApi._activeChartWidgetWV.value(); ch.setSymbol('${test.symbol}'); ch.setResolution('${test.res}'); })()`});
  await sleep(15000);

  const data = await c.Runtime.evaluate({expression: `
    (function() {
      var el = document.querySelector('[class*="layout__area--bottom"]');
      if (!el) return {};
      var t = el.textContent;
      var m = {};
      var v;

      m.strat = t.includes('Validated') || t.includes('CLOUD RIDER') ? 'CR' : '?';

      v = t.match(/([A-Z][a-z]+ \\d+, \\d+) — ([A-Z][a-z]+ \\d+, \\d+)/);
      m.range = v ? v[1] + ' — ' + v[2] : null;
      v = t.match(/Total trades([\\d,]+)/); m.trades = v ? v[1].replace(/,/g,'') : '0';
      v = t.match(/Percent profitable(\\d+\\.?\\d*)%/); m.wr = v ? v[1]+'%' : null;
      if (!m.wr) { v = t.match(/Profitable[\\s\\S]*?(\\d+\\.?\\d*)%/); m.wr = v ? v[1]+'%' : null; }
      v = t.match(/Profit factor(\\d+\\.?\\d*)/); m.pf = v ? v[1] : null;
      v = t.match(/Total P&L([-\\d,.]+)USD([-\\d.]+%)/); m.pnl = v ? {usd: v[1], pct: v[2]} : null;
      if (!m.pnl) { v = t.match(/Net P&L([-\\d,.]+)USD([-\\d.]+%)/); m.pnl = v ? {usd: v[1], pct: v[2]} : null; }
      v = t.match(/Max equity drawdown([\\d,.]+)USD([\\d.]+%)/); m.dd = v ? {usd: v[1], pct: v[2]} : null;
      v = t.match(/Ratio avg win \\/ avg loss(\\d+\\.\\d+)/); m.wl = v ? v[1] : null;
      v = t.match(/Sharpe ratio([-\\d.]+)/); m.sharpe = v ? v[1] : null;
      v = t.match(/Sortino ratio([-\\d.]+)/); m.sortino = v ? v[1] : null;
      v = t.match(/Avg trade([-\\d,.]+)USD([-\\d.]+%)/); m.avgTrade = v ? {usd: v[1], pct: v[2]} : null;
      v = t.match(/Max consec\\. wins(\\d+)/); m.maxConsecWins = v ? v[1] : null;
      v = t.match(/Max consec\\. losses(\\d+)/); m.maxConsecLosses = v ? v[1] : null;
      v = t.match(/Avg # bars in winning trades(\\d+)/); m.avgBarsWin = v ? v[1] : null;
      v = t.match(/Avg # bars in losing trades(\\d+)/); m.avgBarsLoss = v ? v[1] : null;

      return m;
    })()
  `, returnByValue: true});

  const m = data.result.value;
  results.push({label: test.label, symbol: test.symbol, res: test.res, ...m});

  if (m.trades !== '0' && parseInt(m.trades) > 0) {
    const pfNum = parseFloat(m.pf || 0);
    const ddPct = m.dd ? m.dd.pct : '?';
    const avgT = m.avgTrade ? m.avgTrade.usd : '?';
    const marker = pfNum > 1.5 ? '★★★' : pfNum > 1.2 ? '★★ ' : pfNum > 1.0 ? '★  ' : '   ';
    console.log(`${marker} ${m.trades.padStart(4)}  ${(m.wr||'?').padStart(7)}  ${(m.pf||'?').padStart(6)}  ${(m.wl||'?').padStart(7)}  ${(ddPct+'%').padStart(8)}  ${(avgT||'?').padStart(9)}  ${(m.sharpe||'?').padStart(6)}  ${m.range || ''}`);
  } else {
    console.log(`   NO TRADES [${m.strat}] | ${m.range || ''}`);
  }

  const s = await c.Page.captureScreenshot({format:'png'});
  writeFileSync(`screenshots/valid_${test.label.replace(/\s/g,'_')}.png`, Buffer.from(s.data, 'base64'));
}

// ═══════ PROFESSIONAL SUMMARY ═══════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  RISK-NORMALIZED VALIDATION SUMMARY');
console.log('  $10,000 initial | 1% risk per trade | ATR×3 stop');
console.log('═══════════════════════════════════════════════════════════════');

const withTrades = results.filter(r => parseInt(r.trades||0) > 0);
const profitable = withTrades.filter(r => parseFloat(r.pf||0) > 1.0);

// Sort by a composite score: PF * sqrt(trades) / max(DD%, 1)
const scored = withTrades.map(r => {
  const pf = parseFloat(r.pf || 0);
  const trades = parseInt(r.trades || 0);
  const dd = r.dd ? parseFloat(r.dd.pct) : 100;
  const score = pf * Math.sqrt(trades) / Math.max(dd/10, 1);
  return {...r, score, pfNum: pf, tradesNum: trades, ddNum: dd};
}).sort((a, b) => b.score - a.score);

console.log('\n  RANKED BY COMPOSITE SCORE (PF × √trades / DD):');
console.log('  ──────────────────────────────────────────────────');
for (const r of scored) {
  const verdict = r.pfNum > 1.3 && r.ddNum < 30 && r.tradesNum > 30 ? '✅ TIER 1' :
                  r.pfNum > 1.0 && r.ddNum < 50 && r.tradesNum > 15 ? '🟡 TIER 2' :
                  r.pfNum > 1.0 ? '⚠️ WEAK' : '❌ FAIL';
  console.log(`  ${verdict.padEnd(12)} ${r.label.padEnd(18)} Score: ${r.score.toFixed(2).padStart(6)} | PF ${r.pf} | ${r.trades} tr | DD ${r.dd ? r.dd.pct + '%' : '?'} | W/L ${r.wl || '?'} | Sharpe ${r.sharpe || '?'}`);
}

console.log(`\n  TOTAL: ${profitable.length}/${withTrades.length} profitable`);

writeFileSync('validation_results.json', JSON.stringify(results, null, 2));
console.log('\nFull results saved to validation_results.json');
await c.close();
process.exit(0);
