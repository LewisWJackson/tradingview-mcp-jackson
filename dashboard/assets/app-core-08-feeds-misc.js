// ── Macro Calendar ────────────────────────────────────────────────────────────
const TYPE_LABELS = { fed:'Fed', sama:'SAMA', opec:'OPEC+', cpi:'CPI', nfp:'Jobs', earnings:'Earnings', holiday:'Holiday', macro:'Saudi Macro' };

function dayLabel(dateStr) {
  const todayKSA = new Date(Date.now() + 3*3600*1000).toISOString().slice(0,10);
  if (dateStr === todayKSA) return 'Today';
  const diff = Math.round((new Date(dateStr) - new Date(todayKSA)) / 86400000);
  if (diff === 1) return 'Tomorrow';
  if (diff <= 6) {
    const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return names[new Date(dateStr + 'T12:00:00Z').getUTCDay()];
  }
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short'});
}

async function loadMacroPanel(force=false) {
  const scroll = document.getElementById('macro-cal-scroll');
  const countEl = document.getElementById('macro-event-count');
  if (!scroll) return;
  try {
    const d = await fetch('/api/macro/events?days=21').then(r=>r.json());
    const events = d.events || [];
    if (countEl) countEl.textContent = events.length ? `(${events.length})` : '';
    if (!events.length) {
      scroll.innerHTML = '<div class="macro-empty">No major events in the next 21 days.</div>';
    } else {
      const todayKSA = new Date(Date.now() + 3*3600*1000).toISOString().slice(0,10);
      scroll.innerHTML = events.map(e => {
        const isToday = e.date === todayKSA;
        const tasiTag = e.tasiImpact
          ? `<span class="macro-evt-tasi ${e.tasiImpact}">${e.tasiImpact === 'closed' ? '🔒 TASI Closed' : e.tasiImpact === 'bullish' ? '↑ Bullish' : e.tasiImpact === 'bearish' ? '↓ Bearish' : '→ Neutral'}</span>`
          : '';
        return `<div class="macro-evt ${e.impact}${isToday?' today':''}" title="${e.detail}">
          <div class="macro-evt-type ${e.type}">${TYPE_LABELS[e.type]||e.type}</div>
          <div class="macro-evt-label">${e.label}</div>
          <div class="macro-evt-date">${dayLabel(e.date)} · ${e.date.slice(5).replace('-','/')}</div>
          <div class="macro-evt-detail">${e.detail.slice(0,60)}${e.detail.length>60?'…':''}</div>
          ${tasiTag}
        </div>`;
      }).join('');
    }
  } catch(e) {
    scroll.innerHTML = `<div class="macro-empty">Error loading events: ${e.message}</div>`;
  }
}

// ── Whale Watch ──────────────────────────────────────────────────────────────
async function loadSectorBreadth(){
  const el=document.getElementById('sector-breadth-panel');
  if(!el) return;
  el.innerHTML='<div style="color:var(--text3);font-size:12px;padding:8px 0">Loading…</div>';
  try{
    const d=await fetch('/api/sectors/breadth').then(r=>r.json());
    if(!d.sectors||!d.sectors.length){el.innerHTML='<div style="color:var(--text3);font-size:12px;padding:8px 0">No scan data. Run a scan first.</div>';return;}
    const rows=d.sectors.map(s=>{
      const mCol=s.momentum==='strong'?'var(--green)':s.momentum==='weak'?'#ff5252':'var(--yellow)';
      const barW=s.bull_pct+'%';
      return`<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;font-weight:600;color:var(--text);width:130px;flex-shrink:0">${s.sector}</div>
        <div style="flex:1;background:rgba(255,255,255,.05);border-radius:3px;height:6px;overflow:hidden"><div style="height:100%;width:${barW};background:${mCol};border-radius:3px;transition:width .4s"></div></div>
        <div style="font-size:10px;color:${mCol};font-weight:700;width:32px;text-align:end">${s.bull_pct}%</div>
        <div style="font-size:10px;color:var(--text3);width:60px">${s.count_buy}↑ ${s.count_sell}↓ ${s.count_watch}◎</div>
        <div style="font-size:10px;color:var(--text3);width:60px">${s.avg_rs!=null?(s.avg_rs>0?'+':'')+s.avg_rs+'% RS':'—'}</div>
      </div>`;
    }).join('');
    el.innerHTML=`<div style="display:flex;gap:8px;padding:4px 0 8px;font-size:10px;color:var(--text3)">
        <span>${d.total_stocks} stocks · ${d.sectors.length} sectors</span>
        <span style="margin-inline-start:auto">${d.scanned_at?new Date(d.scanned_at).toLocaleTimeString():''}</span>
      </div>${rows}`;
  }catch(e){el.innerHTML=`<div style="color:var(--red);font-size:12px;padding:8px 0">Error: ${e.message}</div>`;}
}

async function loadExitCheck(){
  const el=document.getElementById('exit-check-panel');
  if(!el) return;
  el.innerHTML='<div style="color:var(--text3);font-size:12px;padding:8px 0">Checking positions…</div>';
  try{
    const d=await fetch('/api/positions/exit-check').then(r=>r.json());
    if(!d.checks||!d.checks.length){el.innerHTML='<div style="color:var(--text3);font-size:12px;padding:8px 0">No open positions to check.</div>';return;}
    const actionColor={'EXIT':'#ff5252','REDUCE':'var(--orange)','WATCH':'var(--yellow)','HOLD':'var(--green)','DATA_MISSING':'var(--text3)'};
    const rows=d.checks.map(c=>{
      const col=actionColor[c.action]||'var(--text2)';
      const vel=c.velocity?.direction==='rising'?'<span style="color:var(--green)">↗</span>':c.velocity?.direction==='falling'?'<span style="color:#ff5252">↘</span>':'<span style="color:var(--text3)">→</span>';
      const exits=c.exit_signals?.length?`<div style="font-size:10px;color:#ff5252;margin-top:3px">${c.exit_signals.map(s=>'✗ '+s).join('<br>')}</div>`:'';
      const holds=c.hold_signals?.length?`<div style="font-size:10px;color:var(--green);margin-top:2px">${c.hold_signals.map(s=>'✓ '+s).join('<br>')}</div>`:'';
      const pl=c.pl_pct!=null?`<span style="font-size:10px;color:${c.pl_pct>=0?'var(--green)':'#ff5252'}">${c.pl_pct>=0?'+':''}${c.pl_pct}%</span>`:'';
      return`<div style="background:rgba(255,255,255,.025);border:1px solid var(--border);border-radius:6px;padding:9px 12px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;font-weight:700;color:var(--text)">${c.name||c.sym}</span>
          ${vel}
          ${pl}
          <span style="margin-inline-start:auto;font-size:11px;font-weight:800;color:${col};padding:2px 8px;background:${col}22;border-radius:10px">${c.action}</span>
        </div>
        ${exits}${holds}
        ${c.note?`<div style="font-size:10px;color:var(--text3);margin-top:3px">${c.note}</div>`:''}
      </div>`;
    }).join('');
    const sum=d.summary||{};
    el.innerHTML=`<div style="display:flex;gap:10px;padding:4px 0 8px;font-size:10px">
      <span style="color:#ff5252">${sum.exit||0} EXIT</span><span style="color:var(--orange)">${sum.reduce||0} REDUCE</span>
      <span style="color:var(--yellow)">${sum.watch||0} WATCH</span><span style="color:var(--green)">${sum.hold||0} HOLD</span>
    </div>${rows}`;
  }catch(e){el.innerHTML=`<div style="color:var(--red);font-size:12px;padding:8px 0">Error: ${e.message}</div>`;}
}

async function loadCorrelationMatrix() {
  const el = document.getElementById('correlation-panel');
  if (!el) return;
  const syms = Object.keys(positionsData || {});
  if (syms.length < 2) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">Need at least 2 open positions to compute correlation.</div>';
    return;
  }
  el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">Computing…</div>';
  try {
    const d = await fetch('/api/correlation', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ syms }) }).then(r=>r.json());
    if (!d.matrix || !d.matrix.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">Not enough scan data for these positions — run a scan first.</div>'; return; }
    const names = d.names || d.syms;
    const n = d.syms.length;
    // Find high-correlation pairs (>0.7, excluding diagonal)
    const warnings = [];
    for (let i = 0; i < n; i++) for (let j = i+1; j < n; j++) {
      if (d.matrix[i][j] != null && d.matrix[i][j] >= 0.7) warnings.push(`${tickerDisplay(d.syms[i])} ↔ ${tickerDisplay(d.syms[j])}: ${d.matrix[i][j].toFixed(2)}`);
    }
    // Color mapping
    function corrColor(v) {
      if (v == null) return 'var(--bg2)';
      if (v >= 0.7)  return 'rgba(255,82,82,.25)';
      if (v >= 0.3)  return 'rgba(255,160,0,.18)';
      if (v <= -0.3) return 'rgba(0,229,170,.18)';
      return 'rgba(255,255,255,.04)';
    }
    function corrText(v) {
      if (v == null) return '—';
      if (v === 1)   return '—';
      return (v >= 0 ? '+' : '') + v.toFixed(2);
    }
    // Build grid
    const labelRow = `<div></div>${d.syms.map(s=>`<div style="font-size:9px;font-weight:700;color:var(--text3);text-align:center;padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tickerDisplay(s)}</div>`).join('')}`;
    const rows = d.syms.map((rs, i) =>
      `<div style="font-size:9px;font-weight:700;color:var(--text3);display:flex;align-items:center;padding-inline-end:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tickerDisplay(rs)}</div>` +
      d.syms.map((_, j) => {
        const v = d.matrix[i][j];
        const bg = i === j ? 'rgba(255,255,255,.08)' : corrColor(v);
        const txt = i === j ? '●' : corrText(v);
        const color = i === j ? 'var(--text3)' : v != null && v >= 0.7 ? '#ff5252' : v != null && v <= -0.3 ? 'var(--green)' : 'var(--text2)';
        return `<div style="background:${bg};border-radius:4px;padding:5px 3px;text-align:center;font-size:10px;font-weight:700;color:${color}">${txt}</div>`;
      }).join('')
    ).map(r => `<div style="display:contents">${r}</div>`).join('');
    const warnHtml = warnings.length
      ? `<div style="margin-bottom:8px;padding:7px 10px;background:rgba(255,82,82,.08);border:1px solid rgba(255,82,82,.25);border-radius:6px;font-size:11px;color:#ff5252">⚠ Highly correlated pairs (≥0.70): ${warnings.join(' · ')}</div>`
      : `<div style="margin-bottom:8px;font-size:11px;color:var(--green)">✓ No highly correlated pairs — portfolio is well diversified</div>`;
    const legend = `<div style="display:flex;gap:10px;font-size:10px;color:var(--text3);margin-top:8px">
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(255,82,82,.25);vertical-align:middle;margin-inline-end:3px"></span>High ≥0.70</span>
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(255,160,0,.18);vertical-align:middle;margin-inline-end:3px"></span>Moderate 0.30–0.70</span>
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(0,229,170,.18);vertical-align:middle;margin-inline-end:3px"></span>Negative (good)</span>
    </div>`;
    el.innerHTML = warnHtml +
      `<div style="display:grid;grid-template-columns:60px ${d.syms.map(()=>'1fr').join(' ')};gap:3px;align-items:center">${labelRow}${rows}</div>` +
      legend;
  } catch(e) { el.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px 0">Error: ${e.message}</div>`; }
}

function whaleEmoji(score) {
  if (score >= 8) return '🐋🐋🐋';
  if (score >= 5) return '🐋🐋';
  if (score >= 3) return '🐋';
  return '◦';
}

function whaleDirection(r) {
  const bear = ['STRONG SELL','SELL','AVOID'].includes(r.bias);
  const mfi  = r.mfi;
  if (!mfi) return { cls:'wdir-neu', label:'Unknown' };
  if (!bear && mfi > 65) return { cls:'wdir-acc', label:'📈 Accumulation' };
  if ( bear && mfi < 35) return { cls:'wdir-dist', label:'📉 Distribution' };
  if (!bear && r.obv_trend==='rising') return { cls:'wdir-acc', label:'↑ Buying' };
  if ( bear && r.obv_trend==='falling') return { cls:'wdir-dist', label:'↓ Selling' };
  return { cls:'wdir-neu', label:'Neutral' };
}

// renderWhaleActivity removed Phase 4 — whale_score has no edge (Volume Activity UI cut Phase 1, /api/whale/activity removed).

async function addBlockDeal() {
  const sym   = document.getElementById('bd-sym')?.value.trim();
  const price = parseFloat(document.getElementById('bd-price')?.value);
  const qty   = parseInt(document.getElementById('bd-qty')?.value);
  const note  = document.getElementById('bd-note')?.value.trim()||'';
  if (!sym || !price || !qty) { alert('Symbol, price, and quantity are required.'); return; }
  const name = scanData.find(r=>tickerDisplay(r.sym)===sym||r.sym===`TADAWUL:${sym}`)?.name||'';
  await fetch('/api/whale/block-deals/add',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({sym,price,qty,note,name,time:new Date().toISOString()})});
  ['bd-sym','bd-price','bd-qty','bd-note'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  loadBlockDeals(true);
}

async function deleteBlockDeal(sym, time) {
  await fetch('/api/whale/block-deals/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym,time})});
  loadBlockDeals(true);
}

async function loadBlockDeals(force=false) {
  const listEl = document.getElementById('block-deals-list');
  if (!listEl) return;
  try {
    const d = await fetch('/api/whale/block-deals').then(r=>r.json());
    if (!d.deals?.length) {
      listEl.innerHTML = `<div class="whale-empty">No block deals found today. Argaam is checked automatically — or enter deals manually above.</div>
        ${d.error?`<div class="whale-error">ℹ️ ${d.error}</div>`:''}`;
      return;
    }
    // Cache for drawer Overview tab
    blockDealsCache = d.deals;
    // If drawer is open, refresh the block-deals section in the Overview tab
    if(openDrawerData) renderDrawerBlockDeals(openDrawerData.sym);

    const autoCount = d.deals.filter(x=>x.source==='Argaam').length;
    const manCount  = d.deals.filter(x=>x.source==='Manual').length;
    const srcLine   = [autoCount?`${autoCount} from Argaam`:'', manCount?`${manCount} manual`:''].filter(Boolean).join(' · ');
    // Remove any previous source info div to avoid accumulation on refresh
    listEl.parentElement?.querySelectorAll('.bd-src-info').forEach(el=>el.remove());
    if (srcLine) {
      const info = document.createElement('div');
      info.className = 'bd-src-info';
      info.style.cssText = 'font-size:11px;color:var(--text3);padding:4px 0 8px;';
      info.textContent = `Sources: ${srcLine}` + (d.error ? ` · ⚠️ ${d.error}` : '');
      listEl.parentElement?.insertBefore(info, listEl);
    }
    const fmt = v => v>=1e9?(v/1e9).toFixed(2)+'B SAR':v>=1e6?(v/1e6).toFixed(1)+'M SAR':(v/1e3).toFixed(0)+'K SAR';

    // Significance relative to each stock's ADTV (falls back to absolute if ADTV unknown)
    function dealSignificance(sarValue, sym){
      const s = dealSignificanceVsADTV(sarValue, sym);
      const adtv = getADTV(sym);
      const bg = s.col==='#ff5252'?'rgba(255,23,68,.12)':s.col==='var(--orange)'?'rgba(255,145,0,.1)':
                 s.col==='var(--yellow)'?'rgba(255,215,64,.1)':'rgba(255,255,255,.04)';
      const pctLabel = adtv ? ` · ${s.pct.toFixed(0)}% of ADTV` : '';
      return { ...s, bg, pctLabel };
    }
    // Max deal value in this batch — used to size bars relatively
    const maxVal = Math.max(...d.deals.map(x=>x.value||x.price*x.qty||0), 1);

    listEl.innerHTML = d.deals.map((deal) => {
      const sarValue = deal.value||deal.price*deal.qty||0;
      const scanRow  = scanData.find(r=>r.sym===deal.sym);
      const bias     = scanRow ? biasBadgeHtml(scanRow.bias) : '';
      const whale    = scanRow?.whale_score>=5 ? `<span title="Whale score ${scanRow.whale_score}/10">🐋</span>` : '';
      const time     = deal.time ? new Date(deal.time).toLocaleTimeString('en-SA',{hour:'2-digit',minute:'2-digit'}) : '';
      const val      = fmt(sarValue);
      const sarDisp  = sarValue.toLocaleString('en-SA',{maximumFractionDigits:0});
      const isManual = deal.source === 'Manual';
      const sig      = dealSignificance(sarValue, deal.sym);
      // Relative bar: this deal vs largest deal today
      const relPct   = Math.round((sarValue / maxVal) * 100);
      // Vol context: if stock was scanned, show vol_ratio as note
      const volCtx   = scanRow?.vol_ratio!=null
        ? `<span style="font-size:9px;color:${scanRow.vol_ratio>=1.5?'var(--green)':scanRow.vol_ratio>=1.2?'var(--yellow)':'var(--text3)'}">Vol ${scanRow.vol_ratio}× avg</span>`
        : '';
      const freq = d.frequency?.[deal.sym];
      const freqBadge = freq?.label ? `<span style="font-size:9px;background:rgba(255,215,64,.12);color:var(--yellow);border:1px solid rgba(255,215,64,.2);border-radius:10px;padding:1px 6px;margin-left:4px">${freq.label}</span>` : '';
      const srcBadge = `<span class="bd-source-tag" style="background:${isManual?'var(--bg3)':'#1a3a5c'};color:${isManual?'var(--text3)':'#5aabff'}">${deal.source||'Auto'}</span>`;
      const arabicHint = (!isManual && deal.arabicCompany) ? `<span style="font-size:10px;color:var(--text3);margin-left:4px" dir="rtl">${deal.arabicCompany}</span>` : '';
      const delBtn   = isManual
        ? `<button class="bd-del-btn" onclick="deleteBlockDeal('${deal.sym}','${deal.time}')" title="Remove">✕</button>`
        : `<span title="Argaam auto-fetched" style="color:var(--text3);padding:0 6px;font-size:11px">🔒</span>`;
      const cmaBadge = cmaBadgeForDeal(deal, deal.time ? deal.time.slice(0,10) : null);
      return `<div class="bd-row">
        <div style="flex:1;cursor:pointer" onclick="onRowClick(event,'${deal.sym}')">
          <div class="bd-header">
            <span>${whale}<span class="bd-ticker">${tickerDisplay(deal.sym)}</span>${freqBadge} ${srcBadge} ${bias}</span>
            <div style="display:flex;align-items:center;gap:6px">
              <span class="bd-sig-badge" style="font-size:9px;font-weight:700;padding:1px 7px;border-radius:10px;background:${sig.bg};color:${sig.col};border:1px solid ${sig.col}33">${sig.label}${sig.pctLabel}</span>
              <span class="bd-value">${val}</span>
            </div>
          </div>
          ${cmaBadge ? `<div style="margin-top:4px">${cmaBadge}</div>` : ''}
          <!-- Relative size bar -->
          <div style="margin:5px 0 4px;height:4px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${relPct}%;background:${sig.col};border-radius:2px;transition:width .4s"></div>
          </div>
          <div style="font-size:11px;color:var(--text2)">${deal.name}${arabicHint}${deal.note?' · <em>'+deal.note+'</em>':''}</div>
          <div class="bd-detail">
            <span>@ <strong>${deal.price.toFixed(2)}</strong></span>
            <span><strong>${deal.qty.toLocaleString()}</strong> shares</span>
            <span>= SAR ${sarDisp}</span>
            ${time?`<span>${time}</span>`:''}
            ${volCtx}
          </div>
        </div>
        ${delBtn}
      </div>`;
    }).join('');
  } catch(e) {
    listEl.innerHTML = `<div class="whale-empty">Error loading deals: ${e.message}</div>`;
  }
}

// Insider Buys functions removed Phase 4 — UI cut Phase 1, /api/insider-buys routes removed, tables empty.

init();

// ── Glossary ─────────────────────────────────────────────────────────────────
const GLOSSARY = [
  { section: 'Signals' },
  { term:'STRONG BUY / BUY', def:'The stock passes most or all of the checklist. Indicators suggest an upward move is likely. This is when traders consider entering.' },
  { term:'WATCH',            def:'The stock shows some positive signs but hasn\'t fully confirmed. Monitor it daily — a volume surge or breakout could be the trigger.' },
  { term:'SKIP',             def:'No clear direction either way. There are better opportunities elsewhere. Ignore for now.' },
  { term:'AVOID',            def:'The stock has warning signs — maybe it\'s in a downtrend, or momentum is weak. Higher risk than reward.' },
  { term:'SELL / STRONG SELL',def:'Existing holders should consider exiting. Multiple signs point to weakness or a continued decline.' },

  { section: 'Score (0–8 pts)' },
  { term:'Score',            def:'A number from 0 to 8 based on how many technical criteria pass. Think of it like a scorecard: 7–8 = almost perfect setup, 0–2 = most criteria failing.' },
  { term:'Strong (7–8)',     def:'Nearly all criteria are met — the best quality setups.' },
  { term:'Good (5–6)',       def:'More criteria pass than fail. A reasonable setup worth watching.' },
  { term:'Fair (3–4)',       def:'Mixed signals. Half the criteria pass, half don\'t.' },
  { term:'Weak (0–2)',       def:'Most criteria are failing. Low probability of a successful trade.' },

  { section: 'Trend Indicators' },
  { term:'EMA (Exponential Moving Average)', def:'A smoothed average of recent prices. "EMA 13" means the average of the last 13 days, weighted toward more recent prices. When short-term EMA > long-term EMA, the stock is trending up.' },
  { term:'EMA Stack (13 > 34 > 89)',  def:'When the 13-day average is above the 34-day, which is above the 89-day, all three timeframes agree the stock is rising. Like traffic lights all turning green at once.' },
  { term:'Above EMA 200',    def:'The stock\'s price is above its 200-day moving average — the gold standard for "this stock is in a long-term uptrend." Most professional investors require this before buying.' },

  { section: 'Momentum Indicators' },
  { term:'RSI (Relative Strength Index)', def:'A 0–100 score measuring how fast a stock has been rising or falling. 52–78 = healthy upward momentum. Above 78 = potentially overbought (may pull back). Below 40 = weak momentum.' },
  { term:'MACD (Moving Average Convergence Divergence)', def:'Compares two moving averages to measure momentum direction. When MACD is positive (histogram above zero), buying pressure is building. When negative, selling pressure is building.' },
  { term:'Divergence',       def:'When price makes a new low but RSI doesn\'t — or vice versa. This mismatch often signals a reversal is coming before it happens.' },

  { section: 'Volume & Risk' },
  { term:'Volume (1.2× average)', def:'The number of shares traded. When volume is higher than usual (1.2× or more), it confirms that the price move is backed by real buying interest — not just noise.' },
  { term:'ATR (Average True Range)', def:'Measures how much a stock typically moves per day. Used to set stop-losses and profit targets. A high ATR means the stock is volatile; a low ATR means it moves slowly.' },
  { term:'Stop Loss',        def:'The price at which you exit a trade to limit your loss if it goes wrong. Typically set 1.5× ATR below your entry price.' },
  { term:'Target 1 / Target 2', def:'Expected profit levels based on the ATR. T1 = 1.5× ATR above entry (conservative). T2 = 3× ATR above entry (optimistic).' },
  { term:'RS (Relative Strength vs Index)', def:'How the stock is performing compared to its market index over the last 20 days. +3% means it\'s outperforming the index by 3%. Positive RS = market leader.' },

  { section: 'Chart Terms' },
  { term:'Support Level',    def:'A price where the stock has bounced back up multiple times in the past. Think of it as a floor — buyers step in at this price.' },
  { term:'Resistance Level', def:'A price where the stock has been turned back down multiple times. Think of it as a ceiling — sellers step in at this price.' },
  { term:'Halal / Sharia Compliant', def:'Stocks screened against Islamic finance principles — no interest-based businesses, no gambling, no alcohol/tobacco, debt ratio below acceptable levels.' },
];

function openGlossary(){
  let html=GLOSSARY.map(g=>{
    if(g.section) return`<div class="glossary-section">${g.section}</div>`;
    return`<div class="glossary-term"><dl><dt>${g.term}</dt><dd>${g.def}</dd></dl></div>`;
  }).join('');
  document.getElementById('glossary-content').innerHTML=html;
  document.getElementById('glossary-overlay').classList.add('open');
}
function closeGlossary(){ document.getElementById('glossary-overlay').classList.remove('open'); }

// ════════════════════════════════════════════════════════════
// CMA FILING MONITOR
// ════════════════════════════════════════════════════════════
let cmaFilingsCache = [];   // all CMA filings loaded from server

async function loadCMAFilings(force = false) {
  try {
    if (!force && cmaFilingsCache.length) return cmaFilingsCache;
    const d = await fetch('/api/cma/filings').then(r => r.json());
    cmaFilingsCache = d.filings || [];
    renderCMAFilings();
    // Re-render block deal rows so CMA badges appear
    if (openDrawerData) renderDrawerBlockDeals(openDrawerData.sym);
    return cmaFilingsCache;
  } catch (e) {
    console.warn('CMA filings load failed:', e.message);
    return [];
  }
}

function cmaForSym(sym, refDate = null, windowDays = 5) {
  const ticker = sym.replace('TADAWUL:','');
  return cmaFilingsCache.filter(f => {
    const fs = (f.sym||'').replace('TADAWUL:','');
    const symMatch = fs === ticker || f.sym === sym;
    if (!symMatch) return false;
    if (!refDate) return true;
    const diff = Math.abs(new Date(f.filing_date) - new Date(refDate)) / 86400000;
    return diff <= windowDays;
  });
}

function renderCMAFilings() {
  const el = document.getElementById('cma-filings-list');
  if (!el) return;
  if (!cmaFilingsCache.length) {
    el.innerHTML = `<div class="whale-empty">No CMA filings loaded. Click ⟳ Refresh or add manually above.</div>`;
    return;
  }
  const fmt = v => v != null ? v.toFixed(1)+'%' : '—';
  el.innerHTML = cmaFilingsCache.map(f => {
    const dirCls  = f.direction === 'buy' ? 'cma-buy' : f.direction === 'sell' ? 'cma-sell' : 'cma-unknown';
    const dirLbl  = f.direction === 'buy' ? '↑ Bought' : f.direction === 'sell' ? '↓ Sold' : '? Unknown';
    const verifBadge = f.verified
      ? `<span class="cma-verified">✓ CMA Confirmed</span>`
      : `<span class="cma-inferred">~ Inferred</span>`;
    const delta = f.prev_pct != null && f.new_pct != null
      ? `${fmt(f.prev_pct)} → ${fmt(f.new_pct)} <span style="color:${f.direction==='buy'?'var(--green)':'#ff5252'}">(${f.direction==='buy'?'+':''}${(f.new_pct-f.prev_pct).toFixed(1)}%)</span>`
      : f.new_pct != null ? `Stake: ${fmt(f.new_pct)}` : '';
    const scanRow = scanData.find(r => r.sym === f.sym);
    const ticker  = (f.sym||'').replace('TADAWUL:','');
    const name    = f.company || scanRow?.name || ticker;
    return `<div class="cma-row">
      <span class="cma-dir-badge ${dirCls}">${dirLbl}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px">
          <span class="td-ticker" style="font-size:11px">${ticker}</span>
          <span style="font-size:11px;color:var(--text2)">${name}</span>
          ${verifBadge}
          <span style="font-size:10px;color:var(--text3);margin-inline-start:auto">${f.filing_date}</span>
        </div>
        <div class="cma-inst">${f.institution||'Unknown'}</div>
        ${f.institution_en ? `<div class="cma-inst-en">${f.institution_en}</div>` : ''}
        ${delta ? `<div class="cma-pct-change" style="margin-top:2px">${delta}</div>` : ''}
        ${f.source_url ? `<div style="margin-top:3px"><a href="${f.source_url}" target="_blank" style="font-size:9px;color:var(--accent)">Source →</a></div>` : ''}
      </div>
      <button class="cma-del-btn" onclick="deleteCMAFiling(${f.id})" title="Remove">✕</button>
    </div>`;
  }).join('');
}

async function addCMAFiling() {
  const sym  = document.getElementById('cma-sym')?.value.trim();
  const inst = document.getElementById('cma-inst')?.value.trim();
  const dir  = document.getElementById('cma-dir')?.value;
  const prev = document.getElementById('cma-prev')?.value;
  const nw   = document.getElementById('cma-new')?.value;
  const date = document.getElementById('cma-date')?.value;
  const url  = document.getElementById('cma-url')?.value.trim();
  const statusEl = document.getElementById('cma-add-status');

  if (!sym || !inst || !date) {
    if (statusEl) { statusEl.textContent = 'Stock code, institution and date are required'; statusEl.style.color='var(--red)'; }
    return;
  }

  try {
    const r = await fetch('/api/cma/filings/add', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sym, institution: inst, direction: dir,
        prev_pct: prev||null, new_pct: nw||null, filing_date: date, source_url: url||null })
    }).then(x => x.json());

    if (r.ok) {
      if (statusEl) { statusEl.textContent = '✓ Filing added'; statusEl.style.color='var(--green)'; }
      ['cma-sym','cma-inst','cma-prev','cma-new','cma-url'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
      await loadCMAFilings(true);
    } else {
      if (statusEl) { statusEl.textContent = r.error || 'Add failed'; statusEl.style.color='var(--red)'; }
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = e.message; statusEl.style.color='var(--red)'; }
  }
}

async function deleteCMAFiling(id) {
  await fetch('/api/cma/filings/delete', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id})
  });
  await loadCMAFilings(true);
}

async function refreshCMAFilings() {
  const btn = document.getElementById('cma-refresh-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin">⟳</span> Fetching…'; }
  try {
    const r = await fetch('/api/cma/refresh', { method:'POST' }).then(x => x.json());
    await loadCMAFilings(true);
    if (btn) {
      btn.innerHTML = r.new_filings > 0
        ? `✓ ${r.new_filings} new filing${r.new_filings>1?'s':''}`
        : (r.skipped ? '⟳ Refresh (cached)' : '⟳ None found');
      setTimeout(() => { btn.innerHTML = '⟳ Refresh'; btn.disabled = false; }, 3000);
    }
  } catch (e) {
    if (btn) { btn.innerHTML = '⟳ Refresh'; btn.disabled = false; }
  }
}

// Whale tab loads block deals + CMA filings.
async function loadWhaleTab(force=false) {
  await loadBlockDeals(force);
  await loadCMAFilings(force);
}

// Helper: get CMA badge HTML for a block deal row
function cmaBadgeForDeal(deal, dealDate) {
  const filings = cmaForSym(deal.sym, dealDate, 5);
  if (!filings.length) return '';
  const f = filings[0];
  if (f.direction === 'buy')
    return `<span class="bd-cma-badge bd-cma-buy">✓ CMA: ${f.institution_en||f.institution||'Institution'} Bought</span>`;
  if (f.direction === 'sell')
    return `<span class="bd-cma-badge bd-cma-sell">✓ CMA: ${f.institution_en||f.institution||'Institution'} Sold</span>`;
  return `<span class="bd-cma-badge" style="background:rgba(255,255,255,.05);color:var(--text2);border:1px solid var(--border)">CMA Filing Exists</span>`;
}

// ════════════════════════════════════════════════════════════
// BLOCK DEALS IN DRAWER OVERVIEW
// ════════════════════════════════════════════════════════════
function renderDrawerBlockDeals(sym){
  const el=document.getElementById('drawer-block-deals'); if(!el) return;
  if(!blockDealsCache.length){ el.style.display='none'; return; }
  // Match by sym — TradingView format (TADAWUL:1234) vs plain (1234)
  const ticker=tickerDisplay(sym).replace('TADAWUL:','');
  const deals=blockDealsCache.filter(d=>{
    const ds=d.sym?.replace('TADAWUL:','');
    return ds===ticker||d.sym===sym||tickerDisplay(d.sym)===ticker;
  });
  if(!deals.length){ el.style.display='none'; return; }
  const fmtV=v=>v>=1e6?(v/1e6).toFixed(1)+'M SAR':v>=1e3?(v/1e3).toFixed(0)+'K SAR':v.toLocaleString()+' SAR';
  const maxV=Math.max(...deals.map(x=>x.value||x.price*x.qty||0),1);
  function sig(v,sym){ const s=dealSignificanceVsADTV(v,sym); return s; }
  el.innerHTML=`<div class="crit-section-title" style="margin-top:10px">Block Deals Today <span style="font-size:9px;font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0;margin-inline-start:4px">${deals.length} deal${deals.length>1?'s':''} · confirms volume story</span></div>
  <div style="display:flex;flex-direction:column;gap:6px">
  ${deals.map(deal=>{
    const sarV=deal.value||deal.price*deal.qty||0;
    const s=sig(sarV);
    const relPct=Math.round(sarV/maxV*100);
    const t=deal.time?new Date(deal.time).toLocaleTimeString('en-SA',{hour:'2-digit',minute:'2-digit'}):'';
    return`<div style="background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-inline-start:3px solid ${s.col};border-radius:10px;padding:10px 12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:9px;font-weight:700;color:${s.col}">${s.label}</span>
        <span style="font-size:13px;font-weight:800;font-family:'JetBrains Mono',monospace;color:${s.col}">${fmtV(sarV)}</span>
      </div>
      <div style="height:4px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;margin-bottom:6px">
        <div style="height:100%;width:${relPct}%;background:${s.col};border-radius:2px"></div>
      </div>
      <div style="font-size:11px;color:var(--text2)">${deal.qty.toLocaleString()} shares @ ${deal.price.toFixed(2)}${t?' · '+t:''}</div>
    </div>`;
  }).join('')}
  </div>`;
  el.style.display='block';
}

// ════════════════════════════════════════════════════════════
// MARKET STATUS — TASI / US / BTC pills in header
// ════════════════════════════════════════════════════════════
function updateMarketStatus(){
  const el=document.getElementById('market-status'); if(!el) return;
  const now=new Date();
  const utcH=now.getUTCHours(), utcM=now.getUTCMinutes(), utcDay=now.getUTCDay(); // 0=Sun
  const utcMins=utcH*60+utcM;

  // TASI: Sun–Thu 07:00–12:00 UTC (10:00–15:00 AST UTC+3)
  const tasiOpen=(utcDay>=0&&utcDay<=4)&&(utcMins>=420&&utcMins<720);

  // US: determine ET offset (EDT UTC-4 Mar 2nd Sun → Nov 1st Sun; EST UTC-5 otherwise)
  function isEDT(d){ const yr=d.getUTCFullYear(); function nthSun(m,n){const t=new Date(Date.UTC(yr,m,1));const diff=(7-t.getUTCDay())%7;return new Date(Date.UTC(yr,m,1+diff+(n-1)*7));} const start=nthSun(2,2),end=nthSun(10,1); return d>=start&&d<end; }
  const etOffset=isEDT(now)?-4:-5;
  const etMins=((utcH+etOffset+24)%24)*60+utcM;
  const etDay=(utcDay+(utcH+etOffset<0?-1:utcH+etOffset>=24?1:0)+7)%7;
  // Regular session Mon–Fri 09:30–16:00 ET
  const usOpen=(etDay>=1&&etDay<=5)&&(etMins>=570&&etMins<960);

  function pill(label,isOpen,always){
    const cls=always?'mkt-always':isOpen?'mkt-open':'mkt-closed';
    return`<span class="mkt-pill ${cls}"><span class="mk-dot"></span>${label}</span>`;
  }
  el.innerHTML=pill('TASI',tasiOpen)+pill('US',usOpen)+pill('BTC',false,true);
}
setInterval(updateMarketStatus,30000); updateMarketStatus();

// ════════════════════════════════════════════════════════════
// SET ALL ATR ALERTS — one-click batch
// ════════════════════════════════════════════════════════════
async function setAllAtrAlerts(stop,tgt1,tgt2){
  const btn=document.getElementById('tpc-set-all-btn'); if(btn){btn.disabled=true;btn.textContent='Setting alerts…';}
  const sym=openDrawerData?.sym; if(!sym) return;
  const fmt=v=>parseFloat(v).toFixed(2);
  const calls=[
    fetch('/api/alert/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym,price:stop,   message:`${tickerDisplay(sym)} Stop @ ${fmt(stop)}`})}),
    fetch('/api/alert/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym,price:tgt1,   message:`${tickerDisplay(sym)} T1 @ ${fmt(tgt1)}`})}),
    fetch('/api/alert/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym,price:tgt2,   message:`${tickerDisplay(sym)} T2 @ ${fmt(tgt2)}`})}),
  ];
  try{
    const results=await Promise.all(calls.map(p=>p.then(r=>r.json()).catch(()=>({success:false}))));
    const ok=results.filter(r=>r.success).length;
    if(btn){btn.textContent=`✓ ${ok}/3 alerts set`;btn.style.color='var(--green)';setTimeout(()=>{if(btn){btn.textContent='Set Stop + T1 + T2 Alerts';btn.disabled=false;btn.style.color='';}},2500);}
  }catch(e){if(btn){btn.textContent='Error';setTimeout(()=>{if(btn){btn.textContent='Set Stop + T1 + T2 Alerts';btn.disabled=false;}},2000);}}
}

// ════════════════════════════════════════════════════════════
// SECTOR ROTATION — score delta between scans
// ════════════════════════════════════════════════════════════
function updateSectorRotation(){
  const wrap=document.getElementById('sector-rotation-wrap'); if(!wrap||!scanData.length){if(wrap)wrap.style.display='none';return;}
  // Compute current sector averages
  const sd={};
  scanData.filter(r=>r.bias!=='ERROR'&&r.bias!=='NO_DATA').forEach(r=>{
    const sec=sectorOf(r.sym);
    if(!sd[sec]) sd[sec]={sum:0,n:0};
    sd[sec].sum+=r.score; sd[sec].n++;
  });
  const curr={};
  Object.entries(sd).forEach(([sec,d])=>{ curr[sec]=Math.round(d.sum/d.n*10)/10; });
  // Load previous
  let prev={};
  try{ prev=JSON.parse(localStorage.getItem('mawjah_sector_prev')||'{}'); }catch(_){}
  // Save current for next scan
  localStorage.setItem('mawjah_sector_prev',JSON.stringify(curr));
  // Render only if we have prev data
  const hasPrev=Object.keys(prev).length>0;
  const _rotMaxS = scanData.find(r=>r.maxScore>8)?.maxScore || 9;
  const entries=Object.entries(curr).sort((a,b)=>b[1]-a[1]);
  const tiles=entries.map(([sec,avg])=>{
    const col=avg>=(_rotMaxS*7/9)?'var(--green)':avg>=(_rotMaxS*4/9)?'var(--yellow)':'#ff5252';
    const pct=Math.round(avg/_rotMaxS*100);
    const delta=hasPrev&&prev[sec]!=null?Math.round((avg-prev[sec])*10)/10:null;
    const dHtml=delta!=null&&delta!==0?`<span class="srot-delta ${delta>0?'up':'dn'}">${delta>0?'+':''}${delta}</span>`:'';
    return`<div class="srot-tile" onclick="filterSector('${sec}',document.querySelector('[onclick*=filterSector][onclick*=${sec}]')||{classList:{add:()=>{},remove:()=>{}}})">
      <div class="srot-name">${sectorLabel(sec)}</div>
      <div><span class="srot-score" style="color:${col}">${avg}</span>${dHtml}</div>
      <div class="srot-bar"><div class="srot-fill" style="width:${pct}%;background:${col}"></div></div>
    </div>`;
  }).join('');
  wrap.innerHTML=`<div class="sector-rot-panel">
    <div class="sector-rot-header">Sector Scores <span style="font-size:9px;font-weight:400;color:var(--text3);margin-inline-start:4px">avg score/${_rotMaxS} · click to filter · delta vs last scan</span></div>
    <div class="sector-rot-grid">${tiles}</div>
  </div>`;
  wrap.style.display='block';
}

// ════════════════════════════════════════════════════════════
// TRADE CHECKLIST MODAL
// ════════════════════════════════════════════════════════════
let _checklistCallback=null;
function showTradeChecklist(r, onConfirm){
  const overlay=document.getElementById('cl-overlay'); if(!overlay) return;
  const isBear=['STRONG SELL','SELL','AVOID'].includes(r?.bias);
  // Build checklist items
  const items=[];
  // 1. Score
  const score=r?.score??0; const maxScore=r?.maxScore??8;
  const scoreOk=score>=(isBear?6:5);
  items.push({cls:scoreOk?'cl-pass':'cl-fail',icon:scoreOk?'✓':'✗',label:`Score: ${score}/${maxScore}`,detail:scoreOk?`${isBear?'Bear':'Bull'} criteria met`:`Below minimum — ${isBear?6:5}/${maxScore} needed to meet the trend-alignment threshold`});
  // 2. Volume
  const volOk=(r?.vol_ratio??0)>=1.2;
  items.push({cls:volOk?'cl-pass':'cl-warn',icon:volOk?'✓':'⚠',label:`Volume: ${r?.vol_ratio??'—'}×`,detail:volOk?'Above 1.2× average — confirms institutional participation':'Below 1.2× — thin volume, entry may not have conviction'});
  // 3. R:R
  const rrEl=document.getElementById('tpc-rr');
  const rrVal=rrEl?parseFloat(rrEl.textContent):null;
  const rrOk=rrVal!=null&&rrVal>=1.5;
  items.push({cls:rrOk?'cl-pass':rrVal!=null?'cl-fail':'cl-warn',icon:rrOk?'✓':'✗',label:`R:R: ${rrVal!=null?rrVal+':1':'—'}`,detail:rrOk?`${rrVal}:1 reward-to-risk — acceptable trade`:'Minimum 1.5:1 R:R needed for a positive-expectancy trade'});
  // 4. Market regime
  const regTrend=document.getElementById('rg-trend')?.textContent??'';
  const regOk=!regTrend.toLowerCase().includes('bear')||isBear;
  items.push({cls:regOk?'cl-pass':'cl-warn',icon:regOk?'✓':'⚠',label:`Market regime: ${regTrend||'—'}`,detail:regOk?'Regime supports this direction':'Counter-trend trade — use tighter stops and smaller size'});
  // 5. Sector
  const sec=sectorOf(r?.sym??'');
  const secAvgData=scanData.filter(x=>sectorOf(x.sym)===sec&&x.bias!=='ERROR');
  const secAvg=secAvgData.length?secAvgData.reduce((a,b)=>a+(b.score??0),0)/secAvgData.length:null;
  const secOk=secAvg!=null&&(isBear?secAvg<=4:secAvg>=4);
  items.push({cls:secOk?'cl-pass':'cl-warn',icon:secOk?'✓':'⚠',label:`Sector: ${sectorLabel(sec)} avg ${secAvg!=null?secAvg.toFixed(1):'—'}/8`,detail:secOk?'Sector score supports this trade direction':'Sector not fully aligned — consider if thesis is stock-specific'});

  const passCount=items.filter(i=>i.cls==='cl-pass').length;
  const failCount=items.filter(i=>i.cls==='cl-fail').length;
  document.getElementById('cl-subtitle').textContent=`${passCount}/5 checks pass · ${failCount>0?failCount+' critical issues':'No blockers'} · ${r?.name??r?.sym??''}`;
  document.getElementById('cl-items').innerHTML=items.map(i=>`<div class="cl-item ${i.cls}"><div class="cl-icon">${i.icon}</div><div><div class="cl-label">${i.label}</div><div class="cl-detail">${i.detail}</div></div></div>`).join('');
  const confirmBtn=document.getElementById('cl-confirm-btn');
  if(confirmBtn){
    confirmBtn.textContent=failCount>0?'Proceed anyway ('+failCount+' issue'+(failCount>1?'s':'')+')':'Proceed — Execute Trade';
    confirmBtn.style.background=failCount>0?'rgba(255,61,113,.6)':'';
    confirmBtn.onclick=()=>{ closeChecklist(); onConfirm(); };
  }
  _checklistCallback=onConfirm;
  overlay.classList.add('cl-open');
}
function closeChecklist(){ document.getElementById('cl-overlay')?.classList.remove('cl-open'); _checklistCallback=null; }

