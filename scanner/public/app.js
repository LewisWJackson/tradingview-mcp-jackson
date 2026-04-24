/**
 * TV Scanner — Frontend Application
 * Uses safe DOM manipulation (no innerHTML with untrusted data).
 */

// --- Utility: Safe DOM helpers ---
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'textContent') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else node.setAttribute(k, v);
    }
  }
  if (children) {
    for (const child of (Array.isArray(children) ? children : [children])) {
      if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else if (child) node.appendChild(child);
    }
  }
  return node;
}

function text(str) { return document.createTextNode(str); }

// --- WebSocket ---
let ws;
let reconnectTimer;

function connectWS() {
  ws = new WebSocket('ws://' + location.host);

  ws.onopen = function() {
    addLog('info', 'WebSocket baglantisi kuruldu');
    clearTimeout(reconnectTimer);
  };

  ws.onmessage = function(e) {
    try {
      const data = JSON.parse(e.data);
      handleWSMessage(data);
    } catch (err) { /* ignore parse errors */ }
  };

  ws.onclose = function() {
    addLog('error', 'WebSocket baglantisi kesildi');
    reconnectTimer = setTimeout(connectWS, 3000);
  };
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'status':
      updateStatus(data.data);
      break;
    case 'scheduler_status':
      updateSchedulerUI(data.status);
      break;
    case 'scan_start':
      showScanning((data.category || '') + ' taraniyor...');
      addLog('info', 'Tarama basladi: ' + (data.category || '') + ' (' + (data.mode || 'short') + ')');
      break;
    case 'scan_complete':
      hideScanning();
      if (data.result) displayResult(data.result);
      addLog('success', 'Tarama tamamlandi: ' + (data.category || '') + ' — ' + ((data.result && data.result.signals) ? data.result.signals.length : 0) + ' sinyal');
      break;
    case 'scan_error':
      hideScanning();
      addLog('error', 'Tarama hatasi: ' + (data.category || '') + ' — ' + (data.error || ''));
      break;
    case 'signal_alert':
      if (data.signals) {
        data.signals.forEach(function(sig) {
          addLog('signal', 'SINYAL: ' + sig.symbol + ' ' + sig.grade + '-' + (sig.direction || '').toUpperCase() + ' (' + (sig.timeframe || '') + ')');
        });
      }
      break;
    case 'signal_resolved':
      if (data.signal) {
        var s = data.signal;
        var outcomeColor = s.win ? 'success' : 'error';
        addLog(outcomeColor, 'SONUC: ' + s.symbol + ' ' + s.grade + '-' + (s.direction || '').toUpperCase() + ' → ' + s.outcome + ' (RR: ' + (s.actualRR || '?') + ')');
        refreshLearningStatus();
      }
      break;
    case 'weights_updated':
      if (data.data) {
        addLog('info', 'OGRENME: ' + (data.data.message || 'Agirliklar guncellendi'));
        if (data.data.changes) {
          data.data.changes.forEach(function(c) { addLog('info', '  → ' + c); });
        }
        refreshLearningStatus();
      }
      break;
    case 'learning_status':
      if (data.data) updateLearningPanel(data.data);
      break;
  }
}

// --- UI Update Functions ---

function updateStatus(status) {
  var tvDot = document.getElementById('tvStatus');
  var tvText = document.getElementById('tvStatusText');
  var schDot = document.getElementById('schedulerStatus');
  var schText = document.getElementById('schedulerStatusText');

  tvDot.className = 'status-dot online';
  tvText.textContent = 'TV Bagli';

  if (status && status.running) {
    schDot.className = 'status-dot online';
    schText.textContent = 'Oto-Tarama Aktif';
  } else {
    schDot.className = 'status-dot offline';
    schText.textContent = 'Oto-Tarama Kapali';
  }
}

function updateSchedulerUI(status) {
  var schDot = document.getElementById('schedulerStatus');
  var schText = document.getElementById('schedulerStatusText');
  if (status === 'started') {
    schDot.className = 'status-dot online';
    schText.textContent = 'Oto-Tarama Aktif';
    addLog('success', 'Otomatik tarama baslatildi');
  } else {
    schDot.className = 'status-dot offline';
    schText.textContent = 'Oto-Tarama Kapali';
    addLog('info', 'Otomatik tarama durduruldu');
  }
}

function addLog(type, message) {
  var panel = document.getElementById('logPanel');
  var entry = el('div', { className: 'log-entry ' + type });
  var time = new Date().toLocaleTimeString('tr-TR');
  entry.appendChild(el('span', { className: 'time', textContent: time + ' ' }));
  entry.appendChild(text(message));
  panel.insertBefore(entry, panel.firstChild);

  while (panel.children.length > 100) {
    panel.removeChild(panel.lastChild);
  }
}

function showScanning(msg) {
  document.getElementById('scanningOverlay').classList.remove('hidden');
  document.getElementById('scanningText').textContent = msg;
}

function hideScanning() {
  document.getElementById('scanningOverlay').classList.add('hidden');
}

// --- Display Results ---

function displayResult(result) {
  var panel = document.getElementById('centerPanel');
  var empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';

  if (result.results && Array.isArray(result.results)) {
    displayBatchResult(result);
    return;
  }
  if (result.totalTrades !== undefined) {
    displayBacktestResult(result);
    return;
  }
  // Long-term multi-TF results have .timeframes object
  if (result.mode === 'long' && result.tfSignals) {
    displaySignalCard(result, panel);
    return;
  }
  displaySignalCard(result, panel);
}

function fmt(v) {
  return v ? Number(v).toFixed(2) : '—';
}

function displaySignalCard(sig, container) {
  if (!container) container = document.getElementById('centerPanel');

  var card = el('div', { className: 'signal-card grade-' + (sig.grade || 'IPTAL') });

  // Header
  var header = el('div', { className: 'signal-header' });
  var headerLeft = el('div');
  headerLeft.appendChild(el('span', { className: 'signal-symbol', textContent: sig.symbol || '?' }));
  var dirClass = sig.direction === 'long' ? 'long' : 'short';
  var dirText = sig.direction === 'long' ? 'LONG' : sig.direction === 'short' ? 'SHORT' : '—';
  headerLeft.appendChild(el('span', { className: 'signal-direction ' + dirClass, textContent: dirText }));
  headerLeft.appendChild(el('span', { textContent: ' ' + (sig.timeframe || ''), style: { fontSize: '11px', color: '#8b949e', marginLeft: '8px' } }));
  header.appendChild(headerLeft);

  var gradeText = (sig.grade || 'IPTAL') + (sig.position_pct ? ' (%' + sig.position_pct + ')' : '');
  header.appendChild(el('span', { className: 'signal-grade', textContent: gradeText }));
  card.appendChild(header);

  // Bias row
  var biasRow = el('div', { className: 'signal-row' });
  biasRow.appendChild(el('span', { className: 'label', textContent: 'Bias' }));
  biasRow.appendChild(el('span', { className: 'value', textContent: sig.khanSaabBias || '—' }));
  card.appendChild(biasRow);

  // R:R row
  var rrRow = el('div', { className: 'signal-row' });
  rrRow.appendChild(el('span', { className: 'label', textContent: 'R:R' }));
  rrRow.appendChild(el('span', { className: 'value', textContent: sig.rr || '—' }));
  card.appendChild(rrRow);


  // Formations
  if (sig.formations && sig.formations.length > 0) {
    sig.formations.forEach(function(f) {
      var fRow = el('div', { className: 'signal-row' });
      fRow.appendChild(el('span', { className: 'label', textContent: 'Formasyon' }));
      var tfInfo = f.tfLabel ? ' [' + f.tfLabel + ']' : '';
      fRow.appendChild(el('span', { className: 'value', textContent: f.name + tfInfo + ' | Olgunluk: %' + f.maturity + ' | Kirilim: ' + (f.broken ? 'Evet' : 'Hayir') }));
      card.appendChild(fRow);
    });
  }
  if (sig.candles && sig.candles.length > 0) {
    var cRow = el('div', { className: 'signal-row' });
    cRow.appendChild(el('span', { className: 'label', textContent: 'Mum' }));
    cRow.appendChild(el('span', { className: 'value', textContent: sig.candles.map(function(c) { return c.name; }).join(', ') }));
    card.appendChild(cRow);
  }

  // Price levels
  if (sig.entry) {
    var levels = el('div', { className: 'signal-levels' });
    var labels = ['Entry', 'SL', 'TP1', 'TP2', 'TP3'];
    var values = [sig.entry, sig.sl, sig.tp1, sig.tp2, sig.tp3];
    var classes = ['entry', 'sl', 'tp', 'tp', 'tp'];
    for (var i = 0; i < labels.length; i++) {
      var box = el('div', { className: 'level-box' });
      box.appendChild(el('div', { className: 'lbl', textContent: labels[i] }));
      box.appendChild(el('div', { className: 'val ' + classes[i], textContent: fmt(values[i]) }));
      levels.appendChild(box);
    }
    card.appendChild(levels);
  }

  // Transition Directive (signal history awareness)
  if (sig.transitionDirective) {
    var td = sig.transitionDirective;
    var tdColor = td.type === 'REVERSE' ? 'var(--red)' : td.type === 'REINFORCE' ? 'var(--green)' : td.type === 'CLOSE_AND_WAIT' ? 'var(--yellow)' : 'var(--blue)';
    var tdDiv = el('div', { style: { margin: '8px 0', padding: '10px', background: 'rgba(88,166,255,0.08)', border: '1px solid ' + tdColor, borderRadius: '6px' } });
    tdDiv.appendChild(el('div', { textContent: 'POZISYON YONETIMI: ' + td.type, style: { fontSize: '11px', fontWeight: 'bold', color: tdColor, marginBottom: '4px' } }));
    tdDiv.appendChild(el('div', { textContent: td.message, style: { fontSize: '11px', color: 'var(--text)', lineHeight: '1.4' } }));
    if (td.previousSignal) {
      tdDiv.appendChild(el('div', { textContent: 'Onceki: ' + td.previousSignal.grade + '-' + (td.previousSignal.direction || '').toUpperCase() + ' @ ' + (td.previousSignal.entry ? td.previousSignal.entry.toFixed(2) : '?') + ' (' + new Date(td.previousSignal.createdAt).toLocaleString('tr-TR') + ')', style: { fontSize: '10px', color: 'var(--text2)', marginTop: '4px' } }));
    }
    card.appendChild(tdDiv);
  }

  // Warnings
  if (sig.warnings && sig.warnings.length > 0) {
    var warnDiv = el('div', { style: { margin: '8px 0' } });
    sig.warnings.forEach(function(w) {
      warnDiv.appendChild(el('span', { className: 'warning-tag', textContent: w }));
    });
    card.appendChild(warnDiv);
  }

  // Reasoning
  if (sig.reasoning && sig.reasoning.length > 0) {
    var ul = el('ul', { className: 'reasoning-list' });
    sig.reasoning.forEach(function(r) {
      ul.appendChild(el('li', { textContent: r }));
    });
    card.appendChild(ul);
  }

  // Multi-TF breakdown
  if (sig.tfSignals && sig.tfSignals.length > 1) {
    var mtfDiv = el('div', { style: { margin: '10px 0', padding: '10px', background: 'var(--bg)', borderRadius: '6px' } });
    mtfDiv.appendChild(el('div', { textContent: 'Multi-TF Analiz', style: { fontSize: '11px', color: 'var(--text2)', marginBottom: '6px', fontWeight: 'bold' } }));

    if (sig.mtfConfirmation) {
      var mtfColor = sig.mtfConfirmation.direction === 'long' ? 'var(--green)' : sig.mtfConfirmation.direction === 'short' ? 'var(--red)' : 'var(--text2)';
      var mtfText = sig.mtfConfirmation.direction.toUpperCase() + ' %' + sig.mtfConfirmation.agreement + ' uyum (' + sig.mtfConfirmation.count + '/' + sig.mtfConfirmation.total + ' TF)';
      mtfDiv.appendChild(el('div', { textContent: mtfText, style: { fontSize: '12px', color: mtfColor, marginBottom: '6px', fontWeight: 'bold' } }));
    }
    if (sig.trendAgreement) {
      var taColor = sig.trendAgreement.direction === 'LONG' ? 'var(--green)' : sig.trendAgreement.direction === 'SHORT' ? 'var(--red)' : 'var(--text2)';
      var taText = 'Trend: ' + sig.trendAgreement.direction + ' %' + sig.trendAgreement.agreement + ' uyum (' + sig.trendAgreement.count + '/' + sig.trendAgreement.total + ' TF)';
      mtfDiv.appendChild(el('div', { textContent: taText, style: { fontSize: '12px', color: taColor, marginBottom: '6px', fontWeight: 'bold' } }));
    }

    var tfGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '4px' } });
    sig.tfSignals.forEach(function(ts) {
      var gradeColor = ts.grade === 'A' ? 'var(--green)' : ts.grade === 'B' ? 'var(--blue)' : ts.grade === 'C' ? 'var(--yellow)' : 'var(--text2)';
      // Long-term uses action instead of grade
      var label = ts.grade || ts.action || '—';
      if (ts.action) {
        gradeColor = ts.action.includes('LONG') ? 'var(--green)' : ts.action.includes('SHORT') ? 'var(--red)' : 'var(--text2)';
        label = ts.action;
      }
      var tfBox = el('div', { style: { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '4px', padding: '4px 6px', textAlign: 'center' } });
      tfBox.appendChild(el('div', { textContent: ts.tfLabel || ts.tf, style: { fontSize: '10px', color: 'var(--text2)' } }));
      tfBox.appendChild(el('div', { textContent: label, style: { fontSize: '11px', color: gradeColor, fontWeight: 'bold' } }));
      if (ts.direction) {
        var dColor = ts.direction === 'long' ? 'var(--green)' : 'var(--red)';
        tfBox.appendChild(el('div', { textContent: ts.direction.toUpperCase(), style: { fontSize: '9px', color: dColor } }));
      }
      tfGrid.appendChild(tfBox);
    });
    mtfDiv.appendChild(tfGrid);
    card.appendChild(mtfDiv);
  }

  // Scanned TFs info
  if (sig.scannedTimeframes && sig.scannedTimeframes.length > 1) {
    card.appendChild(el('div', { textContent: 'Taranan TF: ' + sig.scannedTimeframes.join(', '), style: { fontSize: '10px', color: '#8b949e', marginTop: '4px' } }));
  }

  // Indicator warnings
  if (sig.indicatorWarnings && sig.indicatorWarnings.length > 0) {
    sig.indicatorWarnings.forEach(function(w) {
      card.appendChild(el('div', { textContent: 'UYARI: ' + w, style: { fontSize: '10px', color: 'var(--orange)', marginTop: '4px' } }));
    });
  }

  // Timestamp
  card.appendChild(el('div', { textContent: sig.timestamp || new Date().toISOString(), style: { fontSize: '10px', color: '#8b949e', marginTop: '8px' } }));

  container.insertBefore(card, container.firstChild);
}

function displayBatchResult(batch) {
  var panel = document.getElementById('centerPanel');

  // Summary card
  var header = el('div', { className: 'signal-card' });
  var hdr = el('div', { className: 'signal-header' });
  hdr.appendChild(el('span', { className: 'signal-symbol', textContent: (batch.category || '').toUpperCase() + ' Toplu Tarama' }));
  hdr.appendChild(el('span', { textContent: (batch.symbolCount || 0) + ' sembol | ' + (batch.scanDuration || ''), style: { fontSize: '12px', color: '#8b949e' } }));
  header.appendChild(hdr);

  var sigRow = el('div', { className: 'signal-row' });
  sigRow.appendChild(el('span', { className: 'label', textContent: 'Sinyal' }));
  sigRow.appendChild(el('span', { className: 'value', textContent: ((batch.signals && batch.signals.length) || 0) + ' adet tespit edildi', style: { color: 'var(--green)' } }));
  header.appendChild(sigRow);

  if (batch.macroSummary) {
    var pre = el('pre', { textContent: batch.macroSummary, style: { fontSize: '10px', color: '#8b949e', marginTop: '8px', whiteSpace: 'pre-wrap' } });
    header.appendChild(pre);
  }

  panel.insertBefore(header, panel.firstChild);

  // Sort and display individual signals
  var sorted = (batch.results || []).slice().sort(function(a, b) {
    var order = { 'A': 0, 'B': 1, 'C': 2, 'BEKLE': 3, 'IPTAL': 4, 'HATA': 5 };
    return (order[a.grade] || 9) - (order[b.grade] || 9);
  });

  sorted.forEach(function(sig) {
    if (sig.grade === 'HATA') return;
    displaySignalCard(sig, panel);
  });
}

function displayBacktestResult(bt) {
  var panel = document.getElementById('centerPanel');
  var card = el('div', { className: 'signal-card' });

  // Header
  var hdr = el('div', { className: 'signal-header' });
  hdr.appendChild(el('span', { className: 'signal-symbol', textContent: 'Backtest: ' + (bt.symbol || '') + ' (' + (bt.timeframe || '') + ')' }));
  hdr.appendChild(el('span', { textContent: bt.strategy || '', style: { fontSize: '12px', color: '#8b949e' } }));
  card.appendChild(hdr);

  // Date range
  var range = (bt.dateRange ? bt.dateRange.from + ' > ' + bt.dateRange.to : '') + ' | ' + (bt.barCount || 0) + ' bar';
  card.appendChild(el('div', { textContent: range, style: { fontSize: '11px', color: '#8b949e', marginBottom: '10px' } }));

  // Stats grid
  var stats = el('div', { className: 'backtest-stats' });
  var statData = [
    { label: 'Toplam Islem', value: bt.totalTrades, cls: '' },
    { label: 'Kazanma Orani', value: '%' + bt.winRate, cls: bt.winRate >= 50 ? 'positive' : 'negative' },
    { label: 'Toplam PnL', value: (bt.totalPnl > 0 ? '+' : '') + bt.totalPnl + '%', cls: bt.totalPnl >= 0 ? 'positive' : 'negative' },
    { label: 'Ort. Kazanc', value: '+' + bt.avgWin + '%', cls: 'positive' },
    { label: 'Ort. Kayip', value: bt.avgLoss + '%', cls: 'negative' },
    { label: 'Profit Factor', value: bt.profitFactor, cls: bt.profitFactor >= 1.5 ? 'positive' : bt.profitFactor >= 1 ? '' : 'negative' },
  ];
  statData.forEach(function(s) {
    var box = el('div', { className: 'stat-box' });
    box.appendChild(el('div', { className: 'stat-label', textContent: s.label }));
    box.appendChild(el('div', { className: 'stat-value ' + s.cls, textContent: String(s.value) }));
    stats.appendChild(box);
  });
  card.appendChild(stats);

  // Win/Loss rows
  var winRow = el('div', { className: 'signal-row' });
  winRow.appendChild(el('span', { className: 'label', textContent: 'Kazanc' }));
  winRow.appendChild(el('span', { className: 'value', textContent: bt.wins + ' islem', style: { color: 'var(--green)' } }));
  card.appendChild(winRow);

  var lossRow = el('div', { className: 'signal-row' });
  lossRow.appendChild(el('span', { className: 'label', textContent: 'Kayip' }));
  lossRow.appendChild(el('span', { className: 'value', textContent: bt.losses + ' islem', style: { color: 'var(--red)' } }));
  card.appendChild(lossRow);

  panel.insertBefore(card, panel.firstChild);
}

// --- Macro Panel ---

function renderMacroPanel(state) {
  var panel = document.getElementById('macroPanel');
  panel.textContent = ''; // clear

  if (!state) {
    panel.appendChild(el('div', { className: 'macro-row', textContent: 'Veri yok' }));
    return;
  }

  Object.entries(state).forEach(function(pair) {
    var sym = pair[0];
    var data = pair[1];
    var row = el('div', { className: 'macro-row' });
    row.appendChild(el('span', { textContent: sym, style: { color: '#8b949e' } }));

    if (data.type === 'price') {
      var level = data.level === 'PANIK' ? 'color:var(--red)' : data.level === 'DIKKAT' ? 'color:var(--yellow)' : 'color:var(--green)';
      row.appendChild(el('span', { textContent: (data.value ? data.value.toFixed(1) : '?') + ' (' + (data.level || '?') + ')', style: { cssText: level } }));
    } else {
      var arrow = data.direction === 'bullish' ? '▲ yukari' : data.direction === 'bearish' ? '▼ asagi' : '— belirsiz';
      var dirColor = data.direction === 'bullish' ? 'color:var(--green)' : data.direction === 'bearish' ? 'color:var(--red)' : 'color:var(--text2)';
      row.appendChild(el('span', { textContent: arrow, style: { cssText: dirColor } }));
    }

    panel.appendChild(row);
  });
}

// --- API Calls ---

function apiCall(url, method, body) {
  var opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts).then(function(resp) { return resp.json(); });
}

function startScheduler() {
  showScanning('Zamanlayici baslatiliyor...');
  apiCall('/api/scheduler/start', 'POST').then(function() { hideScanning(); });
}

function stopScheduler() {
  apiCall('/api/scheduler/stop', 'POST');
}

// --- Scan Mode UI ---

function onScanModeChange() {
  var mode = document.getElementById('scanMode').value;
  var singleGroup = document.getElementById('singleTFGroup');
  var tfInfo = document.getElementById('scanTFInfo');

  if (mode === 'short-single' || mode === 'long-single') {
    singleGroup.style.display = '';
    tfInfo.textContent = 'Secilen tek zaman diliminde taranacak';
  } else if (mode === 'short') {
    singleGroup.style.display = 'none';
    tfInfo.textContent = 'Taranacak: 15m, 30m, 45m, 1H, 4H, 1D';
  } else if (mode === 'long') {
    singleGroup.style.display = 'none';
    tfInfo.textContent = 'Taranacak: 4H, 1D, 3D, 1W, 1M';
  }
}

function runManualScan() {
  var symbol = document.getElementById('scanSymbol').value.trim().toUpperCase();
  var modeRaw = document.getElementById('scanMode').value;

  if (!symbol) { addLog('error', 'Sembol giriniz'); return; }

  // Parse mode: "short", "long", "short-single", "long-single"
  var isSingle = modeRaw.endsWith('-single');
  var mode = isSingle ? modeRaw.replace('-single', '') : modeRaw;
  var singleTF = isSingle ? document.getElementById('scanTimeframe').value : null;

  var tfLabel = singleTF || (mode === 'short' ? '15m-1D' : '4H-1M');
  showScanning(symbol + ' taraniyor (' + tfLabel + ')...');
  addLog('info', 'Manuel tarama: ' + symbol + ' [' + tfLabel + '] (' + mode + (isSingle ? ' tek-TF' : ' multi-TF') + ')');

  var body = { symbol: symbol };
  if (singleTF) body.singleTF = singleTF;

  apiCall('/api/scan/' + mode, 'POST', body)
    .then(function(result) {
      displayResult(result);
      var gradeInfo = result.grade || '?';
      if (result.scannedTimeframes) gradeInfo += ' (' + result.scannedTimeframes.join(', ') + ')';
      addLog('success', 'Tarama tamamlandi: ' + symbol + ' — ' + gradeInfo);
      hideScanning();
    })
    .catch(function(e) {
      addLog('error', 'Tarama hatasi: ' + e.message);
      hideScanning();
    });
}

function runBatchScan() {
  var category = document.getElementById('batchCategory').value;
  var mode = document.getElementById('batchMode').value;

  showScanning(category + ' toplu tarama...');
  addLog('info', 'Toplu tarama: ' + category + ' (' + mode + ')');

  apiCall('/api/scan/batch', 'POST', { category: category, mode: mode })
    .then(function(result) {
      displayResult(result);
      hideScanning();
    })
    .catch(function(e) {
      addLog('error', 'Toplu tarama hatasi: ' + e.message);
      hideScanning();
    });
}

function runBacktest() {
  var symbol = document.getElementById('btSymbol').value.trim().toUpperCase();
  var timeframe = document.getElementById('btTimeframe').value;
  var bars = parseInt(document.getElementById('btBars').value) || 500;

  if (!symbol) { addLog('error', 'Backtest icin sembol giriniz'); return; }

  showScanning(symbol + ' backtest...');
  addLog('info', 'Backtest: ' + symbol + ' ' + timeframe + ' (' + bars + ' bar)');

  apiCall('/api/backtest', 'POST', { symbol: symbol, timeframe: timeframe, bars: bars })
    .then(function(result) {
      displayResult(result);
      addLog('success', 'Backtest tamamlandi: ' + symbol + ' — WR %' + result.winRate);
      hideScanning();
    })
    .catch(function(e) {
      addLog('error', 'Backtest hatasi: ' + e.message);
      hideScanning();
    });
}

function refreshMacro() {
  addLog('info', 'Makro veriler guncelleniyor...');
  apiCall('/api/macro?refresh=true')
    .then(function(data) {
      renderMacroPanel(data.state);
      addLog('success', 'Makro veriler guncellendi');
    })
    .catch(function(e) {
      addLog('error', 'Makro hatasi: ' + e.message);
    });
}

// --- Signal History Query ---

function querySignalHistory() {
  var symbol = document.getElementById('historySymbol').value.trim().toUpperCase();
  var days = parseInt(document.getElementById('historyDays').value) || 3;

  if (!symbol) { addLog('error', 'Sinyal gecmisi icin sembol giriniz'); return; }

  addLog('info', 'Sinyal gecmisi sorgusu: ' + symbol + ' (son ' + days + ' gun)');
  showScanning(symbol + ' sinyal gecmisi yukleniyor...');

  apiCall('/api/signals/history/' + encodeURIComponent(symbol) + '?days=' + days)
    .then(function(result) {
      hideScanning();
      displaySignalHistory(result);
      addLog('success', symbol + ' sinyal gecmisi: ' + result.count + ' sinyal bulundu');
    })
    .catch(function(e) {
      hideScanning();
      addLog('error', 'Sinyal gecmisi hatasi: ' + e.message);
    });
}

function displaySignalHistory(data) {
  var panel = document.getElementById('centerPanel');
  var empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';

  // Header card
  var card = el('div', { className: 'signal-card' });
  var hdr = el('div', { className: 'signal-header' });
  hdr.appendChild(el('span', { className: 'signal-symbol', textContent: data.symbol + ' — Sinyal Gecmisi' }));
  hdr.appendChild(el('span', { textContent: 'Son ' + data.days + ' gun | ' + data.count + ' sinyal', style: { fontSize: '12px', color: '#8b949e' } }));
  card.appendChild(hdr);

  if (data.signals.length === 0) {
    card.appendChild(el('div', { textContent: 'Bu donemde sinyal bulunamadi.', style: { color: 'var(--text2)', padding: '16px 0' } }));
    panel.insertBefore(card, panel.firstChild);
    return;
  }

  // Stats summary
  var wins = data.signals.filter(function(s) { return s.win === true; }).length;
  var losses = data.signals.filter(function(s) { return s.win === false; }).length;
  var open = data.signals.filter(function(s) { return s.status === 'open'; }).length;
  var total = data.signals.length;
  var wr = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0;

  var statsDiv = el('div', { style: { display: 'flex', gap: '16px', padding: '10px', background: 'var(--bg)', borderRadius: '6px', margin: '10px 0' } });
  var statItems = [
    { label: 'Toplam', value: total, color: 'var(--text)' },
    { label: 'Kazanc', value: wins, color: 'var(--green)' },
    { label: 'Kayip', value: losses, color: 'var(--red)' },
    { label: 'Acik', value: open, color: 'var(--blue)' },
    { label: 'WR', value: '%' + wr, color: wr >= 50 ? 'var(--green)' : 'var(--red)' },
  ];
  statItems.forEach(function(si) {
    var box = el('div', { style: { textAlign: 'center', flex: '1' } });
    box.appendChild(el('div', { textContent: si.label, style: { fontSize: '10px', color: 'var(--text2)' } }));
    box.appendChild(el('div', { textContent: String(si.value), style: { fontSize: '16px', fontWeight: 'bold', color: si.color } }));
    statsDiv.appendChild(box);
  });
  card.appendChild(statsDiv);

  // Signal timeline
  data.signals.forEach(function(sig) {
    var row = el('div', { style: { padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '11px' } });

    var dirColor = sig.direction === 'long' ? 'var(--green)' : 'var(--red)';
    var gradeColor = sig.grade === 'A' ? 'var(--green)' : sig.grade === 'B' ? 'var(--blue)' : 'var(--yellow)';
    var statusColor = sig.win === true ? 'var(--green)' : sig.win === false ? 'var(--red)' : 'var(--blue)';
    var statusText = sig.status === 'open' ? 'ACIK' : sig.win ? 'KAZANC' : 'KAYIP';
    if (sig.outcome) {
      var outcomeLabel = sig.outcome;
      // Add hit price next to outcome
      if (sig.outcome === 'sl_hit' && sig.slHitPrice) outcomeLabel += ' @ ' + Number(sig.slHitPrice).toFixed(2);
      else if (sig.outcome === 'tp3_hit' && sig.tp3HitPrice) outcomeLabel += ' @ ' + Number(sig.tp3HitPrice).toFixed(2);
      else if (sig.outcome === 'tp2_hit' && sig.tp2HitPrice) outcomeLabel += ' @ ' + Number(sig.tp2HitPrice).toFixed(2);
      else if (sig.outcome === 'tp1_hit' && sig.tp1HitPrice) outcomeLabel += ' @ ' + Number(sig.tp1HitPrice).toFixed(2);
      // Also add SL/TP target prices for context
      else if (sig.outcome === 'sl_hit' && sig.sl) outcomeLabel += ' @ ' + Number(sig.sl).toFixed(2);
      else if (sig.outcome === 'tp1_hit' && sig.tp1) outcomeLabel += ' @ ' + Number(sig.tp1).toFixed(2);
      else if (sig.outcome === 'tp2_hit' && sig.tp2) outcomeLabel += ' @ ' + Number(sig.tp2).toFixed(2);
      else if (sig.outcome === 'tp3_hit' && sig.tp3) outcomeLabel += ' @ ' + Number(sig.tp3).toFixed(2);
      statusText += ' (' + outcomeLabel + ')';
    }

    var topLine = el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '4px' } });
    var leftPart = el('span');
    leftPart.appendChild(el('span', { textContent: sig.grade, style: { color: gradeColor, fontWeight: 'bold' } }));
    leftPart.appendChild(el('span', { textContent: ' ' + (sig.direction || '').toUpperCase(), style: { color: dirColor, fontWeight: 'bold' } }));
    leftPart.appendChild(el('span', { textContent: ' ' + (sig.timeframe || '') + ' | Entry: ' + (sig.entry ? sig.entry.toFixed(2) : '?'), style: { color: 'var(--text2)' } }));
    topLine.appendChild(leftPart);
    topLine.appendChild(el('span', { textContent: statusText, style: { color: statusColor, fontWeight: 'bold' } }));
    row.appendChild(topLine);

    // Price levels line: SL / TP1 / TP2 / TP3
    var levelsLine = el('div', { style: { color: 'var(--text2)', fontSize: '10px' } });
    var levelParts = [];
    if (sig.sl) levelParts.push('SL: ' + Number(sig.sl).toFixed(2) + (sig.slHit ? ' ✗' : ''));
    if (sig.tp1) levelParts.push('TP1: ' + Number(sig.tp1).toFixed(2) + (sig.tp1Hit ? ' ✓' : ''));
    if (sig.tp2) levelParts.push('TP2: ' + Number(sig.tp2).toFixed(2) + (sig.tp2Hit ? ' ✓' : ''));
    if (sig.tp3) levelParts.push('TP3: ' + Number(sig.tp3).toFixed(2) + (sig.tp3Hit ? ' ✓' : ''));
    if (levelParts.length > 0) {
      levelsLine.appendChild(el('span', { textContent: levelParts.join(' | ') }));
      row.appendChild(levelsLine);
    }

    var bottomLine = el('div', { style: { color: 'var(--text2)' } });
    bottomLine.appendChild(el('span', { textContent: new Date(sig.createdAt).toLocaleString('tr-TR') }));
    if (sig.actualRR != null) {
      bottomLine.appendChild(el('span', { textContent: ' | RR: ' + sig.actualRR.toFixed(1), style: { color: sig.win ? 'var(--green)' : 'var(--red)' } }));
    }
    if (sig.rr) {
      bottomLine.appendChild(el('span', { textContent: ' | Hedef R:R: ' + sig.rr }));
    }
    row.appendChild(bottomLine);

    // Transition directive
    if (sig.transitionDirective) {
      var tdLine = el('div', { textContent: sig.transitionDirective.message, style: { color: 'var(--orange)', fontSize: '10px', marginTop: '3px', fontStyle: 'italic' } });
      row.appendChild(tdLine);
    }

    card.appendChild(row);
  });

  panel.insertBefore(card, panel.firstChild);
}

// --- Symbol Search Autocomplete ---

var searchTimer = null;
var activeDropdown = null;

function setupSymbolSearch(inputId) {
  var input = document.getElementById(inputId);
  if (!input) return;

  // Create dropdown container
  var wrapper = input.parentElement;
  wrapper.style.position = 'relative';

  var dropdown = el('div', { className: 'search-dropdown' });
  dropdown.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;z-index:100;background:#161b22;border:1px solid #30363d;border-top:none;border-radius:0 0 6px 6px;max-height:240px;overflow-y:auto;';
  wrapper.appendChild(dropdown);

  input.addEventListener('input', function() {
    var query = input.value.trim();
    if (searchTimer) clearTimeout(searchTimer);

    if (query.length < 1) {
      dropdown.style.display = 'none';
      return;
    }

    searchTimer = setTimeout(function() {
      fetch('/api/search?q=' + encodeURIComponent(query))
        .then(function(r) { return r.json(); })
        .then(function(results) {
          dropdown.textContent = '';
          if (!results || results.length === 0) {
            dropdown.style.display = 'none';
            return;
          }
          results.forEach(function(r) {
            var item = el('div', {
              style: { padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #21262d', fontSize: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
            });

            var left = el('div');
            left.appendChild(el('span', { textContent: r.full_name, style: { color: '#c9d1d9', fontWeight: 'bold' } }));
            left.appendChild(el('span', { textContent: ' ' + (r.description || ''), style: { color: '#8b949e', fontSize: '11px' } }));

            var right = el('span', { textContent: r.type || '', style: { color: '#58a6ff', fontSize: '10px', textTransform: 'uppercase' } });

            item.appendChild(left);
            item.appendChild(right);

            item.addEventListener('mouseenter', function() { item.style.background = '#21262d'; });
            item.addEventListener('mouseleave', function() { item.style.background = 'transparent'; });
            item.addEventListener('mousedown', function(e) {
              e.preventDefault();
              input.value = r.full_name;
              dropdown.style.display = 'none';
            });

            dropdown.appendChild(item);
          });
          dropdown.style.display = 'block';
          activeDropdown = dropdown;
        })
        .catch(function() { dropdown.style.display = 'none'; });
    }, 300);
  });

  input.addEventListener('blur', function() {
    setTimeout(function() { dropdown.style.display = 'none'; }, 200);
  });

  input.addEventListener('focus', function() {
    if (dropdown.children.length > 0 && input.value.trim().length > 0) {
      dropdown.style.display = 'block';
    }
  });

  // Enter key submits
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      dropdown.style.display = 'none';
      if (inputId === 'scanSymbol') runManualScan();
      else if (inputId === 'btSymbol') runBacktest();
      else if (inputId === 'historySymbol') querySignalHistory();
    }
  });
}

// --- Learning System UI ---

function updateLearningPanel(data) {
  var stateEl = document.getElementById('learningStateText');
  var versionEl = document.getElementById('learningVersion');
  var resolvedEl = document.getElementById('learningResolved');
  var openEl = document.getElementById('learningOpen');
  var wrEl = document.getElementById('learningWinRate');
  var trendEl = document.getElementById('learningTrend');

  if (data.learningState) {
    var stateMap = { observation: 'Gozlem', preliminary: 'On-Ogrenme', active: 'Aktif Ogrenme' };
    var stateColor = data.learningState === 'active' ? 'var(--green)' : data.learningState === 'preliminary' ? 'var(--yellow)' : 'var(--purple)';
    stateEl.textContent = stateMap[data.learningState] || data.learningState;
    stateEl.style.color = stateColor;
  }
  if (data.weightVersion != null) versionEl.textContent = 'v' + data.weightVersion;
  if (data.totalResolved != null) resolvedEl.textContent = data.totalResolved;
  if (data.openSignals != null) openEl.textContent = data.openSignals;
  if (data.winRate != null) {
    wrEl.textContent = '%' + data.winRate;
    wrEl.style.color = data.winRate >= 55 ? 'var(--green)' : data.winRate >= 45 ? 'var(--yellow)' : 'var(--red)';
  }
  if (data.recentTrend) {
    var trendMap = { improving: 'Yukselis', declining: 'Dusus', stable: 'Stabil', positive: 'Pozitif', negative: 'Negatif', neutral: 'Notr', insufficient_data: 'Yetersiz Veri' };
    var trendColor = { improving: 'var(--green)', declining: 'var(--red)', stable: 'var(--text2)', positive: 'var(--green)', negative: 'var(--red)' };
    trendEl.textContent = trendMap[data.recentTrend] || data.recentTrend;
    trendEl.style.color = trendColor[data.recentTrend] || 'var(--text2)';
  }
}

function refreshLearningStatus() {
  apiCall('/api/learning/quick')
    .then(function(data) {
      updateLearningPanel(data);
    })
    .catch(function() {});
}

function viewLearningReport() {
  addLog('info', 'Ogrenme raporu yukleniyor...');
  fetch('/api/learning/report')
    .then(function(r) { return r.text(); })
    .then(function(report) {
      displayTextReport('Otonom Ogrenme Raporu', report);
      addLog('success', 'Ogrenme raporu hazir');
    })
    .catch(function(e) {
      addLog('error', 'Rapor hatasi: ' + e.message);
    });
}

function viewIndicatorReport() {
  addLog('info', 'Indikator analizi yukleniyor...');
  fetch('/api/learning/indicators/report')
    .then(function(r) { return r.text(); })
    .then(function(report) {
      displayTextReport('Indikator Elestirisel Analizi', report);
      addLog('success', 'Indikator raporu hazir');
    })
    .catch(function(e) {
      addLog('error', 'Rapor hatasi: ' + e.message);
    });
}

function view24hChanges() {
  addLog('info', 'Son 24 saat ogrenme degisiklikleri yukleniyor...');
  fetch('/api/learning/changes?hours=24')
    .then(function(r) { return r.text(); })
    .then(function(report) {
      displayTextReport('Son 24 Saat — Otonom Ogrenme Degisiklikleri', report);
      addLog('success', 'Ogrenme degisiklikleri raporu hazir');
    })
    .catch(function(e) {
      addLog('error', 'Degisiklik raporu hatasi: ' + e.message);
    });
}

function forceOutcomeCheck() {
  addLog('info', 'Sinyal sonuclari kontrol ediliyor...');
  apiCall('/api/learning/check-outcomes', 'POST')
    .then(function(result) {
      addLog('success', 'Sonuc kontrolu: ' + result.checked + ' kontrol, ' + result.resolved + ' cozuldu');
      refreshLearningStatus();
    })
    .catch(function(e) {
      addLog('error', 'Sonuc kontrol hatasi: ' + e.message);
    });
}

function forceWeightAdjust() {
  addLog('info', 'Agirlik ayarlamasi yapiliyor...');
  apiCall('/api/learning/adjust', 'POST')
    .then(function(result) {
      addLog('success', 'Ayarlama: ' + result.message);
      if (result.changes && result.changes.length > 0) {
        result.changes.forEach(function(c) {
          addLog('info', '  → ' + c);
        });
      }
      refreshLearningStatus();
    })
    .catch(function(e) {
      addLog('error', 'Ayarlama hatasi: ' + e.message);
    });
}

function displayTextReport(title, text) {
  var panel = document.getElementById('centerPanel');
  var empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';

  var card = el('div', { className: 'signal-card' });

  var header = el('div', { className: 'signal-header' });
  header.appendChild(el('span', { className: 'signal-symbol', textContent: title }));
  header.appendChild(el('span', { textContent: new Date().toLocaleString('tr-TR'), style: { fontSize: '11px', color: '#8b949e' } }));
  card.appendChild(header);

  var pre = el('pre', {
    textContent: text,
    style: { fontSize: '11px', color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: '1.5', marginTop: '10px', maxHeight: '600px', overflowY: 'auto' }
  });
  card.appendChild(pre);

  panel.insertBefore(card, panel.firstChild);
}

// --- Init ---
function init() {
  connectWS();

  // Setup autocomplete on symbol input fields
  setupSymbolSearch('scanSymbol');
  setupSymbolSearch('btSymbol');
  setupSymbolSearch('historySymbol');

  apiCall('/api/health')
    .then(function(health) {
      var tvDot = document.getElementById('tvStatus');
      var tvText = document.getElementById('tvStatusText');
      if (health.tradingview) {
        tvDot.className = 'status-dot online';
        tvText.textContent = 'TV Bagli';
      } else {
        tvDot.className = 'status-dot offline';
        tvText.textContent = 'TV Baglanti Yok';
      }
      updateStatus(health.scheduler);
    })
    .catch(function() {
      document.getElementById('tvStatus').className = 'status-dot offline';
      document.getElementById('tvStatusText').textContent = 'Sunucu Erisim Yok';
    });

  apiCall('/api/macro')
    .then(function(data) {
      if (data && data.state) renderMacroPanel(data.state);
    })
    .catch(function() {});

  // Learning status
  refreshLearningStatus();
  setInterval(refreshLearningStatus, 60000); // Refresh every minute
}

init();

// ============================================================
// Watchlist Manager Modal
// ============================================================

var WL_CATEGORIES = [
  { key: 'kripto', label: 'Kripto' },
  { key: 'forex', label: 'Forex' },
  { key: 'abd_hisse', label: 'ABD Hisse' },
  { key: 'bist', label: 'BIST' },
  { key: 'emtia', label: 'Emtia' },
];
var _wlState = { active: 'kripto', watchlists: {}, exchangeMap: {}, selectedSymbol: null };

// Safe DOM builder
function wlEl(tag, attrs, children) {
  var el = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function(k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'onclick') el.onclick = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k === 'title') el.title = attrs[k];
      else if (k === 'type') el.type = attrs[k];
      else if (k === 'placeholder') el.placeholder = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
  }
  if (children) {
    (Array.isArray(children) ? children : [children]).forEach(function(c) {
      if (c == null) return;
      if (typeof c === 'string') el.appendChild(document.createTextNode(c));
      else el.appendChild(c);
    });
  }
  return el;
}

function wlClear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function openWatchlistModal() {
  document.getElementById('watchlistModal').classList.remove('hidden');
  loadWatchlistData();
}

function closeWatchlistModal() {
  document.getElementById('watchlistModal').classList.add('hidden');
}

function wlToast(msg, kind) {
  var el = document.getElementById('wlToast');
  el.textContent = msg;
  el.className = 'wl-toast ' + (kind || 'success');
  setTimeout(function() { el.classList.add('hidden'); }, 2800);
}

function loadWatchlistData() {
  Promise.all([
    apiCall('/api/watchlists'),
    apiCall('/api/watchlists/exchange-map'),
  ]).then(function(arr) {
    _wlState.watchlists = arr[0] || {};
    _wlState.exchangeMap = arr[1] || {};
    renderWatchlistTabs();
    renderWatchlistList();
  }).catch(function(e) {
    wlToast('Watchlist yuklenemedi: ' + e.message, 'error');
  });
}

function renderWatchlistTabs() {
  var host = document.getElementById('wlTabs');
  wlClear(host);
  WL_CATEGORIES.forEach(function(c) {
    var list = _wlState.watchlists[c.key] || [];
    var tab = wlEl('div', {
      class: 'wl-tab' + (c.key === _wlState.active ? ' active' : ''),
      onclick: function() { setWatchlistTab(c.key); },
    }, [
      c.label + ' ',
      wlEl('span', { class: 'count', text: '(' + list.length + ')' }),
    ]);
    host.appendChild(tab);
  });
}

function setWatchlistTab(cat) {
  _wlState.active = cat;
  renderWatchlistTabs();
  renderWatchlistList();
}

function renderWatchlistList() {
  var host = document.getElementById('wlList');
  wlClear(host);
  var list = _wlState.watchlists[_wlState.active] || [];
  if (list.length === 0) {
    host.appendChild(wlEl('div', {
      style: 'color:var(--text2);padding:20px;text-align:center;font-size:11px;',
      text: 'Bu kategori bos.',
    }));
    return;
  }
  list.forEach(function(raw) {
    var sym = String(raw).toUpperCase();
    var leftParts = [wlEl('span', { class: 'sym', text: sym })];
    if (_wlState.active === 'abd_hisse') {
      var ex = _wlState.exchangeMap[sym];
      if (ex) {
        var cls = ex.toLowerCase() === 'nyse' ? ' nyse' : (ex.toLowerCase() === 'nasdaq' ? ' nasdaq' : '');
        leftParts.push(wlEl('span', { class: 'ex-badge' + cls, text: ex }));
      }
    }
    var delBtn = wlEl('button', { class: 'del', title: 'Sil', text: '×' });
    delBtn.onclick = function(e) { e.stopPropagation(); removeWatchlistSymbol(sym); };
    var item = wlEl('div', {
      class: 'wl-item' + (_wlState.selectedSymbol === sym ? ' active' : ''),
      onclick: function() { selectWatchlistSymbol(sym); },
    }, [wlEl('span', {}, leftParts), delBtn]);
    host.appendChild(item);
  });
}

function addWatchlistSymbol() {
  var input = document.getElementById('wlAddInput');
  var sym = String(input.value || '').trim().toUpperCase();
  if (!sym) return;
  if (!/^[A-Z0-9.]{1,15}$/.test(sym)) {
    wlToast('Gecersiz sembol formati', 'error');
    return;
  }
  apiCall('/api/watchlists', 'POST', { category: _wlState.active, symbol: sym }).then(function(r) {
    if (r && r.error) { wlToast(r.error, 'error'); return; }
    input.value = '';
    var msg = r.exchange ? (sym + ' eklendi (' + r.exchange + ')') : (sym + ' eklendi');
    wlToast(msg, 'success');
    loadWatchlistData();
  }).catch(function(e) { wlToast('Hata: ' + e.message, 'error'); });
}

function removeWatchlistSymbol(sym) {
  if (!confirm(sym + ' silinsin mi?')) return;
  apiCall('/api/watchlists', 'DELETE', { category: _wlState.active, symbol: sym }).then(function(r) {
    if (r && r.error) { wlToast(r.error, 'error'); return; }
    wlToast(sym + ' silindi', 'success');
    if (_wlState.selectedSymbol === sym) {
      _wlState.selectedSymbol = null;
      var panel = document.getElementById('wlStatsPanel');
      wlClear(panel);
      panel.appendChild(wlEl('div', { class: 'wl-empty', text: 'Istatistikleri gormek icin sol taraftaki bir sembole tiklayin.' }));
    }
    loadWatchlistData();
  });
}

function selectWatchlistSymbol(sym) {
  _wlState.selectedSymbol = sym;
  renderWatchlistList();
  var panel = document.getElementById('wlStatsPanel');
  wlClear(panel);
  panel.appendChild(wlEl('div', { class: 'wl-empty', text: 'Yukleniyor...' }));
  apiCall('/api/watchlists/stats/' + encodeURIComponent(sym) + '?days=90').then(function(stats) {
    if (!stats || stats.error) {
      wlClear(panel);
      panel.appendChild(wlEl('div', { class: 'wl-empty', text: 'Istatistik alinamadi' + (stats && stats.error ? ': ' + stats.error : '') }));
      return;
    }
    renderWatchlistStats(stats);
  });
}

function wlPct(v) { return v == null ? '—' : v.toFixed(1) + '%'; }
function wlFmtDate(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderWatchlistStats(s) {
  var panel = document.getElementById('wlStatsPanel');
  wlClear(panel);

  var header = wlEl('div', { class: 'wl-stats-header' }, [
    wlEl('h3', { text: s.symbol }),
    wlEl('div', { class: 'sub', text: 'Son ' + s.days + ' gun | ' + s.total + ' sinyal' }),
  ]);
  panel.appendChild(header);

  var winColor = s.winRate == null ? '' : (s.winRate >= 55 ? 'green' : (s.winRate >= 40 ? 'yellow' : 'red'));
  var avgRColor = s.avgR == null ? '' : (s.avgR >= 1 ? 'green' : (s.avgR >= 0 ? 'yellow' : 'red'));

  var cards = [
    { label: 'Toplam Sinyal', value: String(s.total), cls: '' },
    { label: 'Kazanan / Kaybeden', value: s.wins + ' / ' + s.losses, cls: '' },
    { label: 'Win Rate', value: wlPct(s.winRate), cls: winColor },
    { label: 'TP1 Hit', value: wlPct(s.tp1Rate), cls: 'green' },
    { label: 'SL Hit', value: wlPct(s.slRate), cls: 'red' },
    { label: 'Ort. R', value: s.avgR == null ? '—' : (s.avgR.toFixed(2) + 'R'), cls: avgRColor },
    { label: 'A / B / C', value: (s.byGrade.A || 0) + ' / ' + (s.byGrade.B || 0) + ' / ' + (s.byGrade.C || 0), cls: '' },
    { label: 'Bekleyen', value: String(s.pending || 0), cls: 'yellow' },
  ];
  var grid = wlEl('div', { class: 'wl-stats-grid' });
  cards.forEach(function(c) {
    grid.appendChild(wlEl('div', { class: 'wl-stat-card' }, [
      wlEl('div', { class: 'label', text: c.label }),
      wlEl('div', { class: 'value ' + c.cls, text: c.value }),
    ]));
  });
  panel.appendChild(grid);

  panel.appendChild(wlEl('div', { class: 'wl-last-title', text: 'Son Sinyaller' }));

  if (!s.last || s.last.length === 0) {
    panel.appendChild(wlEl('div', { class: 'wl-empty', style: 'padding:20px;', text: 'Son 90 gunde bu sembol icin sinyal yok.' }));
    return;
  }
  var listHost = wlEl('div', { class: 'wl-last-list' });
  s.last.forEach(function(r) {
    var grade = r.grade || '—';
    var gCls = (grade === 'A' || grade === 'B' || grade === 'C') ? grade : '';
    var dirCls = (r.direction || '').toLowerCase();
    var outcomeText = r.win === true ? 'win' : (r.win === false ? 'loss' : (r.status || ''));
    var outCls = r.win === true ? 'win' : (r.win === false ? 'loss' : '');
    var rrStr = r.actualRR == null ? '' : (' ' + r.actualRR);
    var row = wlEl('div', { class: 'wl-last-row' }, [
      wlEl('span', { text: wlFmtDate(r.createdAt) }),
      wlEl('span', { class: 'grade ' + gCls, text: grade }),
      wlEl('span', { class: 'dir ' + dirCls, text: r.direction || '—' }),
      wlEl('span', { text: r.timeframe || '—' }),
      wlEl('span', { class: 'outcome ' + outCls, text: outcomeText + rrStr }),
      wlEl('span', { style: 'text-align:right;color:var(--text2);', text: r.entry != null ? String(r.entry) : '—' }),
    ]);
    listHost.appendChild(row);
  });
  panel.appendChild(listHost);
}

// Enter key ile ekle
document.addEventListener('DOMContentLoaded', function() {
  var inp = document.getElementById('wlAddInput');
  if (inp) inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') addWatchlistSymbol();
  });
});
