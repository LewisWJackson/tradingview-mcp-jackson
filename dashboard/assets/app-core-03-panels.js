// ── Calendar ──────────────────────────────────────────────────────────────────
const calCache={};
async function fetchCalendar(sym){
  if(calCache[sym]!==undefined) return calCache[sym];
  try{
    const r=await fetch('/api/calendar?sym='+encodeURIComponent(sym)).then(x=>x.json());
    calCache[sym]=r.event||null;
    return calCache[sym];
  }catch(_){ calCache[sym]=null; return null; }
}

function calBadgeHtml(event){
  if(!event) return'';
  const days=Math.round((new Date(event.date)-Date.now())/864e5);
  if(days<0||days>35) return'';
  const urgent=days<=7;
  const when=days===0?'today':days===1?'tomorrow':`in ${days}d`;
  const hour=event.hour==='bmo'?'pre-mkt':event.hour==='amc'?'after-close':'';
  return`<span class="cal-badge${urgent?' urgent':''}" title="Earnings ${event.date} ${hour}">📅 ${t('calEarnings')} ${when}</span>`;
}

// Catalyst risk flags (validated "don't buy now" signals: debt/earnings/management).
// Bulk-loaded once; defensive entry-timing warning, not alpha.
const riskCache={}; let _riskLoaded=false;
async function loadRiskFlags(){
  try{
    const r=await fetch('/api/catalyst/risks').then(x=>x.json());
    Object.keys(riskCache).forEach(k=>delete riskCache[k]);
    Object.assign(riskCache, r.flags||{});
  }catch(_){}
  _riskLoaded=true;
}
function riskBadgeHtml(flags){
  if(!flags||!flags.length) return'';
  const notes=flags.map(f=>'• '+f.note+' ('+f.date+')').join('\n');
  return`<span class="risk-badge" title="Catalyst risk — avoid a fresh entry right now:\n${notes}" style="font-size:8.5px;font-weight:700;padding:1px 6px;border-radius:10px;background:#ff525222;color:#ff5252;border:1px solid #ff525244;margin-inline-start:4px;cursor:help">⚠ Risk</span>`;
}

// ── Trade journal / analytics ─────────────────────────────────────────────────
function closeTrade(sym){
  const tr=document.querySelector(`.pos-close-row[data-sym="${sym}"]`);
  if(tr){ tr.remove(); return; }
  const tbody=document.getElementById('positions-body');
  const row=tbody.querySelector(`tr[data-pos-sym="${sym}"]`);
  if(!row) return;
  const form=document.createElement('tr');
  form.className='pos-close-row'; form.setAttribute('data-sym',sym);
  form.innerHTML=`<td colspan="8"><div class="close-trade-form">
    <span style="font-weight:700;color:var(--accent)">${tickerDisplay(sym)}</span>
    <input id="close-price-${sym}" class="add-criteria-input" style="max-width:90px" placeholder="${t('closePrice')}" type="number" step="0.01">
    <input id="close-date-${sym}"  class="add-criteria-input" style="max-width:110px" type="date" value="${new Date().toISOString().split('T')[0]}">
    <select id="close-reason-${sym}" class="add-criteria-input" style="max-width:110px">
      <option value="target1">${t('closeReasonT1')}</option>
      <option value="target2">${t('closeReasonT2')}</option>
      <option value="stop">${t('closeReasonStop')}</option>
      <option value="manual">${t('closeReasonManual')}</option>
    </select>
    <button class="btn btn-success" style="font-size:11px" onclick="confirmCloseTrade('${sym}')">${t('closeConfirm')}</button>
    <button class="btn btn-secondary" style="font-size:11px" onclick="closeTrade('${sym}')">${t('clearSel')}</button>
  </div></td>`;
  row.after(form);
}

function confirmCloseTrade(sym){
  const exitPrice=parseFloat(document.getElementById(`close-price-${sym}`)?.value||'0');
  const exitDate=document.getElementById(`close-date-${sym}`)?.value||'';
  const exitReason=document.getElementById(`close-reason-${sym}`)?.value||'manual';
  if(!exitPrice) return;
  const pos=positionsData[sym];
  if(!pos) return;
  const pct=(exitPrice-pos.entry_price)/pos.entry_price*100;
  const key=sym+'_'+Date.now();
  if(!positionsData._closed) positionsData._closed={};
  positionsData._closed[key]={...pos,exit_price:exitPrice,exit_date:exitDate,exit_reason:exitReason,pct:Math.round(pct*100)/100,status:'closed'};
  delete positionsData[sym];
  savePositionsToServer();
  renderPositionsPanel();
  renderTable();
}

function computeTradeAnalytics(){
  const closed=Object.values(positionsData._closed||{});
  if(!closed.length) return null;
  const wins=closed.filter(t=>t.pct>0);
  const losses=closed.filter(t=>t.pct<=0);
  const winRate=Math.round(wins.length/closed.length*100);
  const avgWin=wins.length?Math.round(wins.reduce((s,t)=>s+t.pct,0)/wins.length*100)/100:0;
  const avgLoss=losses.length?Math.round(losses.reduce((s,t)=>s+t.pct,0)/losses.length*100)/100:0;
  const pf=losses.length&&avgLoss?Math.round(Math.abs(avgWin*wins.length/(avgLoss*losses.length))*100)/100:null;
  // Equity curve
  let cum=100; const equity=closed.map(t=>{cum*=(1+t.pct/100);return Math.round(cum*100)/100;});
  return{closed,winRate,avgWin,avgLoss,pf,equity};
}

function renderTradeAnalytics(){
  const el=document.getElementById('pos-analytics');
  const grid=document.getElementById('analytics-grid');
  const svg=document.getElementById('analytics-equity');
  if(!el||!grid) return;
  const an=computeTradeAnalytics();
  if(!an||!an.closed.length){el.style.display='none';return;}
  el.style.display='block';
  const winCol=an.winRate>=55?'var(--green)':an.winRate>=45?'var(--yellow)':'#ff5252';
  grid.innerHTML=`
    <div class="an-stat"><div class="an-val" style="color:${winCol}">${an.winRate}%</div><div class="an-lbl">${t('anWinRate')}</div></div>
    <div class="an-stat"><div class="an-val" style="color:var(--green)">+${an.avgWin}%</div><div class="an-lbl">${t('anAvgWin')}</div></div>
    <div class="an-stat"><div class="an-val" style="color:#ff5252">${an.avgLoss}%</div><div class="an-lbl">${t('anAvgLoss')}</div></div>
    <div class="an-stat"><div class="an-val">${an.pf!=null?an.pf+'×':'—'}</div><div class="an-lbl">${t('anPF')}</div></div>`;
  if(svg&&an.equity.length>1){
    const w=400,h=70,min=Math.min(...an.equity),max=Math.max(...an.equity),range=max-min||1;
    const pts=an.equity.map((v,i)=>`${Math.round(i/(an.equity.length-1)*(w-1))},${Math.round(h-1-(v-min)/range*(h-1))}`).join(' ');
    const col=an.equity[an.equity.length-1]>=100?'var(--green)':'#ff5252';
    svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
    svg.innerHTML=`<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5"/><line x1="0" y1="${Math.round(h-1-(100-min)/range*(h-1))}" x2="${w}" y2="${Math.round(h-1-(100-min)/range*(h-1))}" stroke="var(--border2)" stroke-dasharray="3,3"/>`;
  }
}

// ── Mode toggle ──────────────────────────────────────────────────────────────
function setMode(mode, btn){
  scanMode=mode;
  localStorage.setItem('mawjah-mode', mode);
  applyModeUI();
  renderTable();
}
function applyModeUI(){
  ['swing','position','breakout'].forEach(m => {
    const el=document.getElementById('mode-'+m);
    if(el) el.classList.toggle('active', scanMode===m);
  });
  const pill=document.getElementById('mode-ctx-pill');
  if(pill){
    const labels={swing:'Swing Trading',position:'Position Investing',breakout:'Breakout Hunting'};
    const classes={swing:'swing',position:'position',breakout:'breakout'};
    pill.textContent=labels[scanMode]||scanMode;
    pill.className='mode-ctx-pill '+(classes[scanMode]||'swing');
  }
}

// ── Weekly badge ─────────────────────────────────────────────────────────────
function weeklyBadgeHtml(r){
  if(scanMode!=='position') return`<span class="wb wb-na">${t('wNa')}</span>`;
  if(!r.weekly) return`<span class="wb wb-na">${t('wNa')}</span>`;
  const {score}=r.weekly;
  if(score===4) return`<span class="wb wb-full">${t('wFull')}</span>`;
  if(score===2) return`<span class="wb wb-partial">${t('wPartial')}</span>`;
  return`<span class="wb wb-none">${t('wNone')}</span>`;
}

// ── Position P&L badge ───────────────────────────────────────────────────────
function positionBadgeHtml(sym, scanPrice){
  const pos=positionsData[sym];
  if(!pos || !scanPrice) return'';
  const pct=(scanPrice-pos.entry_price)/pos.entry_price*100;
  const cls=pct>=0?'pos-gain':'pos-loss';
  const sign=pct>=0?'+':'';
  return`<span class="pos-badge ${cls}" title="${t('posEntry')}: ${pos.entry_price}">${sign}${pct.toFixed(1)}%</span>`;
}

// ── CSV export ───────────────────────────────────────────────────────────────
function exportCsv(){
  const rows=getVisibleRows();
  const maxS=rows.find(r=>r.maxScore>8)?.maxScore||9;
  const headers=[
    'Symbol','Name','Market','Sector','Price','Score','Max Score','Score %','Bias',
    'RSI','MACD Hist','Vol Ratio','ATR','RS Score',
    'Hurst','Hurst State','ATR Rank %','ATR Regime',
    'VWAP 20d','Above VWAP',
    'EMA13','EMA34','EMA89','EMA200',
    'Sharia','Weekly Score',
    'Bullish Flags','Warnings'
  ];
  const hurstState=h=>h==null?'':h>0.55?'Trending':h<0.45?'Mean-Rev':'Random';
  const atrRegime=p=>p==null?'':p>=80?'Expanded/Volatile':p<=20?'Compressed/Coiling':'Normal';
  const lines=rows.map(r=>[
    r.sym, r.name, marketOf(r.sym), sectorLabel(sectorOf(r.sym)),
    r.price?.toFixed(2)||'', r.score, r.maxScore||maxS,
    r.score&&(r.maxScore||maxS)?Math.round(r.score/(r.maxScore||maxS)*100)+'%':'',
    r.bias,
    r.rsi?.toFixed(1)||'', r.macd_hist?.toFixed(4)||'', r.vol_ratio||'',
    r.atr?.toFixed(4)||'', r.rs_score?.toFixed(2)||'',
    r.hurst?.toFixed(2)||'', hurstState(r.hurst),
    r.atr_pct_rank??'', atrRegime(r.atr_pct_rank),
    r.vwap20?.toFixed(2)||'', r.above_vwap!=null?(r.above_vwap?'Yes':'No'):'',
    r.emas?.ema13?.toFixed(2)||'', r.emas?.ema34?.toFixed(2)||'',
    r.emas?.ema89?.toFixed(2)||'', r.emas?.ema200?.toFixed(2)||'',
    shariaMap[r.sym]?.status||'unknown', r.weekly?.score??'',
    (r.flags||[]).join('; '), (r.warnings||[]).join('; ')
  ].map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(','));
  const csv=[headers.join(','), ...lines].join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'}));
  a.download=`mawjah-${new Date().toISOString().split('T')[0]}-${scanMode}.csv`;
  a.click();
}

// ── Positions management ─────────────────────────────────────────────────────
async function loadPositionsPanel(){
  try{ const r=await fetch('/api/positions'); positionsData=await r.json(); }catch(_){}
  renderPositionsPanel();
}

function renderPositionsPanel(){
  const tbody=document.getElementById('positions-body');
  const summaryEl=document.getElementById('positions-summary');
  if(!tbody) return;
  // Open risk bar
  const riskEl=document.getElementById('open-risk-bar');
  if(riskEl){
    const balance=settingsData?.account_balance||100000;
    const openEntries=Object.values(positionsData).filter(p=>p.sym&&!p.sym.startsWith('_'));
    if(openEntries.length){
      const totalInvested=openEntries.reduce((a,p)=>{const s=scanData.find(x=>x.sym===p.sym);const px=s?.price||p.entry_price;return a+(px*(p.shares||0));},0);
      const pct=Math.min(totalInvested/balance*100,100);
      const col=pct>80?'#ff5252':pct>50?'var(--yellow)':'var(--green)';
      const maxRiskPct=settingsData?.risk_percent?settingsData.risk_percent*openEntries.length:null;
      riskEl.innerHTML=`<div class="risk-bar-container">
        <div class="risk-bar-header">
          <span class="risk-bar-title">Portfolio Exposure</span>
          <span class="risk-bar-pct" style="color:${col}">${pct.toFixed(1)}%</span>
        </div>
        <div class="risk-bar-track"><div class="risk-bar-fill" style="width:${pct}%;background:${col}"></div></div>
        <div class="risk-stats-row">
          <div class="risk-stat-item">Invested: <span>${totalInvested.toLocaleString('en-US',{maximumFractionDigits:0})}</span></div>
          <div class="risk-stat-item">Balance: <span>${balance.toLocaleString('en-US',{maximumFractionDigits:0})}</span></div>
          <div class="risk-stat-item">Positions: <span>${openEntries.length}</span></div>
          ${maxRiskPct!=null?`<div class="risk-stat-item" style="${maxRiskPct>10?'color:#ff5252':''}">Max risk/trade × count: <span>${maxRiskPct.toFixed(1)}%</span></div>`:''}
        </div>
      </div>`;
      riskEl.style.display='block';
    } else { riskEl.style.display='none'; }
  }
  const entries=Object.values(positionsData);
  if(!entries.length){
    tbody.innerHTML=`<tr><td colspan="8" style="padding:30px;text-align:center;color:var(--text3);font-size:12px">${t('posEmpty')}</td></tr>`;
    if(summaryEl) summaryEl.style.display='none';
    return;
  }
  let totalPnlPct=0, posCount=0;
  tbody.innerHTML=entries.map(pos=>{
    const scanRow=scanData.find(r=>r.sym===pos.sym);
    const scanP=scanRow?.price;
    const pct=scanP?(scanP-pos.entry_price)/pos.entry_price*100:null;
    const pnlCls=pct==null?'':pct>=0?'pos-pnl-pos':'pos-pnl-neg';
    const pnlStr=pct==null?'—':`${pct>=0?'+':''}${pct.toFixed(2)}%`;
    const pnlVal=pct!=null&&pos.shares?`${(pct/100*pos.entry_price*pos.shares).toFixed(0)}`:'';
    if(pct!=null){totalPnlPct+=pct;posCount++;}
    const ticker=tickerDisplay(pos.sym);
    return`<tr data-pos-sym="${pos.sym}">
      <td class="td-ticker">${ticker}</td>
      <td>${pos.name||ticker}</td>
      <td style="font-family:monospace">${pos.entry_price}</td>
      <td style="font-family:monospace">${scanP?.toFixed(2)||'—'}</td>
      <td class="${pnlCls}" style="font-family:monospace;font-weight:700">${pnlStr} ${pnlVal?`<span style="font-size:10px;opacity:.7">(${pnlVal})</span>`:''}</td>
      <td>${pos.shares||'—'}</td>
      <td style="color:var(--text3)">${pos.date||'—'}</td>
      <td style="display:flex;gap:4px">
        <button class="btn btn-secondary" style="font-size:10px;padding:2px 7px" onclick="closeTrade('${pos.sym}')">${t('closeTrade')}</button>
        <button class="pos-del-btn" onclick="removePosition('${pos.sym}')">✕</button>
      </td>
    </tr>`;
  }).join('');
  if(summaryEl && posCount){
    const avg=totalPnlPct/posCount;
    summaryEl.innerHTML=`<span style="color:var(--text2)">${posCount} ${posCount===1?'position':'positions'}</span><span class="${avg>=0?'pos-pnl-pos':'pos-pnl-neg'}" style="font-weight:700">${avg>=0?'+':''}${avg.toFixed(2)}% avg P&L</span>`;
    summaryEl.style.display='flex';
  }
  // Closed trades section
  const closed=Object.values(positionsData._closed||{});
  if(closed.length){
    const closedHtml=closed.slice(-10).reverse().map(pos=>{
      const pnlCls=pos.pct>=0?'pos-pnl-pos':'pos-pnl-neg';
      return`<tr>
        <td class="td-ticker">${tickerDisplay(pos.sym)}</td>
        <td>${pos.name||pos.sym}</td>
        <td style="font-family:monospace">${pos.entry_price}</td>
        <td style="font-family:monospace">${pos.exit_price}</td>
        <td class="${pnlCls}" style="font-family:monospace;font-weight:700">${pos.pct>=0?'+':''}${pos.pct}%</td>
        <td>${pos.shares||'—'}</td>
        <td style="color:var(--text3)">${pos.exit_date||'—'}</td>
        <td style="color:var(--text3);font-size:10px">${pos.exit_reason||'—'}</td>
      </tr>`;
    }).join('');
    tbody.innerHTML+=`<tr><td colspan="8" class="journal-section">${t('closeTrade')}d</td></tr>`+closedHtml;
  }
  renderTradeAnalytics();
  renderHeatMap();
  setTimeout(addDividendBadges, 300);
}

function addPosition(){
  const sym=(document.getElementById('pos-sym')?.value||'').trim().toUpperCase();
  const entry=parseFloat(document.getElementById('pos-entry')?.value||'');
  const shares=parseFloat(document.getElementById('pos-shares')?.value||'');
  const date=document.getElementById('pos-date')?.value||'';
  if(!sym||isNaN(entry)) return;
  const scanRow=scanData.find(r=>r.sym===sym||tickerDisplay(r.sym)===sym);
  // Normalize a bare 4-digit TASI code → TADAWUL:1120 so it matches scan/momentum keys
  // (otherwise turnover BUY/HOLD/SELL can never match a hand-entered holding).
  const fullSym=scanRow?.sym||(/^\d{4}$/.test(sym)?`TADAWUL:${sym}`:sym);
  positionsData[fullSym]={sym:fullSym,name:scanRow?.name||sym,entry_price:entry,shares:isNaN(shares)?null:shares,date};
  document.getElementById('pos-sym').value='';
  document.getElementById('pos-entry').value='';
  document.getElementById('pos-shares').value='';
  savePositionsToServer();
  renderPositionsPanel();
  renderTable();
}

function removePosition(sym){
  delete positionsData[sym];
  savePositionsToServer();
  renderPositionsPanel();
  renderTable();
}

async function savePositionsToServer(){
  try{ await fetch('/api/positions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(positionsData)}); }catch(_){}
}

// ── Telegram settings ────────────────────────────────────────────────────────
async function loadTelegramSettings(){
  try{ const r=await fetch('/api/settings'); settingsData=await r.json(); }catch(_){}
  const tg=settingsData?.telegram||{};
  const el=id=>document.getElementById(id);
  if(el('tg-enabled'))     el('tg-enabled').checked=!!tg.enabled;
  if(el('tg-token'))       el('tg-token').value=tg.token||'';
  if(el('tg-chatid'))      el('tg-chatid').value=tg.chat_id||'';
  if(el('finnhub-token'))  el('finnhub-token').value=settingsData?.finnhub_token||'';
}

async function saveTelegram(){ await saveSettings(); }
async function saveSettings(){
  const enabled=document.getElementById('tg-enabled')?.checked||false;
  const token=(document.getElementById('tg-token')?.value||'').trim();
  const chat_id=(document.getElementById('tg-chatid')?.value||'').trim();
  const finnhub_token=(document.getElementById('finnhub-token')?.value||'').trim();
  settingsData={...settingsData, telegram:{enabled,token,chat_id}, finnhub_token};
  try{
    await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(settingsData)});
    const st=document.getElementById('tg-status');
    if(st){st.textContent=t('notifSaved');st.style.display='block';setTimeout(()=>st.style.display='none',2000);}
  }catch(_){}
}

async function testTelegram(){
  await saveTelegram();
  const btn=event.currentTarget; btn.disabled=true; btn.textContent='…';
  try{
    const r=await fetch('/api/notify/test',{method:'POST'}).then(x=>x.json());
    btn.textContent=r.ok?t('notifTestOk'):t('notifTestFail');
    btn.style.color=r.ok?'var(--green)':'var(--red)';
    setTimeout(()=>{btn.textContent=t('notifTest');btn.disabled=false;btn.style.color='';},3000);
  }catch(_){btn.textContent=t('notifTestFail');setTimeout(()=>{btn.textContent=t('notifTest');btn.disabled=false;},2000);}
}

// ── Screenshot in drawer ─────────────────────────────────────────────────────
async function viewChartScreenshot(sym){
  const el=document.getElementById('drawer-screenshot');
  if(!el) return;
  el.innerHTML=`<div style="padding:12px;text-align:center;font-size:12px;color:var(--text3)">${t('chartLoading')}</div>`;
  try{
    const r=await fetch('/api/chart/screenshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym})}).then(x=>x.json());
    if(r.success) el.innerHTML=`<img src="${r.url}?t=${Date.now()}" class="chart-screenshot" alt="Chart">`;
    else el.innerHTML=`<div style="padding:8px;font-size:11px;color:var(--red)">${r.error||'Failed'}</div>`;
  }catch(e){el.innerHTML=`<div style="padding:8px;font-size:11px;color:var(--red)">${e.message}</div>`;}
}

// ── Live price in drawer ─────────────────────────────────────────────────────
async function refreshLivePrice(sym){
  const el=document.getElementById('drawer-live-price');
  if(!el) return;
  el.innerHTML=`<span class="live-price-val">…</span>`;
  try{
    const q=await fetch('/api/quote?sym='+encodeURIComponent(sym)).then(r=>r.json());
    if(q.success){
      const p=q.last||q.close;
      const scanRow=scanData.find(r=>r.sym===sym);
      const drift=scanRow?.price&&p?((p-scanRow.price)/scanRow.price*100):null;
      const driftStr=drift!=null?` <span style="color:${drift>=0?'var(--green)':'#ff5252'};font-size:11px">${drift>=0?'+':''}${drift.toFixed(2)}% vs scan</span>`:'';
      el.innerHTML=`<span class="live-price-val">${p?.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>${driftStr}`;
    } else { el.innerHTML=`<span style="color:var(--text3);font-size:11px">${q.error||'N/A'}</span>`; }
  }catch(e){el.innerHTML=`<span style="color:var(--red);font-size:11px">${e.message}</span>`;}
}

function updateBreadthBar(){
  const el=document.getElementById('breadth-container');
  if(!el) return;
  const rows=getVisibleRows().filter(r=>r.bias!=='ERROR'&&r.bias!=='NO_DATA');
  if(!rows.length){el.style.display='none';return;}
  const bull=rows.filter(r=>['STRONG BUY','BUY'].includes(r.bias)).length;
  const bear=rows.filter(r=>['STRONG SELL','SELL','AVOID'].includes(r.bias)).length;
  const neu=rows.length-bull-bear;
  const bp=Math.round(bull/rows.length*100), brp=Math.round(bear/rows.length*100), np=100-bp-brp;
  document.getElementById('breadth-bull').style.width=bp+'%';
  document.getElementById('breadth-neutral').style.width=np+'%';
  document.getElementById('breadth-bear').style.width=brp+'%';
  document.getElementById('breadth-lbl-bull').textContent='▲ '+bp+'% ('+bull+')';
  document.getElementById('breadth-lbl-neutral').textContent='◆ '+np+'% ('+neu+')';
  document.getElementById('breadth-lbl-bear').textContent='▼ '+brp+'% ('+bear+')';
  document.getElementById('breadth-total').textContent=rows.length+' stocks';
  el.style.display='block';
}

function updateSectorHeatmap(){
  const el=document.getElementById('sector-heatmap');
  if(!el) return;
  const rows=getVisibleRows().filter(r=>r.bias!=='ERROR'&&r.bias!=='NO_DATA');
  if(!rows.length){el.style.display='none';return;}
  const sd={};
  rows.forEach(r=>{
    const sec=sectorOf(r.sym);
    if(!sd[sec]) sd[sec]={sum:0,n:0,bull:0,bear:0};
    sd[sec].sum+=r.score; sd[sec].n++;
    if(['STRONG BUY','BUY'].includes(r.bias)) sd[sec].bull++;
    if(['STRONG SELL','SELL','AVOID'].includes(r.bias)) sd[sec].bear++;
  });
  const entries=Object.entries(sd).filter(([,d])=>d.n>0)
    .map(([sec,d])=>({sec,avg:Math.round(d.sum/d.n*10)/10,n:d.n,bull:d.bull,bear:d.bear}))
    .sort((a,b)=>b.avg-a.avg);
  const _hmaxS = scanData.find(r=>r.maxScore>8)?.maxScore || 9;
  el.innerHTML=entries.map(({sec,avg,n,bull,bear})=>{
    const col=avg>=(_hmaxS*7/9)?'var(--green)':avg>=(_hmaxS*4/9)?'var(--yellow)':'#ff5252';
    const pct=Math.round(avg/_hmaxS*100);
    const active=filterSec===sec?' htactive':'';
    return`<div class="heat-tile${active}" onclick="filterSector('${sec}',this)">
      <div class="heat-name">${sectorLabel(sec)}</div>
      <div class="heat-score" style="color:${col}">${avg}</div>
      <div class="heat-bar-track"><div class="heat-bar-fill" style="width:${pct}%;background:${col}"></div></div>
      <div class="heat-counts"><span style="color:var(--green)">▲${bull}</span><span style="color:#ff5252">▼${bear}</span><span>${n}</span></div>
    </div>`;
  }).join('');
  el.style.display=entries.length?'flex':'none';
  updateSectorRotation();
}

// Plain-language change summary for each criterion key
const CRIT_SHORT = {
  emaStack: { gained: 'trend stack aligned',        lost: 'trend stack broken'       },
  ema200:   { gained: 'price crossed above EMA 200', lost: 'price fell below EMA 200' },
  rsi:      { gained: 'RSI entered momentum zone',   lost: 'RSI left momentum zone'   },
  macd:     { gained: 'MACD turned bullish',          lost: 'MACD turned bearish'      },
  vol:      { gained: 'volume surged',               lost: 'volume retreated'         },
  vwap:     { gained: 'price moved above VWAP',      lost: 'price dropped below VWAP' },
};
const CRIT_SHORT_BEAR = {
  emaStack: { gained: 'bearish EMA stack confirmed', lost: 'bearish stack broken'   },
  ema200:   { gained: 'price dropped below EMA 200', lost: 'price recovered EMA 200'},
  rsi:      { gained: 'RSI in weak zone',             lost: 'RSI left weak zone'     },
  macd:     { gained: 'MACD turned bearish',          lost: 'MACD turned bullish'    },
  vol:      { gained: 'volume confirmed',             lost: 'volume retreated'       },
  vwap:     { gained: 'price fell below VWAP',        lost: 'price recovered above VWAP' },
};
function buildMoverSummary(d){
  if(!d.criteria_changes||!d.criteria_changes.length){
    // No criterion changed — bias threshold crossed with same score
    return d.direction==='improved'
      ? 'Score crossed into higher signal band — same criteria, stronger reading'
      : 'Score dropped into lower signal band — conditions weakened';
  }
  const isBear=['STRONG SELL','SELL','AVOID'].includes(d.curr_bias);
  const map=isBear?CRIT_SHORT_BEAR:CRIT_SHORT;
  const gained=d.criteria_changes.filter(c=>c.now&&!c.was).map(c=>(map[c.key]||{}).gained||c.label);
  const lost  =d.criteria_changes.filter(c=>c.was&&!c.now).map(c=>(map[c.key]||{}).lost  ||c.label);
  const parts=[];
  if(gained.length) parts.push(gained.join(', '));
  if(lost.length)   parts.push((gained.length?'but ':'') + lost.join(', '));
  if(!parts.length) return '';
  const conclusion=d.direction==='improved'
    ? (d.curr_bias==='STRONG BUY'||d.curr_bias==='BUY' ? ' — strong setup forming' : d.curr_bias==='WATCH' ? ' — approaching entry zone' : ' — improving')
    : (d.curr_bias==='STRONG SELL'||d.curr_bias==='SELL'||d.curr_bias==='AVOID' ? ' — bearish signals confirmed' : d.curr_bias==='SKIP' ? ' — momentum fading' : ' — weakening');
  return parts.join(' ') + conclusion;
}

async function loadPreSignal() {
  const panel = document.getElementById('presignal-panel');
  if (!panel) return;
  panel.style.display = 'block';
  const posEl2 = document.getElementById('presignal-positive');
  const negEl2 = document.getElementById('presignal-negative');
  const loadMsg = `<div style="color:var(--text3);font-size:11px;padding:14px;text-align:center">Analysing…</div>`;
  if (posEl2) posEl2.innerHTML = loadMsg;
  if (negEl2) negEl2.innerHTML = loadMsg;
  try {
    const d = await fetch('/api/scan/presignal').then(r => r.json());

    // Update badge
    const badge = document.getElementById('presignal-badge');
    if (badge) {
      const exitCount = (d.presignal||[]).filter(s=>s.approaching==='EXIT_RISK').length;
      if (exitCount > 0) { badge.textContent = exitCount; badge.style.display='inline-block'; }
      else if (d.presignal?.length > 0) { badge.textContent = d.presignal.length; badge.style.display='inline-block'; }
      else { badge.style.display='none'; }
    }

    const posEl = document.getElementById('presignal-positive');
    const negEl = document.getElementById('presignal-negative');
    // Also keep list for backward compat
    const listEl = document.getElementById('presignal-list');

    const positiveTypes = new Set(['BUY','RECOVERY','ACCUMULATION']);
    const negativeTypes = new Set(['EXIT_RISK','SELL']);

    if (!d.presignal?.length) {
      const empty = `<div style="color:var(--text3);font-size:11px;padding:14px;text-align:center">No signals detected.<br>Run a full scan first.</div>`;
      if (posEl) posEl.innerHTML = empty;
      if (negEl) negEl.innerHTML = empty;
      if (listEl) listEl.innerHTML = '';
      return;
    }

    const catMeta = {
      EXIT_RISK:    { label:'🚨 Exit Risk',       cls:'exit_risk',    desc:'Deteriorating — consider reducing' },
      BUY:          { label:'→ Approaching BUY',  cls:'buy',          desc:'Close to a buy signal' },
      RECOVERY:     { label:'⬆ Recovering',       cls:'recovery',     desc:'Selling pressure easing' },
      ACCUMULATION: { label:'◎ Accumulation',     cls:'accumulation', desc:'Coiling — watch for breakout' },
      SELL:         { label:'→ Approaching SELL', cls:'sell',         desc:'Close to a sell signal' },
    };

    function buildRow(s) {
      const confBar = '█'.repeat(Math.round(s.confidence/2)) + '░'.repeat(5-Math.round(s.confidence/2));
      const confCol = s.confidence >= 7 ? 'var(--green)' : s.confidence >= 4 ? 'var(--orange)' : 'var(--text3)';
      const heldBadge = s.held ? `<span class="presignal-held-badge">📌</span>` : '';
      const durBadge  = s.accum_duration >= 2 ? `<span class="presignal-dur">${s.accum_duration}×</span>` : '';
      const rsiTxt    = s.rsi != null ? `RSI ${s.rsi.toFixed(0)}` : '';
      const ptsAway   = s.approaching==='BUY'?s.proximity?.pts_to_buy:s.approaching==='SELL'?s.proximity?.pts_to_sell:null;
      const ptsTxt    = ptsAway>0 ? `${ptsAway}pt` : '';
      const trendTxt  = s.trend>0.2?`↑${s.trend.toFixed(1)}`:s.trend<-0.2?`↓${s.trend.toFixed(1)}`:'';
      const detail    = [rsiTxt,ptsTxt,trendTxt].filter(Boolean).join(' · ');
      const proxBadge = ptsAway===1?'<span class="prox-badge prox-1">1 away</span>':ptsAway===2?'<span class="prox-badge prox-2">2 away</span>':ptsAway===3?'<span class="prox-badge prox-3">3 away</span>':'';
      const arName    = s.ar ? `<span style="font-size:9px;color:var(--text3)" dir="rtl">${s.ar}</span>` : '';
      const sigCol    = s.approaching==='BUY'||s.approaching==='RECOVERY'||s.approaching==='ACCUMULATION'?'var(--green)':s.approaching==='SELL'||s.approaching==='EXIT_RISK'?'var(--red)':'var(--yellow)';
      return `<div class="presignal-row" onclick="onRowClick(event,'${s.sym}')">
        <div style="flex:1;min-width:0;overflow:hidden">
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
            <strong style="font-size:11px">${tickerDisplay(s.sym)}</strong>${heldBadge}${durBadge}
            <span style="font-size:9px;color:var(--text3);font-family:'JetBrains Mono',monospace;color:${confCol}">${confBar}</span>
          </div>
          <div style="font-size:10px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name} ${arName}</div>
          ${detail?`<div class="presignal-detail">${detail}</div>`:''}
          <div class="presignal-watch">${s.watch_for}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;padding-inline-start:4px">
          ${proxBadge}
          <span style="font-size:10px;font-weight:700;color:${sigCol}">${s.score}/${s.maxScore}</span>
          <button onclick="event.stopPropagation();setAlertFromPresignal('${s.sym}','${s.name}',${s.score},'${s.approaching}')" style="font-size:9px;padding:1px 5px;background:rgba(61,142,255,.1);color:var(--blue);border:1px solid rgba(61,142,255,.2);border-radius:4px;cursor:pointer">🔔</button>
        </div>
      </div>`;
    }

    // Group by category, render positive and negative columns separately
    const groups = {};
    for (const s of d.presignal) {
      if (!groups[s.approaching]) groups[s.approaching] = [];
      groups[s.approaching].push(s);
    }
    // Sort each group by proximity (fewest criteria away = first)
    Object.keys(groups).forEach(cat=>{
      groups[cat].sort((a,b)=>{
        const pa=cat==='BUY'?a.proximity?.pts_to_buy:cat==='SELL'?a.proximity?.pts_to_sell:null;
        const pb=cat==='BUY'?b.proximity?.pts_to_buy:cat==='SELL'?b.proximity?.pts_to_sell:null;
        if(pa!=null&&pb!=null) return pa-pb;
        return (b.score??0)-(a.score??0);
      });
    });

    function renderColumn(types) {
      return Object.keys(catMeta)
        .filter(cat => types.has(cat) && groups[cat]?.length)
        .map(cat => {
          const m = catMeta[cat];
          const header = `<div style="padding:4px 10px;font-size:9px;font-weight:700;color:${m.cls==='buy'||m.cls==='recovery'||m.cls==='accumulation'?'var(--green)':m.cls==='exit_risk'||m.cls==='sell'?'var(--red)':'var(--text3)'};border-bottom:1px solid var(--border);background:rgba(255,255,255,.01)">${m.label}</div>`;
          return header + groups[cat].map(buildRow).join('');
        }).join('') || `<div style="color:var(--text3);font-size:11px;padding:14px;text-align:center">None</div>`;
    }

    if (posEl) posEl.innerHTML = renderColumn(positiveTypes);
    if (negEl) negEl.innerHTML = renderColumn(negativeTypes);
    if (listEl) listEl.innerHTML = '';

  } catch(e) {
    const posEl = document.getElementById('presignal-positive');
    const negEl = document.getElementById('presignal-negative');
    const errMsg = `<div style="color:var(--text3);font-size:11px;padding:14px">Error: ${e.message}</div>`;
    if (posEl) posEl.innerHTML = errMsg;
    if (negEl) negEl.innerHTML = errMsg;
  }
}

function setAlertFromPresignal(sym, name, score, approaching) {
  // Navigate to Alerts tab and pre-fill a rule
  const tabBtn = document.querySelector('.tab[onclick*="criteria"]');
  if (tabBtn) { switchTab('criteria', tabBtn); }
  setTimeout(() => {
    const symEl  = document.getElementById('rule-sym');
    const nameEl = document.getElementById('rule-name');
    if (symEl)  symEl.value  = sym;
    if (nameEl) nameEl.value = `${name} — ${approaching === 'BUY' ? 'Score≥5 BUY' : approaching === 'EXIT_RISK' ? 'Score≤4 Exit' : approaching + ' watch'}`;
    symEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 200);
}

function updateMovers(){
  const el=document.getElementById('movers-panel');
  const listEl=document.getElementById('movers-list');
  if(!el||!listEl) return;
  const mkt=activeMarket==='all'?null:activeMarket;
  const relevant=mkt?deltaData.filter(d=>marketOf(d.sym)===mkt):deltaData;
  if(!relevant.length){el.style.display='none';return;}
  const imp=relevant.filter(d=>d.direction==='improved');
  const deg=relevant.filter(d=>d.direction==='degraded');
  const impBadge=document.getElementById('movers-imp-badge');
  const degBadge=document.getElementById('movers-deg-badge');
  if(impBadge){impBadge.textContent=imp.length+' '+t('moversImp');impBadge.style.display=imp.length?'':'none';}
  if(degBadge){degBadge.textContent=deg.length+' '+t('moversDeg');degBadge.style.display=deg.length?'':'none';}
  listEl.innerHTML=relevant.slice(0,10).map(d=>{
    const dir=d.direction==='improved';
    const sign=d.score_delta>0?'+':'';
    const summary=buildMoverSummary(d);
    return`<div class="mover-row" onclick="onRowClick(event,'${d.sym}')">
      <div class="mover-top">
        <span class="mover-dir ${dir?'imp':'deg'}">${dir?'▲':'▼'}</span>
        <div class="mover-id">
          <span class="mover-ticker">${tickerDisplay(d.sym)}</span>
          <span class="mover-name">${d.name||''}</span>
        </div>
        <span class="mover-biases">${biasBadgeHtml(d.prev_bias)}<span class="mover-arr">→</span>${biasBadgeHtml(d.curr_bias)}</span>
        <span class="mover-pts ${dir?'imp':'deg'}">${sign}${d.score_delta} pts</span>
      </div>
      ${summary?`<div class="mover-summary">${summary}</div>`:''}
    </div>`;
  }).join('');
  el.style.display='block';
}

async function createAlertFromDrawer(price, label){
  const sym=openDrawerData?.sym;
  if(!sym||price==null) return;
  const btn=event.currentTarget;
  btn.disabled=true; btn.textContent='...';
  try{
    const r=await fetch('/api/alert/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym,price:parseFloat(price),message:tickerDisplay(sym)+' '+label+' @ '+parseFloat(price).toFixed(2)})}).then(x=>x.json());
    btn.textContent=r.success?t('alertSet'):t('alertFail');
    btn.style.color=r.success?'var(--green)':'var(--red)';
    setTimeout(()=>{btn.textContent=t('setAlert');btn.disabled=false;btn.style.color='';},2000);
  }catch(e){btn.textContent=t('alertFail');setTimeout(()=>{btn.textContent=t('setAlert');btn.disabled=false;},2000);}
}