/**
 * Core chart control logic.
 */
import { evaluate, evaluateAsync, evaluateWrite, withWriteLock } from '../connection.js';
import { waitForChartReady } from '../wait.js';

// Local helper: evaluateAsync under the write mutex. setSymbol is the
// only write that awaits a promise inside the evaluation; everything
// else uses evaluateWrite() / withWriteLock() directly.
async function evaluateAsyncWrite(expression) {
  return evaluateWrite(expression, { awaitPromise: true });
}

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function getState() {
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol }) {
  await evaluateAsyncWrite(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol('${symbol.replace(/'/g, "\\'")}', {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  return { success: true, symbol, chart_ready: ready };
}

export async function setTimeframe({ timeframe }) {
  await evaluateWrite(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution('${timeframe.replace(/'/g, "\\'")}', {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type }) {
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluateWrite(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  // Multi-step write — before/after snapshot of study IDs around the
  // mutation must be inside the same critical section, otherwise a
  // concurrent add would corrupt the newIds diff.
  return withWriteLock(async (evalInside) => {
    if (action === 'add') {
      const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
      const before = await evalInside(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      await evalInside(`
        (function() {
          var chart = ${CHART_API};
          chart.createStudy('${indicator.replace(/'/g, "\\'")}', false, false, ${JSON.stringify(inputArr)});
        })()
      `);
      await new Promise(r => setTimeout(r, 1500));
      const after = await evalInside(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      const newIds = (after || []).filter(id => !(before || []).includes(id));
      return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
    } else if (action === 'remove') {
      if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
      await evalInside(`
        (function() {
          var chart = ${CHART_API};
          chart.removeEntity('${entity_id.replace(/'/g, "\\'")}');
        })()
      `);
      return { success: true, action: 'remove', entity_id };
    } else {
      throw new Error('action must be "add" or "remove"');
    }
  });
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to }) {
  // Multi-step: write the zoom, then read back the actual range for the
  // response. Both inside the mutex so a concurrent setVisibleRange
  // can't change the viewport between our write and our read-back.
  return withWriteLock(async (evalInside) => {
    await evalInside(`
      (function() {
        var chart = ${CHART_API};
        var m = chart._chartWidget.model();
        var ts = m.timeScale();
        var bars = m.mainSeries().bars();
        var startIdx = bars.firstIndex();
        var endIdx = bars.lastIndex();
        var fromIdx = startIdx, toIdx = endIdx;
        for (var i = startIdx; i <= endIdx; i++) {
          var v = bars.valueAt(i);
          if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
          if (v && v[0] <= ${to}) toIdx = i;
        }
        ts.zoomToBarsRange(fromIdx, toIdx);
      })()
    `);
    await new Promise(r => setTimeout(r, 500));
    const actual = await evalInside(`
      (function() {
        var chart = ${CHART_API};
        try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
        catch(e) { return { from: 0, to: 0, error: e.message }; }
      })()
    `);
    return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
  });
}

export async function scrollToDate({ date }) {
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  // Read-then-write sequence: resolution read must see the same
  // resolution the zoom write operates on. Lock both.
  return withWriteLock(async (evalInside) => {
    const resolution = await evalInside(`${CHART_API}.resolution()`);
    let secsPerBar = 60;
    const res = String(resolution);
    if (res === 'D' || res === '1D') secsPerBar = 86400;
    else if (res === 'W' || res === '1W') secsPerBar = 604800;
    else if (res === 'M' || res === '1M') secsPerBar = 2592000;
    else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

    const halfWindow = 25 * secsPerBar;
    const from = timestamp - halfWindow;
    const to = timestamp + halfWindow;

    await evalInside(`
      (function() {
        var chart = ${CHART_API};
        var m = chart._chartWidget.model();
        var ts = m.timeScale();
        var bars = m.mainSeries().bars();
        var startIdx = bars.firstIndex();
        var endIdx = bars.lastIndex();
        var fromIdx = startIdx, toIdx = endIdx;
        for (var i = startIdx; i <= endIdx; i++) {
          var v = bars.valueAt(i);
          if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
          if (v && v[0] <= ${to}) toIdx = i;
        }
        ts.zoomToBarsRange(fromIdx, toIdx);
      })()
    `);
    await new Promise(r => setTimeout(r, 500));
    return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
  });
}

export async function symbolInfo() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
