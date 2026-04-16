import {writeFileSync} from 'fs';
import CDP from 'chrome-remote-interface';

const c = await CDP({host:'localhost', port:9222});
await c.Runtime.enable();

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
  // Switch symbol
  await c.Runtime.evaluate({expression: `(function(){ var ch = window.TradingViewApi._activeChartWidgetWV.value(); ch.setSymbol('${sym.id}'); ch.setResolution('D'); })()`});
  await new Promise(r => setTimeout(r, 6000));

  // Extract OHLCV from chart header text and use basic chart API
  const data = await c.Runtime.evaluate({expression: `
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var r = {};
        r.symbol = chart.symbol();
        r.resolution = chart.resolution();

        // Read OHLCV from header
        var headerEls = document.querySelectorAll('[class*="valuesWrapper"], [class*="headerRow"]');
        var headerText = '';
        for (var i = 0; i < headerEls.length; i++) {
          headerText += headerEls[i].textContent + ' ';
        }
        r.headerRaw = headerText.substring(0, 500);

        // Try to parse OHLC from header
        var oMatch = headerText.match(/O([\\d,.]+)/);
        var hMatch = headerText.match(/H([\\d,.]+)/);
        var lMatch = headerText.match(/L([\\d,.]+)/);
        var cMatch = headerText.match(/C([\\d,.]+)/);
        r.open = oMatch ? parseFloat(oMatch[1].replace(/,/g,'')) : null;
        r.high = hMatch ? parseFloat(hMatch[1].replace(/,/g,'')) : null;
        r.low = lMatch ? parseFloat(lMatch[1].replace(/,/g,'')) : null;
        r.close = cMatch ? parseFloat(cMatch[1].replace(/,/g,'')) : null;

        // Get visible price range
        var range = chart.getVisibleRange();
        r.visibleFrom = new Date(range.from * 1000).toISOString().slice(0, 10);
        r.visibleTo = new Date(range.to * 1000).toISOString().slice(0, 10);

        // Try to read price scale labels on the right side for support/resistance
        var priceLabels = document.querySelectorAll('[class*="price-axis"] text, [class*="priceAxisLabel"]');
        r.priceLabelsCount = priceLabels.length;

        return r;
      } catch(e) { return {error: e.message}; }
    })()
  `, returnByValue: true});

  const m = data.result.value;
  allData[sym.label] = m;
  console.log(`${sym.label}: ${m.symbol} | O:${m.open} H:${m.high} L:${m.low} C:${m.close}`);

  // Take screenshot
  const s = await c.Page.captureScreenshot({format:'png'});
  writeFileSync(`screenshots/scan2_${sym.label}_D.png`, Buffer.from(s.data, 'base64'));
}

writeFileSync('price_data.json', JSON.stringify(allData, null, 2));
console.log('\nDone. Saved to price_data.json');
await c.close();
process.exit(0);
