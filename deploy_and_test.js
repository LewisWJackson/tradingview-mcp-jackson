import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import CDP from 'chrome-remote-interface';

try { mkdirSync('screenshots', {recursive: true}); } catch(e) {}

const c = await CDP({host:'localhost', port:9222});
await c.Runtime.enable();
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('═══════════════════════════════════════════════════');
console.log('  ☁️  CLOUD RIDER v2 — Deploy & Full Backtest');
console.log('═══════════════════════════════════════════════════\n');

// Set Pine source code
const pine = readFileSync('cloud_rider.pine', 'utf8');
const setResult = await c.Runtime.evaluate({expression: `
  (function() {
    var wrapper = document.querySelector('[class*="editorWrapper"]');
    if (!wrapper) return {error: 'no wrapper'};
    var fiberKey = Object.keys(wrapper).find(function(k) { return k.startsWith('__reactFiber'); });
    if (!fiberKey) return {error: 'no fiber'};
    var node = wrapper[fiberKey];
    for (var i = 0; i < 80; i++) {
      if (!node) break;
      var props = node.memoizedProps || node.pendingProps;
      if (props && props.monacoEnv) {
        var editors = props.monacoEnv.editor.getEditors();
        if (editors.length > 0) {
          editors[0].getModel().setValue(${JSON.stringify(pine)});
          return {ok: true};
        }
      }
      node = node.return;
    }
    return {error: 'monacoEnv not found'};
  })()
`, returnByValue: true});
console.log('Source set:', JSON.stringify(setResult.result.value));
if (!setResult.result.value.ok) { await c.close(); process.exit(1); }
await sleep(1000);

// Remove existing studies that aren't Volume
console.log('Removing old strategies...');
await c.Runtime.evaluate({expression: `
  (function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var studies = chart.getAllStudies();
    for (var i = 0; i < studies.length; i++) {
      if (studies[i].name !== 'Volume') {
        chart.removeEntity(studies[i].id);
      }
    }
  })()
`});
await sleep(2000);

// Ctrl+Enter to compile
console.log('Compiling with Ctrl+Enter...');
await c.Input.dispatchKeyEvent({type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13});
await c.Input.dispatchKeyEvent({type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2});
await sleep(5000);

// Click "Add to chart" if dialog appears
for (let attempt = 0; attempt < 3; attempt++) {
  const btn = await c.Runtime.evaluate({expression: `
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent.trim();
        if (t.includes('Add to chart')) {
          btns[i].click();
          return 'clicked: ' + t;
        }
      }
      return null;
    })()
  `, returnByValue: true});
  if (btn.result.value) {
    console.log(btn.result.value);
    break;
  }
  await sleep(2000);
}

await sleep(10000);  // Wait for strategy to load and compute

// Verify
const verify = await c.Runtime.evaluate({expression: `
  (function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var studies = chart.getAllStudies();
    var el = document.querySelector('[class*="layout__area--bottom"]');
    var bottomText = el ? el.textContent.substring(0, 300) : 'no panel';
    return {
      studies: studies.map(function(s){return s.name}),
      hasCloudRider: bottomText.includes('CLOUD') || bottomText.includes('Cloud'),
      bottom: bottomText
    };
  })()
`, returnByValue: true});
console.log('\nVerification:', JSON.stringify(verify.result.value, null, 2));

const deployed = verify.result.value.hasCloudRider;
if (!deployed) {
  console.log('\n⚠️ Cloud Rider may not be on chart. Proceeding with backtest anyway...');
}

// ═══════ FULL BACKTEST ═══════
const tests = [
  {symbol: 'BITSTAMP:BTCUSD', res: 'W',  label: 'BTC Weekly'},
  {symbol: 'BITSTAMP:ETHUSD', res: 'W',  label: 'ETH Weekly'},
  {symbol: 'BINANCE:SOLUSDT', res: 'W',  label: 'SOL Weekly'},
  {symbol: 'BATS:QQQ',        res: 'W',  label: 'QQQ Weekly'},
  {symbol: 'AMEX:SPY',        res: 'W',  label: 'SPY Weekly'},
  {symbol: 'TVC:GOLD',        res: 'W',  label: 'GOLD Weekly'},
  {symbol: 'TVC:SILVER',      res: 'W',  label: 'SILVER Weekly'},
  {symbol: 'TVC:USOIL',       res: 'W',  label: 'OIL Weekly'},
  {symbol: 'FX:EURUSD',       res: 'W',  label: 'EURUSD Weekly'},
  {symbol: 'BITSTAMP:BTCUSD', res: 'M',  label: 'BTC Monthly'},
  {symbol: 'BATS:QQQ',        res: 'M',  label: 'QQQ Monthly'},
  {symbol: 'AMEX:SPY',        res: 'M',  label: 'SPY Monthly'},
  {symbol: 'TVC:GOLD',        res: 'M',  label: 'GOLD Monthly'},
  {symbol: 'BITSTAMP:BTCUSD', res: 'D',  label: 'BTC Daily'},
  {symbol: 'BATS:QQQ',        res: 'D',  label: 'QQQ Daily'},
  {symbol: 'TVC:GOLD',        res: 'D',  label: 'GOLD Daily'},
];

console.log('\n═══════════════════════════════════════════════════');
console.log('  BACKTEST RESULTS');
console.log('═══════════════════════════════════════════════════\n');

const results = [];
for (const test of tests) {
  process.stdout.write(`  ${test.label.padEnd(18)}`);

  await c.Runtime.evaluate({expression: `(function(){ var ch = window.TradingViewApi._activeChartWidgetWV.value(); ch.setSymbol('${test.symbol}'); ch.setResolution('${test.res}'); })()`});
  await sleep(15000);  // extra time for weekly/monthly bars

  const data = await c.Runtime.evaluate({expression: `
    (function() {
      var el = document.querySelector('[class*="layout__area--bottom"]');
      if (!el) return {};
      var t = el.textContent;
      var m = {};
      var v;
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

      // Also check strategy name
      m.stratName = t.includes('CLOUD RIDER') ? 'CLOUD RIDER' : t.includes('VIPER') ? 'VIPER' : 'unknown';
      return m;
    })()
  `, returnByValue: true});

  const m = data.result.value;
  results.push({label: test.label, ...m});

  if (m.trades !== '0' && parseInt(m.trades) > 0) {
    const pfNum = parseFloat(m.pf || 0);
    const marker = pfNum > 1.5 ? '★★★' : pfNum > 1.2 ? '★★ ' : pfNum > 1.0 ? '★  ' : '   ';
    console.log(`${marker} ${m.trades.padStart(4)} tr | WR ${(m.wr||'?').padStart(7)} | PF ${(m.pf||'?').padStart(6)} | W/L ${(m.wl||'?').padStart(6)} | DD ${(m.dd||'?').padStart(7)} | ${m.pnl||'?'} | [${m.stratName}] ${m.range || ''}`);
  } else {
    console.log(`   NO TRADES | [${m.stratName}] ${m.range || ''}`);
  }

  const s = await c.Page.captureScreenshot({format:'png'});
  writeFileSync(`screenshots/cr2_${test.label.replace(/\s/g,'_')}.png`, Buffer.from(s.data, 'base64'));
}

// Summary
console.log('\n═══════════════════════════════════════════════════');
const withTrades = results.filter(r => parseInt(r.trades||0) > 0);
const profitable = withTrades.filter(r => parseFloat(r.pf||0) > 1.0);
console.log(`  ${profitable.length}/${withTrades.length} profitable configs`);
if (profitable.length > 0) {
  console.log('\n  ✅ PROFITABLE:');
  for (const r of profitable.sort((a,b) => parseFloat(b.pf) - parseFloat(a.pf))) {
    console.log(`    ${r.label.padEnd(18)} PF ${r.pf} | WR ${r.wr} | ${r.trades} trades | DD ${r.dd} | P&L ${r.pnl}`);
  }
}
const losing = withTrades.filter(r => parseFloat(r.pf||0) <= 1.0);
if (losing.length > 0) {
  console.log('\n  ❌ LOSING/BREAKEVEN:');
  for (const r of losing) {
    console.log(`    ${r.label.padEnd(18)} PF ${r.pf} | WR ${r.wr} | ${r.trades} trades`);
  }
}

writeFileSync('cr2_results.json', JSON.stringify(results, null, 2));
console.log('\nSaved to cr2_results.json');
await c.close();
process.exit(0);
