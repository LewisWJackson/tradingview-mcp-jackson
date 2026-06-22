function shariaHtml(sym){
  const s=shariaMap[sym];
  if(!s) return`<span class="sharia-badge sharia-unknown" title="No data">${t('sUnknown')}</span>`;
  const cls={'compliant':'sharia-compliant','non_compliant':'sharia-non-compliant','review':'sharia-review'}[s.status]||'sharia-unknown';
  const label={'compliant':t('sHalal'),'non_compliant':t('sNonHalal'),'review':t('sReview')}[s.status]||t('sUnknown');
  return`<span class="sharia-badge ${cls}" title="${s.basis}">${label}</span>`;
}
function biasBadgeHtml(bias){
  const cls={
    'STRONG BUY':'bias-strong-buy','BUY':'bias-buy','WATCH':'bias-watch',
    'SKIP':'bias-skip','ERROR':'bias-error','NO_DATA':'bias-skip',
    'STRONG SELL':'bias-strong-sell','SELL':'bias-sell','AVOID':'bias-avoid',
  }[bias]||'bias-skip';
  const icon={
    'STRONG BUY':'▲▲','BUY':'▲','WATCH':'◆','SKIP':'—','ERROR':'✗','NO_DATA':'?',
    'STRONG SELL':'▼▼','SELL':'▼','AVOID':'◆',
  }[bias]||'';
  const label={
    'STRONG BUY':t('bStrongBuy'),'BUY':t('bBuy'),'WATCH':t('bWatch'),
    'SKIP':t('bSkip'),'ERROR':t('bError'),'NO_DATA':t('bNoData'),
    'STRONG SELL':t('bStrongSell'),'SELL':t('bSell'),'AVOID':t('bAvoid'),
  }[bias]||bias;
  // Honest tooltip: this DESCRIBES current price state, it does NOT forecast or recommend.
  const tip={
    'STRONG BUY':'Strong Uptrend::Describes the current price state — trending up with momentum. NOT a forecast or buy advice. History: these scored-high names were profitable only ~37% of the time and LAGGED simple buy-and-hold. Use as context; the validated buy-list is the Momentum tab.',
    'BUY':'Uptrend::Price is in an uptrend. A description of current state, not a recommendation — the score does not predict returns (it lagged buy-and-hold in testing).',
    'WATCH':'Building::Mixed/early signals — trend not established. Descriptive only.',
    'SKIP':'Flat::No clear trend either way.',
    'AVOID':'Weak::Price showing weakness. Descriptive state, not a sell call.',
    'SELL':'Downtrend::Price is in a downtrend. NOT a short signal (no shorting on TASI) — context only.',
    'STRONG SELL':'Strong Downtrend::Price falling hard. Descriptive state, not a trade signal. You cannot short TASI, so this is context only.',
  }[bias];
  const titleAttr = tip ? ` title="${tip.replace(/"/g,'')}" style="cursor:help"` : '';
  return`<span class="bias-badge ${cls}"${titleAttr}>${icon} ${label}</span>`;
}
function emaStackHtml(r){ if(!r.emas)return'—'; const{ema13,ema34,ema89,ema200}=r.emas; return`<div class="ema-stack"><div class="ema-dot ${ema13>ema34&&ema34>ema89?'aligned':'broken'}"></div><div class="ema-dot ${r.price>ema200?'aligned':'broken'}"></div></div>`; }

// ────────────────────────────────────────────────────────────────────────────
// Render table
// ────────────────────────────────────────────────────────────────────────────
function renderTable(){
  // Always sync beginner view alongside the pro table
  renderMarketMood();
  renderBeginnerTable();
  const tbody=document.getElementById('screener-body');
  if(!scanData.length) return;
  if(!_riskLoaded){ loadRiskFlags().then(renderTable); } // load risk flags once, then re-render with badges
  let rows=getVisibleRows();
  rows.sort((a,b)=>{ const av=sortVal(a,sortKey),bv=sortVal(b,sortKey),cmp=typeof av==='string'?av.localeCompare(bv):av-bv; return sortAsc?cmp:-cmp; });
  // Update match count
  const cntEl=document.getElementById('search-match-count');
  if(cntEl){
    if(searchQuery) cntEl.textContent=rows.length?`${rows.length} of ${scanData.length} stocks`:'No matches';
    else cntEl.textContent=`${rows.length} stocks`;
  }
  // No results state
  if(!rows.length){
    tbody.innerHTML=`<tr><td colspan="17" style="text-align:center;padding:30px;color:var(--text3);font-size:13px">${
      searchQuery?`No stocks match "<strong style="color:var(--text2)">${searchQuery}</strong>" — try a different name or ticker`
      :'No stocks match current filters'}</td></tr>`;
    return;
  }
  // Pre-compute rank within each market by score (descending)
  const _rankMap = new Map();
  const _mktGroups = {};
  scanData.filter(r=>r.bias!=='ERROR'&&r.bias!=='NO_DATA').forEach(r=>{
    const m=marketOf(r.sym);
    if(!_mktGroups[m]) _mktGroups[m]=[];
    _mktGroups[m].push(r);
  });
  Object.values(_mktGroups).forEach(grp=>{
    grp.sort((a,b)=>b.score-a.score);
    grp.forEach((r,i)=>_rankMap.set(r.sym,{rank:i+1,total:grp.length}));
  });

  tbody.innerHTML=rows.map(r=>{
    const ticker=tickerDisplay(r.sym);
    const sec=sectorOf(r.sym);
    const isCrossCcy=nativeCcy(r.sym)!==currency;
    const priceV=(isCrossCcy?'<span class="price-tilde" title="Converted from '+nativeCcy(r.sym)+' at '+SAR_USD+' rate">~</span>':'')+fmtPrice(r.price, r.sym);
    const rsiV=r.rsi!=null?r.rsi.toFixed(1):'—';
    const macdV=r.macd_hist!=null?(r.macd_hist>0?'+':'')+r.macd_hist.toFixed(4):'—';
    const volV=r.vol_ratio!=null?r.vol_ratio+'×':'—';
    const chgV=r.change_pct!=null?((r.change_pct>0?'+':'')+r.change_pct.toFixed(2)+'%'):'—';
    const chgCol=r.change_pct==null?'var(--text3)':r.change_pct>0?'var(--green)':r.change_pct<0?'var(--red)':'var(--text2)';
    const col=scoreColor(r.score,r.maxScore||8);
    const pct=Math.round((r.score/(r.maxScore||8))*100);
    const sel=selectedSyms.has(r.sym);
    // Score delta
    const delta=deltaData.find(d=>d.sym===r.sym);
    const dHtml=delta&&delta.score_delta!==0?`<span class="${delta.score_delta>0?'delta-up':'delta-dn'}">${delta.score_delta>0?'+':''}${delta.score_delta}</span>`:`<span class="delta-na">—</span>`;
    // Bias badge with tooltip (natural language summary)
    const passFlags=(r.flags||[]).join(', ')||'—';
    const _sc=r.score||0, _mx=r.maxScore||9;
    const _bDesc=_sc>=7?'Strong trend alignment — descriptive state, not a buy signal (score had no validated edge; use the Momentum tab).':_sc>=5?'Moderate trend alignment — descriptive, not a recommendation.':_sc>=3?'Mixed trend — few criteria aligned.':'Weak — most criteria not aligned.';
    const _warns=(r.warnings||[]).length?'\nWatch: '+(r.warnings||[]).join('. ')+'.':'';
    const biasTitle=`${r.bias} — ${_sc} of ${_mx} criteria aligned.\n${_bDesc}\nPassing: ${passFlags}.${_warns}`;
    // EMA tooltip (natural language)
    const _e=r.emas||{}, _eStack=_e.ema13>_e.ema34&&_e.ema34>_e.ema89;
    const emaTitle=`EMA trend stack — fast (13): ${_e.ema13?.toFixed(2)||'?'} | mid (34): ${_e.ema34?.toFixed(2)||'?'} | slow (89): ${_e.ema89?.toFixed(2)||'?'} | baseline (200): ${_e.ema200?.toFixed(2)||'?'}.\n${_eStack?'All three averages are stacked in uptrend order — strong bull structure confirmed.':'Averages are not in uptrend order — trend structure is incomplete.'}\n▲▲ = fully bullish · ▲ = partial · ◆ = neutral · ▼ = partial bear · ▼▼ = fully bearish`;
    // Error retry
    const isError=r.bias==='ERROR'||r.bias==='NO_DATA';
    const retryHtml=isError?`<button class="retry-btn" onclick="event.stopPropagation();retrySymbol('${r.sym}',this)" title="${r.error||'Data unavailable'}">${t('retryBtn')}</button>`:'';
    return`<tr data-sym="${r.sym}" class="${sel?'selected-row':''}" onclick="onRowClick(event,'${r.sym}')">
      <td class="cb-cell"><input type="checkbox" class="row-cb" ${sel?'checked':''} onclick="event.stopPropagation();toggleRow('${r.sym}',this.checked)"><button class="wl-star ${isWatched(r.sym)?'wl-active':''}" data-sym="${r.sym}" onclick="event.stopPropagation();toggleWatchlist('${r.sym}',event)" title="${isWatched(r.sym)?'Remove from watchlist':'Add to watchlist'}">${isWatched(r.sym)?'★':'☆'}</button></td>
      <td class="td-ticker">${ticker}</td>
      <td class="td-name">${r.name}${r.ar?`<span class="ar-name" dir="rtl">${r.ar}</span>`:''}${positionBadgeHtml(r.sym,r.price)}${calCache[r.sym]?calBadgeHtml(calCache[r.sym]):''}${riskCache[r.sym]?riskBadgeHtml(riskCache[r.sym]):''}${retryHtml}${(()=>{const sTags=(r.style_tags||[]).length?'<div style="margin-top:3px;display:flex;gap:3px;flex-wrap:wrap">'+(r.style_tags).map(s=>{const sc={'Momentum':'#5ba3ff','Trend':'#00e676','Breakout':'#ffd740','Recovery':'#3d8bff','Pullback':'#33d1e5'}[s]||'var(--text3)';return`<span style="font-size:8.5px;font-weight:700;padding:1px 5px;border-radius:10px;background:${sc}22;color:${sc};border:1px solid ${sc}44;cursor:pointer" onclick="event.stopPropagation();filterStyle('${s}',document.querySelector('[onclick*=filterStyle][onclick*=${s}]'))">${s}</span>`;}).join('')+'</div>':'';const pBadges=(r.patterns||[]).map(p=>{const pc=p.bullish?'#00e5aa':'#ff5252';return`<span style="font-size:8px;font-weight:700;padding:1px 5px;border-radius:4px;background:${pc}15;color:${pc};border:1px solid ${pc}33" title="${p.desc}">⬦ ${p.name}</span>`;}).join('');const pDiv=pBadges?`<div style="margin-top:3px;display:flex;gap:3px;flex-wrap:wrap">${pBadges}</div>`:'';return sTags+pDiv;})()}</td>
      <td class="hm"><span class="sector-badge sector-${sec}">${sectorLabel(sec)}</span></td>
      <td class="td-price" title="${nativeCcy(r.sym)} price · toggle header to convert">${priceV}</td>
      <td style="text-align:end;font-weight:700;font-size:12px;color:${chgCol};font-family:'JetBrains Mono',monospace">${chgV}</td>
      <td>${(()=>{const _rk=_rankMap.get(r.sym);const _rkHtml=_rk&&_rk.total>3?`<span style="font-size:9px;color:var(--text3);font-family:'JetBrains Mono',monospace;margin-inline-start:5px" title="Rank #${_rk.rank} of ${_rk.total} in this market by score">#${_rk.rank}</span>`:'';return`<div class="score-wrap" title="${r.score} of ${r.maxScore||9} trend criteria aligned (descriptive — NOT a buy signal; the score had no validated edge, use the Momentum tab). ${(r.score||0)>=7?'Strong trend alignment.':( r.score||0)>=5?'Moderate alignment.':( r.score||0)>=3?'Mixed trend.':'Weak.'}"><div class="score-bar"><div class="score-fill" style="width:${pct}%;background:${col}"></div></div><span class="score-text">${r.score}/${r.maxScore||9}</span>${_rkHtml}</div><div class="score-tier" style="color:${scoreLabel(r.score,r.maxScore||8).col}">${scoreLabel(r.score,r.maxScore||8).text}</div>${r.regime_discount>0?`<div style="font-size:9px;color:var(--orange);margin-top:2px" title="Regime-adjusted: ${r.regime_score}/${r.maxScore||8} — market is ${r.market_regime}">⚠ -${r.regime_discount} ${r.market_regime} mkt</div>`:''}${scoreSparklineHtml(r.sym)}${priceSparklineHtml(r.sym)}<div style="display:inline-flex;align-items:center;gap:2px;margin-top:1px">${velocityArrowHtml(r.sym)}</div>`;})()}</td>
      <td class="hm">${dHtml}</td>
      <td style="text-align:end"><span class="rsi-pill ${rsiClass(r.rsi)}">${rsiV}</span></td>
      <td class="td-macd hm ${r.macd_hist>0?'macd-pos':'macd-neg'}">${macdV}</td>
      <td class="td-vol hm ${r.vol_ratio>=1.2?'vol-ok':''}">${volV}</td>
      <td class="hm" title="${emaTitle}">${emaStackHtml(r)}</td>
      <td title="${biasTitle}">${biasBadgeHtml(r.bias)}<div class="plain-signal">${plainSignal(r.bias)}</div></td>
      <td class="hm">${divergenceBadgeHtml(r)}</td>
      <td class="hm">${shariaHtml(r.sym)}</td>
      <td class="hm" style="text-align:end">${rsHtml(r)}</td>
      <td class="hm">${weeklyBadgeHtml(r)}</td>
    </tr>`;
  }).join('');
  if(!rows.length) tbody.innerHTML=`<tr><td colspan="16"><div class="empty-state"><div class="icon">🔍</div><p>${t('emptyScreener')}</p></div></td></tr>`;
  updateBreadthBar();
  updateSectorHeatmap();
  updateMovers();
  document.getElementById('count-strong-buy').textContent =scanData.filter(r=>r.bias==='STRONG BUY').length;
  document.getElementById('count-buy').textContent        =scanData.filter(r=>r.bias==='BUY').length;
  document.getElementById('count-watch').textContent      =scanData.filter(r=>r.bias==='WATCH').length;
  document.getElementById('count-strong-sell').textContent=scanData.filter(r=>r.bias==='STRONG SELL').length;
  document.getElementById('count-total').textContent      =scanData.length;
}

// ────────────────────────────────────────────────────────────────────────────
// Detail drawer
// ────────────────────────────────────────────────────────────────────────────
function onRowClick(event,sym){
  // Ignore clicks on interactive children (checkbox, star, buttons, inputs)
  if(event.target.closest('input,button,select,a,.alert-btn,.retry-btn,.wl-star')) return;
  const r=scanData.find(x=>x.sym===sym);
  if(r){ openDrawer(r); }
  else if(sym){
    // No scan data — show minimal message in drawer
    openDrawerNoData(sym);
  }
}

function openDrawerNoData(sym){
  openDrawerData=null;
  openTickerParam(sym);
  document.getElementById('d-ticker').textContent=tickerDisplay(sym);
  document.getElementById('d-name').textContent='No scan data available';
  document.getElementById('d-price').textContent='—';
  document.getElementById('d-bias-badge').innerHTML='';
  document.getElementById('d-tv-actions').innerHTML='';
  document.getElementById('dtab-signal').innerHTML=`<div class="empty-state"><div class="icon">🔍</div><p>No data for <strong>${tickerDisplay(sym)}</strong>.<br>Run a scan first to see the full breakdown.</p></div>`;
  ['dtab-trade','dtab-analysis','dtab-fund','dtab-news'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.innerHTML='';
  });
  document.querySelectorAll('.drawer-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.drawer-tab-panel').forEach(p=>p.classList.remove('dtab-active'));
  const firstTab=document.querySelector('.drawer-tab'); if(firstTab) firstTab.classList.add('active');
  document.getElementById('dtab-signal').classList.add('dtab-active');
  document.getElementById('detail-overlay').classList.add('open');
  document.getElementById('detail-drawer').classList.add('open');
}

// ─── Fix 3: Column header popovers ───────────────────────────────────────────
const COL_POPOVER_CONTENT = {
  ema: {
    title: 'EMA Signal',
    rows: [['▲▲','Full bull — EMA 13 > 34 > 89 AND price above 200 EMA'],['▲','Partial bullish alignment'],['◆','Neutral / mixed signals'],['▼','Partial bearish alignment'],['▼▼','Full bear — EMA 13 < 34 < 89 AND price below 200 EMA'],['—','Insufficient data']],
    note: 'EMAs used: 13-day, 34-day, 89-day, 200-day. All timeframes must align for ▲▲ or ▼▼.'
  },
  div: {
    title: 'RSI Divergence',
    rows: [['↗ Div','Bullish — price makes lower low but RSI makes higher low → hidden strength'],['↘ Div','Bearish — price makes higher high but RSI makes lower high → fading momentum'],['—','No divergence detected in last 30 bars']],
    note: 'Divergence is detected using the last 30 daily bars. Only shown when confirmed.'
  },
  halal: {
    title: 'Sharia Compliance',
    rows: [['Halal','AAOIFI-compliant — passes sector and financial screens'],['Non-Halal','Fails Sharia screening (interest-based or prohibited sector)'],['Review','Classification pending — consult a qualified Islamic finance scholar'],['—','Not assessed — no data available']],
    note: 'Based on AAOIFI sector screens. Not a fatwa. Verify with a qualified scholar.'
  },
  delta: {
    title: 'Score Delta (Δ)',
    rows: [['+2','Score improved by 2 points since last scan (green = improved)'],['−3','Score dropped by 3 points since last scan (red = degraded)'],['—','No change, or this is the first scan']],
    note: 'Click the Δ header to sort by biggest movers. Updated after every scan.'
  },
};

function showColPopover(key, e){
  e?.stopPropagation();
  const pop=document.getElementById('col-popover');
  const titleEl=document.getElementById('cpop-title');
  const bodyEl=document.getElementById('cpop-body');
  const noteEl=document.getElementById('cpop-note');
  if(!pop||!titleEl||!bodyEl) return;
  const d=COL_POPOVER_CONTENT[key];
  if(!d) return;
  titleEl.textContent=d.title;
  bodyEl.innerHTML=d.rows.map(([k,v])=>`<div class="cpop-row"><span class="cpop-key">${k}</span><span class="cpop-val">${v}</span></div>`).join('');
  if(d.note){noteEl.textContent=d.note;noteEl.style.display='block';}
  else noteEl.style.display='none';
  pop.classList.add('open');
  // Position near click
  const rect=e.currentTarget.getBoundingClientRect();
  pop.style.top=(rect.bottom+6)+'px';
  const left=Math.min(rect.left,window.innerWidth-310);
  pop.style.left=Math.max(8,left)+'px';
  // Dismiss on outside click
  const dismiss=(ev)=>{if(!pop.contains(ev.target)){pop.classList.remove('open');document.removeEventListener('click',dismiss);}};
  setTimeout(()=>document.addEventListener('click',dismiss),0);
}

// ─── Fix 2: Currency info bar update ─────────────────────────────────────────
function updateCcyInfoBar(){
  const text=document.getElementById('ccy-info-text');
  const btnLbl=document.getElementById('ccy-info-btn-label');
  const badge=document.getElementById('price-ccy-badge');
  if(text) text.innerHTML=currency==='SAR'?`TASI prices in <strong>SAR</strong> · US/Crypto/Commodity in <strong>USD</strong>`:`US/Crypto/Commodity in <strong>USD</strong> · TASI prices in <strong>SAR</strong>`;
  if(btnLbl) btnLbl.textContent=currency==='SAR'?'$ USD':'SAR';
  if(badge) badge.textContent=`(${currency})`;
}

// ─── Fix 1: Drawer URL param + signal actions ─────────────────────────────────
function openTickerParam(sym){
  try{ history.replaceState(null,'',`${location.pathname}?ticker=${encodeURIComponent(sym)}`); }catch(_){}
}

function clearTickerParam(){
  try{ history.replaceState(null,'',location.pathname); }catch(_){}
}

function openFromUrl(){
  const param=new URLSearchParams(location.search).get('ticker');
  if(!param||!scanData.length) return;
  const r=scanData.find(x=>x.sym===param||tickerDisplay(x.sym)===param);
  if(r) openDrawer(r);
}

function goToDrawerTab(tabName){
  const tabs=document.querySelectorAll('.drawer-tab');
  const tabMap={'trade':1,'analysis':2,'fund':3};
  const idx=tabMap[tabName]??0;
  if(tabs[idx]) switchDrawerTab(tabName,tabs[idx]);
}

// ─── Signal Legend — DESCRIPTIVE trend-state labels, NOT buy/sell advice. The 9-pt score had
// no validated edge (lagged buy-and-hold); the validated buy-list is the Momentum tab. ──────────
const SIGNAL_LEGEND = [
  {icon:'🟢',bias:'STRONG BUY',  en:'7+ of 9 criteria aligned — strong uptrend STATE. Descriptive only, not a buy signal (lagged buy-and-hold in testing). Validated buy-list = Momentum tab.',  ar:'7+ من 9 معايير — حالة اتجاه صعودي قوي. وصفية فقط، ليست إشارة شراء. قائمة الشراء المعتمدة = تبويب الزخم.'},
  {icon:'🟩',bias:'BUY',         en:'5–6 criteria aligned — uptrend state. A description of current price behaviour, not a recommendation.',       ar:'5–6 معايير — حالة اتجاه صعودي. وصف للحالة، ليست توصية.'},
  {icon:'🟡',bias:'WATCH',       en:'3–4 criteria aligned — mixed/building trend state. Not a signal.',       ar:'3–4 معايير — حالة اتجاه مختلطة. ليست إشارة.'},
  {icon:'⚫',bias:'SKIP',        en:'Below 3 criteria — weak / no clear trend state.',                    ar:'أقل من 3 معايير — حالة اتجاه ضعيفة أو غير واضحة.'},
  {icon:'🟠',bias:'AVOID',       en:'3–4 bearish criteria — early downtrend lean (descriptive).',                     ar:'3–4 معايير هبوطية — ميل هبوطي مبكر (وصفي).'},
  {icon:'🔴',bias:'SELL',        en:'5–6 bearish criteria — downtrend state (descriptive, not advice).',              ar:'5–6 معايير هبوطية — حالة هبوط (وصفية، ليست نصيحة).'},
  {icon:'🔴',bias:'STRONG SELL', en:'7+ bearish criteria — strong downtrend state. Descriptive, not advice.',             ar:'7+ معايير هبوطية — حالة هبوط قوي. وصفية، ليست نصيحة.'},
  {icon:'⚠️',bias:'ERROR',       en:'Data feed failure for this symbol. Check your data source or retry.',              ar:'فشل بيانات لهذا الرمز. تحقق من المصدر أو أعد المحاولة.'},
  {icon:'❓',bias:'NO DATA',     en:'Missing price, volume, or indicator data — symbol may not be active.',             ar:'بيانات سعر أو حجم مفقودة — قد لا يكون الرمز نشطاً.'},
];

function toggleLegend(){
  const bar=document.getElementById('legend-bar');
  const btn=document.getElementById('legend-toggle-btn');
  if(!bar||!btn) return;
  const open=bar.classList.toggle('open');
  btn.textContent=open?t('legendClose'):t('legendBtn');
  if(open&&!bar.innerHTML.trim()){
    bar.innerHTML=`<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:8px">Signal Guide — Mawjah Scoring System</div>
    <div class="legend-grid">${SIGNAL_LEGEND.map(l=>`<div class="legend-item"><span class="legend-dot">${l.icon}</span><div class="legend-text"><strong>${l.bias}</strong> — ${lang==='ar'?l.ar:l.en}</div></div>`).join('')}</div>
    <div style="font-size:10px;color:var(--text3);margin-top:8px;border-top:1px solid var(--border);padding-top:6px">EMA arrows: ▲▲ All bullish (13&gt;34&gt;89, price &gt;200) · ▲ Partial · ◆ Neutral · ▼ Partial bearish · ▼▼ Full bearish stack</div>`;
  }
}

// ─── 1.3 Currency header badge ────────────────────────────────────────────────
function updatePriceCcyBadge(){
  const el=document.getElementById('price-ccy-badge');
  if(el) el.textContent=currency;
}

// ─── 1.4 Error retry ──────────────────────────────────────────────────────────
async function retrySymbol(sym,btn){
  if(btn){btn.disabled=true;btn.textContent='…';}
  try{
    await fetch('/api/scan/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols:[sym]})});
    startPolling();
  }catch(e){}
}

// ─── 1.6 Data freshness ───────────────────────────────────────────────────────
function showFreshness(ts){
  const badge=document.getElementById('freshness-badge');
  if(!badge) return;
  if(!ts){badge.style.display='none';return;}
  const ageMin=Math.round((Date.now()-new Date(ts).getTime())/60000);
  const stale=ageMin>60;
  badge.style.display='inline-flex';
  badge.className='freshness-badge'+(stale?' freshness-stale':'');
  badge.title=stale?'Prices may not reflect current market — run a new scan to refresh':'Data is recent';
  badge.textContent=ageMin<1?'Just now':ageMin<60?`${ageMin}m ago`:`${Math.round(ageMin/60)}h ago`;
}

// ─── 2.3 Watchlist ───────────────────────────────────────────────────────────
function isWatched(sym){ return watchlistData.includes(sym); }

function toggleWatchlist(sym,e){
  if(e) e.stopPropagation();
  // Always read from localStorage first to stay in sync (handles cross-tab changes)
  watchlistData=JSON.parse(localStorage.getItem('mawjah_watchlist')||'[]');
  const wasWatched=watchlistData.includes(sym);
  watchlistData=wasWatched?watchlistData.filter(s=>s!==sym):[...watchlistData,sym];
  localStorage.setItem('mawjah_watchlist',JSON.stringify(watchlistData));
  // Update every star icon for this sym in the DOM (no full re-render needed)
  document.querySelectorAll(`.wl-star[data-sym="${sym}"]`).forEach(el=>{
    el.textContent=watchlistData.includes(sym)?'★':'☆';
    el.classList.toggle('wl-active',watchlistData.includes(sym));
  });
  // Update the sig-wl-btn in the open drawer if it's for this sym
  if(openDrawerData?.sym===sym){
    const sigBtn=document.getElementById('sig-wl-btn');
    if(sigBtn){
      const now=watchlistData.includes(sym);
      sigBtn.textContent=now?'★ Watchlist':'☆ Watchlist';
      sigBtn.classList.toggle('sig-watch-on',now);
    }
  }
  // Toast notification
  const n=document.createElement('div');
  n.style.cssText='position:fixed;bottom:20px;inset-inline-start:20px;background:var(--card);border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:6px;font-size:12px;z-index:999;box-shadow:0 2px 8px rgba(0,0,0,.3)';
  n.textContent=(wasWatched?'☆ '+t('wlRemovedToast'):'★ '+t('wlAddedToast'))+' — '+tickerDisplay(sym);
  document.body.appendChild(n); setTimeout(()=>n.remove(),2000);
  // Refresh watchlist panel (no full table re-render)
  renderWatchlistPanel();
}

function renderWatchlistPanel(){
  // Always re-sync from localStorage — this is the single source of truth
  watchlistData=JSON.parse(localStorage.getItem('mawjah_watchlist')||'[]');
  const el=document.getElementById('watchlist-content');
  if(!el) return;
  if(!watchlistData.length){
    el.innerHTML=`<div class="wl-empty">${t('wlEmpty').replace(/\n/g,'<br>')}</div>`;
    return;
  }
  // Reload price alerts too
  priceAlerts=JSON.parse(localStorage.getItem('mawjah_price_alerts')||'[]');
  const rows=watchlistData.map(sym=>{
    const r=scanData.find(x=>x.sym===sym);
    const delta=deltaData.find(d=>d.sym===sym);
    const dHtml=delta&&delta.score_delta!==0?`<span class="${delta.score_delta>0?'delta-up':'delta-dn'}">${delta.score_delta>0?'+':''}${delta.score_delta}</span>`:'<span class="delta-na">—</span>';
    const symAlerts=priceAlerts.filter(a=>a.sym===sym);
    const activeAlert=symAlerts.find(a=>!a.triggered);
    const triggeredAlert=symAlerts.find(a=>a.triggered);
    const sid=sym.replace(/[^a-z0-9]/gi,'_');
    if(!r){
      return`<tr>
        <td><button class="wl-star wl-active" data-sym="${sym}" onclick="toggleWatchlist('${sym}',event)">★</button> <span class="td-ticker">${tickerDisplay(sym)}</span></td>
        <td colspan="6" style="color:var(--text3);font-size:11px">Not in last scan — run a scan to load data</td>
      </tr>`;
    }
    const col=scoreColor(r.score,r.maxScore||8);
    const pct2=Math.round(r.score/(r.maxScore||8)*100);
    const isCross=nativeCcy(r.sym)!==currency;
    const priceDisp=(isCross?'<span class="price-tilde">~</span>':'')+fmtPrice(r.price,r.sym);
    // Alert pill display
    let alertPill='';
    if(triggeredAlert) alertPill=`<div style="font-size:9px;color:var(--text3);margin-top:2px">✓ Triggered @ ${fmtPrice(triggeredAlert.price,sym)} <button class="pos-del-btn" onclick="deleteWlAlert('${sym}',event)" style="font-size:9px">×</button></div>`;
    else if(activeAlert) alertPill=`<div style="margin-top:2px"><span class="freshness-badge">${activeAlert.dir==='above'?'▲':'▼'} ${fmtPrice(activeAlert.price,sym)} <button class="pos-del-btn" onclick="deleteWlAlert('${sym}',event)" style="font-size:9px">×</button></span></div>`;
    return`<tr data-sym="${sym}" onclick="onRowClick(event,'${sym}')" style="cursor:pointer">
      <td style="white-space:nowrap">
        <button class="wl-star wl-active" data-sym="${sym}" onclick="toggleWatchlist('${sym}',event)">★</button>
        <span class="td-ticker" style="margin-inline-start:4px">${tickerDisplay(sym)}</span>
      </td>
      <td class="td-name">${r.name}<br><span style="font-size:10px;color:var(--text3)">${sectorLabel(sectorOf(r.sym))}</span></td>
      <td>${biasBadgeHtml(r.bias)}</td>
      <td><div class="score-wrap"><div class="score-bar"><div class="score-fill" style="width:${pct2}%;background:${col}"></div></div><span class="score-text">${r.score}/${r.maxScore||8}</span></div></td>
      <td class="td-price">${priceDisp}</td>
      <td><span class="rsi-pill ${rsiClass(r.rsi)}" style="font-size:10px">${r.rsi!=null?r.rsi.toFixed(1):'—'}</span></td>
      <td>${dHtml}</td>
      <td onclick="event.stopPropagation()">
        ${alertPill}
        <div id="wl-alert-form-${sid}" style="display:none">
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:4px">
            <select id="wl-d-${sid}" class="rule-select" style="font-size:10px">
              <option value="above">▲ Above</option>
              <option value="below">▼ Below</option>
            </select>
            <input id="wl-p-${sid}" class="add-criteria-input" style="max-width:80px;font-size:10px" type="number" step="0.01" placeholder="${fmtPrice(r.price,r.sym)}">
            <button class="alert-btn" onclick="savePriceAlert('${sym}')">Save</button>
            <button class="pos-del-btn" onclick="document.getElementById('wl-alert-form-${sid}').style.display='none'">×</button>
          </div>
        </div>
        ${!activeAlert?`<button class="alert-btn" style="margin-top:2px" onclick="document.getElementById('wl-alert-form-${sid}').style.display='flex'">+ Alert</button>`:''}
      </td>
    </tr>`;
  }).join('');
  el.innerHTML=`<div class="table-wrap" style="border:none;border-radius:0">
    <table class="pos-table">
      <thead><tr>
        <th>Ticker</th><th>Name</th><th>Signal</th><th>Score</th>
        <th>Price</th><th>RSI</th><th>Δ</th><th>Alert</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function savePriceAlert(sym){
  const id=sym.replace(/[^a-z0-9]/gi,'_');
  const price=parseFloat(document.getElementById(`wl-p-${id}`)?.value||0);
  const dir=document.getElementById(`wl-d-${id}`)?.value||'above';
  if(!price||price<=0) return;
  priceAlerts=JSON.parse(localStorage.getItem('mawjah_price_alerts')||'[]');
  // Only one active alert per sym/dir
  priceAlerts=priceAlerts.filter(a=>!(a.sym===sym&&!a.triggered));
  priceAlerts.push({sym,dir,price,createdAt:new Date().toISOString(),triggered:false});
  localStorage.setItem('mawjah_price_alerts',JSON.stringify(priceAlerts));
  document.getElementById(`wl-alert-form-${id}`)?.style && (document.getElementById(`wl-alert-form-${id}`).style.display='none');
  renderWatchlistPanel();
}

// Keep old name as alias for backward compat
function setPriceAlert(sym){ savePriceAlert(sym); }

function deleteWlAlert(sym,e){
  if(e) e.stopPropagation();
  priceAlerts=JSON.parse(localStorage.getItem('mawjah_price_alerts')||'[]');
  priceAlerts=priceAlerts.filter(a=>a.sym!==sym);
  localStorage.setItem('mawjah_price_alerts',JSON.stringify(priceAlerts));
  renderWatchlistPanel();
}

function checkPriceAlerts(){
  priceAlerts=JSON.parse(localStorage.getItem('mawjah_price_alerts')||'[]');
  if(!priceAlerts.length||!scanData.length) return;
  let changed=false;
  priceAlerts.forEach(alert=>{
    if(alert.triggered) return;
    const r=scanData.find(x=>x.sym===alert.sym); if(!r?.price) return;
    const fired=(alert.dir==='above'&&r.price>=alert.price)||(alert.dir==='below'&&r.price<=alert.price);
    if(!fired) return;
    alert.triggered=true; alert.triggeredPrice=r.price; alert.triggeredAt=new Date().toISOString();
    changed=true;
    // In-app banner
    const n=document.createElement('div');
    n.style.cssText='position:fixed;top:64px;inset-inline-end:16px;background:rgba(255,214,0,.95);color:#000;padding:12px 16px;border-radius:8px;font-size:13px;font-weight:700;z-index:999;max-width:300px;box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer';
    n.innerHTML=`🔔 <strong>${tickerDisplay(alert.sym)}</strong> crossed your alert<br><span style="font-weight:400">${alert.dir==='above'?'▲':'▼'} ${fmtPrice(alert.price,alert.sym)} target. Now: ${fmtPrice(r.price,alert.sym)}</span>`;
    n.onclick=()=>n.remove();
    document.body.appendChild(n); setTimeout(()=>n.remove(),12000);
    // Telegram notification
    const tg=settingsData?.telegram;
    if(tg?.enabled&&tg.token&&tg.chat_id){
      const msg=`🔔 Mawjah Price Alert: ${r.name||tickerDisplay(alert.sym)} (${tickerDisplay(alert.sym)})\n`+
        `Your ${alert.dir} alert of ${alert.price} was triggered.\n`+
        `Current price: ${r.price?.toFixed(2)} | Signal: ${r.bias}`;
      fetch('https://api.telegram.org/bot'+tg.token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:tg.chat_id,text:msg})}).catch(()=>{});
    }
  });
  if(changed){
    localStorage.setItem('mawjah_price_alerts',JSON.stringify(priceAlerts));
    renderWatchlistPanel();
  }
}

// ─── 2.5 Price sparkline ─────────────────────────────────────────────────────
function priceSparklineHtml(sym){
  const hist=scoreHistory[sym];
  if(!hist||hist.length<2) return'';
  const prices=hist.slice(-10).filter(h=>h.p!=null).map(h=>h.p);
  if(prices.length<2) return'';
  const mn=Math.min(...prices),mx=Math.max(...prices),range=mx-mn||1;
  const w=44,h=12;
  const xs=(w-2)/Math.max(prices.length-1,1);
  const pts=prices.map((p,i)=>`${Math.round(i*xs+1)},${Math.round(h-1-(p-mn)/range*(h-2))}`).join(' ');
  const col=prices[prices.length-1]>=prices[0]?'var(--green)':'#ff5252';
  return`<svg width="${w}" height="${h}" class="price-spark"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
}

// ─── 2.6 Scan archive ────────────────────────────────────────────────────────
const ARCHIVE_PFX='mawjah_archive_';

function saveArchiveSnapshot(){
  if(!scanData.length) return;
  const keys=Object.keys(localStorage).filter(k=>k.startsWith(ARCHIVE_PFX)).sort();
  while(keys.length>=10){ localStorage.removeItem(keys.shift()); }
  localStorage.setItem(ARCHIVE_PFX+Date.now(),JSON.stringify({ts:Date.now(),results:scanData}));
  renderArchiveDropdown();
  const btn=document.getElementById('archive-btn');
  if(btn) btn.style.display='';
}

function renderArchiveDropdown(){
  const el=document.getElementById('archive-dropdown-menu');
  if(!el) return;
  const keys=Object.keys(localStorage).filter(k=>k.startsWith(ARCHIVE_PFX)).sort().reverse();
  if(!keys.length){el.innerHTML=`<div style="padding:10px;font-size:11px;color:var(--text3)">${t('noScan')}</div>`;return;}
  el.innerHTML=`<div class="archive-menu-item${!archiveViewing?' active':''}" onclick="loadArchive(null)">🔴 ${t('archiveLive')}</div>`+
    keys.map(k=>{
      const d=JSON.parse(localStorage.getItem(k)||'{}');
      const date=new Date(d.ts).toLocaleString(lang==='ar'?'ar-SA':'en-SA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      return`<div class="archive-menu-item${archiveViewing===k?' active':''}" onclick="loadArchive('${k}')">${date} <span style="color:var(--text3)">${d.results?.length||0}</span></div>`;
    }).join('');
}

function toggleArchiveDropdown(){
  const el=document.getElementById('archive-dropdown-menu');
  if(el){ renderArchiveDropdown(); el.classList.toggle('open'); }
  document.addEventListener('click',function h(e){if(!e.target.closest('.archive-wrap')){el?.classList.remove('open');document.removeEventListener('click',h);}},{once:false});
}

function loadArchive(key){
  document.getElementById('archive-dropdown-menu')?.classList.remove('open');
  document.getElementById('archive-banner-el')?.remove();
  if(!key){ archiveViewing=null; renderTable(); showFreshness(null); return; }
  const data=JSON.parse(localStorage.getItem(key)||'{}');
  if(!data.results) return;
  archiveViewing=key;
  scanData=data.results;
  renderTable();
  const date=new Date(data.ts).toLocaleString(lang==='ar'?'ar-SA':'en-SA',{dateStyle:'medium',timeStyle:'short'});
  const banner=document.createElement('div');
  banner.id='archive-banner-el'; banner.className='archive-banner';
  banner.innerHTML=`📦 Viewing scan from <strong>${date}</strong> (${data.results.length} stocks) · <button onclick="loadArchive(null)" style="background:none;border:none;color:var(--yellow);cursor:pointer;font-size:11px;text-decoration:underline">Return to live</button>`;
  document.getElementById('panel-screener')?.insertBefore(banner,document.querySelector('.screener-toolbar'));
  renderArchiveDropdown();
}

// ─── 2.7 Batch calendar fetch ─────────────────────────────────────────────────
function batchFetchCalendars(){
  const top=getVisibleRows().slice(0,20);
  top.filter(r=>calCache[r.sym]===undefined).forEach(r=>fetchCalendar(r.sym).then(()=>{ const row=document.querySelector(`tr[data-sym="${r.sym}"] .td-name`); if(row&&calCache[r.sym]) row.insertAdjacentHTML('beforeend',calBadgeHtml(calCache[r.sym])); }));
}

// ─── 2.1 TradingView embed (legacy — kept for compatibility) ─────────────────
function loadTVEmbed(sym){
  const wrap=document.getElementById('tv-embed-wrap');
  if(!wrap) return;
  const url=`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(sym)}&interval=D&theme=dark&hide_top_toolbar=1&save_image=0&style=1&timezone=exchange&hide_legend=0`;
  wrap.innerHTML=`<iframe src="${url}" style="width:100%;height:100%;border:none" loading="lazy" allowfullscreen></iframe>`;
}

// ─── 2.2 Native canvas price chart ──────────────────────────────────────────
async function loadNativeChart(sym, containerId, opts = {}) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.innerHTML = '<div class="native-chart-loading">Loading chart…</div>';
  try {
    const res = await fetch('/api/ohlcv?sym=' + encodeURIComponent(sym) + '&count=252');
    if (!res.ok) {
      wrap.innerHTML = `<div class="native-chart-loading" style="color:var(--red)">Chart unavailable (${res.status}) — restart the server</div>`;
      return;
    }
    const d = await res.json();
    if (!d.success || !d.bars?.length) {
      wrap.innerHTML = `<div class="native-chart-loading" style="color:var(--red)">${d.error || 'No data'}</div>`;
      return;
    }
    wrap.innerHTML = '';
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    const tooltip = document.createElement('div');
    tooltip.className = 'native-chart-tooltip';
    wrap.appendChild(tooltip);
    drawCandleChart(canvas, tooltip, d.bars, opts);
    // Redraw on resize
    const ro = new ResizeObserver(() => drawCandleChart(canvas, tooltip, d.bars, opts));
    ro.observe(wrap);
    wrap._chartObserver = ro;
  } catch(e) {
    wrap.innerHTML = `<div class="native-chart-loading" style="color:var(--red)">${e.message}</div>`;
  }
}

function drawCandleChart(canvas, tooltip, bars, opts = {}) {
  const { discoveryPrice = null, currentPrice = null } = opts;
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth || 540;
  const H = wrap.clientHeight || 280;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Layout
  const PAD_R = 60, PAD_B = 22, PAD_L = 8, PAD_T = 10;
  const priceH = Math.floor((H - PAD_T - PAD_B) * 0.76);
  const volH   = (H - PAD_T - PAD_B) - priceH - 4;
  const chartW = W - PAD_L - PAD_R;
  const priceY = PAD_T;
  const volY   = PAD_T + priceH + 4;

  // Price min/max
  const highs = bars.map(b => b.high);
  const lows  = bars.map(b => b.low);
  let pMin = Math.min(...lows), pMax = Math.max(...highs);
  const pPad = (pMax - pMin) * 0.06;
  pMin -= pPad; pMax += pPad;

  // Volume max
  const vols = bars.map(b => b.volume || 0);
  const vMax = Math.max(...vols, 1);

  const toX = i => PAD_L + (i / (bars.length - 1)) * chartW;
  const toY = p => priceY + priceH - ((p - pMin) / (pMax - pMin)) * priceH;
  const toVY = v => volY + volH - (v / vMax) * volH;

  // ── Background
  ctx.fillStyle = '#080a0f';
  ctx.fillRect(0, 0, W, H);

  // ── Grid lines (horizontal price)
  const pStep = nicePriceStep(pMin, pMax, 5);
  let gP = Math.ceil(pMin / pStep) * pStep;
  ctx.strokeStyle = 'rgba(255,255,255,.045)';
  ctx.lineWidth = 1;
  while (gP <= pMax) {
    const gy = Math.round(toY(gP)) + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(PAD_L + chartW, gy); ctx.stroke();
    gP = +(gP + pStep).toFixed(10);
  }

  // ── Candlestick body width
  const candleW = Math.max(1, Math.min(10, chartW / bars.length * 0.65));
  const wickW   = Math.max(0.5, candleW * 0.15);

  // ── Volume bars
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const x = toX(i);
    const isUp = b.close >= b.open;
    ctx.fillStyle = isUp ? 'rgba(0,230,118,.25)' : 'rgba(255,61,113,.22)';
    const vTop = toVY(b.volume || 0);
    ctx.fillRect(x - candleW / 2, vTop, candleW, volY + volH - vTop);
  }

  // ── Discovery price line (dashed accent)
  if (discoveryPrice && discoveryPrice >= pMin && discoveryPrice <= pMax) {
    const dy = Math.round(toY(discoveryPrice)) + 0.5;
    ctx.save();
    ctx.strokeStyle = '#4f8bff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(PAD_L, dy); ctx.lineTo(PAD_L + chartW, dy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#4f8bff';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillText('Disc ' + fmtPriceShort(discoveryPrice), PAD_L + chartW + 2, dy + 3);
    ctx.restore();
  }

  // ── Current price line (dashed white)
  const lastClose = bars[bars.length - 1]?.close;
  if (lastClose && lastClose >= pMin && lastClose <= pMax) {
    const cy = Math.round(toY(lastClose)) + 0.5;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(PAD_L, cy); ctx.lineTo(PAD_L + chartW, cy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── Candles
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const x = toX(i);
    const isUp = b.close >= b.open;
    const col = isUp ? '#00e676' : '#ff3d71';
    const bodyTop    = toY(Math.max(b.open, b.close));
    const bodyBot    = toY(Math.min(b.open, b.close));
    const bodyHeight = Math.max(1, bodyBot - bodyTop);

    // Wick
    ctx.strokeStyle = col;
    ctx.lineWidth = wickW;
    ctx.beginPath();
    ctx.moveTo(x, toY(b.high));
    ctx.lineTo(x, toY(b.low));
    ctx.stroke();

    // Body
    ctx.fillStyle = isUp ? col : col;
    if (isUp) {
      ctx.fillStyle = col;
    } else {
      ctx.fillStyle = col;
    }
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyHeight);
  }

  // ── Price axis labels (right side)
  let gP2 = Math.ceil(pMin / pStep) * pStep;
  ctx.fillStyle = 'rgba(107,115,148,.75)';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  while (gP2 <= pMax) {
    const gy = Math.round(toY(gP2));
    ctx.fillText(fmtPriceShort(gP2), PAD_L + chartW + 4, gy + 3);
    gP2 = +(gP2 + pStep).toFixed(10);
  }

  // ── Date axis labels (bottom)
  const dateCount = 5;
  const step = Math.max(1, Math.floor(bars.length / dateCount));
  ctx.fillStyle = 'rgba(107,115,148,.7)';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  for (let i = step; i < bars.length - step / 2; i += step) {
    const b = bars[i];
    const x = toX(i);
    const d = new Date(b.time * 1000);
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    ctx.fillText(label, x, H - 5);
  }

  // ── Hover + touch interaction
  canvas._chartState = { bars, toX, toY, pMin, pMax, priceY, priceH, PAD_L, PAD_R, PAD_T, PAD_B, W, H, candleW };
  const args = [canvas, tooltip, bars, toX, toY, priceH, priceY, PAD_L, chartW, H, discoveryPrice];
  canvas.onmousemove  = (e) => handleChartHover(e, ...args);
  canvas.onmouseleave = ()  => { tooltip.style.display = 'none'; };
  canvas.ontouchstart = (e) => { e.preventDefault(); handleChartHover(e.touches[0], ...args); };
  canvas.ontouchmove  = (e) => { e.preventDefault(); handleChartHover(e.touches[0], ...args); };
  canvas.ontouchend   = ()  => { setTimeout(() => { tooltip.style.display = 'none'; }, 1200); };
}

function handleChartHover(e, canvas, tooltip, bars, toX, toY, priceH, priceY, PAD_L, chartW, H, discoveryPrice) {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  if (mx < PAD_L || mx > PAD_L + chartW) { tooltip.style.display = 'none'; return; }
  const idx = Math.max(0, Math.min(bars.length - 1, Math.round((mx - PAD_L) / chartW * (bars.length - 1))));
  const b = bars[idx];
  if (!b) { tooltip.style.display = 'none'; return; }
  const d = new Date(b.time * 1000);
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const chg = bars[idx - 1] ? ((b.close - bars[idx - 1].close) / bars[idx - 1].close * 100) : 0;
  const chgStr = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
  const chgCol = chg >= 0 ? '#00e676' : '#ff3d71';
  const vol = b.volume ? (b.volume >= 1e6 ? (b.volume / 1e6).toFixed(1) + 'M' : b.volume >= 1e3 ? (b.volume / 1e3).toFixed(0) + 'K' : b.volume) : '—';
  tooltip.innerHTML =
    `<span style="color:rgba(255,255,255,.5)">${dateStr}</span>\n` +
    `O <strong>${fmtPriceShort(b.open)}</strong>  H <strong>${fmtPriceShort(b.high)}</strong>  L <strong>${fmtPriceShort(b.low)}</strong>  C <strong>${fmtPriceShort(b.close)}</strong>\n` +
    `<span style="color:${chgCol}">${chgStr}</span>   Vol <span style="color:rgba(255,255,255,.6)">${vol}</span>` +
    (discoveryPrice ? `\n<span style="color:#4f8bff">Disc ${fmtPriceShort(discoveryPrice)}</span>` : '');
  // Position tooltip — always inside chart bounds, flip side near right edge
  const tipW = Math.min(260, chartW - 8);
  const cx = toX(idx);
  const leftPos = cx > PAD_L + chartW / 2 ? Math.max(4, cx - tipW - 4) : Math.min(cx + 8, PAD_L + chartW - tipW - 4);
  tooltip.style.maxWidth = tipW + 'px';
  tooltip.style.display = 'block';
  tooltip.style.left = leftPos + 'px';
  tooltip.style.top = '8px';
}

function fmtPriceShort(v) {
  if (v == null) return '—';
  if (v >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
  if (v >= 10)   return v.toFixed(2);
  return v.toFixed(3);
}

function nicePriceStep(min, max, targetLines) {
  const range = max - min;
  const raw = range / targetLines;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * pow;
}

// ─── Score sparkline ──────────────────────────────────────────────────────────
function scoreSparklineHtml(sym){
  const hist=scoreHistory[sym];
  if(!hist||hist.length<2) return'';
  const scores=hist.slice(-10).map(h=>h.s);
  const maxS=8,w=44,h=14;
  const xStep=(w-2)/Math.max(scores.length-1,1);
  const pts=scores.map((s,i)=>`${Math.round(i*xStep+1)},${Math.round(h-1-(s/maxS)*(h-2))}`).join(' ');
  const last=scores[scores.length-1],first=scores[0];
  const col=last>first?'var(--green)':last<first?'#ff5252':'var(--text3)';
  return`<svg width="${w}" height="${h}" class="score-spark"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function velocityOf(sym){
  // Use server-enriched velocity if already in scanData, otherwise compute from scoreHistory
  const r=scanData.find(x=>x.sym===sym);
  if(r&&r.velocity) return r.velocity;
  const hist=scoreHistory[sym]||[];
  const pts=hist.slice(-3).map(h=>h.s);
  if(pts.length<2) return{slope:0,direction:'stable'};
  const n=pts.length,mx=(n-1)/2,my=pts.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0;
  pts.forEach((v,i)=>{num+=(i-mx)*(v-my);den+=(i-mx)**2;});
  const slope=den?+(num/den).toFixed(2):0;
  return{slope,direction:slope>=0.5?'rising':slope<=-0.5?'falling':'stable'};
}

function velocityArrowHtml(sym){
  const v=velocityOf(sym);
  if(v.direction==='rising') return`<span style="color:var(--green);font-size:11px;font-weight:700" title="Score rising (slope +${v.slope}/scan)">↗</span>`;
  if(v.direction==='falling') return`<span style="color:#ff5252;font-size:11px;font-weight:700" title="Score falling (slope ${v.slope}/scan)">↘</span>`;
  return`<span style="color:var(--text3);font-size:11px" title="Score stable">→</span>`;
}

// ─── TradingView Actions ──────────────────────────────────────────────────────
async function openOnChart(sym){
  const btn=event?.currentTarget;
  if(btn){btn.textContent='…';btn.disabled=true;}
  try{
    await fetch('/api/tv/open-symbol',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym})});
    if(btn){btn.textContent='✓ '+t('tvOpenChart');setTimeout(()=>{btn.textContent=t('tvOpenChart');btn.disabled=false;},1500);}
  }catch(e){if(btn){btn.textContent=t('tvOpenChart');btn.disabled=false;}}
}

async function tvCopySymbol(sym){
  try{ await navigator.clipboard.writeText(tickerDisplay(sym)); }catch(_){}
  const btn=event?.currentTarget;
  if(btn){const o=btn.textContent;btn.textContent='✓ Copied';setTimeout(()=>btn.textContent=o,1200);}
}

function tvAddToWatchlist(sym,name,market){
  // 1. Add to scan universe
  const mkt=market||marketOf(sym)||'tasi';
  if(!universeData[mkt]) universeData[mkt]=[];
  const alreadyInUniverse=universeData[mkt].some(s=>(typeof s==='object'?s.sym:s)===sym);
  if(!alreadyInUniverse){
    universeData[mkt].push({sym,name:name||tickerDisplay(sym)});
    fetch('/api/universe',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({market:mkt,symbols:universeData[mkt]})});
  }
  // 2. Also add to Portfolio watchlist (the internal ☆/★ list)
  watchlistData=JSON.parse(localStorage.getItem('mawjah_watchlist')||'[]');
  const wasWatched=watchlistData.includes(sym);
  if(!wasWatched){
    watchlistData=[...watchlistData,sym];
    localStorage.setItem('mawjah_watchlist',JSON.stringify(watchlistData));
    renderWatchlistPanel();
  }
  // Update button and drawer star
  const btn=event?.currentTarget;
  const nowWatched=watchlistData.includes(sym);
  if(btn){
    btn.textContent=alreadyInUniverse&&wasWatched?'★ Watchlisted':'★ Added to Watchlist';
    btn.style.color='var(--yellow)';
    setTimeout(()=>{btn.textContent=nowWatched?'★ Watchlist':'⭐ Watchlist';btn.style.color='';},1500);
  }
  // Sync the sig-wl-btn inside the drawer
  if(openDrawerData?.sym===sym){
    const sigBtn=document.getElementById('sig-wl-btn');
    if(sigBtn){sigBtn.textContent='★ Watchlist';sigBtn.classList.add('sig-watch-on');}
  }
  // Update all star icons in the table
  document.querySelectorAll(`.wl-star[data-sym="${sym}"]`).forEach(el=>{el.textContent='★';el.classList.add('wl-active');});
}

function renderTVActions(r){
  const el=document.getElementById('d-tv-actions');
  if(!el) return;
  const watched=isWatched(r.sym);
  el.innerHTML=`
    <button class="tv-btn" onclick="openOnChart('${r.sym}')">${t('tvOpenChart')}</button>
    <button class="tv-btn${watched?' tv-btn-watched':''}" id="d-tv-wl-btn" onclick="tvAddToWatchlist('${r.sym}','${r.name.replace(/'/g,"\\'")}','${marketOf(r.sym)}')">${watched?'★ Watchlist':'⭐ Watchlist'}</button>
    <button class="tv-btn" onclick="tvCopySymbol('${r.sym}')">${t('tvCopySymbol')}</button>
    <button class="tv-btn tv-btn-warn" onclick="openAddAlertRuleModal('${r.sym}','${r.name.replace(/'/g,"\\'")}')">📋 Smart Rule</button>`;
}

// ─── Multi-timeframe alignment ────────────────────────────────────────────────
async function loadTFAlignment(sym){
  const el=document.getElementById('tf-align-content');
  if(!el) return;
  el.innerHTML=`<div class="tf-loading"><span class="spin">⟳</span> ${t('tfLoading')}</div>`;
  try{
    const d=await fetch('/api/tf-align?sym='+encodeURIComponent(sym)).then(r=>r.json());
    if(d.error){el.innerHTML=`<div class="tf-loading" style="color:var(--red)">${d.error}</div>`;return;}
    const tfHtml=(data,label)=>{
      if(!data) return`<div class="tf-col"><div class="tf-label">${label}</div><div class="tf-row"><span>—</span></div></div>`;
      const emaOk=data.ema_stack,a200ok=data.above_200,rsiOk=data.rsi>=52&&data.rsi<78;
      const ok=(v,lbl)=>`<div class="tf-row"><span>${lbl}</span><span class="${v?'tf-pass':'tf-fail'}">${v?'✓':'✗'}</span></div>`;
      const score=[emaOk,a200ok,rsiOk].filter(Boolean).length;
      const col=score===3?'var(--green)':score===2?'var(--yellow)':'#ff5252';
      return`<div class="tf-col"><div class="tf-label" style="color:${col}">${label} ${score}/3</div>${ok(emaOk,'EMA')}${ok(a200ok,'EMA200')}<div class="tf-row"><span>RSI</span><span class="${rsiOk?'tf-pass':data.rsi>=78?'tf-neutral':'tf-fail'}">${data.rsi?.toFixed(1)}</span></div></div>`;
    };
    el.innerHTML=`<div class="tf-grid">${tfHtml(d.h4,'4H')}${tfHtml(d.d,'Daily')}${tfHtml(d.w,'Weekly')}</div>`;
  }catch(e){el.innerHTML=`<div class="tf-loading" style="color:var(--red)">${e.message}</div>`;}
}

// ─── News ─────────────────────────────────────────────────────────────────────
async function loadNewsForDrawer(sym){
  const el=document.getElementById('news-content');
  if(!el) return;
  el.innerHTML=`<div class="tf-loading"><span class="spin">⟳</span></div>`;
  try{
    const d=await fetch('/api/news?sym='+encodeURIComponent(sym)).then(r=>r.json());
    if(!d.articles||!d.articles.length){
      el.innerHTML=`<div class="news-no-token">${t(d.error?'newsNone':'newsNoToken')}</div>`;
      return;
    }
    el.innerHTML=d.articles.map(a=>{
      const date=new Date(a.datetime*1000).toLocaleDateString();
      const sent=a.sentiment;
      const sentHtml=sent>0.1?`<span class="news-sentiment-pos">▲ Positive</span>`:sent<-0.1?`<span class="news-sentiment-neg">▼ Negative</span>`:'';
      return`<div class="news-item">
        <div class="news-headline"><a href="${a.url}" target="_blank">${a.headline}</a></div>
        <div class="news-meta"><span>${date}</span><span>${a.source}</span>${sentHtml}</div>
      </div>`;
    }).join('');
  }catch(e){el.innerHTML=`<div class="news-no-token">${e.message}</div>`;}
}

// ─── Smart Alert Rules ────────────────────────────────────────────────────────
async function loadAlertRules(){
  try{ alertRulesData=await fetch('/api/alert-rules').then(r=>r.json()); }catch(_){}
  renderAlertRules();
}

function renderAlertRules(){
  const el=document.getElementById('alert-rules-list');
  if(!el) return;
  if(!alertRulesData.length){el.innerHTML=`<div style="padding:12px;font-size:12px;color:var(--text3);text-align:center">${t('ruleEmpty')}</div>`;return;}
  el.innerHTML=alertRulesData.map(r=>`<div class="rule-row">
    <span class="rule-name">${r.name}</span>
    <span class="rule-cond">${tickerDisplay(r.sym)} ${r.field} ${r.op} ${r.threshold}</span>
    <span class="rule-last">${r.lastTriggered||'Never'}</span>
    <button class="pos-del-btn" onclick="deleteAlertRule('${r.id}')">✕</button>
  </div>`).join('');
}

async function addAlertRule(){
  const name=(document.getElementById('rule-name')?.value||'').trim();
  const sym=(document.getElementById('rule-sym')?.value||'').trim().toUpperCase();
  const field=document.getElementById('rule-field')?.value||'score';
  const op=document.getElementById('rule-op')?.value||'gte';
  const threshold=document.getElementById('rule-threshold')?.value||'';
  if(!name||!sym||!threshold) return;
  const threshVal=field==='bias'?threshold:parseFloat(threshold);
  try{
    const r=await fetch('/api/alert-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,sym,field,op,threshold:threshVal})}).then(x=>x.json());
    if(r.ok){ alertRulesData.push(r.rule); renderAlertRules(); ['rule-name','rule-sym','rule-threshold'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';}); }
  }catch(e){alert(e.message);}
}

async function deleteAlertRule(id){
  try{
    await fetch('/api/alert-rules/'+id,{method:'DELETE'});
    alertRulesData=alertRulesData.filter(r=>r.id!==id);
    renderAlertRules();
  }catch(e){alert(e.message);}
}

function openAddAlertRuleModal(sym,name){
  // Pre-fill the alert rule form and switch to criteria tab
  switchTab('criteria',document.querySelector('.tab:nth-child(3)'));
  setTimeout(()=>{
    const el=document.getElementById('rule-sym'); if(el) el.value=sym;
    const nl=document.getElementById('rule-name'); if(nl) nl.value=name+' Score≥6';
    const tl=document.getElementById('rule-threshold'); if(tl) tl.value='6';
  },100);
}

// ─── Portfolio Heat Map (treemap) ─────────────────────────────────────────────
function layoutTreemap(items,x,y,w,h){
  if(!items.length) return[];
  if(items.length===1) return[{...items[0],x,y,w,h}];
  const total=items.reduce((s,i)=>s+i.value,0);
  let cum=0,splitAt=1;
  const half=total/2;
  for(let i=0;i<items.length;i++){cum+=items[i].value;if(cum>=half){splitAt=i+1;break;}}
  const left=items.slice(0,splitAt),right=items.slice(splitAt);
  const lf=left.reduce((s,i)=>s+i.value,0)/total;
  if(w>=h){const lw=Math.round(w*lf);return[...layoutTreemap(left,x,y,lw,h),...layoutTreemap(right,x+lw,y,w-lw,h)];}
  else{const lh=Math.round(h*lf);return[...layoutTreemap(left,x,y,w,lh),...layoutTreemap(right,x,y+lh,w,h-lh)];}
}

function renderHeatMap(){
  const svg=document.getElementById('heatmap-svg');
  const section=document.getElementById('pos-heatmap');
  if(!svg||!section) return;
  const entries=Object.values(positionsData).filter(p=>p.sym&&!p.sym.startsWith('_'));
  if(!entries.length){section.style.display='none';return;}
  section.style.display='block';
  const W=svg.parentElement.offsetWidth||400,H=120;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.setAttribute('width',W);
  const items=entries.map(pos=>{
    const scanRow=scanData.find(r=>r.sym===pos.sym);
    const curP=scanRow?.price||pos.entry_price;
    const value=(pos.shares||1)*curP;
    const pct=((curP-pos.entry_price)/pos.entry_price*100);
    return{...pos,value,pct};
  }).sort((a,b)=>b.value-a.value);
  const layout=layoutTreemap(items,0,0,W,H);
  svg.innerHTML=layout.map(item=>{
    const pct=item.pct??0;
    const fill=pct>=3?'#00695c':pct>=0?'#1b5e20':pct>=-3?'#b71c1c':'#7f0000';
    const textCol='rgba(255,255,255,.9)';
    const pad=3;
    const tw=item.w-pad*2,th=item.h-pad*2;
    if(tw<20||th<14) return`<rect x="${item.x+1}" y="${item.y+1}" width="${item.w-2}" height="${item.h-2}" rx="3" fill="${fill}"/>`;
    return`<g onclick="openDrawer(scanData.find(r=>r.sym==='${item.sym}'))" style="cursor:pointer">
      <rect x="${item.x+1}" y="${item.y+1}" width="${item.w-2}" height="${item.h-2}" rx="3" fill="${fill}" opacity=".85"/>
      <text x="${item.x+item.w/2}" y="${item.y+item.h/2-4}" text-anchor="middle" font-size="${Math.min(13,tw/3+4)}" font-weight="700" fill="${textCol}" font-family="SF Mono,Fira Code,monospace">${tickerDisplay(item.sym)}</text>
      <text x="${item.x+item.w/2}" y="${item.y+item.h/2+9}" text-anchor="middle" font-size="${Math.min(11,tw/4+3)}" fill="${textCol}" opacity=".8">${pct>=0?'+':''}${pct.toFixed(1)}%</text>
    </g>`;
  }).join('');
}