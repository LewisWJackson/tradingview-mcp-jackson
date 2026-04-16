import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import CDP from 'chrome-remote-interface';
import {setSource, ensurePineEditorOpen} from './src/core/pine.js';

try { mkdirSync('screenshots', {recursive: true}); } catch(e) {}

const c = await CDP({host:'localhost', port:9222});
await c.Runtime.enable();

// Deploy strategy
console.log('=== DEPLOYING Multi-Asset Alpha Engine v1 ===');
const pine = readFileSync('multi_asset_alpha.pine', 'utf8');
await setSource({source: pine});
await c.Input.dispatchKeyEvent({type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13});
await c.Input.dispatchKeyEvent({type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2});
await new Promise(r => setTimeout(r, 8000));

// Verify deployment
const check = await c.Runtime.evaluate({expression: `
  (function() {
    var el = document.querySelector('[class*="layout__area--bottom"]');
    if (!el) return {deployed: false};
    var t = el.textContent;
    return {deployed: t.includes('Alpha') || t.includes('Multi-Asset'), bottomText: t.substring(0, 200)};
  })()
`, returnByValue: true});
console.log('Deploy check:', JSON.stringify(check.result.value));

// Test configurations
const tests = [
  // Crypto
  {symbol: 'BITSTAMP:BTCUSD', res: '60', label: 'BTC 1H'},
  {symbol: 'BITSTAMP:BTCUSD', res: '15', label: 'BTC 15min'},
  {symbol: 'BITSTAMP:BTCUSD', res: 'D',  label: 'BTC Daily'},
  {symbol: 'BITSTAMP:ETHUSD', res: '60', label: 'ETH 1H'},
  {symbol: 'BITSTAMP:ETHUSD', res: '15', label: 'ETH 15min'},
  {symbol: 'BINANCE:SOLUSDT', res: '60', label: 'SOL 1H'},
  // Equity
  {symbol: 'BATS:QQQ',        res: '60', label: 'QQQ 1H'},
  {symbol: 'BATS:QQQ',        res: 'D',  label: 'QQQ Daily'},
  // Commodities
  {symbol: 'TVC:GOLD',        res: '60', label: 'GOLD 1H'},
  {symbol: 'TVC:GOLD',        res: 'D',  label: 'GOLD Daily'},
  {symbol: 'TVC:SILVER',      res: '60', label: 'SILVER 1H'},
  {symbol: 'TVC:USOIL',       res: '60', label: 'OIL 1H'},
  {symbol: 'TVC:USOIL',       res: 'D',  label: 'OIL Daily'},
  // Forex
  {symbol: 'FX:EURUSD',       res: '60', label: 'EURUSD 1H'},
];

console.log('\n══════════════════════════════════════════════════════════════════════════');
console.log('  MULTI-ASSET ALPHA ENGINE v1 — PREMIUM FULL BACKTEST');
console.log('══════════════════════════════════════════════════════════════════════════\n');

const results = [];
for (const test of tests) {
  process.stdout.write(`  ${test.label.padEnd(16)}`);

  await c.Runtime.evaluate({expression: `(function(){ var ch = window.TradingViewApi._activeChartWidgetWV.value(); ch.setSymbol('${test.symbol}'); ch.setResolution('${test.res}'); })()`});
  await new Promise(r => setTimeout(r, 10000));

  const data = await c.Runtime.evaluate({expression: `
    (function() {
      var el = document.querySelector('[class*="layout__area--bottom"]');
      if (!el) return {};
      var t = el.textContent;
      var m = {}, v;
      v = t.match(/([A-Z][a-z]+ \\d+, \\d+) — ([A-Z][a-z]+ \\d+, \\d+)/);
      m.range = v ? v[1] + ' — ' + v[2] : null;
      v = t.match(/Total trades([\\d,]+)/); m.trades = v ? v[1].replace(/,/g,'') : '0';
      v = t.match(/Percent profitable(\\d+\\.?\\d*)%/); m.wr = v ? v[1]+'%' : null;
      if (!m.wr) { v = t.match(/Profitable[\\s\\S]*?(\\d+\\.?\\d*)%/); m.wr = v ? v[1]+'%' : null; }
      v = t.match(/Profit factor(\\d+\\.?\\d*)/); m.pf = v ? v[1] : null;
      v = t.match(/Total P&L([-\\d,.]+)USD([-\\d.]+%)/); m.pnl = v ? v[2] : null;
      if (!m.pnl) { v = t.match(/Net P&L([-\\d,.]+)USD([-\\d.]+%)/); m.pnl = v ? v[2] : null; }
      v = t.match(/Max equity drawdown([\\d,.]+)USD([\\d.]+%)/); m.dd = v ? v[2] : null;
      v = t.match(/Ratio avg win \\/ avg loss(\\d+\\.\\d+)/); m.wl = v ? v[1] : null;
      v = t.match(/Sharpe ratio([-\\d.]+)/); m.sharpe = v ? v[1] : null;
      v = t.match(/Sortino ratio([-\\d.]+)/); m.sortino = v ? v[1] : null;
      return m;
    })()
  `, returnByValue: true});

  const m = data.result.value;
  results.push({label: test.label, ...m});

  if (m.trades !== '0' && parseInt(m.trades) > 0) {
    const pfNum = parseFloat(m.pf || 0);
    const marker = pfNum > 1.3 ? '★★' : pfNum > 1.0 ? '★ ' : '  ';
    console.log(`${marker} ${m.trades.padStart(5)} tr | WR ${(m.wr||'?').padStart(7)} | PF ${(m.pf||'?').padStart(6)} | W/L ${(m.wl||'?').padStart(6)} | DD ${(m.dd||'?').padStart(7)} | Sharpe ${(m.sharpe||'?').padStart(6)} | ${m.range || ''}`);
  } else {
    console.log(`   NO TRADES | ${m.range || ''}`);
  }

  const s = await c.Page.captureScreenshot({format:'png'});
  writeFileSync(`screenshots/alpha_${test.symbol.replace(/[:\/]/g, '_')}_${test.res}.png`, Buffer.from(s.data, 'base64'));
}

// Summary
console.log('\n══════════════════════════════════════════════════════════════════════════');
console.log('  RESULTS BY CATEGORY');
console.log('══════════════════════════════════════════════════════════════════════════');

const profitable = results.filter(r => r.pf && parseFloat(r.pf) > 1.0 && r.trades !== '0');
const nearBE = results.filter(r => r.pf && parseFloat(r.pf) >= 0.85 && parseFloat(r.pf) <= 1.0 && r.trades !== '0');
const losing = results.filter(r => r.pf && parseFloat(r.pf) < 0.85 && r.trades !== '0');

if (profitable.length > 0) {
  console.log('\n  ★ PROFITABLE:');
  for (const r of profitable.sort((a,b) => parseFloat(b.pf) - parseFloat(a.pf))) {
    console.log(`    ${r.label.padEnd(16)} PF ${(r.pf||'').padEnd(6)} | WR ${(r.wr||'').padEnd(7)} | W/L ${(r.wl||'').padEnd(6)} | ${r.trades} tr | DD ${r.dd} | ${r.range}`);
  }
}
if (nearBE.length > 0) {
  console.log('\n  ~ NEAR BREAKEVEN:');
  for (const r of nearBE) {
    console.log(`    ${r.label.padEnd(16)} PF ${(r.pf||'').padEnd(6)} | WR ${(r.wr||'').padEnd(7)} | ${r.trades} tr`);
  }
}
if (losing.length > 0) {
  console.log('\n  ✗ LOSING:');
  for (const r of losing) {
    console.log(`    ${r.label.padEnd(16)} PF ${(r.pf||'').padEnd(6)} | ${r.trades} tr`);
  }
}

writeFileSync('alpha_results.json', JSON.stringify(results, null, 2));
console.log('\n\nResults saved to alpha_results.json');
await c.close();
process.exit(0);
