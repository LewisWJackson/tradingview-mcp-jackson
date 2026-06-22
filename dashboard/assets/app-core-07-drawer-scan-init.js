function openDrawer(r){
  openDrawerData=r;
  openTickerParam(r.sym);
  const ticker=tickerDisplay(r.sym);
  document.getElementById('d-ticker').textContent=ticker+' · '+sectorLabel(sectorOf(r.sym));
  document.getElementById('d-name').textContent=r.name;
  document.getElementById('d-price').textContent=r.price!=null?ccySign(r.sym)+' '+fmtPrice(r.price,r.sym):'—';
  document.getElementById('d-bias-badge').innerHTML=biasBadgeHtml(r.bias);
  // Discovery price badge — shows change since stock first appeared in Top Opportunities
  const discEl = document.getElementById('d-discovery');
  if (discEl) {
    const opp = (window._oppCache || []).find(o => o.sym === r.sym);
    if (opp && opp.discovery_price && r.price) {
      const dp = opp.discovery_price;
      const delta = ((r.price - dp) / dp * 100);
      const sign = delta >= 0 ? '+' : '';
      const cls = delta >= 0 ? 'up' : 'down';
      const daysAgo = opp.detected_at ? Math.round((Date.now() - new Date(opp.detected_at).getTime()) / 86400000) : null;
      const ageStr = daysAgo != null ? ` · ${daysAgo}d ago` : '';
      discEl.innerHTML = `<span class="discovery-badge" title="Price when first discovered in Top Opportunities">Discovered @ ${ccySign(r.sym)}${fmtPrice(dp, r.sym)}${ageStr} <span class="disc-delta ${cls}">${sign}${delta.toFixed(1)}%</span></span>`;
    } else {
      discEl.innerHTML = '';
    }
  }
  // Reset to Signal tab
  document.querySelectorAll('.drawer-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.drawer-tab-panel').forEach(p=>p.classList.remove('dtab-active'));
  const firstTab=document.querySelector('.drawer-tab');
  if(firstTab) firstTab.classList.add('active');
  document.getElementById('dtab-signal').classList.add('dtab-active');
  renderTVActions(r);
  // Clear chart loaded flag so it reloads for the new symbol
  const _prevChartWrap = document.getElementById('drawer-native-chart');
  if (_prevChartWrap) delete _prevChartWrap.dataset.chartLoaded;
  // Build all tabs
  buildSignalTab(r);
  buildTradeTab(r);
  buildAnalysisTab(r);
  buildFundamentalsTab(r);
  loadDrawerNews(r.sym, r.name);
  document.getElementById('detail-overlay').classList.add('open');
  document.getElementById('detail-drawer').classList.add('open');
  fetchCalendar(r.sym).then(ev=>{
    const el=document.getElementById('drawer-cal');
    if(el) el.innerHTML=calBadgeHtml(ev);
    renderTable();
  });
}
function closeDrawer(){ openDrawerData=null; clearTickerParam(); document.getElementById('detail-overlay').classList.remove('open'); document.getElementById('detail-drawer').classList.remove('open'); }

async function runValidate(sym){
  const el=document.getElementById('drawer-validate-result');
  if(!el) return;
  el.innerHTML='<div style="font-size:11px;color:var(--text3);padding:8px 0">Checking setup…</div>';
  try{
    const res=await fetch('/api/validate/'+encodeURIComponent(sym));
    const d=await res.json();
    if(!d.ok&&d.error){el.innerHTML=`<div style="font-size:11px;color:var(--red);padding:6px">${d.error}</div>`;return;}
    const vCol=d.verdict==='STRONG GO'?'var(--green)':d.verdict==='CAUTIOUS GO'?'var(--yellow)':d.verdict==='WAIT'?'var(--orange)':'#ff5252';
    const rows=d.checks.map(c=>`<div style="display:flex;align-items:flex-start;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">
      <span style="color:${c.pass?'var(--green)':'#ff5252'};font-size:12px;flex-shrink:0;margin-top:1px">${c.pass?'✓':'✗'}</span>
      <div><div style="font-size:11px;font-weight:600;color:var(--text)">${c.name}</div><div style="font-size:10px;color:var(--text2);line-height:1.4;margin-top:1px">${c.detail}</div></div>
    </div>`).join('');
    const velArrow=d.velocity?.direction==='rising'?'<span style="color:var(--green)">↗ Rising</span>':d.velocity?.direction==='falling'?'<span style="color:#ff5252">↘ Falling</span>':'<span style="color:var(--text3)">→ Stable</span>';
    el.innerHTML=`<div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-top:4px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:13px;font-weight:800;color:${vCol}">${d.verdict}</span>
        <span style="font-size:10px;color:var(--text3)">${d.confidence}% confidence · Momentum: ${velArrow}</span>
      </div>
      <div style="font-size:11px;color:var(--text2);margin-bottom:8px;line-height:1.5">${d.summary}</div>
      ${rows}
    </div>`;
  }catch(e){el.innerHTML=`<div style="font-size:11px;color:var(--red);padding:6px">Validate failed: ${e.message}</div>`;}
}

function buildDrawerBody(r){
  if(r.bias==='NO_DATA'||r.bias==='ERROR') return`<div class="crit-card fail"><div class="crit-card-header"><span class="crit-icon">✗</span><span class="crit-label">${t('bNoData')}</span></div><div class="crit-explain">${r.error||''}</div></div>`;
  const{ema13,ema34,ema89,ema200}=r.emas||{};
  const isBear=['STRONG SELL','SELL','AVOID'].includes(r.bias);
  const col=isBear?'#ff1744':scoreColor(r.score,r.maxScore||8);
  const pct=Math.round((r.score/(r.maxScore||8))*100);
  const verdict=(EXPL.verdicts[lang]||EXPL.verdicts.en)[r.bias];
  const verdictText=verdict?verdict(r.name):'';

  let crits;
  if(isBear){
    // ── Bearish criteria breakdown ──────────────────────────────────────────
    const stackBear=ema13<ema34&&ema34<ema89;
    const below200=r.price<ema200;
    const rsiWeak=r.rsi>22&&r.rsi<=48;
    const rsiOs=r.rsi<=22;
    const macdBear=r.macd_hist<0;
    const volOk=r.vol_ratio>=1.2;
    crits=[
      buildCrit(stackBear, t('lEmaStackBear')+' (2'+t('pts')+')',
        `EMA 13: <strong>${ema13?.toFixed(2)}</strong> | EMA 34: <strong>${ema34?.toFixed(2)}</strong> | EMA 89: <strong>${ema89?.toFixed(2)}</strong>`,
        stackBear ? EXPL.emaStackBear[lang].pass : EXPL.emaStackBear[lang].fail),
      buildCrit(below200, t('lEma200Bear')+' (2'+t('pts')+')',
        `${lang==='ar'?'السعر':'Price'}: <strong>${r.price?.toFixed(2)}</strong> | EMA 200: <strong>${ema200?.toFixed(2)}</strong>`,
        below200 ? EXPL.ema200Bear[lang].pass : EXPL.ema200Bear[lang].fail),
      buildCrit(rsiWeak&&!rsiOs, t('lRsiBear')+' (2'+t('pts')+')',
        `RSI(14): <strong>${r.rsi?.toFixed(1)}</strong>`,
        rsiOs ? EXPL.rsiOs[lang] : rsiWeak ? EXPL.rsiWeakBear[lang] : EXPL.rsiNotWeak[lang],
        rsiOs?'warn':null),
      buildCrit(macdBear, t('lMacd')+' (1'+t('pts')+')',
        `${lang==='ar'?'هيستوجرام':'Histogram'}: <strong>${r.macd_hist?.toFixed(4)}</strong>`,
        macdBear ? EXPL.macdBear[lang].pass : EXPL.macdBear[lang].fail),
      buildCrit(volOk, t('lVol')+' (1'+t('pts')+')',
        `${lang==='ar'?'الحجم':'Volume'}: <strong>${r.vol_ratio}×</strong>`,
        volOk ? EXPL.volBear[lang].pass : EXPL.volBear[lang].fail),
    ];
  } else {
    // ── Bullish criteria breakdown (existing) ───────────────────────────────
    const stack=ema13>ema34&&ema34>ema89;
    const above200=r.price>ema200;
    const rsiOk=r.rsi>=52&&r.rsi<78;
    const rsiOb=r.rsi>=78;
    const macdOk=r.macd_hist>0;
    const volOk=r.vol_ratio>=1.2;
    crits=[
      buildCrit(stack, t('lEmaStack')+' (2'+t('pts')+')',
        `EMA 13: <strong>${ema13?.toFixed(2)}</strong> | EMA 34: <strong>${ema34?.toFixed(2)}</strong> | EMA 89: <strong>${ema89?.toFixed(2)}</strong>`,
        stack ? EXPL.emaStack[lang].pass : EXPL.emaStack[lang].fail),
      buildCrit(above200, t('lEma200')+' (2'+t('pts')+')',
        `${lang==='ar'?'السعر':'Price'}: <strong>${r.price?.toFixed(2)}</strong> | EMA 200: <strong>${ema200?.toFixed(2)}</strong>`,
        above200 ? EXPL.ema200[lang].pass : EXPL.ema200[lang].fail),
      buildCrit(rsiOk&&!rsiOb, t('lRsi')+' (2'+t('pts')+')',
        `RSI(14): <strong>${r.rsi?.toFixed(1)}</strong>`,
        rsiOb ? EXPL.rsiOb[lang] : rsiOk ? EXPL.rsiOk[lang] : EXPL.rsiWeak[lang],
        rsiOb?'warn':null),
      buildCrit(macdOk, t('lMacd')+' (1'+t('pts')+')',
        `${lang==='ar'?'هيستوجرام':'Histogram'}: <strong>${r.macd_hist>0?'+':''}${r.macd_hist?.toFixed(4)}</strong>`,
        macdOk ? EXPL.macd[lang].pass : EXPL.macd[lang].fail),
      buildCrit(volOk, t('lVol')+' (1'+t('pts')+')',
        `${lang==='ar'?'الحجم':'Volume'}: <strong>${r.vol_ratio}×</strong> ${lang==='ar'?'(يلزم 1.2×)':'(need 1.2×)'}`,
        volOk ? EXPL.vol[lang].pass : EXPL.vol[lang].fail),
    ];
  }

  const shd=shariaMap[r.sym];
  const shCard=shd?`<div class="crit-section-title">${t('shariaTitle')}</div>
    <div class="crit-card ${'compliant'===shd.status?'pass':'non_compliant'===shd.status?'fail':'warn'}">
      <div class="crit-card-header">
        <span class="crit-icon">${'compliant'===shd.status?'✅':'non_compliant'===shd.status?'❌':'⚠️'}</span>
        <span class="crit-label">${t('shariaTitle')}</span>
        <span class="crit-value" style="color:${'compliant'===shd.status?'var(--green)':'non_compliant'===shd.status?'var(--red)':'var(--yellow)'}">${{'compliant':t('sHalal'),'non_compliant':t('sNonHalal'),'review':t('sReview')}[shd.status]||t('sUnknown')}</span>
      </div>
      <div class="crit-explain">${shd.basis}</div>
      <div class="crit-explain" style="margin-top:5px;font-size:11px;color:var(--text3)">${t('shariaDisc')}</div>
    </div>`:'';

  let actionHtml='';
  if(r.bias==='STRONG BUY'||r.bias==='BUY'){
    actionHtml=`<div class="entry-box"><div class="entry-box-title">${t('entryGuidanceTitle')}</div><p>${EXPL.entryGuide[lang](ema34?.toFixed(2),ema89?.toFixed(2))}</p></div>`;
  } else if(r.bias==='WATCH'){
    actionHtml=`<div class="entry-box"><div class="entry-box-title">${t('watchTitle')}</div><p>${EXPL.watchGuide[lang](r.warnings||[],ema34?.toFixed(2))}</p></div>`;
  } else if(r.bias==='STRONG SELL'||r.bias==='SELL'){
    actionHtml=`<div class="entry-box" style="background:rgba(255,23,68,.06);border-color:rgba(255,23,68,.25)"><div class="entry-box-title" style="color:#ff1744">${t('sellGuidanceTitle')}</div><p>${EXPL.sellGuide[lang](ema34?.toFixed(2),ema89?.toFixed(2))}</p></div>`;
  } else if(r.bias==='AVOID'){
    actionHtml=`<div class="entry-box" style="background:rgba(255,145,0,.06);border-color:rgba(255,145,0,.25)"><div class="entry-box-title" style="color:var(--orange)">${t('avoidTitle')}</div><p>${EXPL.avoidGuide[lang](r.warnings||[],ema34?.toFixed(2))}</p></div>`;
  }

  // ── ATR trade levels ─────────────────────────────────────────────────────
  let atrHtml='';
  if(r.atr!=null){
    const isBear=['STRONG SELL','SELL','AVOID'].includes(r.bias);
    const stop =isBear?r.price+1.5*r.atr:r.price-1.5*r.atr;
    const tgt1 =isBear?r.price-1.5*r.atr:r.price+1.5*r.atr;
    const tgt2 =isBear?r.price-3*r.atr   :r.price+3*r.atr;
    const fmt  =v=>v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const stopCol=isBear?'var(--green)':'#ff5252';
    const tgtCol =isBear?'#ff5252':'var(--green)';
    atrHtml=`<div class="crit-section-title">${t('atrTitle')} <span style="font-size:9px;font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0;margin-inline-start:4px">· volatility-based · see Signal tab for structure stop (EMA 89)</span></div>
    <div class="atr-panel">
      <div class="atr-row"><span class="atr-label">ATR(14) <span style="font-size:10px;color:var(--text3);font-weight:400">daily volatility unit</span></span><span class="atr-val" style="color:var(--text2)">${fmt(r.atr)}</span></div>
      <div class="atr-row"><span class="atr-label">${t('atrStop')} <span style="font-size:10px;color:var(--text3);font-weight:400">1.5× ATR</span></span><span class="atr-val" style="color:${stopCol}">${fmt(stop)}</span><button class="alert-btn" onclick="createAlertFromDrawer(${stop.toFixed(4)},'${t('atrStop')}')">${t('setAlert')}</button></div>
      <div class="atr-row"><span class="atr-label">${t('atrT1')} <span style="font-size:10px;color:var(--text3);font-weight:400">1.5× · 1:1 R:R · partial exit</span></span><span class="atr-val" style="color:${tgtCol}">${fmt(tgt1)}</span><button class="alert-btn" onclick="createAlertFromDrawer(${tgt1.toFixed(4)},'T1')">${t('setAlert')}</button></div>
      <div class="atr-row"><span class="atr-label">${t('atrT2')} <span style="font-size:10px;color:var(--text3);font-weight:400">3× · 2:1 R:R · main target</span></span><span class="atr-val" style="color:${tgtCol}">${fmt(tgt2)}</span><button class="alert-btn" onclick="createAlertFromDrawer(${tgt2.toFixed(4)},'T2')">${t('setAlert')}</button></div>
    </div>`;
  }

  // ── Relative Strength ────────────────────────────────────────────────────
  let rsCard='';
  if(r.rs_score!=null){
    const isLead=r.rs_score>2, isLag=r.rs_score<-2;
    const rsCol=isLead?'var(--green)':isLag?'#ff5252':'var(--yellow)';
    const rsLbl=isLead?t('rsLeader'):isLag?t('rsLaggard'):'Neutral';
    const sign=r.rs_score>0?'+':'';
    rsCard=`<div class="crit-section-title">${t('rsTitle')}</div>
    <div class="crit-card ${isLead?'pass':isLag?'fail':'warn'}">
      <div class="crit-card-header">
        <span class="crit-icon">${isLead?'📈':isLag?'📉':'➡️'}</span>
        <span class="crit-label">${t('rsTitle')} vs index</span>
        <span class="crit-value" style="color:${rsCol}">${sign}${r.rs_score.toFixed(1)}% — ${rsLbl}</span>
      </div>
      <div class="crit-explain">${isLead?`This stock has outperformed its market index by <strong>${sign}${r.rs_score.toFixed(1)}%</strong> over the past 20 sessions — a sign of relative institutional strength.`:isLag?`This stock has underperformed its market index by <strong>${r.rs_score.toFixed(1)}%</strong> over the past 20 sessions — money is rotating away from it.`:'Performing roughly in line with its market index over the past 20 sessions.'}</div>
    </div>`;
  }

  // ── Weekly alignment (invest mode) ──────────────────────────────────────
  let weeklyCard='';
  if(scanMode==='position'&&r.weekly){
    const{ema_stack,above200,score}=r.weekly;
    weeklyCard=`<div class="crit-section-title">${t('weeklyTitle')}</div>
    <div class="crit-card ${score===4?'pass':score===0?'fail':'warn'}">
      <div class="crit-card-header">
        <span class="crit-icon">${score===4?'✅':score===0?'❌':'⚠️'}</span>
        <span class="crit-label">${t('weeklyTitle')}</span>
        <span class="crit-value" style="color:${score===4?'var(--green)':score===0?'var(--red)':'var(--yellow)'}">${weeklyBadgeHtml(r)}</span>
      </div>
      <div class="crit-nums">${t('wEmaStack')}: ${ema_stack?'✓':'✗'} | ${t('wAbove200')}: ${above200===null?'N/A':above200?'✓':'✗'}</div>
      <div class="crit-explain">${score===4?'Weekly timeframe fully aligned — higher conviction for longer holds.':score===0?'Weekly trend is against the daily signal — consider shorter holding period or wait for weekly alignment.':'Partially aligned on weekly — monitor for full confirmation before sizing up.'}</div>
    </div>`;
  }

  return`
    <div class="drawer-score-row">
      <div class="drawer-score-num" style="color:${col}">${r.score}<span style="font-size:16px;color:var(--text3)">/${r.maxScore||8}</span></div>
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:11px;color:var(--text2)">${biasBadgeHtml(r.bias)}</div>
          ${r.conviction_score!=null?`<span style="font-size:10px;color:var(--text3)" title="Conviction score: multi-factor blend of technical (40%), smart money (20%), RS (20%), OBV (10%), regime (10%) + pattern bonus. Higher = more confirming evidence across all dimensions.">⬦ ${r.conviction_score} conviction</span>`:''}
        </div>
        <div class="drawer-score-bar-track"><div class="drawer-score-bar-fill" style="width:${pct}%;background:${col}"></div></div>
        <div class="drawer-verdict">${verdictText}</div>
      </div>
    </div>
    ${(r.patterns||[]).length?`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${(r.patterns||[]).map(p=>{const pc=p.bullish?'#00e5aa':'#ff5252';return`<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:${pc}15;color:${pc};border:1px solid ${pc}33" title="${p.desc}">⬦ ${p.name}</span>`;}).join('')}</div>`:''}
    ${(r.style_tags||[]).length?`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${(r.style_tags||[]).map(s=>{const sc={'Momentum':'#5ba3ff','Trend':'#00e676','Breakout':'#ffd740','Recovery':'#3d8bff','Pullback':'#33d1e5'}[s]||'var(--text3)';return`<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${sc}22;color:${sc};border:1px solid ${sc}44">${s}</span>`;}).join('')}</div>`:''}

    <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
      <button class="btn btn-secondary" style="font-size:11px;padding:4px 10px;flex:1" onclick="runValidate('${r.sym}')">✓ Validate Setup</button>
    </div>
    <div id="drawer-validate-result" style="margin-top:6px"></div>
    <div style="margin-top:4px">
      <div id="drawer-live-price" class="live-price-row">
        <span style="font-size:11px;color:var(--text2)">Scan: <strong>${r.price?.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})||'—'}</strong></span>
        <button class="live-refresh-btn" onclick="refreshLivePrice('${r.sym}')">${t('posLivePrice')}</button>
      </div>
    </div>
    ${shCard}
    ${rsCard}
    ${weeklyCard}
    <div class="crit-section-title">${t('critBreakdown')}</div>
    ${crits.join('')}
    ${actionHtml}
    ${atrHtml}
    <div class="crit-section-title">${t('btTitle')}</div>
    <div id="drawer-bt">
      <button class="btn btn-secondary" style="width:100%;font-size:11px" onclick="runBacktestInDrawer('${r.sym}')">${t('btRun')}</button>
    </div>
    <div class="fund-section-title">${t('fundTitle')}</div>
    <div id="d-fund-section"><div class="fund-loading">${t('fundLoading')}</div></div>`;
}

// Renders a "how close to flipping" bar below a failing criterion
function buildProximityBar(key, pass, r) {
  if (pass) return ''; // only show for failing criteria
  const p = r.proximity;
  if (!p) return '';
  const isBear = ['STRONG SELL','SELL','AVOID'].includes(r.bias);

  let pct = 0, label = '', approaching = false;

  switch(key) {
    case 'emaStack': {
      // gap between EMA13 and EMA34 in %; closer to 0 = near crossover
      const gap = p.emaStack ?? 0;
      const threshold = 3; // ±3% is "approaching"
      approaching = !isBear ? (gap > -threshold && gap < 0) : (gap < threshold && gap > 0);
      pct = Math.max(0, Math.min(100, 50 + (gap / threshold * 50)));
      label = gap > 0
        ? `EMA 13 is ${Math.abs(gap).toFixed(1)}% above EMA 34 — bullish stack forming`
        : `EMA 13 is ${Math.abs(gap).toFixed(1)}% below EMA 34 — ${Math.abs(gap)<1?'very close to crossover':'gap narrowing helps'}`;
      break;
    }
    case 'ema200': {
      const pctFromEma = p.ema200 ?? 0;
      const threshold = 5;
      approaching = !isBear ? (pctFromEma > -threshold && pctFromEma < 0) : (pctFromEma < threshold && pctFromEma > 0);
      pct = Math.max(0, Math.min(100, 50 + (pctFromEma / threshold * 50)));
      label = pctFromEma > 0
        ? `Price is ${pctFromEma.toFixed(1)}% above EMA 200 — criterion already met`
        : `Price is ${Math.abs(pctFromEma).toFixed(1)}% below EMA 200${approaching?' — within striking distance':''}`;
      break;
    }
    case 'rsi': {
      const rsiVal = r.rsi ?? 50;
      if (!isBear) {
        // Bullish: needs RSI ≥ 52
        approaching = rsiVal >= 44 && rsiVal < 52;
        pct = Math.max(0, Math.min(100, (rsiVal / 78) * 100));
        label = `RSI at ${rsiVal.toFixed(1)} — needs ${Math.max(0,(52-rsiVal)).toFixed(1)} more pts to enter momentum zone (52–78)`;
      } else {
        // Bearish: needs RSI ≤ 48
        approaching = rsiVal > 48 && rsiVal <= 56;
        pct = Math.max(0, Math.min(100, 100 - ((rsiVal - 22) / 56 * 100)));
        label = `RSI at ${rsiVal.toFixed(1)} — needs to fall ${Math.max(0,(rsiVal-48)).toFixed(1)} pts to enter weak zone (22–48)`;
      }
      break;
    }
    case 'macd': {
      const hist = p.macd ?? 0;
      approaching = Math.abs(hist) < 0.005;
      pct = approaching ? 80 : Math.abs(hist) < 0.02 ? 60 : Math.abs(hist) < 0.05 ? 35 : 15;
      const direction = !isBear ? 'positive' : 'negative';
      label = approaching
        ? `MACD histogram at ${hist.toFixed(4)} — very close to ${direction} crossover`
        : `MACD histogram at ${hist.toFixed(4)} — needs to turn ${direction}`;
      break;
    }
    default: return '';
  }

  if (!approaching && pct < 40) return ''; // too far away — don't clutter
  const col = approaching ? 'var(--yellow)' : 'var(--text3)';
  return `<div class="prox-bar-wrap">
    <div class="prox-bar-track"><div class="prox-bar-fill" style="width:${pct}%;background:${col}"></div></div>
    <div class="prox-label"><span>${label}</span>${approaching?`<span class="prox-approaching prox-app-near">⚡ Approaching</span>`:''}</div>
  </div>`;
}

function buildCrit(pass,label,valueHtml,explain,override=null,proximityHtml=''){
  const cls=override||(pass?'pass':'fail');
  const icon=cls==='pass'?'✅':cls==='warn'?'⚠️':'❌';
  const passLabel=pass?t('pass'):t('fail');
  const passColor=cls==='pass'?'var(--green)':cls==='warn'?'var(--yellow)':'var(--red)';
  return`<div class="crit-card ${cls}">
    <div class="crit-card-header">
      <span class="crit-icon">${icon}</span>
      <span class="crit-label">${label}</span>
      <span class="crit-value" style="color:${passColor}">${passLabel}</span>
    </div>
    <div class="crit-nums">${valueHtml}</div>
    <div class="crit-explain">${explain}</div>
    ${proximityHtml}
  </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Scoring rules grid
// ────────────────────────────────────────────────────────────────────────────
function renderScoringRules(){
  const rules=[
    {label:'EMA '+t('lEmaStack').split(' ')[0], pts:'2', descKey:'srEmaStack'},
    {label:'EMA 200', pts:'2', descKey:'srEma200'},
    {label:'RSI 52–78', pts:'2', descKey:'srRsi'},
    {label:'MACD Hist', pts:'1', descKey:'srMacd'},
    {label:t('lVol'), pts:'1', descKey:'srVol'},
  ];
  const rulesHtml=rules.map(r=>`
    <div class="scoring-rule">
      <div class="sr-label">${r.label}</div>
      <div class="sr-pts">${r.pts} ${t('pts')}</div>
      <div class="sr-desc">${t(r.descKey)}</div>
    </div>`).join('');
  // Render into both possible containers (Settings tab uses -settings suffix)
  const g1=document.getElementById('scoring-rules-grid'); if(g1) g1.innerHTML=rulesHtml;
  const g2=document.getElementById('scoring-rules-grid-settings'); if(g2) g2.innerHTML=rulesHtml;
  document.querySelectorAll('.scoring-card-header h3').forEach(el=>{ if(el.dataset.i18n==='scoringTitle'||el.textContent.includes('scored')) el.textContent=t('scoringTitle'); });
  document.querySelector('.scoring-card-header span').textContent=t('scoringSubtitle');
}

// ────────────────────────────────────────────────────────────────────────────
// Criteria editor
// ────────────────────────────────────────────────────────────────────────────
async function loadCriteriaEditor(){
  const grid=document.getElementById('criteria-grid');
  grid.innerHTML=`<div style="padding:20px;color:var(--text3);font-size:12px">${t('loading')}</div>`;
  try{
    const res=await fetch('/api/rules');
    rulesData=await res.json();
    renderCriteriaEditor();
  }catch(e){ grid.innerHTML=`<div style="padding:20px;color:var(--red);font-size:12px">${e.message}</div>`; }
}

function renderCriteriaEditor(){
  if(!rulesData) return;
  const bc=rulesData.bias_criteria||{};
  const rr=rulesData.risk_rules||[];
  document.getElementById('criteria-grid').innerHTML=[
    renderCriteriaCard('bullish',t('crBullish'),bc.bullish||[],'bias_criteria.bullish'),
    renderCriteriaCard('bearish',t('crBearish'),bc.bearish||[],'bias_criteria.bearish'),
    renderCriteriaCard('neutral',t('crNeutral'),bc.neutral||[],'bias_criteria.neutral'),
    renderCriteriaCard('risk',   t('crRisk'),   rr,            'risk_rules'),
  ].join('');
  document.querySelectorAll('.criteria-text').forEach(ta=>{
    ta.addEventListener('input',()=>markDirty(ta.closest('[data-section]').dataset.section));
    ta.style.height=ta.scrollHeight+'px';
    ta.addEventListener('input',function(){ this.style.height='auto'; this.style.height=this.scrollHeight+'px'; });
  });
}

function renderCriteriaCard(id,title,items,section){
  const itemsHtml=items.map((item,i)=>`
    <div class="criteria-item"><textarea class="criteria-text" rows="1" data-index="${i}">${escHtml(item)}</textarea>
    <button class="criteria-del" onclick="removeCriterion('${section}',${i})">✕</button></div>`).join('');
  return`<div class="criteria-card" data-section="${section}">
    <div class="criteria-card-header"><h3>${title}</h3><span id="save-notice-${id}" class="save-notice">${t('unsaved')}</span></div>
    <div class="criteria-body" id="crit-body-${id}">${itemsHtml}
      <div class="add-criteria-row">
        <input type="text" class="add-criteria-input" id="add-input-${id}" placeholder="${t('addPlaceholder')}" onkeydown="if(event.key==='Enter'){addCriterion('${section}','${id}');event.preventDefault();}">
        <button class="btn btn-secondary" style="font-size:11px;padding:5px 10px" onclick="addCriterion('${section}','${id}')">${t('addBtn')}</button>
      </div>
    </div>
    <div class="criteria-save-bar">
      <span style="font-size:11px;color:var(--text3)">${t('editHint')}</span>
      <button class="btn btn-primary" style="margin-inline-start:auto;font-size:11px;padding:5px 12px" onclick="saveSection('${section}','${id}')">${t('saveBtn')}</button>
    </div>
  </div>`;
}

function escHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function markDirty(section){ const el=document.getElementById('save-notice-'+sectionToId(section)); if(el){el.textContent=t('unsaved');el.classList.add('visible');} }
function sectionToId(s){ const m={'bias_criteria.bullish':'bullish','bias_criteria.bearish':'bearish','bias_criteria.neutral':'neutral','risk_rules':'risk'}; return m[s]||s; }
function getItemsFromCard(section){ const card=document.querySelector(`[data-section="${section}"]`); if(!card)return[]; return[...card.querySelectorAll('.criteria-text')].map(ta=>ta.value.trim()).filter(Boolean); }
function updateSection(section,items){ if(!rulesData)return; if(section==='risk_rules'){rulesData.risk_rules=items;return;} const key=section.replace('bias_criteria.',''); if(!rulesData.bias_criteria)rulesData.bias_criteria={}; rulesData.bias_criteria[key]=items; }
function addCriterion(section,id){ const inp=document.getElementById('add-input-'+id); const val=inp.value.trim(); if(!val)return; const items=getItemsFromCard(section); items.push(val); updateSection(section,items); inp.value=''; renderCriteriaEditor(); markDirty(section); }
function removeCriterion(section,idx){ const items=getItemsFromCard(section); items.splice(idx,1); updateSection(section,items); renderCriteriaEditor(); markDirty(section); }

async function saveSection(section,id){
  const items=getItemsFromCard(section); updateSection(section,items);
  try{
    const res=await fetch('/api/rules',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({bias_criteria:rulesData.bias_criteria,risk_rules:rulesData.risk_rules})});
    const r=await res.json();
    if(r.ok){ const el=document.getElementById('save-notice-'+id); if(el){el.textContent=t('saved');el.style.color='var(--green)';setTimeout(()=>{el.classList.remove('visible');el.style.color='';},2000);} }
    else alert(r.error||'Save failed');
  }catch(e){ alert(e.message); }
}

// ────────────────────────────────────────────────────────────────────────────
// Fundamentals
// ────────────────────────────────────────────────────────────────────────────
function fmtNum(v,dec=2){ return v!=null?v.toFixed(dec):t('fundNone'); }
function fmtPct(v){ return v!=null?v.toFixed(1)+'%':t('fundNone'); }
function fmtBig(v){
  if(v==null) return t('fundNone');
  if(Math.abs(v)>=1e12) return (v/1e12).toFixed(2)+'T';
  if(Math.abs(v)>=1e9)  return (v/1e9).toFixed(2)+'B';
  if(Math.abs(v)>=1e6)  return (v/1e6).toFixed(2)+'M';
  return v.toLocaleString();
}
function metricColor(val,goodThresh,badThresh,higherIsBetter){
  if(val==null) return'fv-dim';
  if(higherIsBetter) return val>=goodThresh?'fv-green':val>=badThresh?'fv-yellow':'fv-red';
  return val<=goodThresh?'fv-green':val<=badThresh?'fv-yellow':'fv-red';
}
function fundRow(label,valHtml){ return`<div class="fund-row"><span class="fund-row-label">${label}</span><span class="fund-row-val">${valHtml}</span></div>`; }

function buildFundamentalsSection(f,scoreObj){
  const sc=scoreObj||{};
  const sig=sc.signal||'N/A';
  const score=sc.score;
  const sigCls=sig==='UNDERVALUED'?'fund-undervalued':sig==='FAIR VALUE'?'fund-fair':'fund-overvalued';
  const sigLabel=sig==='UNDERVALUED'?t('sigUndervalued'):sig==='FAIR VALUE'?t('sigFair'):sig==='OVERVALUED'?t('sigOvervalued'):t('na');
  const scoreCol=score>=70?'var(--green)':score>=45?'var(--yellow)':'var(--red)';

  // Signal row
  const signalHtml=`<div class="fund-signal-row">
    <div>
      <div class="fund-score-num" style="color:${scoreCol}">${score!=null?score:'—'}</div>
      <div style="font-size:11px;color:var(--text2);margin-top:2px">${t('fundScore')}</div>
      <div class="fund-score-bar-track" style="min-width:80px">
        <div class="fund-score-bar-fill" style="width:${score||0}%;background:${scoreCol}"></div>
      </div>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;align-items:flex-end;gap:6px">
      <span class="fund-signal-badge ${sigCls}">${sigLabel}</span>
      ${f.marketCap?`<span style="font-size:11px;color:var(--text3)">${t('lMarketCap')}: <strong style="color:var(--text)">${fmtBig(f.marketCap)} ${f.currency||'SAR'}</strong></span>`:''}
    </div>
  </div>`;

  // Valuation panel
  const valRows=[
    fundRow(t('lPE'),    `<span class="${metricColor(f.peTrailing,12,20,false)}">${fmtNum(f.peTrailing,1)}</span>`),
    fundRow(t('lFPE'),   `<span class="${metricColor(f.peForward,10,18,false)}">${fmtNum(f.peForward,1)}</span>`),
    fundRow(t('lPB'),    `<span class="${metricColor(f.pb,1.5,3,false)}">${fmtNum(f.pb,2)}</span>`),
    fundRow(t('lEVEbitda'),`<span class="${metricColor(f.evEbitda,8,15,false)}">${fmtNum(f.evEbitda,1)}</span>`),
    fundRow('EPS',       `<span class="fv-dim">${fmtNum(f.eps,2)}</span>`),
    fundRow('EPS (Fwd)', `<span class="fv-dim">${fmtNum(f.epsForward,2)}</span>`),
  ].join('');

  // Dividends panel
  const divRows=[
    fundRow(t('lDivYield'),   `<span class="${metricColor(f.divYield,5,2,true)}">${fmtPct(f.divYield)}</span>`),
    fundRow(t('lDivRate'),    `<span class="fv-dim">${f.divRate!=null?f.divRate.toFixed(2)+' '+(f.currency||'SAR'):t('fundNone')}</span>`),
    fundRow(t('lPayoutRatio'),`<span class="${metricColor(f.payoutRatio,60,85,false)}">${fmtPct(f.payoutRatio)}</span>`),
    ...(f.exDivDate?[fundRow(t('lExDiv'),`<span class="fv-dim">${f.exDivDate}</span>`)]:[]),
  ].join('');

  // Profitability panel
  const profRows=[
    fundRow(t('lROE'),        `<span class="${metricColor(f.roe,15,10,true)}">${fmtPct(f.roe)}</span>`),
    fundRow(t('lNetMargin'),  `<span class="${metricColor(f.netMargin,15,8,true)}">${fmtPct(f.netMargin)}</span>`),
    fundRow(t('lOpMargin'),   `<span class="${metricColor(f.opMargin,20,12,true)}">${fmtPct(f.opMargin)}</span>`),
    fundRow(t('lEbitdaMargin'),`<span class="fv-dim">${fmtPct(f.ebitdaMargin)}</span>`),
  ].join('');

  // Health panel
  const healthRows=[
    fundRow(t('lDE'),         `<span class="${metricColor(f.debtToEquity,50,150,false)}">${f.debtToEquity!=null?f.debtToEquity.toFixed(1):t('fundNone')}</span>`),
    fundRow(t('lCurrentRatio'),`<span class="${metricColor(f.currentRatio,2,1,true)}">${fmtNum(f.currentRatio,2)}</span>`),
    fundRow(t('lFreeCF'),     `<span class="fv-dim">${fmtBig(f.freeCashflow)}</span>`),
    fundRow(t('lBeta'),       `<span class="fv-dim">${fmtNum(f.beta,2)}</span>`),
    ...(f.insiderPct!=null?[fundRow(t('lInsider'),`<span class="fv-dim">${fmtPct(f.insiderPct)}</span>`)]:[]),
    ...(f.institutionPct!=null?[fundRow(t('lInstitution'),`<span class="fv-dim">${fmtPct(f.institutionPct)}</span>`)]:[]),
  ].join('');

  // 52-week range bar
  let rangeHtml='';
  if(f.high52w!=null&&f.low52w!=null&&f.price!=null){
    const range=f.high52w-f.low52w;
    const pos=range>0?Math.max(0,Math.min(100,((f.price-f.low52w)/range)*100)):50;
    rangeHtml=`<div class="fund-52w-wrap">
      <div class="fund-section-title" style="margin-bottom:8px">${t('s52w')}</div>
      <div class="fund-52w-header">
        <span>${fmtNum(f.low52w,2)}</span>
        <span style="color:var(--text)">${fmtNum(f.price,2)} (${pos.toFixed(0)}%)</span>
        <span>${fmtNum(f.high52w,2)}</span>
      </div>
      <div class="fund-52w-track">
        <div class="fund-52w-fill" style="width:100%"></div>
        <div class="fund-52w-cursor" style="inset-inline-start:${pos}%"></div>
      </div>
      ${f.ma50!=null?`<div style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:var(--text3)"><span>MA50: <strong style="color:var(--text)">${fmtNum(f.ma50,2)}</strong></span><span>MA200: <strong style="color:var(--text)">${fmtNum(f.ma200,2)}</strong></span></div>`:''}
    </div>`;
  }

  return`${signalHtml}
    ${rangeHtml}
    <div class="fund-panel"><div class="fund-panel-header">${t('sValuation')}</div><div class="fund-rows">${valRows}</div></div>
    <div class="fund-panel"><div class="fund-panel-header">${t('sDividends')}</div><div class="fund-rows">${divRows}</div></div>
    <div class="fund-panel"><div class="fund-panel-header">${t('sProfitability')}</div><div class="fund-rows">${profRows}</div></div>
    <div class="fund-panel"><div class="fund-panel-header">${t('sHealth')}</div><div class="fund-rows">${healthRows}</div></div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// API / polling
// ────────────────────────────────────────────────────────────────────────────
async function startScan(){
  const btn=document.getElementById('btn-scan'); btn.disabled=true; btn.innerHTML='<span class="spin">⟳</span> Scanning…';
  const mkt=activeMarket==='all'?'tasi':activeMarket;
  await fetch('/api/scan/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({market:mkt,mode:scanMode})});
  startPolling();
}
async function startQuickScan(){
  if(!scanData.length){
    alert('Run a full scan first — Quick Scan only refreshes stocks from the previous scan.');
    return;
  }
  const btn=document.getElementById('btn-quick'); btn.disabled=true; btn.innerHTML='<span class="spin">⚡</span> Scanning…';
  const mkt=activeMarket==='all'?'tasi':activeMarket;
  const r=await fetch('/api/scan/quick',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({market:mkt})}).then(x=>x.json());
  if(!r.ok){ btn.disabled=false; btn.innerHTML='⚡ Quick'; alert(r.message||'Quick scan failed'); return; }
  // Show how many stocks are being re-scanned
  btn.innerHTML=`<span class="spin">⚡</span> ${r.scanning}/${r.full}`;
  startPolling();
}
function startPolling(){ if(pollTimer)return; pollTimer=setInterval(poll,2000); poll(); }

async function poll(){
  try{
    const[st,sr]=await Promise.all([fetch('/api/status').then(r=>r.json()),fetch('/api/scan/results').then(r=>r.json())]);
    document.getElementById('status-dot').className='status-dot '+(st.scan.running?'running':'ok');
    const prog=document.getElementById('scan-progress');
    if(st.scan.running){
      prog.style.display='block';
      const pct=st.scan.total>0?Math.round((st.scan.progress/st.scan.total)*100):0;
      document.getElementById('prog-fill').style.width=pct+'%';
      document.getElementById('scan-progress-text').textContent=t('scanning')+` ${st.scan.progress}/${st.scan.total} (${pct}%)`;
    } else prog.style.display='none';
    if(sr.results&&sr.results.length&&!archiveViewing){ scanData=sr.results; renderTable(); }
    if(sr.scanned_at){
      const d=new Date(sr.scanned_at);
      const ts=document.getElementById('last-run-text');
      if(ts) ts.textContent=t('lastScan')+' '+d.toLocaleString();
      document.getElementById('scan-time').textContent=t('lastScan')+' '+d.toLocaleTimeString();
      showFreshness(sr.scanned_at);
    }
    if(!st.scan.running){ const b=document.getElementById('btn-scan'); b.disabled=false; b.innerHTML='⟳ Full Scan'; const bq=document.getElementById('btn-quick'); if(bq){bq.disabled=false;bq.innerHTML='⚡ Quick';} const bs=document.getElementById('btn-scan-selected'); if(bs){bs.disabled=false;bs.innerHTML='⟳ '+t('scanSelected');} }
    if(!st.scan.running){
      clearInterval(pollTimer); pollTimer=null;
      try{
        const dl=await fetch('/api/scan/delta').then(r=>r.json()); deltaData=(dl?.delta)||[]; updateMovers();
        fetch('/api/score-history').then(r=>r.json()).then(h=>{scoreHistory=h;if(!archiveViewing)renderTable();}).catch(()=>{});
        saveArchiveSnapshot();
        checkPriceAlerts();
        batchFetchCalendars();
      }catch(_){}
    }
  }catch(_){}
}

// ────────────────────────────────────────────────────────────────────────────
// Init
// ────────────────────────────────────────────────────────────────────────────
async function init(){
  // Apply saved language first
  setLang(lang);
  initViewMode();
  renderScoringRules();
  renderSectorFilter();
  // Apply currency state immediately (before data loads)
  applyCurrencyUI();
  try{
    const[sr,sh,uv,dl,pos,cfg,vp,sh2]=await Promise.all([
      fetch('/api/scan/results').then(r=>r.json()),
      fetch('/api/sharia').then(r=>r.json()),
      fetch('/api/universe').then(r=>r.json()),
      fetch('/api/scan/delta').then(r=>r.json()),
      fetch('/api/positions').then(r=>r.json()),
      fetch('/api/settings').then(r=>r.json()).catch(()=>({})),
      fetch('/api/virtual').then(r=>r.json()).catch(()=>({})),
      fetch('/api/score-history').then(r=>r.json()).catch(()=>({})),
    ]);
    shariaMap=sh||{};
    universeData=uv||{};
    deltaData=(dl?.delta)||[];
    positionsData=pos||{};
    settingsData=cfg||{};
    virtualData=vp||{};
    scoreHistory=sh2||{};
    applyCurrencyUI();
    applyModeUI();
    connectSSE();
    // Initialize archive button if history exists
    if(Object.keys(localStorage).some(k=>k.startsWith(ARCHIVE_PFX))){ const btn=document.getElementById('archive-btn'); if(btn) btn.style.display=''; }
    renderArchiveDropdown();
    fetch('/api/live/status').then(r=>r.json()).then(s=>{ if(s.active){liveActive=true;liveIntervalVal=s.interval;updateLiveBtn();} }).catch(()=>{});
    loadAutoScanStatus();
    if(sr.results&&sr.results.length){
      scanData=sr.results; renderTable();
      if(sr.scanned_at){
        const d=new Date(sr.scanned_at);
        document.getElementById('scan-time').textContent=t('lastScan')+' '+d.toLocaleTimeString();
        const ts=document.getElementById('last-run-text'); if(ts) ts.textContent=t('lastScan')+' '+d.toLocaleString();
        showFreshness(sr.scanned_at);
      }
      setTimeout(batchFetchCalendars,500);
      // Open drawer if URL has ?ticker= param
      setTimeout(openFromUrl, 200);
    }
    document.getElementById('status-dot').className='status-dot ok';
  }catch(_){}
  try{ const st=await fetch('/api/status').then(r=>r.json()); if(st.scan.running)startPolling(); }catch(_){}
}
// Escape key closes drawer + any open popover
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if(openDrawerData) closeDrawer();
    document.getElementById('col-popover')?.classList.remove('open');
    document.getElementById('archive-dropdown-menu')?.classList.remove('open');
  }
});

// ── Auto-scan status pill ────────────────────────────────────────────────────
async function loadAutoScanStatus() {
  try {
    const s = await fetch('/api/auto-scan/status').then(r=>r.json());
    const pill = document.getElementById('auto-scan-pill');
    const txt  = document.getElementById('auto-scan-pill-text');
    if (!pill || !txt) return;

    // Only show pill on trading days (Sun=0…Thu=4)
    const nowKSA = new Date(Date.now() + 3 * 3600 * 1000);
    const day = nowKSA.getUTCDay();
    const hKSA = nowKSA.getUTCHours();
    const isTrading = day >= 0 && day <= 4;

    if (!isTrading) { pill.style.display = 'none'; return; }
    pill.style.display = 'inline-flex';

    const todayStr = nowKSA.toISOString().slice(0, 10);
    const done = s.log?.[todayStr] || [];
    const slotNames = ['morning', 'midday', 'afternoon'];

    if (s.next && s.next.msUntil != null) {
      const minUntil = Math.round(s.next.msUntil / 60000);
      const timeStr = `${String(s.next.h).padStart(2,'0')}:${String(s.next.m).padStart(2,'0')}`;
      pill.classList.remove('as-fired');
      txt.textContent = `Next auto-scan ${timeStr} KSA (${minUntil}m)`;
    } else if (done.length === slotNames.length) {
      pill.classList.add('as-fired');
      txt.textContent = `Auto-scans done ✓ (${done.length}/3 today)`;
    } else if (hKSA >= 16) {
      pill.classList.remove('as-fired');
      txt.textContent = `Market closed — ${done.length}/3 scans ran`;
    } else {
      pill.classList.remove('as-fired');
      txt.textContent = `Auto-scan: ${done.length}/3 today`;
    }
  } catch (_) {}
}

setInterval(loadAutoScanStatus, 60 * 1000); // refresh every minute