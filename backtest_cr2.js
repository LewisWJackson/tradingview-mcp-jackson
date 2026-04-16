import {writeFileSync, mkdirSync} from 'fs';
import CDP from 'chrome-remote-interface';

try { mkdirSync('screenshots', {recursive: true}); } catch(e) {}

const c = await CDP({host:'localhost', port:9222});
await c.Runtime.enable();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Verify Cloud Rider is on chart
const check = await c.Runtime.evaluate({expression: `
  window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(function(s){return s.name})
`, returnByValue: true});
console.log('Studies on chart:', check.result.value);

if (!check.result.value.includes('CLOUD RIDER v2')) {
  console.log('ERROR: Cloud Rider v2 not on chart!');
  await c.close();
  process.exit(1);
}

const tests = [
  // WEEKLY — primary target
  {symbol: 'BITSTAMP:BTCUSD', res: 'W',  label: 'BTC Weekly'},
  {symbol: 'BITSTAMP:ETHUSD', res: 'W',  label: 'ETH Weekly'},
  {symbol: 'BINANCE:SOLUSDT', res: 'W',  label: 'SOL Weekly'},
  {symbol: 'BATS:QQQ',        res: 'W',  label: 'QQQ Weekly'},
  {symbol: 'AMEX:SPY',        res: 'W',  label: 'SPY Weekly'},
  {symbol: 'TVC:GOLD',        res: 'W',  label: 'GOLD Weekly'},
  {symbol: 'TVC:SILVER',      res: 'W',  label: 'SILVER Weekly'},
  {symbol: 'TVC:USOIL',       res: 'W',  label: 'OIL Weekly'},
  {symbol: 'FX:EURUSD',       res: 'W',  label: 'EURUSD Weekly'},
  // MONTHLY
  {symbol: 'BITSTAMP:BTCUSD', res: 'M',  label: 'BTC Monthly'},
  {symbol: 'BATS:QQQ',        res: 'M',  label: 'QQQ Monthly'},
  {symbol: 'AMEX:SPY',        res: 'M',  label: 'SPY Monthly'},
  {symbol: 'TVC:GOLD',        res: 'M',  label: 'GOLD Monthly'},
  {symbol: 'TVC:USOIL',       res: 'M',  label: 'OIL Monthly'},
  // DAILY for comparison
  {symbol: 'BITSTAMP:BTCUSD', res: 'D',  label: 'BTC Daily'},
  {symbol: 'BATS:QQQ',        res: 'D',  label: 'QQQ Daily'},
  {symbol: 'TVC:GOLD',        res: 'D',  label: 'GOLD Daily'},
  {symbol: 'AMEX:SPY',        res: 'D',  label: 'SPY Daily'},
];

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  ☁️  CLOUD RIDER v2 — FULL BACKTEST');
console.log('═══════════════════════════════════════════════════════════════\n');
console.log('  Asset             Trades  WinRate   PF      W/L     DD%      P&L%     Sharpe   Range');
console.log('  ──────────────────────────────────────────────────────────────────────────────────────');

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

      // Strategy name check
      m.strat = t.includes('CLOUD RIDER') ? 'CR' : t.includes('VIPER') ? 'VIPER' : '?';

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
  results.push({label: test.label, symbol: test.symbol, res: test.res, ...m});

  if (m.trades !== '0' && parseInt(m.trades) > 0) {
    const pfNum = parseFloat(m.pf || 0);
    const wrNum = parseFloat(m.wr || '0');
    const marker = pfNum > 2.0 ? '★★★' : pfNum > 1.3 ? '★★ ' : pfNum > 1.0 ? '★  ' : '   ';
    console.log(`${marker} ${m.trades.padStart(5)} | ${(m.wr||'?').padStart(7)} | ${(m.pf||'?').padStart(6)} | ${(m.wl||'?').padStart(7)} | ${(m.dd||'?').padStart(8)} | ${(m.pnl||'?').padStart(8)} | ${(m.sharpe||'?').padStart(6)} | ${m.range || ''}`);
  } else {
    console.log(`   NO TRADES | [${m.strat}] ${m.range || ''}`);
  }

  const s = await c.Page.captureScreenshot({format:'png'});
  writeFileSync(`screenshots/cr2_${test.label.replace(/\s/g,'_')}.png`, Buffer.from(s.data, 'base64'));
}

// ═══════ SUMMARY ═══════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('═══════════════════════════════════════════════════════════════');

const withTrades = results.filter(r => parseInt(r.trades||0) > 0);
const profitable = withTrades.filter(r => parseFloat(r.pf||0) > 1.0);
const allWeekly = results.filter(r => r.res === 'W');
const allMonthly = results.filter(r => r.res === 'M');
const allDaily = results.filter(r => r.res === 'D');

const printGroup = (label, group) => {
  const gt = group.filter(r => parseInt(r.trades||0) > 0);
  const gp = gt.filter(r => parseFloat(r.pf||0) > 1.0);
  console.log(`\n  ${label} — ${gp.length}/${gt.length} profitable (${group.length} tested):`);
  for (const r of gt.sort((a,b) => parseFloat(b.pf||0) - parseFloat(a.pf||0))) {
    const status = parseFloat(r.pf||0) > 1.0 ? '✅' : '❌';
    console.log(`    ${status} ${r.label.padEnd(18)} PF ${(r.pf||'?').padEnd(6)} WR ${(r.wr||'?').padEnd(7)} ${r.trades} tr | DD ${r.dd||'?'} | P&L ${r.pnl||'?'}`);
  }
  const noTrades = group.filter(r => parseInt(r.trades||0) === 0);
  if (noTrades.length > 0) {
    console.log(`    ⬜ No trades: ${noTrades.map(r => r.label).join(', ')}`);
  }
};

printGroup('📅 WEEKLY', allWeekly);
printGroup('📆 MONTHLY', allMonthly);
printGroup('📊 DAILY', allDaily);

console.log(`\n  TOTAL: ${profitable.length}/${withTrades.length} profitable configs`);
if (profitable.length > 0) {
  const avgPF = profitable.reduce((s,r) => s + parseFloat(r.pf), 0) / profitable.length;
  const avgWR = profitable.reduce((s,r) => s + parseFloat(r.wr), 0) / profitable.length;
  console.log(`  Avg PF: ${avgPF.toFixed(2)} | Avg WR: ${avgWR.toFixed(1)}%`);
}

writeFileSync('cr2_results.json', JSON.stringify(results, null, 2));
console.log('\nResults saved to cr2_results.json');
await c.close();
process.exit(0);
