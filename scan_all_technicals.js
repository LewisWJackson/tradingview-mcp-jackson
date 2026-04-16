import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import CDP from 'chrome-remote-interface';
import {setSource, ensurePineEditorOpen} from './src/core/pine.js';

try { mkdirSync('screenshots', {recursive: true}); } catch(e) {}

const c = await CDP({host:'localhost', port:9222});
await c.Runtime.enable();

// Deploy the scanner indicator
console.log('Deploying TECH SCANNER indicator...');
const pine = readFileSync('technicals_indicator.pine', 'utf8');
await setSource({source: pine});

// Ctrl+Enter to add to chart
await c.Input.dispatchKeyEvent({type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13});
await c.Input.dispatchKeyEvent({type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2});
await new Promise(r => setTimeout(r, 5000));
console.log('Scanner deployed.\n');

const symbols = [
  {id: 'BITSTAMP:BTCUSD', label: 'BTC'},
  {id: 'BATS:QQQ',        label: 'QQQ'},
  {id: 'BITSTAMP:ETHUSD', label: 'ETH'},
  {id: 'TVC:GOLD',        label: 'GOLD'},
  {id: 'TVC:SILVER',      label: 'SILVER'},
  {id: 'TVC:USOIL',       label: 'OIL'},
];

const allData = {};

for (const sym of symbols) {
  console.log(`=== ${sym.label} ===`);
  await c.Runtime.evaluate({expression: `(function(){ var ch = window.TradingViewApi._activeChartWidgetWV.value(); ch.setSymbol('${sym.id}'); ch.setResolution('D'); })()`});
  await new Promise(r => setTimeout(r, 8000));

  // Read the table from the DOM — look for the SCAN table text
  const data = await c.Runtime.evaluate({expression: `
    (function() {
      // Find all table cells in the chart area
      var tables = document.querySelectorAll('table');
      for (var t = 0; t < tables.length; t++) {
        var text = tables[t].textContent;
        if (text.includes('SCAN') && text.includes('EMA9')) {
          // Parse key-value pairs from table cells
          var cells = tables[t].querySelectorAll('td');
          var data = {};
          for (var i = 0; i < cells.length - 1; i += 2) {
            var key = cells[i].textContent.trim();
            var val = cells[i+1].textContent.trim();
            if (key && val) data[key] = val;
          }
          return data;
        }
      }
      // Fallback: search all text
      var body = document.body.textContent;
      var scanIdx = body.indexOf('SCAN');
      if (scanIdx > -1) {
        return {raw: body.substring(scanIdx, scanIdx + 1000)};
      }
      return {error: 'SCAN table not found'};
    })()
  `, returnByValue: true});

  const m = data.result.value;
  allData[sym.label] = m;

  if (m.CLOSE) {
    console.log(`  Close: ${m.CLOSE} | Trend: ${m.TREND}`);
    console.log(`  EMA9: ${m.EMA9} | EMA21: ${m.EMA21} | EMA50: ${m.EMA50} | EMA200: ${m.EMA200}`);
    console.log(`  RSI: ${m.RSI14} | ADX: ${m.ADX} | MACD: ${m.MACD} / ${m.MACD_SIG} / ${m.MACD_HIST}`);
    console.log(`  ATR: ${m.ATR14} | Vol Ratio: ${m.VOL_RATIO} | Above 200: ${m.ABOVE_200}`);
    console.log(`  52W Range: ${m['52W_LOW']} — ${m['52W_HIGH']} | From High: ${m.PCT_FROM_HIGH}% | From Low: ${m.PCT_FROM_LOW}%`);
    console.log(`  BB Width: ${m.BB_WIDTH} | Stoch: ${m.STOCH_K}`);
  } else if (m.raw) {
    console.log(`  Raw: ${m.raw.substring(0, 200)}`);
  } else {
    console.log(`  ${JSON.stringify(m)}`);
  }

  const s = await c.Page.captureScreenshot({format:'png'});
  writeFileSync(`screenshots/scan_${sym.label}_D.png`, Buffer.from(s.data, 'base64'));
}

writeFileSync('technicals_data.json', JSON.stringify(allData, null, 2));
console.log('\n\nAll technicals saved to technicals_data.json');
await c.close();
process.exit(0);
