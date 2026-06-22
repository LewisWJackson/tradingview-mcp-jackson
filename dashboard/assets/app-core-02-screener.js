// ────────────────────────────────────────────────────────────────────────────
// Tabs / filters
// ────────────────────────────────────────────────────────────────────────────
function switchTab(name,btn){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
  btn.classList.add('active');
  // Portfolio tab loads all three sections
  if(name==='positions'){ loadPositionsPanel(); loadVirtualPanel(); renderWatchlistPanel(); loadWhaleTab(); loadCorrelationMatrix(); }
  // Alerts tab
  if(name==='criteria'){ loadCriteriaEditor(); loadTelegramSettings(); loadAlertRules(); }
  // Settings tab
  if(name==='universe'){ renderScoringRules(); loadUniversePanel(); }
  // Markets tab
  if(name==='markets'){ loadMarketsPanel(); loadPlaybook(); }
  // Goals tab
  if(name==='goals'){ loadGoalsPanel(); loadAllocationPanel(); }
  // Lab tab
  if(name==='lab'){ loadLabPanel(); loadStrategyValidation(); }
  // Momentum Screen tab (+ block-deal signal)
  if(name==='momentum'){ loadMomentumScreen(); loadPeadScreen(); loadBlockDealSignal(); loadFillLedger(); }
}

// ────────────────────────────────────────────────────────────────────────────
// Universe management
// ────────────────────────────────────────────────────────────────────────────
async function loadUniversePanel(){
  const grid=document.getElementById('universe-grid');
  grid.innerHTML=`<div style="padding:20px;color:var(--text3);font-size:12px;grid-column:1/-1">${t('loading')}</div>`;
  try{
    const res=await fetch('/api/universe');
    universeData=await res.json();
    renderUniversePanel();
  }catch(e){ grid.innerHTML=`<div style="padding:20px;color:var(--red);font-size:12px;grid-column:1/-1">${e.message}</div>`; }
}

function renderUniversePanel(){
  const markets=[['tasi','mTasi'],['us','mUs'],['etf','mEtf'],['crypto','mCrypto'],['commodity','mCommodity']];
  document.getElementById('universe-grid').innerHTML=markets.map(([mkt,key])=>renderUniverseCard(mkt,key)).join('');
}

function renderUniverseCard(market,labelKey){
  const syms=universeData[market]||[];
  const itemsHtml=syms.length?syms.map((s,i)=>{
    const sym=typeof s==='object'?s.sym:s;
    const name=typeof s==='object'?s.name:'';
    const ticker=sym.includes(':')?sym.split(':')[1]:sym;
    return`<div class="criteria-item">
      <span class="td-ticker" style="font-size:11px;min-width:75px;flex-shrink:0">${ticker}</span>
      <span style="flex:1;font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name||sym}</span>
      <button class="criteria-del" onclick="removeUnivSymbol('${market}',${i})">✕</button>
    </div>`;
  }).join(''):`<div style="padding:8px 0;font-size:12px;color:var(--text3)">${t('univEmpty')}</div>`;

  return`<div class="criteria-card" data-market="${market}">
    <div class="criteria-card-header">
      <h3>${t(labelKey)} <span style="color:var(--text3);font-weight:400;font-size:11px">(${syms.length} ${t('univCount')})</span></h3>
      <button class="btn btn-secondary" style="font-size:10px;padding:3px 8px" onclick="resetMarket('${market}')">${t('univReset')}</button>
    </div>
    <div class="criteria-body" style="max-height:220px;overflow-y:auto" id="univ-body-${market}">${itemsHtml}</div>
    <div class="criteria-save-bar" style="flex-wrap:wrap;gap:6px">
      <input type="text" id="univ-sym-${market}" class="add-criteria-input" placeholder="${t('univSymPlaceholder')}" style="flex:2;min-width:120px"
        onkeydown="if(event.key==='Enter'){addUnivSymbol('${market}');event.preventDefault();}">
      <input type="text" id="univ-name-${market}" class="add-criteria-input" placeholder="${t('univNamePlaceholder')}" style="flex:1;min-width:90px"
        onkeydown="if(event.key==='Enter'){addUnivSymbol('${market}');event.preventDefault();}">
      <button class="btn btn-success" style="font-size:11px;padding:5px 10px" onclick="addUnivSymbol('${market}')">${t('univAdd')}</button>
      <button class="btn btn-primary" id="univ-save-${market}" style="font-size:11px;padding:5px 10px" onclick="saveMarket('${market}')">${t('univSave')}</button>
    </div>
  </div>`;
}

function removeUnivSymbol(market,index){
  if(!universeData[market]) return;
  universeData[market].splice(index,1);
  renderUniversePanel();
}

function addUnivSymbol(market){
  const symEl=document.getElementById(`univ-sym-${market}`);
  const nameEl=document.getElementById(`univ-name-${market}`);
  const rawSym=(symEl.value||'').trim().toUpperCase();
  const rawName=(nameEl?nameEl.value:'').trim();
  if(!rawSym) return;
  if(!universeData[market]) universeData[market]=[];
  universeData[market].push({sym:rawSym, name:rawName||rawSym.split(':').pop()});
  symEl.value=''; if(nameEl) nameEl.value='';
  renderUniversePanel();
}

async function saveMarket(market){
  try{
    const res=await fetch('/api/universe',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({market,symbols:universeData[market]||[]})});
    const r=await res.json();
    if(r.ok){
      const btn=document.getElementById(`univ-save-${market}`);
      if(btn){const orig=btn.innerHTML;btn.innerHTML=t('univSaved');btn.style.background='rgba(0,200,83,.2)';setTimeout(()=>{btn.innerHTML=orig;btn.style.background='';},1500);}
    }
  }catch(e){ alert(e.message); }
}

async function resetMarket(market){
  const label=t('m'+market.charAt(0).toUpperCase()+market.slice(1))||market;
  if(!confirm(`Reset "${label}" to default symbols?`)) return;
  try{
    const res=await fetch('/api/universe/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({market})});
    const r=await res.json();
    if(r.ok){ const uvRes=await fetch('/api/universe'); universeData=await uvRes.json(); renderUniversePanel(); }
  }catch(e){ alert(e.message); }
}
function filterSector(sec,btn){ filterSec=sec; document.querySelectorAll('#sector-filters .filter-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); renderTable(); }
function filterBias(val,btn){ filterBiasVal=val; document.querySelectorAll('[data-bias].filter-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); renderTable(); }
function onSearchInput(e){
  searchQuery=e.target.value.trim().toLowerCase();
  const clr=document.getElementById('search-clear-btn');
  if(clr) clr.style.display=searchQuery?'flex':'none';
  renderTable();
}
function clearSearch(){
  searchQuery='';
  const inp=document.getElementById('sym-search');
  if(inp) inp.value='';
  const clr=document.getElementById('search-clear-btn');
  if(clr) clr.style.display='none';
  renderTable();
}
function setMarket(mkt,btn){
  activeMarket=mkt;
  filterSec='all';
  document.querySelectorAll('#market-filters .filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderSectorFilter();
  renderTable();
  fetchAndShowRegime(mkt);
}

// ────────────────────────────────────────────────────────────────────────────
// Selection
// ────────────────────────────────────────────────────────────────────────────
function updateSelectionBar(){ const n=selectedSyms.size; document.getElementById('sel-count').textContent=n; document.getElementById('selection-bar').classList.toggle('visible',n>0); }
function toggleSelectAll(checked){ getVisibleRows().forEach(r=>checked?selectedSyms.add(r.sym):selectedSyms.delete(r.sym)); updateSelectionBar(); renderTable(); }
function clearSelection(){ selectedSyms.clear(); document.getElementById('cb-select-all').checked=false; updateSelectionBar(); renderTable(); }
function toggleRow(sym,checked){ if(checked)selectedSyms.add(sym); else selectedSyms.delete(sym); updateSelectionBar(); const vis=getVisibleRows(); document.getElementById('cb-select-all').checked=vis.length>0&&vis.every(r=>selectedSyms.has(r.sym)); }
let activeStyleFilter = 'all';

function filterStyle(style, btn) {
  activeStyleFilter = style;
  document.querySelectorAll('#style-filter-group .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderTable();
}

function getVisibleRows(){
  let rows=[...scanData];
  if(activeMarket!=='all') rows=rows.filter(r=>marketOf(r.sym)===activeMarket);
  if(filterSec!=='all') rows=rows.filter(r=>sectorOf(r.sym)===filterSec);
  if(filterBiasVal==='buys') rows=rows.filter(r=>r.bias==='STRONG BUY'||r.bias==='BUY');
  else if(filterBiasVal==='watch') rows=rows.filter(r=>r.bias==='WATCH');
  else if(filterBiasVal==='sells') rows=rows.filter(r=>r.bias==='STRONG SELL'||r.bias==='SELL'||r.bias==='AVOID');
  else if(filterBiasVal==='halal') rows=rows.filter(r=>shariaMap[r.sym]&&shariaMap[r.sym].status==='compliant');
  // Style filter — based on auto-detected style_tags
  if(activeStyleFilter!=='all') rows=rows.filter(r=>(r.style_tags||[]).includes(activeStyleFilter));
  if(searchQuery){
    const q=searchQuery;
    rows=rows.filter(r=>tickerDisplay(r.sym).toLowerCase().includes(q)||(r.name||'').toLowerCase().includes(q));
  }
  return rows;
}
async function scanSelected(){
  if(!selectedSyms.size) return;
  const btn=document.getElementById('btn-scan-selected');
  btn.disabled=true; btn.innerHTML='<span class="spin">⟳</span> '+t('scanSelected');
  await fetch('/api/scan/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols:[...selectedSyms]})});
  startPolling();
}

// ────────────────────────────────────────────────────────────────────────────
// Sort
// ────────────────────────────────────────────────────────────────────────────
function sortTable(key){ if(sortKey===key)sortAsc=!sortAsc; else{sortKey=key;sortAsc=key!=='score';} renderTable(); }
function sortVal(r,key){ switch(key){ case'ticker':return r.sym||''; case'name':return r.name||''; case'sector':return sectorOf(r.sym); case'price':return r.price||0; case'chg':return r.change_pct??-999; case'score':return r.score||0; case'rsi':return r.rsi||0; case'macd':return r.macd_hist||-999; case'vol':return r.vol_ratio||0; case'rs':return r.rs_score??-999; case'bias':return['STRONG BUY','BUY','WATCH','SKIP','AVOID','SELL','STRONG SELL','ERROR','NO_DATA'].indexOf(r.bias); case'delta':{ const d=deltaData.find(x=>x.sym===r.sym); return d?.score_delta||0; } } return 0; }

// ────────────────────────────────────────────────────────────────────────────
// Render helpers
// ────────────────────────────────────────────────────────────────────────────
function scoreColor(s,m){ const p=s/m; return p>=.85?'#00c853':p>=.6?'#76ff03':p>=.375?'#ffd600':'#ff5252'; }
function rsiClass(v){ if(v==null)return'rsi-neut'; if(v>=78)return'rsi-ob'; if(v>=52)return'rsi-bull'; if(v>=40)return'rsi-neut'; return'rsi-bear'; }

// Plain-language helpers for non-financial users
function scoreLabel(s,m){
  const p=(s||0)/(m||8);
  if(p>=.85) return{text:'Strong',col:'#00c853'};
  if(p>=.625) return{text:'Good',col:'#76ff03'};
  if(p>=.375) return{text:'Fair',col:'#ffd600'};
  return{text:'Weak',col:'#ff5252'};
}
function plainSignal(bias){
  return{
    'STRONG BUY': 'Strong uptrend state — descriptive, not a buy signal',
    'BUY':        'Uptrend state — a description, not a recommendation',
    'WATCH':      'Mixed / building trend — not a signal',
    'SKIP':       'No clear trend',
    'AVOID':      'Early downtrend lean (descriptive)',
    'SELL':       'Downtrend state (descriptive, not advice)',
    'STRONG SELL':'Strong downtrend state (descriptive, not advice)',
    'ERROR':      'Could not load data for this stock',
    'NO_DATA':    'Not enough data to evaluate',
  }[bias]||'';
}

function rsHtml(r){
  if(r.rs_score==null) return'<span class="rs-neut">—</span>';
  const cls=r.rs_score>2?'rs-lead':r.rs_score<-2?'rs-lag':'rs-neut';
  const sign=r.rs_score>0?'+':'';
  return`<span class="${cls}">${sign}${r.rs_score.toFixed(1)}%</span>`;
}

// ── Live scanner (SSE) ───────────────────────────────────────────────────────
let liveActive = false;
let eventSource = null;

function connectSSE(){
  if(eventSource) return;
  // EventSource can't set the Authorization header — pass the JWT as a query param.
  const _t = localStorage.getItem('mawjah_jwt') || '';
  eventSource = new EventSource('/api/events' + (_t ? '?token=' + encodeURIComponent(_t) : ''));
  eventSource.onmessage = e => {
    try{
      const d = JSON.parse(e.data);
      if(d.type === 'score_change'){
        const row = document.querySelector(`tr[data-sym="${d.sym}"]`);
        if(row){ row.classList.remove('flash-improve','flash-degrade'); void row.offsetWidth; row.classList.add(d.direction==='improved'?'flash-improve':'flash-degrade'); }
        const r = scanData.find(x=>x.sym===d.sym);
        if(r && d.curr_bias) r.bias = d.curr_bias;
        renderTable();
      } else if(d.type === 'alert_rule_triggered'){
        // Flash notification
        const n=document.createElement('div');
        n.style.cssText='position:fixed;bottom:20px;inset-inline-end:20px;background:rgba(61,142,255,.9);color:#fff;padding:10px 14px;border-radius:8px;font-size:12px;font-weight:600;z-index:999;max-width:280px;box-shadow:0 4px 12px rgba(0,0,0,.4)';
        n.textContent=`📋 ${d.ruleName}: ${d.name} — ${d.bias}`;
        document.body.appendChild(n);
        setTimeout(()=>n.remove(),5000);
        // Update score history after scan
        fetch('/api/score-history').then(r=>r.json()).then(h=>{scoreHistory=h;renderTable();}).catch(()=>{});
      } else if(d.type === 'auto_scan_starting'){
        const pill=document.getElementById('auto-scan-pill');
        if(pill){ pill.style.display='inline-flex'; pill.classList.add('as-fired'); document.getElementById('auto-scan-pill-text').textContent=`Auto-scan: ${d.slot} running…`; }
        const nt=document.createElement('div');
        nt.style.cssText='position:fixed;bottom:20px;inset-inline-end:20px;background:rgba(0,200,255,.9);color:#000;padding:10px 14px;border-radius:8px;font-size:12px;font-weight:600;z-index:999;max-width:280px;box-shadow:0 4px 12px rgba(0,0,0,.4)';
        nt.textContent=`🤖 Auto-scan: ${d.slot} starting…`;
        document.body.appendChild(nt); setTimeout(()=>nt.remove(),4000);
      } else if(d.type === 'scan_complete'){
        // Show/hide quick scan integrity warning
        const banner=document.getElementById('quick-scan-banner');
        if(banner){
          if(d.quickScan&&d.quickSkipped>0){
            document.getElementById('quick-scan-skipped').textContent=d.quickSkipped;
            banner.style.display='block';
          } else {
            banner.style.display='none'; // Full scan — banner not needed
          }
        }
        fetch('/api/scan/results').then(r=>r.json()).then(sr=>{
          if(sr.results?.length){
            scanData=sr.results; renderTable(); renderWatchlistPanel();
            if(openDrawerData){ const fresh=scanData.find(x=>x.sym===openDrawerData.sym); if(fresh){openDrawerData=fresh;buildSignalTab(fresh);buildTradeTab(fresh);} }
          }
        });
        fetch('/api/score-history').then(r=>r.json()).then(h=>{scoreHistory=h;renderTable();}).catch(()=>{});
        loadAutoScanStatus();
        // Silently refresh presignal badge count
        fetch('/api/scan/presignal').then(r=>r.json()).then(d=>{
          const badge=document.getElementById('presignal-badge');
          if(!badge) return;
          const n=d.presignal?.length||0;
          const exits=(d.presignal||[]).filter(s=>s.approaching==='EXIT_RISK').length;
          if(n>0){badge.textContent=exits>0?exits:n;badge.style.display='inline-block';}
          else{badge.style.display='none';}
          // If panel is visible, refresh it
          const panel=document.getElementById('presignal-panel');
          if(panel&&panel.style.display!=='none') loadPreSignal();
        }).catch(()=>{});
        // Auto-refresh Markets after every full scan
        if (!d.quickScan) {
          loadMarketsPanel(true);
        }
      } else if(d.type === 'live_stopped'){
        liveActive=false; updateLiveBtn();
      }
    }catch(_){}
  };
  eventSource.onerror = () => { eventSource?.close(); eventSource=null; };
}

function updateLiveBtn(){
  const btn=document.getElementById('btn-live');
  const lbl=document.getElementById('btn-live-label');
  if(!btn||!lbl) return;
  btn.classList.toggle('live-active', liveActive);
  lbl.textContent = liveActive ? `${t('liveOn')} ${liveIntervalVal}${t('liveMin')}` : t('liveOff');
}

let liveIntervalVal = 10;
async function toggleLiveMode(){
  if(!liveActive){
    const i = parseInt(prompt(`Scan every X minutes? (5, 10, 15, 30)`, '10') || '10');
    liveIntervalVal = isNaN(i) ? 10 : Math.max(5, Math.min(60, i));
    await fetch('/api/live/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({interval:liveIntervalVal})});
    liveActive=true; connectSSE();
  } else {
    await fetch('/api/live/stop',{method:'POST'});
    liveActive=false;
  }
  updateLiveBtn();
}

// ── Backtest ──────────────────────────────────────────────────────────────────
// ── Backtest state ──────────────────────────────────────────────────────────
let _btSym = null, _btMinScore = 7, _btHoldBars = 40;

function btParamControls() {
  return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 0 8px">
    <span style="font-size:10px;color:var(--text3)">Min Score</span>
    ${[5,6,7].map(v=>`<button onclick="setBtParam('minScore',${v})" id="bt-ms-${v}"
      style="font-size:10px;padding:2px 7px;border-radius:4px;border:1px solid var(--border2);
      background:${_btMinScore===v?'var(--accent)':'var(--bg2)'};color:${_btMinScore===v?'#fff':'var(--text2)'};cursor:pointer">${v}</button>`).join('')}
    <span style="font-size:10px;color:var(--text3);margin-inline-start:6px">Hold</span>
    ${[20,40,60].map(v=>`<button onclick="setBtParam('holdBars',${v})" id="bt-hb-${v}"
      style="font-size:10px;padding:2px 7px;border-radius:4px;border:1px solid var(--border2);
      background:${_btHoldBars===v?'var(--accent)':'var(--bg2)'};color:${_btHoldBars===v?'#fff':'var(--text2)'};cursor:pointer">${v}d</button>`).join('')}
    <button onclick="runSweep('${_btSym||''}')" style="margin-inline-start:auto;font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--border2);background:var(--bg2);color:var(--text2);cursor:pointer">⚡ Sweep</button>
  </div>`;
}

function setBtParam(key, val) {
  if (key === 'minScore') _btMinScore = val;
  else _btHoldBars = val;
  if (_btSym) runBacktestInDrawer(_btSym);
}

function renderEquity(equity, w=300, h=60) {
  if (!equity || equity.length < 2) return '';
  const min=Math.min(...equity), max=Math.max(...equity), range=max-min||1;
  const pts=equity.map((v,i)=>`${Math.round(i/(equity.length-1)*(w-1))},${Math.round(h-1-(v-min)/range*(h-1))}`).join(' ');
  const col=equity.at(-1)>=100?'var(--green)':'#ff5252';
  const baseY=Math.round(h-1-(100-min)/range*(h-1));
  return `<svg viewBox="0 0 ${w} ${h}" class="bt-equity" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5"/>
    <line x1="0" y1="${baseY}" x2="${w}" y2="${baseY}" stroke="var(--border2)" stroke-dasharray="3,3"/>
  </svg>`;
}

function renderBtStats(stats, barCount) {
  const c = (v,g,y)=>v>=g?'var(--green)':v>=y?'var(--yellow)':'#ff5252';
  const pf = stats.profitFactor!=null ? stats.profitFactor+'×' : 'N/A';
  const sh = stats.sharpe!=null ? stats.sharpe.toFixed(2) : 'N/A';
  const dd = stats.maxDrawdown!=null ? '-'+stats.maxDrawdown+'%' : 'N/A';
  const dataLine = barCount ? `<div style="font-size:9px;color:var(--text3);margin-bottom:4px">${barCount} bars · ${Math.round(barCount/252)} yrs · 0.35% commission · open entry</div>` : '';
  return dataLine + `<div class="bt-stats" style="grid-template-columns:repeat(4,1fr)">
    <div class="bt-stat"><div class="bt-stat-val">${stats.total}</div><div class="bt-stat-lbl">Trades</div></div>
    <div class="bt-stat"><div class="bt-stat-val" style="color:${c(stats.winRate,55,45)}">${stats.winRate}%</div><div class="bt-stat-lbl">Win Rate</div></div>
    <div class="bt-stat"><div class="bt-stat-val" style="color:${stats.avgReturn>=0?'var(--green)':'#ff5252'}">${stats.avgReturn>0?'+':''}${stats.avgReturn}%</div><div class="bt-stat-lbl">Avg Return</div></div>
    <div class="bt-stat"><div class="bt-stat-val">${pf}</div><div class="bt-stat-lbl">Prof. Factor</div></div>
    <div class="bt-stat"><div class="bt-stat-val" style="color:${dd==='-0%'||dd==='N/A'?'var(--text2)':'#ff5252'}">${dd}</div><div class="bt-stat-lbl">Max DD</div></div>
    <div class="bt-stat"><div class="bt-stat-val">${sh}</div><div class="bt-stat-lbl">Sharpe</div></div>
    <div class="bt-stat"><div class="bt-stat-val" style="color:var(--green)">${stats.maxWinStreak}W</div><div class="bt-stat-lbl">Best Streak</div></div>
    <div class="bt-stat"><div class="bt-stat-val" style="color:#ff5252">${stats.maxLossStreak}L</div><div class="bt-stat-lbl">Worst Streak</div></div>
  </div>`;
}

function renderBtTrades(trades) {
  if (!trades?.length) return '';
  return `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);margin-bottom:4px">Recent Trades</div>`+
    [...trades].reverse().slice(0,5).map(tr=>`<div class="bt-trade">
      <span class="${tr.pct>=0?'bt-win':'bt-loss'}">${tr.pct>=0?'+':''}${tr.pct}%</span>
      <span style="color:var(--text2)">${tr.date}</span>
      <span class="bt-outcome">${tr.outcome}${tr.trailed?' 🎯':''}</span>
      <span style="margin-inline-start:auto;color:var(--text3)">${tr.bars_held}d · ${tr.score}/8</span>
    </div>`).join('');
}

async function runBacktestInDrawer(sym) {
  const el = document.getElementById('drawer-bt');
  if (!el) return;
  _btSym = sym;
  el.innerHTML = btParamControls() + `<div style="padding:16px;text-align:center;font-size:12px;color:var(--text3)">Fetching 2000 bars from Yahoo…</div>`;
  try {
    const r = await fetch('/api/backtest', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sym, minScore: _btMinScore, holdBars: _btHoldBars }) }).then(x => x.json());
    if (r.error) { el.innerHTML = btParamControls() + `<div style="padding:6px;font-size:11px;color:var(--red)">${r.error}</div>`; return; }
    el.innerHTML = btParamControls() + renderBtStats(r.stats, r.barCount) + renderEquity(r.equity) + renderBtTrades(r.trades);
  } catch(e) { el.innerHTML = btParamControls() + `<div style="padding:6px;font-size:11px;color:var(--red)">${e.message}</div>`; }
}

async function runSweep(sym) {
  if (!sym) return;
  const el = document.getElementById('drawer-bt');
  if (!el) return;
  el.innerHTML = btParamControls() + `<div style="padding:16px;text-align:center;font-size:12px;color:var(--text3)">Running 9-combo sweep…</div>`;
  try {
    const r = await fetch('/api/backtest/sweep', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sym }) }).then(x => x.json());
    if (r.error) { el.innerHTML = btParamControls() + `<div style="padding:6px;font-size:11px;color:var(--red)">${r.error}</div>`; return; }
    const rows = r.sweep.map((s,i)=>`<tr style="background:${i===0?'rgba(61,139,255,.08)':''}">
      <td style="padding:4px 6px;font-weight:${i===0?700:400}">${s.minScore}</td>
      <td style="padding:4px 6px">${s.holdBars}d</td>
      <td style="padding:4px 6px;color:${s.winRate>=55?'var(--green)':s.winRate>=45?'var(--yellow)':'#ff5252'}">${s.winRate}%</td>
      <td style="padding:4px 6px;color:${s.avgReturn>=0?'var(--green)':'#ff5252'}">${s.avgReturn>0?'+':''}${s.avgReturn}%</td>
      <td style="padding:4px 6px">${s.profitFactor!=null?s.profitFactor+'×':'—'}</td>
      <td style="padding:4px 6px;color:#ff5252">-${s.maxDrawdown}%</td>
      <td style="padding:4px 6px;color:var(--text3)">${s.total}</td>
    </tr>`).join('');
    const sweepHtml = `<div style="font-size:10px;color:var(--text3);margin:6px 0 4px">⚡ Parameter Sweep — ${r.barCount} bars · sorted by profit factor · 🟣 = best</div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="color:var(--text3);font-size:10px;text-transform:uppercase">
        <th style="padding:4px 6px;text-align:left">Score</th><th style="padding:4px 6px;text-align:left">Hold</th>
        <th style="padding:4px 6px;text-align:left">Win%</th><th style="padding:4px 6px;text-align:left">Avg</th>
        <th style="padding:4px 6px;text-align:left">PF</th><th style="padding:4px 6px;text-align:left">MaxDD</th>
        <th style="padding:4px 6px;text-align:left">N</th>
      </tr></thead><tbody>${rows}</tbody>
    </table></div>
    <div style="margin-top:6px"><button onclick="setBtParam('minScore',${r.sweep[0]?.minScore||7});setBtParam('holdBars',${r.sweep[0]?.holdBars||40})"
      style="font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--accent);background:var(--bg2);color:var(--accent);cursor:pointer">
      Apply Best Params (Score ${r.sweep[0]?.minScore}, Hold ${r.sweep[0]?.holdBars}d)
    </button></div>`;
    el.innerHTML = btParamControls() + sweepHtml;
  } catch(e) { el.innerHTML = btParamControls() + `<div style="padding:6px;font-size:11px;color:var(--red)">${e.message}</div>`; }
}

async function runPortfolioBt() {
  const el  = document.getElementById('port-bt-result');
  const btn = document.getElementById('port-bt-btn');
  if (!el) return;
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  el.innerHTML = `<div style="color:var(--text3)">Fetching 2000 bars for up to 30 TASI stocks… this takes ~60s</div>`;
  try {
    const r = await fetch('/api/backtest/portfolio', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ market: state?.scan?.currentMarket || 'tasi', minScore: 6, holdBars: 40, maxPositions: 5 }) }).then(x => x.json());
    if (r.error) { el.innerHTML = `<div style="color:var(--red)">${r.error}</div>`; return; }
    const s = r.stats;
    const retCol = s.totalReturn >= 0 ? 'var(--green)' : '#ff5252';
    el.innerHTML = `
      <div class="bt-stats" style="grid-template-columns:repeat(4,1fr);margin-bottom:6px">
        <div class="bt-stat"><div class="bt-stat-val">${s.symbols}</div><div class="bt-stat-lbl">Stocks</div></div>
        <div class="bt-stat"><div class="bt-stat-val">${s.totalTrades}</div><div class="bt-stat-lbl">Trades</div></div>
        <div class="bt-stat"><div class="bt-stat-val" style="color:${s.winRate>=55?'var(--green)':s.winRate>=45?'var(--yellow)':'#ff5252'}">${s.winRate}%</div><div class="bt-stat-lbl">Win Rate</div></div>
        <div class="bt-stat"><div class="bt-stat-val" style="color:${retCol}">${s.totalReturn>0?'+':''}${s.totalReturn}%</div><div class="bt-stat-lbl">Total Return</div></div>
        <div class="bt-stat"><div class="bt-stat-val">${s.capitalEnd?.toLocaleString()} SAR</div><div class="bt-stat-lbl">End Capital</div></div>
        <div class="bt-stat"><div class="bt-stat-val" style="color:#ff5252">-${s.maxDrawdown}%</div><div class="bt-stat-lbl">Max DD</div></div>
        <div class="bt-stat"><div class="bt-stat-val">${s.sharpe!=null?s.sharpe.toFixed(2):'N/A'}</div><div class="bt-stat-lbl">Sharpe</div></div>
        <div class="bt-stat"><div class="bt-stat-val">${s.avgReturn>0?'+':''}${s.avgReturn}%</div><div class="bt-stat-lbl">Avg/Trade</div></div>
      </div>
      ${renderEquity(r.equity, 400, 70)}
      <div style="font-size:9px;color:var(--text3);margin-top:4px">${r.symbolsFetched} stocks · 100K SAR start · max 5 positions · score≥6 · hold 40d · 0.35% commission</div>`;
  } catch(e) { el.innerHTML = `<div style="color:var(--red)">${e.message}</div>`; }
  finally { if (btn) { btn.textContent = '▶ Run'; btn.disabled = false; } }
}