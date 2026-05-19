/**
 * Core batch execution logic.
 */
import { evaluate, evaluateAsync, getClient, getChartApi, getChartCollection } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }) {
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms || 2000;
  const results = [];

  let colPath, apiPath;
  try { colPath = await getChartCollection(); } catch {}
  try { apiPath = await getChartApi(); } catch {}

  for (const symbol of symbols) {
    for (const tf of tfs) {
      const combo = { symbol, timeframe: tf };
      try {
        if (colPath) await evaluate(`${colPath}.setSymbol('${symbol}')`);
        else if (apiPath) await evaluate(`${apiPath}.setSymbol('${symbol}')`);

        if (tf) {
          if (colPath) await evaluate(`${colPath}.setResolution('${tf}')`);
          else if (apiPath) await evaluate(`${apiPath}.setResolution('${tf}')`);
        }

        await waitForChartReady(symbol);
        await new Promise(r => setTimeout(r, delay));

        let actionResult;
        if (action === 'screenshot') {
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          const client = await getClient();
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = `batch_${symbol}_${tf || 'default'}_${ts}.png`;
          const filePath = join(SCREENSHOT_DIR, fname);
          writeFileSync(filePath, Buffer.from(data, 'base64'));
          actionResult = { file_path: filePath };
        } else if (action === 'get_ohlcv') {
          const limit = Math.min(ohlcv_count || 100, 500);
          // Read directly from the bars series — exportData() rejects on partially-loaded charts.
          actionResult = await evaluate(`
            (function() {
              try {
                var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
                if (!bars || typeof bars.lastIndex !== 'function') return { error: 'bars not ready' };
                var end = bars.lastIndex();
                var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
                var out = [];
                for (var i = start; i <= end; i++) {
                  var v = bars.valueAt(i);
                  if (v) out.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
                }
                var last = out[out.length - 1] || null;
                var first = out[0] || null;
                var summary = null;
                if (out.length > 1) {
                  var hi = -Infinity, lo = Infinity, vsum = 0;
                  for (var j = 0; j < out.length; j++) { if (out[j].high > hi) hi = out[j].high; if (out[j].low < lo) lo = out[j].low; vsum += out[j].volume; }
                  summary = { bars: out.length, high: hi, low: lo, first_close: first.close, last_close: last.close, change_pct: ((last.close / first.close - 1) * 100), avg_volume: vsum / out.length };
                }
                return { bar_count: out.length, last_bar: last, summary: summary };
              } catch (e) { return { error: e.message }; }
            })()
          `);
        } else if (action === 'quote_get') {
          // Use the hardcoded path directly — apiPath may have been undefined
          // at batch start if TV wasn't fully loaded yet, but by the time we
          // reach this loop iteration the chart is settled (waitForChartReady
          // returned).
          const apiPathInline = apiPath || 'window.TradingViewApi._activeChartWidgetWV.value()';
          actionResult = await evaluate(`
            (function() {
              try {
                var api = ${apiPathInline};
                var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
                var ext = {};
                try { ext = api.symbolExt() || {}; } catch(e) {}
                var sym = ''; try { sym = api.symbol() || ''; } catch(e) {}
                var q = { symbol: sym };
                if (bars && typeof bars.lastIndex === 'function') {
                  var v = bars.valueAt(bars.lastIndex());
                  if (v) { q.time = v[0]; q.open = v[1]; q.high = v[2]; q.low = v[3]; q.close = v[4]; q.last = v[4]; q.volume = v[5] || 0; }
                  if (bars.size() > 1) {
                    var prev = bars.valueAt(bars.lastIndex() - 1);
                    if (prev && v) { q.change = v[4] - prev[4]; q.change_pct = (v[4] / prev[4] - 1) * 100; }
                  }
                }
                if (ext.description) q.description = ext.description;
                if (ext.exchange) q.exchange = ext.exchange;
                if (ext.type) q.type = ext.type;
                return q;
              } catch (e) { return { error: e.message }; }
            })()
          `);
        } else if (action === 'get_strategy_results') {
          await new Promise(r => setTimeout(r, 1000));
          actionResult = await evaluate(`
            (function() {
              var metrics = {};
              var panel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
              if (!panel) return { error: 'Strategy Tester not found' };
              var items = panel.querySelectorAll('[class*="reportItem"], [class*="metric"]');
              items.forEach(function(item) {
                var label = item.querySelector('[class*="label"]');
                var value = item.querySelector('[class*="value"]');
                if (label && value) metrics[label.textContent.trim()] = value.textContent.trim();
              });
              return { metric_count: Object.keys(metrics).length, metrics: metrics };
            })()
          `);
        } else {
          actionResult = { error: 'Unknown action or API not available: ' + action };
        }
        results.push({ ...combo, success: true, result: actionResult });
      } catch (err) {
        results.push({ ...combo, success: false, error: err.message });
      }
    }
  }

  const successCount = results.filter(r => r.success).length;
  return { success: true, total_iterations: results.length, successful: successCount, failed: results.length - successCount, results };
}
