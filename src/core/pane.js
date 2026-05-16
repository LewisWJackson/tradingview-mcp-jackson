/**
 * Core pane/layout management logic.
 * Controls multi-chart layouts (split panes) in TradingView.
 */
import { evaluate, evaluateAsync, evaluateWrite, withWriteLock, getClient } from '../connection.js';

// Local helper: evaluateAsync under the write mutex.
async function evaluateAsyncWrite(expression) {
  return evaluateWrite(expression, { awaitPromise: true });
}

const CWC = 'window.TradingViewApi._chartWidgetCollection';

const LAYOUT_NAMES = {
  's': '1 chart',
  '2h': '2 horizontal',
  '2v': '2 vertical',
  '2-1': '2 top, 1 bottom',
  '1-2': '1 top, 2 bottom',
  '3h': '3 horizontal',
  '3v': '3 vertical',
  '3s': '3 custom',
  '4': '2x2 grid',
  '4h': '4 horizontal',
  '4v': '4 vertical',
  '4s': '4 custom',
  '6': '6 charts',
  '8': '8 charts',
  '10': '10 charts',
  '12': '12 charts',
  '14': '14 charts',
  '16': '16 charts',
};

/**
 * List all panes in the current layout with their symbols and index.
 */
export async function list() {
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var layoutType = cwc._layoutType;
      if (typeof layoutType === 'object' && layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();

      var all = cwc.getAll();
      var panes = [];
      for (var i = 0; i < all.length; i++) {
        try {
          var c = all[i];
          var model = c.model ? c.model() : null;
          var mainSeries = model ? model.mainSeries() : null;
          var sym = mainSeries ? mainSeries.symbol() : 'unknown';
          var res = mainSeries ? mainSeries.interval() : null;
          panes.push({ index: i, symbol: sym, resolution: res || null });
        } catch(e) { panes.push({ index: i, error: e.message }); }
      }

      // Check which pane is active
      var activeChart = window.TradingViewApi._activeChartWidgetWV.value();
      var activeIndex = null;
      for (var j = 0; j < all.length; j++) {
        try {
          if (all[j].model && activeChart._chartWidget && all[j] === activeChart._chartWidget) { activeIndex = j; break; }
        } catch(e) {}
      }

      return { layout: layoutType, chart_count: count, active_index: activeIndex, panes: panes };
    })()
  `);

  return {
    success: true,
    layout: result.layout,
    layout_name: LAYOUT_NAMES[result.layout] || result.layout,
    chart_count: result.chart_count,
    active_index: result.active_index,
    panes: result.panes,
  };
}

/**
 * Set the chart layout grid.
 * @param {string} layout - Layout code: s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8, etc.
 */
export async function setLayout({ layout }) {
  const code = layout.toLowerCase().replace(/\s+/g, '');

  // Map friendly names to codes
  const aliases = {
    'single': 's', '1': 's', '1x1': 's',
    '2x1': '2h', '1x2': '2v',
    '2x2': '4', 'grid': '4', 'quad': '4',
    '3x1': '3h', '1x3': '3v',
  };
  const resolved = aliases[code] || code;

  if (!LAYOUT_NAMES[resolved]) {
    const available = Object.entries(LAYOUT_NAMES).map(([k, v]) => `  ${k} — ${v}`).join('\n');
    throw new Error(`Unknown layout "${layout}". Available layouts:\n${available}`);
  }

  await evaluateAsyncWrite(`${CWC}.setLayout('${resolved}')`);
  await new Promise(r => setTimeout(r, 500));

  const state = await list();
  return {
    success: true,
    layout: resolved,
    layout_name: LAYOUT_NAMES[resolved],
    chart_count: state.chart_count,
    panes: state.panes,
  };
}

/**
 * Focus a specific pane by index.
 */
export async function focus({ index }) {
  const idx = Number(index);
  const result = await evaluateWrite(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      if (${idx} >= all.length) return { error: 'Pane index ' + ${idx} + ' out of range (have ' + all.length + ' panes)' };
      var chart = all[${idx}];
      // Click the main div to activate it
      if (chart._mainDiv) chart._mainDiv.click();
      return { focused: ${idx}, total: all.length };
    })()
  `);

  if (result?.error) throw new Error(result.error);
  return { success: true, focused_index: result.focused, total_panes: result.total };
}

/**
 * Set the symbol on a specific pane by index.
 * Works by focusing the pane, then using the active chart's setSymbol.
 */
export async function setSymbol({ index, symbol }) {
  const idx = Number(index);
  const escaped = symbol.replace(/'/g, "\\'");

  // Multi-step: focus pane → wait → set symbol on active chart. Lock
  // the whole thing so a concurrent setSymbol on a different pane index
  // can't steal focus between our focus() and setSymbol() calls. focus()
  // itself already locks via evaluateWrite, so we use withWriteLock here
  // and call the inner CDP eval directly to avoid double-locking.
  return withWriteLock(async (evalInside) => {
    // Inline focus logic (avoid recursive lock from focus())
    await evalInside(`
      (function() {
        var cwc = ${CWC};
        var all = cwc.getAll();
        if (${idx} >= all.length) throw new Error('Pane index ' + ${idx} + ' out of range (have ' + all.length + ' panes)');
        var chart = all[${idx}];
        if (chart._mainDiv) chart._mainDiv.click();
        return true;
      })()
    `);
    await new Promise(r => setTimeout(r, 300));
    await evalInside(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        return new Promise(function(resolve) {
          chart.setSymbol('${escaped}', {});
          setTimeout(resolve, 500);
        });
      })()
    `, { awaitPromise: true });
    return { success: true, index: idx, symbol };
  });
}
