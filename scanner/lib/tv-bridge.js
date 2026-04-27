/**
 * TradingView Bridge — self-contained CDP connection for scanner.
 * Does NOT depend on src/connection.js (which uses /json/list and hangs).
 * Uses browser-level WebSocket + Target.getTargets instead.
 */

import { evaluate, evaluateAsync, healthCheck, connect, disconnect } from './cdp-connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const BARS_PATH = 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()';

const SETTLE_DELAY = 2000;
const POLL_INTERVAL = 200;
const WAIT_TIMEOUT = 10000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Connection ---

export async function ensureConnection() {
  try {
    const h = await healthCheck();
    return { connected: true, ...h };
  } catch {
    try {
      await connect();
      return { connected: true };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  }
}

// --- Wait for chart ready ---

async function waitForChartReady(expectedSymbol = null, expectedTf = null) {
  const start = Date.now();
  let stableCount = 0;
  let lastBarCount = -1;

  while (Date.now() - start < WAIT_TIMEOUT) {
    try {
      const state = await evaluate(`
        (function() {
          var spinner = document.querySelector('[class*="loader"]')
            || document.querySelector('[class*="loading"]');
          var isLoading = spinner && spinner.offsetParent !== null;
          var barCount = 0;
          try {
            var bars = ${BARS_PATH};
            barCount = bars ? bars.size() : 0;
          } catch {}
          var currentSymbol = '';
          try { currentSymbol = ${CHART_API}.symbol(); } catch {}
          return { isLoading: !!isLoading, barCount: barCount, currentSymbol: currentSymbol };
        })()
      `);

      if (!state || state.isLoading) { stableCount = 0; await sleep(POLL_INTERVAL); continue; }
      if (expectedSymbol && state.currentSymbol) {
        // EXACT bare-symbol match — substring (.includes) yanlistir,
        // "BA" istegi "BABA"/"BIST:BA" gibi sembollerde false-positive uretir.
        const wantBare = bareOf(expectedSymbol);
        const gotBare = bareOf(state.currentSymbol);
        if (!gotBare || gotBare !== wantBare) {
          stableCount = 0; await sleep(POLL_INTERVAL); continue;
        }
      }
      if (state.barCount === lastBarCount && state.barCount > 0) stableCount++;
      else stableCount = 0;
      lastBarCount = state.barCount;
      if (stableCount >= 2) return true;
    } catch { /* ignore */ }
    await sleep(POLL_INTERVAL);
  }
  return false;
}

// --- Chart Control ---

export async function setSymbol(symbol) {
  const safeSymbol = JSON.stringify(symbol);
  // Strip exchange prefix for comparison (e.g. "BINANCE:BTCUSD" → "BTCUSD")
  const bareSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;

  for (let attempt = 0; attempt < 3; attempt++) {
    await evaluateAsync(`
      (function() {
        var chart = ${CHART_API};
        return new Promise(function(resolve) {
          chart.setSymbol(${safeSymbol}, {});
          setTimeout(resolve, 500);
        });
      })()
    `);
    await waitForChartReady(symbol);
    await sleep(SETTLE_DELAY);

    // Verify symbol actually changed
    const currentSymbol = await evaluate(`
      (function() {
        try { return ${CHART_API}.symbol(); } catch(e) { return ''; }
      })()
    `);

    // EXACT match on bare symbol (exchange-stripped) — .includes() is unsafe
    // because "BA" would falsely match "BABA", "BA.L", "BIST:BA" etc.
    if (currentSymbol) {
      const currentBare = currentSymbol.toUpperCase().includes(':')
        ? currentSymbol.toUpperCase().split(':')[1]
        : currentSymbol.toUpperCase();
      if (currentBare === bareSymbol.toUpperCase()) {
        return { success: true, symbol: currentSymbol };
      }
    }

    console.log(`[Bridge] setSymbol retry ${attempt + 1}: istenen=${symbol}, mevcut=${currentSymbol}`);
    await sleep(1500);
  }

  // Last resort — return FAILURE (caller MUST abort to avoid reading wrong-symbol data)
  console.log(`[Bridge] UYARI: setSymbol(${symbol}) dogrulanamadi — veri yanlis olabilir, sinyal atlanmali`);
  return { success: false, symbol, warning: 'Symbol degisimi dogrulanamadi' };
}

/**
 * Read the current chart symbol (bare, without exchange prefix) — used as a
 * post-read guard to verify that no concurrent symbol change slipped in
 * between bridge calls.
 */
export async function getCurrentBareSymbol() {
  const cur = await evaluate(`
    (function() {
      try { return ${CHART_API}.symbol(); } catch(e) { return ''; }
    })()
  `);
  if (!cur) return null;
  return cur.toUpperCase().includes(':')
    ? cur.toUpperCase().split(':')[1]
    : cur.toUpperCase();
}

/**
 * Normalize an arbitrary symbol string to its bare form for comparison.
 */
export function bareOf(symbol) {
  if (!symbol) return '';
  const s = String(symbol).toUpperCase();
  return s.includes(':') ? s.split(':')[1] : s;
}

export async function setTimeframe(tf) {
  const safeTf = JSON.stringify(tf);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeTf}, {});
    })()
  `);
  await waitForChartReady(null, tf);
  await sleep(SETTLE_DELAY);

  // Verify resolution changed
  const currentRes = await evaluate(`
    (function() {
      try { return ${CHART_API}.resolution(); } catch(e) { return ''; }
    })()
  `);
  if (currentRes && currentRes !== tf) {
    // Retry once
    await evaluate(`(function() { ${CHART_API}.setResolution(${safeTf}, {}); })()`);
    await sleep(SETTLE_DELAY);
  }

  return { success: true, timeframe: currentRes || tf };
}

export async function getChartState() {
  return evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return { symbol: chart.symbol(), resolution: chart.resolution(), chartType: chart.chartType(), studies: studies };
    })()
  `);
}

// --- Data Access ---

export async function getOhlcv(count = 100, summary = false, expectedSymbol = null) {
  const limit = Math.min(count, 500);
  // Atomik okuma: ayni JS contextinde hem symbol hem bars alinir — iki ayri
  // evaluate arasinda chart'in baska sembole gecmesi olasiligini ortadan kaldirir.
  const data = await evaluate(`
    (function() {
      var bars = ${BARS_PATH};
      if (!bars || typeof bars.lastIndex !== 'function') return null;
      var curSym = '';
      try { curSym = ${CHART_API}.symbol() || ''; } catch(e) {}
      var result = [];
      var end = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
      for (var i = start; i <= end; i++) {
        var v = bars.valueAt(i);
        if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
      }
      return {bars: result, total_bars: bars.size(), _symbolAtRead: curSym};
    })()
  `);
  if (!data) return data;
  if (expectedSymbol) {
    const got = bareOf(data._symbolAtRead);
    const want = bareOf(expectedSymbol);
    if (got && want && got !== want) {
      console.log(`[Bridge] getOhlcv symbol uyumsuzlugu: istenen=${want}, mevcut=${got} — veri REDDEDILDI`);
      return { bars: [], total_bars: 0, _symbolMismatch: true, _expected: want, _got: got };
    }
  }
  return data;
}

/**
 * Get a lightweight snapshot of the current bars collection.
 * Used to detect data changes after symbol/TF switches.
 */
export async function getBarSnapshot() {
  return evaluate(`
    (function() {
      var bars = ${BARS_PATH};
      if (!bars || typeof bars.lastIndex !== 'function') return null;
      var end = bars.lastIndex();
      var start = bars.firstIndex();
      var lastV = bars.valueAt(end);
      var firstV = bars.valueAt(start);
      return {
        count: bars.size(),
        firstTime: firstV ? firstV[0] : null,
        lastTime: lastV ? lastV[0] : null,
        lastClose: lastV ? lastV[4] : null,
      };
    })()
  `);
}

/**
 * Wait until the bars collection actually changes compared to a previous snapshot.
 * This is a DATA-LEVEL ready check (not DOM-level like waitForChartReady).
 */
export async function waitForDataChange(prevSnapshot, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await getBarSnapshot();
    if (current && prevSnapshot) {
      const changed = current.firstTime !== prevSnapshot.firstTime
        || current.lastTime !== prevSnapshot.lastTime
        || current.count !== prevSnapshot.count;
      if (changed) return { changed: true, snapshot: current };
    } else if (current && !prevSnapshot) {
      return { changed: true, snapshot: current };
    }
    await sleep(POLL_INTERVAL);
  }
  return { changed: false, snapshot: await getBarSnapshot() };
}

/**
 * Parse timeframe string to seconds.
 */
function parseTFToSeconds(tf) {
  // 'M' (buyuk) = ay, 'm' (kucuk) = dakika ayrimi korunur. Eski kod toUpperCase
  // yapip '1m'i '1M'e cevirip ay sayiyordu → maxAge 30 gun, staleness check'i devre disi.
  const raw = String(tf);
  const s = raw.toUpperCase();
  if (s === '1D' || s === 'D') return 86400;
  if (s === '1W' || s === 'W') return 604800;
  // Ay yalniz buyuk M ile (TradingView konvansiyonu)
  if (raw === '1M' || raw === 'M') return 2592000;
  const n = parseInt(s, 10);
  if (isNaN(n)) return 3600; // fallback 1h
  if (s.includes('H')) return n * 3600;
  // 'm' suffix veya cıplak sayı → dakika
  return n * 60;
}

/**
 * getOhlcv with staleness validation based on bar timestamps.
 * Returns data with a `stale` flag if last bar is too old for the given TF.
 */
export async function getOhlcvValidated(count = 100, timeframe = '60', expectedSymbol = null) {
  const data = await getOhlcv(count, false, expectedSymbol);
  if (data && data._symbolMismatch) {
    return { ...data, stale: true, lastBarAge: Infinity, symbolMismatch: true };
  }
  if (!data?.bars?.length) return { ...data, stale: true, lastBarAge: Infinity };

  const lastBarTime = data.bars[data.bars.length - 1].time;
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSec - lastBarTime;

  const tfSeconds = parseTFToSeconds(timeframe);
  // Allow up to 3x the TF interval (e.g., 30m TF → last bar within 90 min)
  const maxAge = tfSeconds * 3;

  return { ...data, stale: ageSeconds > maxAge, lastBarAge: ageSeconds, lastBarTimestamp: lastBarTime };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = ${CHART_API}._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return data || [];
}

// --- Quote / Price ---

/**
 * Get current quote (last price, high, low, volume) — does NOT depend on chart TF.
 * More reliable than getOhlcv for current price.
 */
export async function getQuote(expectedSymbol = null) {
  const data = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var model = chart.model();
        var series = model.mainSeries();
        var quote = series.symbolInfo();
        var bars = series.bars();
        var lastIdx = bars.lastIndex();
        var lastBar = bars.valueAt(lastIdx);
        return {
          symbol: quote ? (quote.name || quote.ticker || '') : '',
          last: lastBar ? lastBar[4] : null,
          open: lastBar ? lastBar[1] : null,
          high: lastBar ? lastBar[2] : null,
          low: lastBar ? lastBar[3] : null,
          close: lastBar ? lastBar[4] : null,
          volume: lastBar ? (lastBar[5] || 0) : null,
        };
      } catch(e) {
        return null;
      }
    })()
  `);
  if (!data) return data;
  if (expectedSymbol) {
    const got = bareOf(data.symbol);
    const want = bareOf(expectedSymbol);
    if (got && want && got !== want) {
      console.log(`[Bridge] getQuote symbol uyumsuzlugu: istenen=${want}, mevcut=${got} — REDDEDILDI`);
      return { ...data, _symbolMismatch: true, last: null, close: null };
    }
  }
  return data;
}

/**
 * Get the last price for a symbol WITHOUT changing chart.
 * Falls back to getOhlcv if quote fails.
 */
export async function getLastPrice(symbol) {
  // setSymbol dogrulanamadiysa (success:false) chart hala eski sembolde olabilir;
  // bu durumda yanlis-sembol fiyati donmesin.
  const sw = await setSymbol(symbol);
  if (sw && sw.success === false) return null;
  const quote = await getQuote(symbol);
  if (quote && !quote._symbolMismatch && quote.last && quote.last > 0) return quote.last;
  // Fallback — expectedSymbol ile guard'li
  const ohlcv = await getOhlcv(1, false, symbol);
  if (ohlcv && !ohlcv._symbolMismatch && ohlcv.bars && ohlcv.bars.length > 0) {
    return ohlcv.bars[ohlcv.bars.length - 1].close;
  }
  return null;
}

// --- Pine Graphics (labels, tables, boxes, lines) ---

function buildGraphicsJS(collectionName, mapKey, filter) {
  const safeFilter = JSON.stringify(filter || '');
  return `
    (function() {
      var chart = ${CHART_API}._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeFilter};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getPineTables(filter) {
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return [];

  return raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
}

export async function getPineLabels(filter) {
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return [];

  return raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      return { text: v.t || '', price: v.y != null ? Math.round(v.y * 100) / 100 : null };
    }).filter(l => l.text || l.price != null);
    if (labels.length > 50) labels = labels.slice(-50);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
}

export async function getPineBoxes(filter) {
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return [];

  return raw.map(s => {
    const zones = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (high != null && low != null) zones.push({ high, low });
    }
    return { name: s.name, total_boxes: s.count, zones };
  });
}

export async function getPineLines(filter) {
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return [];

  return raw.map(s => {
    const hLevels = [];
    const seen = {};
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      // Yatay cizgi tespiti: float esitlik yerine fiyatin ~%0.01'i kadar epsilon.
      // Tam yatay cizilenler bile renderda kucuk float drift gosterebiliyor.
      const isHorizontal = v.y1 != null && v.y2 != null
        && Math.abs(v.y1 - v.y2) <= Math.max(Math.abs(v.y1), 1e-9) * 0.0001;
      if (y1 != null && isHorizontal && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    return { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
  });
}

// --- Composite Reads ---

export async function readKhanSaab() {
  const [tables, labels, lines] = await Promise.all([
    getPineTables('Sniper').catch(() => []),
    getPineLabels('Sniper').catch(() => []),
    getPineLines('Sniper').catch(() => []),
  ]);
  return { tables, labels, lines };
}

export async function readSMC() {
  // getPineX() bos sonucta throw ETMEZ → bos array doner. Eski .catch fallback'i
  // hicbir zaman tetiklenmiyordu. LuxAlgo fallback'i bos sonuc kontrolu ile yap.
  async function tryBoth(fn) {
    try {
      const primary = await fn('Smart Money');
      if (Array.isArray(primary) && primary.length > 0) return primary;
    } catch { /* ignore */ }
    try {
      const fallback = await fn('LuxAlgo');
      return Array.isArray(fallback) ? fallback : [];
    } catch { return []; }
  }
  const [labels, boxes, lines] = await Promise.all([
    tryBoth(getPineLabels),
    tryBoth(getPineBoxes),
    tryBoth(getPineLines),
  ]);
  return { labels, boxes, lines };
}

export async function takeScreenshot() {
  // Minimal screenshot via CDP Page.captureScreenshot
  return { success: false, note: 'Screenshot not supported in scanner mode' };
}

// --- Indicator Management (Free TradingView: max 2 indicators) ---

/**
 * Get list of currently loaded indicators with their entity IDs.
 */
export async function getIndicators() {
  const data = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = chart.getAllStudies();
      return studies.map(function(s) {
        return { id: s.id, name: s.name || s.title || 'unknown' };
      });
    })()
  `);
  return data || [];
}

/**
 * Add an indicator by full name. Returns the new entity ID.
 * TradingView requires FULL names: "Relative Strength Index" not "RSI".
 */
export async function addIndicator(fullName, inputs) {
  const safeName = JSON.stringify(fullName);
  const safeInputs = JSON.stringify(inputs || []);

  const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.createStudy(${safeName}, false, false, ${safeInputs});
    })()
  `);
  await sleep(2000);

  const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
  const newIds = (after || []).filter(id => !(before || []).includes(id));

  return { success: newIds.length > 0, entityId: newIds[0] || null, allStudies: after };
}

/**
 * Remove an indicator by entity ID.
 */
export async function removeIndicator(entityId) {
  const safeId = JSON.stringify(entityId);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.removeEntity(${safeId});
    })()
  `);
  await sleep(500);
  return { success: true, removed: entityId };
}

/**
 * Indicator slot manager for free TradingView (2 indicator limit).
 * Ensures the required indicators are loaded, swapping out others if needed.
 *
 * @param {string[]} requiredNames - Full indicator names needed (max 2)
 * @param {Object} inputOverrides - Optional: { "Indicator Name": [inputs] }
 * @returns {Object} - { loaded: [{name, entityId}], removed: [entityId] }
 */
export async function ensureIndicators(requiredNames, inputOverrides = {}) {
  const current = await getIndicators();
  const loaded = [];
  const removed = [];

  // Check which required indicators are already loaded
  const alreadyLoaded = [];
  const needToAdd = [];

  for (const reqName of requiredNames) {
    const match = current.find(s =>
      s.name.toLowerCase().includes(reqName.toLowerCase()) ||
      reqName.toLowerCase().includes(s.name.toLowerCase())
    );
    if (match) {
      alreadyLoaded.push({ name: reqName, entityId: match.id });
    } else {
      needToAdd.push(reqName);
    }
  }

  // If we need to add indicators and we're at/over the limit, remove extras
  const maxIndicators = 2;
  const slotsAvailable = maxIndicators - alreadyLoaded.length;
  const slotsNeeded = needToAdd.length;

  if (slotsNeeded > slotsAvailable) {
    // Remove indicators that are NOT in our required list
    const toRemove = current.filter(s =>
      !alreadyLoaded.some(al => al.entityId === s.id)
    );
    const removeCount = slotsNeeded - slotsAvailable;
    for (let i = 0; i < Math.min(removeCount, toRemove.length); i++) {
      await removeIndicator(toRemove[i].id);
      removed.push(toRemove[i].id);
    }
  }

  // Add needed indicators
  for (const name of needToAdd) {
    const inputs = inputOverrides[name] || [];
    const result = await addIndicator(name, inputs);
    if (result.success) {
      loaded.push({ name, entityId: result.entityId });
    }
  }

  return {
    loaded: [...alreadyLoaded, ...loaded],
    removed,
    current: await getIndicators(),
  };
}

/**
 * Indicator presets for different scan modes.
 */
export const INDICATOR_PRESETS = {
  // Short-term: KhanSaab Sniper + Smart Money Concepts
  shortTerm: [
    // These are custom indicators — they may already be loaded
    // If not, the user needs them on their chart
    // We'll check and warn if missing
  ],
  // Long-term: Supertrend + IFCCI
  longTerm: [
    { name: 'Supertrend', fullName: 'Supertrend', inputs: [10, 5.0] },
    { name: 'IFCCI', fullName: 'Inverse Fisher Transform on CCI', inputs: [89] },
  ],
  // Extra indicators that can be swapped in temporarily
  extras: {
    rsi: { fullName: 'Relative Strength Index', inputs: [14] },
    macd: { fullName: 'MACD', inputs: [12, 26, 9] },
    ema9: { fullName: 'Moving Average Exponential', inputs: [9] },
    ema21: { fullName: 'Moving Average Exponential', inputs: [21] },
    bb: { fullName: 'Bollinger Bands', inputs: [20, 2] },
    adx: { fullName: 'Average Directional Index', inputs: [14] },
    vwap: { fullName: 'Volume Weighted Average Price', inputs: [] },
    atr: { fullName: 'Average True Range', inputs: [14] },
  },
};

/**
 * Setup indicators for a scan mode. Checks if required custom indicators
 * are present and swaps built-in indicators as needed.
 */
export async function setupIndicatorsForScan(mode) {
  const current = await getIndicators();
  const warnings = [];

  if (mode === 'short') {
    // Check for Smart Money Concepts
    const hasSMC = current.some(s => s.name.toLowerCase().includes('smart money') || s.name.toLowerCase().includes('luxalgo'));
    if (!hasSMC) warnings.push('Smart Money Concepts indikatoru bulunamadi — ekleyin veya grafikte gorunur yapin');

    return { mode: 'short', indicators: current, warnings };
  }

  if (mode === 'long') {
    // For long-term, we need Supertrend + IFCCI
    // Try to ensure they're loaded
    const hasST = current.some(s => s.name.toLowerCase().includes('supertrend'));
    const hasIFCCI = current.some(s =>
      s.name.toLowerCase().includes('inverse fisher') ||
      s.name.toLowerCase().includes('ifcci') ||
      s.name.toLowerCase().includes('cci')
    );

    const needed = [];
    if (!hasST) needed.push('Supertrend');
    if (!hasIFCCI) needed.push('Inverse Fisher Transform on CCI');

    if (needed.length > 0) {
      const result = await ensureIndicators(needed, {
        'Supertrend': [10, 5.0],
        'Inverse Fisher Transform on CCI': [89],
      });
      return { mode: 'long', indicators: result.current, swapped: result, warnings };
    }

    return { mode: 'long', indicators: current, warnings };
  }

  return { mode, indicators: current, warnings };
}

/**
 * Temporarily add an extra indicator, read its values, then remove it.
 * Useful when you need RSI/MACD/etc. data but have 2 slots occupied.
 */
export async function readWithTempIndicator(indicatorKey) {
  const preset = INDICATOR_PRESETS.extras[indicatorKey];
  if (!preset) return { error: `Unknown indicator: ${indicatorKey}` };

  const current = await getIndicators();

  // If already loaded, just read
  const existing = current.find(s =>
    s.name.toLowerCase().includes(preset.fullName.toLowerCase().split(' ')[0].toLowerCase())
  );
  if (existing) {
    const values = await getStudyValues();
    return { values, alreadyLoaded: true };
  }

  // Need to temporarily add — remove last non-essential indicator
  let removedIndicator = null;
  if (current.length >= 2) {
    // Remove the last indicator temporarily
    const toRemove = current[current.length - 1];
    await removeIndicator(toRemove.id);
    removedIndicator = toRemove;
  }

  // Add the temp indicator
  const addResult = await addIndicator(preset.fullName, preset.inputs);
  await sleep(1500); // Wait for data to load

  // Read values
  const values = await getStudyValues();

  // Remove temp indicator
  if (addResult.entityId) {
    await removeIndicator(addResult.entityId);
  }

  // Restore the removed indicator
  if (removedIndicator) {
    await addIndicator(removedIndicator.name, []);
    await sleep(1000);
  }

  return { values, tempRead: true, indicatorKey };
}
