// ─── Dividend tracker ─────────────────────────────────────────────────────────
const divCache={};
async function fetchDividends(sym){
  if(divCache[sym]!==undefined) return divCache[sym];
  try{
    const d=await fetch('/api/dividends?sym='+encodeURIComponent(sym)).then(r=>r.json());
    divCache[sym]=d.dividends||[];
    return divCache[sym];
  }catch(_){divCache[sym]=[];return[];}
}

async function addDividendBadges(){
  const rows=document.querySelectorAll('#positions-body tr[data-pos-sym]');
  rows.forEach(async row=>{
    const sym=row.dataset.posSym;
    if(!sym) return;
    const divs=await fetchDividends(sym);
    if(!divs.length) return;
    const next=divs[0];
    const yield_pct=next.yield!=null?(next.yield*100).toFixed(1)+'%':null;
    const nameCell=row.querySelector('td:nth-child(2)');
    if(nameCell&&yield_pct&&!nameCell.querySelector('.div-badge')){
      nameCell.insertAdjacentHTML('beforeend',`<span class="div-badge" title="Dividend yield ${yield_pct}">💰 ${yield_pct}</span>`);
    }
  });
}

// ─── Industry Benchmarks (sector-average P/E, P/B, D/E) ──────────────────────
const SECTOR_BENCHMARKS = {
  banking:    { pe:10,  pb:1.2, de:3.5 }, energy:     { pe:12,  pb:1.5, de:0.6 },
  petrochem:  { pe:14,  pb:2.0, de:0.5 }, telecom:    { pe:18,  pb:2.5, de:1.2 },
  utility:    { pe:20,  pb:1.8, de:1.5 }, food:       { pe:22,  pb:2.5, de:0.4 },
  retail:     { pe:20,  pb:3.0, de:0.6 }, health:     { pe:25,  pb:3.5, de:0.3 },
  realestate: { pe:15,  pb:1.5, de:0.8 }, cement:     { pe:16,  pb:1.8, de:0.4 },
  industrial: { pe:18,  pb:2.0, de:0.5 }, insurance:  { pe:14,  pb:1.6, de:2.0 },
  tech:       { pe:28,  pb:5.0, de:0.3 }, financials: { pe:14,  pb:1.8, de:2.5 },
  consumer:   { pe:22,  pb:3.5, de:0.5 }, retailus:   { pe:24,  pb:4.0, de:0.7 },
  healthus:   { pe:22,  pb:4.0, de:0.4 }, energyus:   { pe:13,  pb:1.6, de:0.5 },
  etf_equity: { pe:22,  pb:3.5, de:null}, metal:      { pe:15,  pb:1.5, de:0.3 },
  crude:      { pe:12,  pb:1.4, de:0.5 }, other:      { pe:18,  pb:2.0, de:0.6 },
};

// ─── Global Markets Overview ──────────────────────────────────────────────────
async function loadMarketsPanel(force=false){
  const grid=document.getElementById('mkt-grid');
  const btn=document.getElementById('mkt-refresh-btn');
  if(btn){btn.disabled=true;btn.innerHTML='<span class="spin">⟳</span>';}
  if(grid&&!force) grid.innerHTML='<div class="mkt-loading"><span class="spin">⟳</span><span>'+t('mktLoading')+'</span></div>';
  try{
    const url='/api/markets/overview'+(force?'?force=1':'');
    const d=await fetch(url).then(r=>r.json());
    if(d.error){
      if(grid) grid.innerHTML=`<div style="color:var(--text3);font-size:12px;padding:16px">${d.error}</div>`;
    } else {
      renderMarketsPanel(d);
    }
  }catch(e){
    if(grid) grid.innerHTML=`<div style="color:var(--red);font-size:12px;padding:16px">${e.message}</div>`;
  }finally{
    if(btn){btn.disabled=false;btn.innerHTML=t('mktRefresh');}
  }
  // Load macro panel alongside market data
  loadMacroPanel(force);
  loadWhaleTab(force);
}

// ── Market helper (mirrors server logic) ──────────────────────────────────────
function marketFromSym(sym) {
  if (!sym) return 'us';
  if (sym.startsWith('TADAWUL:')) return 'tasi';
  if (sym.includes('USD') || sym.includes('BTC') || sym.includes('ETH')) return 'crypto';
  if (['TVC:','NYMEX:','COMEX:'].some(p => sym.startsWith(p))) return 'commodity';
  return 'us';
}
const MARKET_META = {
  tasi:      { flag: '🇸🇦', label: 'TASI', color: '#33d46a'   },
  us:        { flag: '🇺🇸', label: 'US Equity', color: '#5ba3ff' },
  crypto:    { flag: '₿',   label: 'Crypto', color: '#ffd740'  },
  commodity: { flag: '🥇',  label: 'Commodities', color: '#ffaa33' },
};

async function loadPlaybook() {
  const el = document.getElementById('playbook-panel');
  if (!el) return;
  try {
    const d = await fetch('/api/playbook').then(r => r.json());
    if (!d.ok && d.error) { el.innerHTML = `<div style="color:var(--text3);font-size:12px;padding:8px 0">${d.error}</div>`; return; }

    const moodCol  = d.market_mood === 'Good' ? 'var(--green)' : d.market_mood === 'Cautious' ? 'var(--yellow)' : '#ff5252';
    const regCol   = d.market_regime === 'bull' ? 'var(--green)' : d.market_regime === 'bear' ? '#ff5252' : 'var(--text2)';
    const riskCol  = d.risk_posture === 'Aggressive' ? 'var(--green)' : d.risk_posture === 'Defensive' ? '#ff5252' : 'var(--yellow)';

    const moodTip  = d.market_mood === 'Good'     ? 'More than 55% of scanned stocks have bullish signals — market conditions favor new entries.'
                   : d.market_mood === 'Cautious' ? '35–55% of stocks are bullish — mixed conditions. Be selective, size smaller.'
                   :                                'Below 35% bullish — market is weak. Avoid new longs, protect open positions.';
    const regTip   = d.market_regime === 'bull'   ? 'Dominant regime: Bullish — most stocks are above their trend lines. Favor long setups.'
                   : d.market_regime === 'bear'   ? 'Dominant regime: Bearish — most stocks are below their trend lines. Reduce exposure.'
                   :                                'Dominant regime: Neutral/Range — no clear directional edge. Trade smaller, tighter stops.';
    const riskTip  = d.risk_posture === 'Aggressive' ? 'Conditions support larger position sizes and more active trading — strong bull regime with high breadth.'
                   : d.risk_posture === 'Defensive'  ? 'Risk-off posture recommended — reduce position sizes, protect profits, and avoid new setups.'
                   :                                   'Mixed conditions — only the strongest trend-alignment scores (7+) stand out. Descriptive context, not a buy signal; the validated buy-list is the Momentum tab.';

    // Header strip
    const header = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <span style="font-size:13px;font-weight:800;color:${moodCol}" title="Market Mood::${moodTip}">${d.market_mood === 'Good' ? '🟢' : d.market_mood === 'Cautious' ? '🟡' : '🔴'} ${d.market_mood}</span>
      <span style="font-size:11px;color:${regCol};font-weight:700;padding:2px 8px;background:${regCol}18;border-radius:10px;border:1px solid ${regCol}33" title="Market Regime::${regTip}">${d.market_regime?.toUpperCase()}</span>
      <span style="font-size:11px;color:${riskCol};font-weight:700;padding:2px 8px;background:${riskCol}18;border-radius:10px;border:1px solid ${riskCol}33" title="Risk Posture::${riskTip}">⚖ ${d.risk_posture}</span>
      <span style="margin-inline-start:auto;font-size:10px;color:var(--text3)" title="Scan breadth — ${d.bull_pct}% of ${d.scanned} stocks are in buy territory (${d.buy_count} buys, ${d.sell_count} sells)">${d.bull_pct}% bullish · ${d.buy_count} buys · ${d.sell_count} sells · ${d.scanned} scanned</span>
    </div>`;

    // Top setups — grouped by market
    const setups = d.top_setups || [];
    let setupsHtml = '';
    if (setups.length) {
      // Group by market
      const byMkt = {};
      setups.forEach(s => {
        const mkt = marketFromSym(s.sym);
        if (!byMkt[mkt]) byMkt[mkt] = [];
        byMkt[mkt].push(s);
      });
      const mktOrder = ['tasi','us','crypto','commodity'];
      const mktSections = mktOrder.filter(m => byMkt[m]).map(mkt => {
        const meta = MARKET_META[mkt];
        const cards = byMkt[mkt].map(s => {
          const velArrow = s.velocity?.direction === 'rising'  ? '<span style="color:var(--green)" title="Score rising — momentum building">↗</span>'
                         : s.velocity?.direction === 'falling' ? '<span style="color:#ff5252" title="Score falling — setup weakening">↘</span>'
                         :                                       '<span style="color:var(--text3)" title="Score stable">→</span>';
          const biasCol = ['STRONG BUY','BUY'].includes(s.bias) ? 'var(--green)' : '#ff5252';
          const coilBadge = s.atr_pct_rank != null && s.atr_pct_rank <= 25
            ? `<div style="font-size:9px;color:var(--accent);margin-top:3px" title="Coiling::ATR in the bottom 25% of its range — volatility is compressed. Compressed volatility often precedes a sharp directional move. Watch for volume expansion as the trigger.">⬦ Coiling</div>`
            : '';
          return `<div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;padding:8px 10px;cursor:pointer;transition:border-color .15s" onmouseenter="this.style.borderColor='var(--border2)'" onmouseleave="this.style.borderColor='var(--border)'" onclick="openDrawerBySym('${s.sym}')" title="${s.name}::Score ${s.score}/${s.maxScore||9} · ${s.bias} · Click to open full analysis">
              <div style="display:flex;align-items:center;gap:4px;margin-bottom:3px">
                <span style="font-family:monospace;font-size:11px;font-weight:700;color:var(--accent)">${tickerDisplay(s.sym)}</span>
                ${velArrow}
                <span style="margin-inline-start:auto;font-size:10px;font-weight:700;color:${biasCol}">${s.score}/${s.maxScore||9}</span>
              </div>
              <div style="font-size:10px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</div>
              ${coilBadge}
            </div>`;
        }).join('');
        return `<div style="margin-bottom:10px">
          <div style="font-size:9px;font-weight:700;color:${meta.color};text-transform:uppercase;letter-spacing:.7px;margin-bottom:5px;display:flex;align-items:center;gap:4px">
            <span>${meta.flag}</span><span>${meta.label}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:6px">${cards}</div>
        </div>`;
      }).join('');
      setupsHtml = `<div style="margin-bottom:12px">
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px" title="Strongest Trends::Highest trend-alignment scores from the last scan (6+, rising/stable momentum), grouped by market. Descriptive trend state, NOT a buy list (lagged buy-and-hold in testing). Validated buy-list = Momentum tab. Click a card for the full analysis.">Strongest Trends</div>
        ${mktSections}
      </div>`;
    }

    // Position alerts (only if any flagged)
    const alertRows = (d.position_alerts || []).filter(a => a.action !== 'HOLD');
    const alertsHtml = alertRows.length
      ? `<div style="margin-bottom:12px">
          <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px" title="Position Alerts::Your open positions that are showing exit warning signals — 2+ criteria have turned negative. EXIT means act now; WATCH means prepare.">Position Alerts</div>
          ${alertRows.map(a => {
            const ac = a.action === 'EXIT' ? '#ff5252' : 'var(--yellow)';
            const tipMsg = a.action === 'EXIT'
              ? `${a.sym} — 2 or more exit criteria triggered. Consider closing or reducing this position.`
              : `${a.sym} — 1 warning signal. Monitor closely on the next scan.`;
            return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:${ac}0d;border:1px solid ${ac}33;border-radius:5px;margin-bottom:4px;font-size:11px;cursor:pointer" onclick="openDrawerBySym('${a.sym}')" title="${tipMsg}">
              <span style="font-weight:700;color:var(--text)">${tickerDisplay(a.sym)}</span>
              <span style="color:var(--text2)">${a.name}</span>
              ${(a.exitSignals||[]).length ? `<span style="font-size:9px;color:var(--text3)">${a.exitSignals[0]}</span>` : ''}
              <span style="margin-inline-start:auto;font-weight:800;color:${ac};font-size:10px">${a.action}</span>
            </div>`;
          }).join('')}
        </div>`
      : '';

    // Top sectors
    const topSectors = (d.sector_summary || []).slice(0, 6);
    const sectorsHtml = topSectors.length
      ? `<div>
          <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px" title="Sector Leaders::Which sectors have the highest proportion of bullish stocks. 60%+ = sector in strong uptrend. 40–60% = mixed. Below 40% = sector in decline.">Sector Leaders</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap">
            ${topSectors.map(s => {
              const c = s.bull_pct >= 60 ? 'var(--green)' : s.bull_pct >= 40 ? 'var(--yellow)' : '#ff5252';
              return `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${c}18;color:${c};border:1px solid ${c}33;cursor:default" title="${s.sector}::${s.bull_pct}% of stocks in this sector have a bullish signal right now (${s.total} stocks scanned).">${s.sector} ${s.bull_pct}%</span>`;
            }).join('')}
          </div>
        </div>`
      : '';

    const ts = d.scanned_at ? `<div style="font-size:10px;color:var(--text3);margin-top:10px">Last scan: ${new Date(d.scanned_at).toLocaleTimeString()}</div>` : '';
    el.innerHTML = `<div style="background:rgba(255,255,255,.018);border:1px solid var(--border);border-radius:8px;padding:12px 14px">${header}${setupsHtml}${alertsHtml}${sectorsHtml}${ts}</div>`;
  } catch(e) {
    el.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px 0">Error: ${e.message}</div>`;
  }
}

function openDrawerBySym(sym) {
  const r = scanData.find(x => x.sym === sym);
  if (r) openDrawer(r);
}

function renderMarketsPanel(d){
  const grid=document.getElementById('mkt-grid');
  const ts=document.getElementById('mkt-ts');
  if(ts&&d.ts){ const age=Math.round((Date.now()-d.ts)/60000); ts.textContent=d.cached?`Cached ${age}m ago`:'Just updated'; }
  if(!grid) return;
  const fmt=v=>v!=null?v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  grid.innerHTML=(d.data||[]).map(m=>{
    if(m.error) return`<div class="mkt-card"><div class="mkt-flag-label"><span class="mkt-flag">${m.flag}</span><span class="mkt-label">${m.label}</span></div><div class="mkt-err">${m.error}</div></div>`;
    const chgCol=m.change_pct>0?'var(--green)':m.change_pct<0?'#ff5252':'var(--text2)';
    const trendCls=m.trend==='bullish'?'regime-bull':m.trend==='bearish'?'regime-bear':'regime-range';
    const trendLbl=m.trend==='bullish'?t('mktBull'):m.trend==='bearish'?t('mktBear'):t('mktRange');
    const pos=m.pos52??50;
    return`<div class="mkt-card">
      <div class="mkt-flag-label"><span class="mkt-flag">${m.flag}</span><span class="mkt-label">${m.label}</span></div>
      <div class="mkt-price">${fmt(m.price)}</div>
      <div class="mkt-change" style="color:${chgCol}">${m.change_pct>0?'+':''}${m.change_pct}%</div>
      <span class="regime-trend ${trendCls}" style="font-size:10px;padding:2px 7px;margin-bottom:6px;display:inline-flex">${trendLbl}</span>
      <div class="mkt-metrics">
        <span>${t('mktRsi')}: <span class="mkt-metric-val" style="color:${m.rsi>=52?'var(--green)':m.rsi<=48?'#ff5252':'var(--yellow)'}">${m.rsi??'—'}</span></span>
        <span>${t('mkt20d')}: <span class="mkt-metric-val" style="color:${(m.perf20d??0)>=0?'var(--green)':'#ff5252'}">${m.perf20d!=null?(m.perf20d>=0?'+':'')+m.perf20d+'%':'—'}</span></span>
      </div>
      <div class="mkt-52w"><div class="mkt-52w-fill"></div><div class="mkt-52w-cur" style="inset-inline-start:${pos}%"></div></div>
    </div>`;
  }).join('');
}

// ── Opportunity signal definitions (mirrors server SIGNAL_DEFS) ──────────────
const OPP_DEFS = {
  STRONG_BUY_CONFIRMED:     { label:'Signal Confirmed',    icon:'✅', color:'#00c853', bg:'rgba(0,200,83,.13)',    tip:'Signal Confirmed::Score 7+ across all criteria — every major filter (trend, momentum, volume, weekly) is aligned. Strongest trend-alignment state in the screener — descriptive, not a buy signal (validated buy-list = Momentum tab).' },
  MTF_CONFLUENCE:           { label:'Multi-TF Confluence', icon:'🎯', color:'#16a34a', bg:'rgba(22,163,74,.13)',   tip:'Multi-TF Confluence::The same bullish signal is confirmed on both the daily and weekly timeframe. Two timeframes pointing the same direction = higher probability of follow-through.' },
  PRE_BREAKOUT_COIL:        { label:'Pre-Breakout Coil',   icon:'🌀', color:'#3d8bff', bg:'rgba(61,139,255,.13)', tip:'Pre-Breakout Coil::Volatility (ATR) is compressed into its bottom 25% — the stock is in a "coil." Compressed volatility historically precedes sharp moves. Score is rising and volume is starting to pick up.' },
  SMART_MONEY_ACCUMULATION: { label:'Smart Money',         icon:'🐳', color:'#0891b2', bg:'rgba(8,145,178,.13)',  tip:'Smart Money::Unusual institutional-scale activity detected — block deals, CMA filings, or insider buying — alongside a valid technical setup. The big money is moving before the price does.' },
  SCORE_TRAJECTORY:         { label:'Building Momentum',   icon:'📈', color:'#059669', bg:'rgba(5,150,105,.13)',  tip:'Building Momentum::Score has been rising for 2+ consecutive scans, projecting a potential buy signal in the next 1–2 scan cycles. Not a buy yet — a "pre-buy" alert to watch closely.' },
  STEALTH_RS_LEADER:        { label:'Stealth RS Leader',   icon:'⚡', color:'#d97706', bg:'rgba(217,119,6,.13)',  tip:'Stealth RS Leader::Relative Strength vs. the index is in the top 20% of the universe, but the technical score hasn\'t fully caught up yet. Strong RS stocks tend to extend — this setup often triggers a full signal on the next scan.' },
  DIVERGENCE_REVERSAL:      { label:'Divergence Reversal', icon:'↩',  color:'#dc2626', bg:'rgba(220,38,38,.13)', tip:'Divergence Reversal::Price made a lower low but RSI made a higher low (bullish divergence) — hidden buying pressure is building beneath the surface. Divergences often precede reversals by 2–5 bars.' },
  INSIDER_TECHNICAL_SYNC:   { label:'Insider + Setup',     icon:'🔍', color:'#3d8bff', bg:'rgba(61,139,255,.13)', tip:'Insider + Setup::A director or executive recently bought shares with their own money AND the technical setup is valid. When insiders buy alongside a strong chart, conviction is very high.' },
  VOLATILITY_EXPANSION:     { label:'Volatility Breakout', icon:'💥', color:'#ea580c', bg:'rgba(234,88,12,.13)', tip:'Volatility Breakout::ATR is expanding (volatility increasing) alongside a rising score and volume surge — a move is underway and picking up speed. Momentum-style entry, smaller stop required.' },
};

// renderOppCard removed Phase 4 — Top Opportunities UI cut Phase 1 (score-derived, no edge). OPP_DEFS kept (used by Strategy Validation).

// loadOpportunities / refreshOpportunities / renderOpportunities removed Phase 4 — Top Opportunities UI cut Phase 1, /api/opportunities routes removed.

// ── Strategy Validation ────────────────────────────────────────────────────────

let svData = null; // cached API response
let svActiveTab = 'tracks';

function svTab(name) {
  svActiveTab = name;
  ['tracks','closed','leaderboard','insights'].forEach(t => {
    document.getElementById(`sv-panel-${t}`).style.display = t === name ? '' : 'none';
    document.getElementById(`svt-${t}`)?.classList.toggle('active', t === name);
  });
  if (name === 'insights') svRenderInsights();
}

function svPnlClass(pnl, status) {
  if (status === 'hit_stop') return 'stopped';
  if (status === 'hit_t2')   return 'hit_t2';
  if (pnl == null)           return 'pending';
  return pnl >= 0 ? 'win' : 'loss';
}

function svMilestoneHtml(m, capital) {
  if (!m) return `<div class="sv-milestone pending"><div class="sv-milestone-label">—</div><div class="sv-milestone-val" style="color:var(--text3)">—</div></div>`;
  const cls  = svPnlClass(m.pnl_pct, m.status);
  const val  = m.pnl_pct != null ? `${m.pnl_pct >= 0 ? '+' : ''}${m.pnl_pct.toFixed(2)}%` : 'Pending';
  const sar  = m.pnl_sar != null ? `${m.pnl_sar >= 0 ? '+' : ''}${m.pnl_sar.toFixed(0)} SAR` : '';
  const icon = m.status === 'hit_stop' ? '🛑' : m.status === 'hit_t2' ? '🎯' : m.status === 'hit_t1' ? '✓' : '';
  return `<div class="sv-milestone ${cls}">
    <div class="sv-milestone-label">${m.checkpoint}</div>
    <div class="sv-milestone-val">${icon}${val}</div>
    ${sar ? `<div class="sv-milestone-sar">${sar}</div>` : ''}
  </div>`;
}

function svRenderTracks(tracks, panel, onlyOpen) {
  const filtered = tracks.filter(t => onlyOpen ? t.status === 'tracking' : t.status !== 'tracking');
  if (!filtered.length) {
    panel.innerHTML = onlyOpen
      ? '<div class="sv-empty">No open tracks. Click 📌 on any opportunity card to start tracking it with SAR 20,000.</div>'
      : '<div class="sv-empty">No closed trades yet.</div>';
    return;
  }
  const OPP = OPP_DEFS || {};
  panel.innerHTML = filtered.map(t => {
    const def = OPP[t.signal_type] || { label: t.signal_type, icon: '•', color: '#888' };
    const ms  = t.milestones || {};
    const daysHeld = Math.round((Date.now() - new Date(t.tracked_at).getTime()) / 86400000);
    const latestMs = ['6m','3m','1m','1w'].map(cp => ms[cp]).find(m => m?.pnl_pct != null);
    const livePnlPct = latestMs?.pnl_pct;
    const liveSar    = latestMs?.pnl_sar;
    const pnlCol = livePnlPct == null ? 'var(--text3)' : livePnlPct >= 0 ? '#00c853' : '#ff5252';

    const outcomeLabel = t.status !== 'tracking'
      ? `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;background:${t.status==='stopped'?'rgba(255,82,82,.15)':'rgba(0,200,83,.15)'};color:${t.status==='stopped'?'#ff5252':'#00c853'}">${t.status.toUpperCase()}</span>`
      : `<span style="font-size:10px;color:var(--text3)">${daysHeld}d held</span>`;

    // MAE/MFE visual excursion bar
    const mae = t.mae ?? 0, mfe = t.mfe ?? 0;
    const range = Math.max(10, Math.abs(mae) + mfe);
    const maeW  = Math.min(50, Math.abs(mae)/range*100);
    const mfeW  = Math.min(50, mfe/range*100);

    return `<div class="sv-track-card">
      <div class="sv-track-header">
        <span style="font-size:11px;font-weight:700;background:${def.color}22;color:${def.color};padding:2px 7px;border-radius:3px">${def.icon} ${def.label}</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:var(--accent)">${tickerDisplay(t.sym)}</span>
        <span style="font-size:11px;color:var(--text2)">${t.name||''}</span>
        ${t.conviction ? `<span style="font-size:10px;color:var(--text3)">conv ${t.conviction}</span>` : ''}
        ${outcomeLabel}
        ${livePnlPct != null ? `<span style="font-size:12px;font-weight:800;font-family:'JetBrains Mono',monospace;color:${pnlCol};margin-inline-start:auto">${livePnlPct>=0?'+':''}${livePnlPct.toFixed(2)}%</span>` : ''}
      </div>
      <div style="font-size:10px;color:var(--text3);margin-bottom:6px">
        Entry: ${t.entry_price?.toFixed(2)} SAR · ${t.shares?.toFixed(0)} shares · SAR ${(t.simulated_capital??20000).toLocaleString()} ·
        ${t.stop ? `Stop ${t.stop}` : ''}${t.target2 ? ` · T2 ${t.target2}` : ''}
        ${t.rsi ? ` · RSI ${t.rsi.toFixed(1)}` : ''}${t.mfi ? ` · MFI ${t.mfi}` : ''}${t.whale_score ? ` · Whale ${t.whale_score}/10` : ''}
      </div>
      <div class="sv-milestone-row">
        ${['1w','1m','3m','6m'].map(cp => svMilestoneHtml(ms[cp], t.simulated_capital)).join('')}
      </div>
      ${(mae || mfe) ? `<div class="sv-excursion-bar">
        <span style="color:#ff5252;width:32px;text-align:right;flex-shrink:0">↓${Math.abs(mae).toFixed(1)}%</span>
        <div class="sv-excursion-track">
          <div style="position:absolute;right:50%;width:${maeW}%;height:100%;background:rgba(255,82,82,.35);border-radius:3px 0 0 3px"></div>
          <div style="position:absolute;left:50%;width:${mfeW}%;height:100%;background:rgba(0,200,83,.35);border-radius:0 3px 3px 0"></div>
          <div style="position:absolute;left:50%;top:-2px;width:2px;height:10px;background:var(--text3)"></div>
        </div>
        <span style="color:#00c853;width:32px;flex-shrink:0">↑${mfe.toFixed(1)}%</span>
        <span style="font-size:9px;color:var(--text3)">MAE/MFE excursion</span>
      </div>` : ''}
      ${t.notes ? `<div style="font-size:11px;color:var(--text2);margin-top:6px;font-style:italic">"${t.notes}"</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:8px">
        <button onclick="svAddNote(${t.id})" style="font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);cursor:pointer">✏ Note</button>
        ${t.status === 'tracking' ? `<button onclick="svClose(${t.id})" style="font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid rgba(255,82,82,.3);background:rgba(255,82,82,.08);color:#ff8080;cursor:pointer">✕ Close</button>` : ''}
        <button onclick="svDelete(${t.id})" style="font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg2);color:var(--text3);cursor:pointer;margin-inline-start:auto">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function svRenderLeaderboard(tracks) {
  const panel = document.getElementById('sv-panel-leaderboard');
  if (!panel) return;
  const allMs = tracks.flatMap(t => Object.values(t.milestones || {}));
  const withM1 = tracks.filter(t => t.milestones?.['1m']?.pnl_pct != null)
    .map(t => ({ ...t, ret: t.milestones['1m'].pnl_pct, win: t.milestones['1m'].pnl_pct > 0 }));

  if (withM1.length < 2) {
    panel.innerHTML = `<div class="sv-empty">Need at least 2 completed 1-month trades for leaderboard. Keep tracking!</div>`;
    return;
  }

  const byType = {};
  withM1.forEach(t => { (byType[t.signal_type] = byType[t.signal_type]||[]).push(t); });
  const stats = Object.entries(byType).map(([type, ts]) => ({
    type, count: ts.length,
    winRate: Math.round(ts.filter(t=>t.win).length/ts.length*100),
    avgRet:  +(ts.reduce((s,t)=>s+t.ret,0)/ts.length).toFixed(2),
    totalSar: +ts.reduce((s,t)=>s+((t.simulated_capital??20000)*t.ret/100),0).toFixed(0),
  })).sort((a,b) => b.winRate - a.winRate);

  const maxWR = Math.max(...stats.map(s => s.winRate));
  const OPP = OPP_DEFS || {};
  panel.innerHTML = `
    <div style="font-size:10px;color:var(--text3);margin-bottom:8px">Based on ${withM1.length} trades with 1-month data</div>
    ${stats.map(s => {
      const def = OPP[s.type] || { icon: '•', color: '#888', label: s.type };
      const col = s.winRate >= 60 ? '#00c853' : s.winRate >= 45 ? '#ffd600' : '#ff5252';
      const barW = Math.round(s.winRate/maxWR*100);
      return `<div class="sv-leaderboard-row">
        <span style="font-size:13px;flex-shrink:0">${def.icon}</span>
        <span style="font-size:10px;font-weight:700;width:140px;flex-shrink:0;color:${def.color}">${def.label}</span>
        <div class="sv-bar-wrap"><div class="sv-bar-fill" style="width:${barW}%;background:${col}"></div></div>
        <span style="font-size:12px;font-weight:800;font-family:'JetBrains Mono',monospace;color:${col};width:38px;text-align:right">${s.winRate}%</span>
        <span style="font-size:10px;color:${s.avgRet>=0?'#00c853':'#ff5252'};width:52px;text-align:right">${s.avgRet>=0?'+':''}${s.avgRet}%</span>
        <span style="font-size:9px;color:var(--text3);width:36px;text-align:right">${s.count}×</span>
        <span style="font-size:10px;font-weight:700;color:${s.totalSar>=0?'#00c853':'#ff5252'};width:72px;text-align:right">${s.totalSar>=0?'+':''}${s.totalSar} SAR</span>
      </div>`;
    }).join('')}`;
}

async function svRenderInsights() {
  const panel = document.getElementById('sv-panel-insights');
  if (!panel) return;
  panel.innerHTML = '<div class="sv-empty"><span class="spin">⟳</span> Computing edge map…</div>';
  try {
    const ins = await fetch('/api/strategy-validation/insights').then(r => r.json());
    if (ins.insufficient) {
      panel.innerHTML = `<div class="sv-empty">Need ${ins.needed} completed trades with 1-month data to compute insights. Currently: ${ins.count}. Keep tracking!</div>`;
      return;
    }

    let html = '';

    // Decay alerts (most urgent)
    if (ins.decayAlerts?.length) {
      html += ins.decayAlerts.map(d => `<div class="sv-decay-alert">
        ⚠ <strong>Signal Decay Detected:</strong> ${d.type} — lifetime win rate ${d.lifetime}% dropped to ${d.recent}% in last 20 trades (-${d.drop}%). Consider reducing size on this signal.
      </div>`).join('');
    }

    // Overall stats
    html += `<div class="sv-insight-block">
      <div class="sv-insight-title">Overall Performance</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
        <div style="text-align:center"><div style="font-size:20px;font-weight:800;color:${ins.overallWinRate>=50?'#00c853':'#ff5252'}">${ins.overallWinRate}%</div><div style="font-size:10px;color:var(--text3)">Win Rate</div></div>
        <div style="text-align:center"><div style="font-size:20px;font-weight:800;color:${ins.overallAvgRet>=0?'#00c853':'#ff5252'}">${ins.overallAvgRet>=0?'+':''}${ins.overallAvgRet}%</div><div style="font-size:10px;color:var(--text3)">Avg Return</div></div>
        <div style="text-align:center"><div style="font-size:20px;font-weight:800;color:${ins.totalCapitalPnl>=0?'#00c853':'#ff5252'}">${ins.totalCapitalPnl>=0?'+':''}${ins.totalCapitalPnl?.toLocaleString()}</div><div style="font-size:10px;color:var(--text3)">Total P&L (SAR)</div></div>
      </div>
    </div>`;

    // RSI edge
    if (ins.rsiEdge?.length) {
      const best = ins.rsiEdge.filter(b => b.winRate != null).sort((a,b) => b.winRate - a.winRate)[0];
      html += `<div class="sv-insight-block">
        <div class="sv-insight-title">RSI Edge — Where Is Your Alpha?</div>
        ${best ? `<div style="font-size:11px;margin-bottom:8px;color:var(--text2)">💡 Your best RSI zone: <strong style="color:#00c853">${best.label}</strong> — ${best.winRate}% win rate (${best.count} trades)</div>` : ''}
        ${ins.rsiEdge.map(b => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:10px">
          <span style="width:45px;color:var(--text3)">${b.label}</span>
          <div style="flex:1;height:4px;background:var(--bg);border-radius:2px;overflow:hidden">
            <div style="width:${b.winRate??0}%;height:100%;background:${(b.winRate??0)>=60?'#00c853':(b.winRate??0)>=45?'#ffd600':'#ff5252'};border-radius:2px"></div>
          </div>
          <span style="width:28px;font-weight:700;color:${(b.winRate??0)>=60?'#00c853':(b.winRate??0)>=45?'#ffd600':'#ff5252'}">${b.winRate??'—'}%</span>
          <span style="color:var(--text3)">${b.count}×</span>
        </div>`).join('')}
      </div>`;
    }

    // Conviction calibration
    if (ins.convCalibration?.some(b => b.actual != null)) {
      html += `<div class="sv-insight-block">
        <div class="sv-insight-title">Conviction Calibration — Is Your Scoring Accurate?</div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:8px">Compare predicted conviction vs actual win rate. Well-calibrated = higher score → higher win rate.</div>
        ${ins.convCalibration.map(b => {
          if (b.actual == null) return '';
          const gap = b.actual - (b.min + (b.max - b.min) / 2);
          const status = Math.abs(gap) < 10 ? '✓ calibrated' : gap > 10 ? '⬆ underestimating' : '⬇ overestimating';
          return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:10px">
            <span style="width:45px;color:var(--text3)">${b.label}</span>
            <div style="flex:1;height:4px;background:var(--bg);border-radius:2px;overflow:hidden">
              <div style="width:${b.actual}%;height:100%;background:var(--accent);border-radius:2px"></div>
            </div>
            <span style="width:28px;font-weight:700;color:var(--accent)">${b.actual}%</span>
            <span style="color:var(--text3)">${b.count}× · ${status}</span>
          </div>`;
        }).join('')}
      </div>`;
    }

    // Time decay
    if (ins.timeReturn?.length) {
      html += `<div class="sv-insight-block">
        <div class="sv-insight-title">Optimal Hold Period — When Do Winners Peak?</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${ins.timeReturn.map(t => `<div style="text-align:center;padding:6px 10px;background:var(--bg);border-radius:6px">
            <div style="font-size:12px;font-weight:800;color:${(t.avg??0)>=0?'#00c853':'#ff5252'}">${(t.avg??0)>=0?'+':''}${t.avg}%</div>
            <div style="font-size:9px;color:var(--text3);text-transform:uppercase">${t.cp} (${t.count}×)</div>
          </div>`).join('')}
        </div>
      </div>`;
    }

    // Regime sensitivity
    if (ins.regimeStats?.length) {
      html += `<div class="sv-insight-block">
        <div class="sv-insight-title">Regime Sensitivity</div>
        ${ins.regimeStats.map(r => `<div style="display:flex;gap:8px;align-items:center;font-size:11px;margin-bottom:3px">
          <span style="width:60px;text-transform:capitalize;color:var(--text2)">${r.regime}</span>
          <span style="font-weight:700;color:${(r.winRate??0)>=55?'#00c853':(r.winRate??0)>=40?'#ffd600':'#ff5252'}">${r.winRate??'—'}% win</span>
          <span style="color:var(--text3)">${r.avgRet!=null?(r.avgRet>=0?'+':'')+r.avgRet+'%':''} · ${r.count}×</span>
        </div>`).join('')}
      </div>`;
    }

    panel.innerHTML = html || '<div class="sv-empty">No insights yet.</div>';
  } catch(e) {
    panel.innerHTML = `<div style="color:var(--red);font-size:11px;padding:8px">${e.message}</div>`;
  }
}

async function loadStrategyValidation() {
  const tracksPanel = document.getElementById('sv-panel-tracks');
  const closedPanel = document.getElementById('sv-panel-closed');
  const lbPanel     = document.getElementById('sv-panel-leaderboard');
  if (!tracksPanel) return;
  tracksPanel.innerHTML = '<div class="sv-empty"><span class="spin">⟳</span> Updating milestones…</div>';
  try {
    const d = await fetch('/api/strategy-validation').then(r => r.json());
    svData = d;
    svRenderTracks(d.tracks, tracksPanel, true);
    svRenderTracks(d.tracks, closedPanel, false);
    svRenderLeaderboard(d.tracks);
    if (svActiveTab === 'insights') svRenderInsights();
  } catch(e) {
    tracksPanel.innerHTML = `<div style="color:var(--red);font-size:11px">${e.message}</div>`;
  }
}

async function svTrackOpp(dataStr) {
  try {
    const data = JSON.parse(dataStr);
    if (!confirm(`📌 Track ${data.name || data.sym}?\n\nSimulating SAR 20,000 at ${data.entry_price?.toFixed(2)} SAR\nStop: ${data.stop || '—'} · Target2: ${data.target2 || '—'}\n\nMilestones checked at 1W, 1M, 3M, 6M.`)) return;
    const r = await fetch('/api/strategy-validation/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }).then(r => r.json());
    if (r.error) { alert(r.error); return; }
    // Switch to strategy validation tab
    await loadStrategyValidation();
    svTab('tracks');
    // Scroll to section
    document.getElementById('sv-root')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch(e) { alert(e.message); }
}

async function svAddNote(id) {
  const note = prompt('Add a note for this track:');
  if (!note) return;
  await fetch(`/api/strategy-validation/${id}/note`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
  });
  loadStrategyValidation();
}

async function svClose(id) {
  const reason = prompt('Close reason (e.g. "target hit manually", "thesis changed"):');
  if (!reason) return;
  const price = parseFloat(prompt('Exit price (SAR):') || '0') || null;
  await fetch(`/api/strategy-validation/${id}/close`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, exit_price: price }),
  });
  loadStrategyValidation();
}

async function svDelete(id) {
  if (!confirm('Remove this track? This cannot be undone.')) return;
  await fetch(`/api/strategy-validation/${id}`, { method: 'DELETE' });
  loadStrategyValidation();
}

// ─── Virtual Portfolio ────────────────────────────────────────────────────────
async function loadVirtualPanel(){
  try{ const r=await fetch('/api/virtual'); virtualData=await r.json(); }catch(_){}
  renderVirtual();
}

function renderVirtual(){
  const vp=virtualData;
  if(!vp) return;
  const positions=Object.values(vp.positions||{});
  const fmt=(v,sym)=>ccySign(sym)+' '+fmtPrice(v,sym);
  const fmtCash=v=>ccySign('TADAWUL:1')+' '+fmtPrice(v,'TADAWUL:1'); // cash is SAR-basis
  // Compute portfolio value
  let invested=0, marketVal=0;
  positions.forEach(pos=>{
    const scanRow=scanData.find(r=>r.sym===pos.sym);
    const curP=scanRow?.price||pos.avg_cost;
    invested+=pos.shares*pos.avg_cost;
    marketVal+=pos.shares*curP;
  });
  const totalValue=convertPrice(vp.cash,'TADAWUL:1')+(positions.length?convertPrice(marketVal,'TADAWUL:1'):0);
  const startVal=convertPrice(vp.balance_start,'TADAWUL:1');
  const pnl=totalValue-startVal;
  const ret=startVal?((pnl/startVal)*100):0;
  const pnlCol=pnl>=0?'var(--green)':'#ff5252';
  // Summary cards
  const cashEl=document.getElementById('vp-cash'); if(cashEl){cashEl.textContent=fmtCash(vp.cash);cashEl.style.color='var(--accent)';}
  const valEl=document.getElementById('vp-value'); if(valEl){valEl.textContent=fmtCash(vp.cash+marketVal);valEl.style.color='var(--text)';}
  const pnlEl=document.getElementById('vp-pnl'); if(pnlEl){pnlEl.textContent=(pnl>=0?'+':'')+fmtCash(pnl*SAR_USD*(currency==='SAR'?1:1/SAR_USD));pnlEl.style.color=pnlCol;}
  const retEl=document.getElementById('vp-return'); if(retEl){retEl.textContent=(ret>=0?'+':'')+ret.toFixed(2)+'%';retEl.style.color=pnlCol;}
  // Holdings
  const hbody=document.getElementById('vp-holdings');
  if(hbody){
    if(!positions.length){
      hbody.innerHTML=`<tr><td colspan="9" style="padding:24px;text-align:center;color:var(--text3);font-size:12px">${t('vpEmpty')}</td></tr>`;
    } else {
      hbody.innerHTML=positions.map(pos=>{
        const scanRow=scanData.find(r=>r.sym===pos.sym);
        const curP=scanRow?.price??null;
        const curDisp=curP!=null?fmtPrice(curP,pos.sym):'—';
        const posVal=curP!=null?pos.shares*curP:null;
        const posValDisp=posVal!=null?fmt(posVal,pos.sym):'—';
        const pnlV=curP!=null?((curP-pos.avg_cost)*pos.shares):null;
        const pnlPct=curP!=null?((curP-pos.avg_cost)/pos.avg_cost*100):null;
        const pnlCls=pnlV==null?'':pnlV>=0?'pos-pnl-pos':'pos-pnl-neg';
        const pnlStr=pnlV!=null?`${pnlV>=0?'+':''}${fmt(pnlV,pos.sym)}`:'—';
        const pctStr=pnlPct!=null?` <span style="font-size:10px;opacity:.7">(${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%)</span>`:'';
        return`<tr>
          <td class="td-ticker">${tickerDisplay(pos.sym)}</td>
          <td>${pos.name}</td>
          <td style="font-family:monospace">${pos.shares}</td>
          <td style="font-family:monospace">${fmt(pos.avg_cost,pos.sym)}</td>
          <td style="font-family:monospace">${curDisp}</td>
          <td style="font-family:monospace">${posValDisp}</td>
          <td class="${pnlCls}" style="font-family:monospace;font-weight:700">${pnlStr}${pctStr}</td>
          <td class="${pnlCls}">${pnlPct!=null?(pnlPct>=0?'+':'')+pnlPct.toFixed(2)+'%':'—'}</td>
          <td><button class="pos-del-btn" onclick="quickVirtualSell('${pos.sym}',${pos.shares},${curP||pos.avg_cost})" title="Sell all">✕</button></td>
        </tr>`;
      }).join('');
    }
  }
  // History
  const histry=document.getElementById('vp-history');
  if(histry){
    const trades=vp.trades||[];
    if(!trades.length){
      histry.innerHTML=`<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--text3);font-size:12px">${t('vpNoTrades')}</td></tr>`;
    } else {
      histry.innerHTML=trades.slice(0,30).map(tr=>{
        const badgeCls=tr.action==='buy'?'vp-buy-badge':'vp-sell-badge';
        const total=tr.shares*tr.price;
        return`<tr class="vp-trade-row">
          <td style="color:var(--text3)">${tr.date}</td>
          <td><span class="${badgeCls}">${tr.action}</span></td>
          <td class="td-ticker">${tickerDisplay(tr.sym)}</td>
          <td style="font-family:monospace">${tr.shares}</td>
          <td style="font-family:monospace">${fmtPrice(tr.price,tr.sym)}</td>
          <td style="font-family:monospace">${fmtPrice(total,tr.sym)}</td>
          <td style="font-family:monospace;color:var(--text2)">${fmtPrice(tr.cash_after,'TADAWUL:1')}</td>
        </tr>`;
      }).join('');
    }
  }
}

async function resetVirtual(){
  const bal=parseFloat(document.getElementById('vp-reset-bal')?.value||100000);
  if(!confirm(`Reset virtual portfolio to ${fmtPrice(bal,'TADAWUL:1')}?`)) return;
  try{
    const r=await fetch('/api/virtual/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({balance:bal})}).then(x=>x.json());
    if(r.ok){virtualData=r.virtual;renderVirtual();}
  }catch(e){alert(e.message);}
}

async function virtualBuyFromDrawer(){
  const r=openDrawerData; if(!r) return;
  const sharesEl=document.getElementById('vp-buy-shares');
  const shares=parseInt(sharesEl?.value||0);
  if(!shares||shares<1){sharesEl?.focus();return;}
  // Show trade checklist before proceeding
  showTradeChecklist(r, ()=>_executevirtualBuy(r,sharesEl,shares));
}
async function _executevirtualBuy(r,sharesEl,shares){
  const statusEl=document.getElementById('vp-trade-status');
  if(statusEl){statusEl.textContent='…';statusEl.style.color='var(--text3)';}
  try{
    const res=await fetch('/api/virtual/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym:r.sym,name:r.name,shares,price:r.price})}).then(x=>x.json());
    if(res.ok){
      virtualData=res.virtual;
      if(statusEl){statusEl.textContent=`✓ ${t('vpBuyOk')} ${shares} × ${fmtPrice(r.price,r.sym)}`;statusEl.style.color='var(--green)';}
      if(sharesEl) sharesEl.value='';
      renderVirtual();
      buildTradeTab(r); // refresh to show updated held shares
    } else {
      if(statusEl){statusEl.textContent=res.error||t('vpErrFunds');statusEl.style.color='var(--red)';}
    }
  }catch(e){if(statusEl){statusEl.textContent=e.message;statusEl.style.color='var(--red)';}}
}

async function virtualSellFromDrawer(){
  const r=openDrawerData; if(!r) return;
  const pos=virtualData?.positions?.[r.sym];
  if(!pos){return;}
  const sharesEl=document.getElementById('vp-buy-shares');
  const shares=parseInt(sharesEl?.value||0)||pos.shares;
  const statusEl=document.getElementById('vp-trade-status');
  if(statusEl){statusEl.textContent='…';statusEl.style.color='var(--text3)';}
  try{
    const res=await fetch('/api/virtual/sell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym:r.sym,shares,price:r.price})}).then(x=>x.json());
    if(res.ok){
      virtualData=res.virtual;
      if(statusEl){statusEl.textContent=`✓ ${t('vpSellOk')} ${shares} × ${fmtPrice(r.price,r.sym)}`;statusEl.style.color='var(--green)';}
      if(sharesEl) sharesEl.value='';
      renderVirtual();
      buildTradeTab(r);
    } else {
      if(statusEl){statusEl.textContent=res.error||t('vpErrShares');statusEl.style.color='var(--red)';}
    }
  }catch(e){if(statusEl){statusEl.textContent=e.message;statusEl.style.color='var(--red)';}}
}

async function quickVirtualSell(sym,shares,price){
  if(!confirm(`Sell all ${shares} shares of ${tickerDisplay(sym)}?`)) return;
  try{
    const res=await fetch('/api/virtual/sell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym,shares,price})}).then(x=>x.json());
    if(res.ok){virtualData=res.virtual;renderVirtual();}
    else alert(res.error||'Failed');
  }catch(e){alert(e.message);}
}

// ─── Drawer tabs ──────────────────────────────────────────────────────────────
function switchDrawerTab(tab,btn){
  document.querySelectorAll('.drawer-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.drawer-tab-panel').forEach(p=>p.classList.remove('dtab-active'));
  btn.classList.add('active');
  document.getElementById('dtab-'+tab).classList.add('dtab-active');
  // Lazy-load native chart when the Chart tab becomes visible
  if (tab === 'analysis') {
    const wrap = document.getElementById('drawer-native-chart');
    if (wrap && wrap.dataset.sym && !wrap.dataset.chartLoaded) {
      wrap.dataset.chartLoaded = '1';
      const sym = wrap.dataset.sym;
      const dp  = wrap.dataset.dp  ? parseFloat(wrap.dataset.dp)  : null;
      const cp  = wrap.dataset.cp  ? parseFloat(wrap.dataset.cp)  : null;
      loadNativeChart(sym, 'drawer-native-chart', { discoveryPrice: dp, currentPrice: cp });
    }
  }
}

async function loadDrawerNews(sym, name) {
  const el = document.getElementById('dtab-news');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px 0">Loading news…</div>';
  try {
    const d = await fetch('/api/news/' + encodeURIComponent(sym)).then(r => r.json());
    const articles = d.articles || [];
    if (!articles.length) {
      el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px 0">No recent news found for this stock.</div>';
      return;
    }
    function timeAgo(pubDate) {
      if (!pubDate) return '';
      const diff = Date.now() - new Date(pubDate).getTime();
      const h = Math.floor(diff / 3600000);
      if (h < 1)  return Math.floor(diff / 60000) + 'm ago';
      if (h < 24) return h + 'h ago';
      return Math.floor(h / 24) + 'd ago';
    }
    el.innerHTML = articles.map(a => {
      const lang  = a.lang === 'ar' ? '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(61,139,255,.12);color:var(--accent)">AR</span>' : '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(61,139,255,.12);color:var(--accent)">EN</span>';
      const ago   = timeAgo(a.published);
      const src   = a.source ? `<span style="font-size:10px;color:var(--text3)">${a.source}</span>` : '';
      const dir   = a.lang === 'ar' ? ' dir="rtl"' : '';
      return `<a href="${a.url}" target="_blank" rel="noopener" style="display:block;text-decoration:none;padding:10px 12px;background:rgba(255,255,255,.025);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;transition:background .15s" onmouseover="this.style.background='rgba(255,255,255,.045)'" onmouseout="this.style.background='rgba(255,255,255,.025)'">
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:5px">${lang}${src}<span style="margin-inline-start:auto;font-size:10px;color:var(--text3)">${ago}</span></div>
        <div style="font-size:12px;font-weight:600;color:var(--text);line-height:1.45"${dir}>${a.title}</div>
      </a>`;
    }).join('');
  } catch(e) {
    el.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px 0">Error: ${e.message}</div>`;
  }
}

// ─── Market Regime Panel ──────────────────────────────────────────────────────
async function fetchAndShowRegime(market){
  const panel=document.getElementById('regime-panel');
  if(!panel) return;
  if(market==='all'){panel.style.display='none';return;}
  panel.style.display='block';
  try{
    const d=await fetch('/api/regime?market='+market).then(r=>r.json());
    if(d.price!=null) renderRegimePanel(d);
    else panel.style.display='none';
  }catch(_){panel.style.display='none';}
}

function renderRegimePanel(data){
  const fmt=v=>v!=null?v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  const sf=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  const symLabel=data.sym?(data.sym.includes(':')?data.sym.split(':')[1]:data.sym):'—';
  sf('rg-sym',symLabel);
  const priceEl=document.getElementById('rg-price');
  if(priceEl) priceEl.textContent=fmt(data.price);
  const chgEl=document.getElementById('rg-change');
  if(chgEl){const chg=data.change_pct;chgEl.textContent=chg!=null?(chg>=0?'+':'')+chg.toFixed(2)+'%':'—';chgEl.style.color=chg>0?'var(--green)':chg<0?'#ff1744':'var(--text2)';}
  const trendEl=document.getElementById('rg-trend');
  if(trendEl){const cls=data.trend==='bullish'?'regime-bull':data.trend==='bearish'?'regime-bear':'regime-range';trendEl.className='regime-trend '+cls;trendEl.textContent=data.trend==='bullish'?'▲ Bull':data.trend==='bearish'?'▼ Bear':'◆ Range';}
  const emaEl=document.getElementById('rg-ema');
  if(emaEl){emaEl.textContent=data.ema_stack?'✓':'✗';emaEl.style.color=data.ema_stack?'var(--green)':'#ff5252';}
  const e200El=document.getElementById('rg-200');
  if(e200El){e200El.textContent=data.above_200?'✓':'✗';e200El.style.color=data.above_200?'var(--green)':'#ff5252';}
  const rsiEl=document.getElementById('rg-rsi');
  if(rsiEl){rsiEl.textContent=data.rsi!=null?data.rsi.toFixed(1):'—';rsiEl.style.color=data.rsi>=52?'var(--green)':data.rsi<=48?'#ff5252':'var(--yellow)';}
  const volEl=document.getElementById('rg-vol');
  if(volEl) volEl.textContent=data.atr_pct!=null?data.atr_pct.toFixed(1)+'%':'—';
  const perfEl=document.getElementById('rg-20d');
  if(perfEl){const p=data.perf20d;perfEl.textContent=p!=null?(p>=0?'+':'')+p.toFixed(1)+'%':'—';perfEl.style.color=p>0?'var(--green)':p<0?'#ff5252':'var(--text2)';}
  const posEl=document.getElementById('rg-pos');
  if(posEl) posEl.textContent=data.pos52!=null?data.pos52.toFixed(0)+'%':'—';
  const loEl=document.getElementById('rg-lo52'),hiEl=document.getElementById('rg-hi52'),cursorEl=document.getElementById('rg-cursor');
  if(loEl) loEl.textContent=fmt(data.lo52);if(hiEl) hiEl.textContent=fmt(data.hi52);if(cursorEl) cursorEl.style.insetInlineStart=(data.pos52||50)+'%';
  const sigEl=document.getElementById('rg-signal');
  if(sigEl) sigEl.innerHTML=`<strong>${symLabel}</strong> is in a <strong>${data.trend}</strong> regime. RSI ${data.rsi?.toFixed(1)||'—'} | ATR ${data.atr?.toFixed(2)||'—'} (${data.atr_pct?.toFixed(1)||'—'}% daily vol). 20d perf: ${data.perf20d!=null?(data.perf20d>=0?'+':'')+data.perf20d.toFixed(1)+'%':'—'}. 52w pos: ${data.pos52?.toFixed(0)||'—'}%.`;
}
function refreshRegime(){ fetchAndShowRegime(activeMarket); }

// ─── Divergence badge ─────────────────────────────────────────────────────────
function divergenceBadgeHtml(r){
  if(!r.divergence) return'—';
  if(r.divergence==='bullish') return'<span class="div-bull">↗ Div</span>';
  if(r.divergence==='bearish') return'<span class="div-bear">↘ Div</span>';
  return'—';
}

// ─── Position sizer calculator ────────────────────────────────────────────────
function calcSizer(){
  const balance=parseFloat(document.getElementById('sz-balance')?.value||0);
  const risk=parseFloat(document.getElementById('sz-risk')?.value||0)/100;
  const entry=parseFloat(document.getElementById('sz-entry')?.value||0);
  const stop=parseFloat(document.getElementById('sz-stop')?.value||0);
  const el=document.getElementById('sz-result');
  if(!el) return;
  if(!balance||!risk||!entry||!stop||entry===stop){
    el.innerHTML='<div class="sizer-row"><span class="sizer-lbl" style="color:var(--text3)">Enter all values to calculate</span></div>';
    return;
  }
  const riskAmount=balance*risk;
  const riskPerShare=Math.abs(entry-stop);
  if(!riskPerShare){el.innerHTML='';return;}
  const shares=Math.floor(riskAmount/riskPerShare);
  const posValue=shares*entry;
  const isBear=entry<stop;
  const tgt1=openDrawerData?.atr?(isBear?entry-1.5*openDrawerData.atr:entry+1.5*openDrawerData.atr):null;
  const rr=tgt1!=null?(Math.abs(tgt1-entry)/riskPerShare).toFixed(1):'—';
  const pctOfPortfolio=(posValue/balance*100).toFixed(1);
  el.innerHTML=`
    <div class="sizer-row"><span class="sizer-lbl">Shares</span><span class="sizer-val sizer-shares">${shares.toLocaleString()}</span></div>
    <div class="sizer-row"><span class="sizer-lbl">Position Value</span><span class="sizer-val">${posValue.toLocaleString('en-US',{maximumFractionDigits:0})} <span style="color:var(--text3);font-size:10px">(${pctOfPortfolio}%)</span></span></div>
    <div class="sizer-row"><span class="sizer-lbl">Risk Amount</span><span class="sizer-val sizer-risk-neg">${riskAmount.toLocaleString('en-US',{maximumFractionDigits:0})}</span></div>
    <div class="sizer-row"><span class="sizer-lbl">R:R (to T1)</span><span class="sizer-val" style="color:${parseFloat(rr)>=2?'var(--green)':parseFloat(rr)>=1?'var(--yellow)':'#ff5252'}">${rr}:1</span></div>`;
  // Update trade plan card stats
  const tpcShares=document.getElementById('tpc-shares'); if(tpcShares) tpcShares.textContent=shares.toLocaleString();
  const tpcRisk=document.getElementById('tpc-risk');   if(tpcRisk)   tpcRisk.textContent=riskAmount.toLocaleString('en-US',{maximumFractionDigits:0});
  const tpcRR=document.getElementById('tpc-rr');       if(tpcRR){    tpcRR.textContent=rr+':1'; tpcRR.style.color=parseFloat(rr)>=2?'var(--green)':parseFloat(rr)>=1.5?'var(--yellow)':'#ff5252'; }
}

// ─── Fix B helpers ────────────────────────────────────────────────────────────
function buildCriteriaTable(r){
  const{ema13,ema34,ema89,ema200}=r.emas||{};
  const isBear=['STRONG SELL','SELL','AVOID'].includes(r.bias);
  let rows;
  if(isBear){
    const stackBear=ema13<ema34&&ema34<ema89,below200=r.price<ema200;
    const rsiWeak=r.rsi>22&&r.rsi<=48,rsiOs=r.rsi<=22;
    const macdBear=r.macd_hist<0,volOk=r.vol_ratio>=1.2;
    rows=[
      {pass:stackBear,name:t('lEmaStackBear'),pts:2,val:`EMA 13: ${ema13?.toFixed(2)} · 34: ${ema34?.toFixed(2)} · 89: ${ema89?.toFixed(2)}`,detail:stackBear?'Inverted stack confirmed':'Not yet inverted'},
      {pass:below200,name:t('lEma200Bear'),pts:2,val:`Price ${r.price?.toFixed(2)} vs EMA200 ${ema200?.toFixed(2)}`,detail:below200?'Below long-term trend line':'Still above 200 EMA'},
      {pass:rsiWeak&&!rsiOs,warn:rsiOs,name:t('lRsiBear'),pts:2,val:`RSI(14): ${r.rsi?.toFixed(1)}`,detail:rsiOs?'Oversold — potential bounce':'RSI not in bearish zone yet'},
      {pass:macdBear,name:t('lMacd'),pts:1,val:`Histogram: ${r.macd_hist?.toFixed(4)}`,detail:macdBear?'Negative — selling momentum':'MACD still positive'},
      {pass:volOk,name:t('lVol'),pts:1,val:`Volume: ${r.vol_ratio}×`,detail:volOk?'Above average — confirms selling pressure':'Below 1.2× threshold — weak distribution'},
    ];
  } else {
    const stack=ema13>ema34&&ema34>ema89,above200=r.price>ema200;
    const rsiOk=r.rsi>=52&&r.rsi<78,rsiOb=r.rsi>=78;
    const macdOk=r.macd_hist>0,volOk=r.vol_ratio>=1.2;
    rows=[
      {pass:stack,name:t('lEmaStack'),pts:2,val:`EMA 13: ${ema13?.toFixed(2)} · 34: ${ema34?.toFixed(2)} · 89: ${ema89?.toFixed(2)}`,detail:stack?'Staircase aligned upward':'Not fully aligned'},
      {pass:above200,name:t('lEma200'),pts:2,val:`Price ${r.price?.toFixed(2)} vs EMA200 ${ema200?.toFixed(2)}`,detail:above200?'In bull-market regime':'Below long-term trend'},
      {pass:rsiOk&&!rsiOb,warn:rsiOb,name:t('lRsi'),pts:2,val:`RSI(14): ${r.rsi?.toFixed(1)}`,detail:rsiOb?'Overbought — may need pullback':rsiOk?'In momentum zone 52–78':'Below momentum threshold'},
      {pass:macdOk,name:t('lMacd'),pts:1,val:`Histogram: ${r.macd_hist>0?'+':''}${r.macd_hist?.toFixed(4)}`,detail:macdOk?'Positive — momentum building':'Negative — not yet accelerating'},
      {pass:volOk,name:t('lVol'),pts:1,val:`Volume: ${r.vol_ratio}×`,detail:volOk?'Above 1.2× — institutional participation':'Below threshold — thin participation'},
    ];
  }
  const scoreCheck=rows.filter(rw=>rw.pass).reduce((s,rw)=>s+rw.pts,0);
  const trs=rows.map((rw,i)=>{
    const cls=rw.warn?'ct-warn':rw.pass?'ct-pass':'ct-fail';
    const icon=rw.warn?'⚠️':rw.pass?'✅':'❌';
    const ptsCls=rw.pass?'ct-pts pass':'ct-pts';
    return`<tr class="${cls}">
      <td class="ct-num">${i+1}</td>
      <td><div class="ct-name">${rw.name}</div><div class="ct-val">${rw.val}</div></td>
      <td><span class="${ptsCls}">${rw.pts} pt${rw.pts>1?'s':''}</span></td>
      <td class="${rw.warn?'ct-status-warn':rw.pass?'ct-status-pass':'ct-status-fail'}">${icon}</td>
      <td class="ct-val">${rw.detail}</td>
    </tr>`;
  }).join('');
  return`<div class="crit-table-wrap">
    <table class="crit-table">
      <thead><tr><th>#</th><th>Criterion</th><th>Pts</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>${trs}</tbody>
      <tfoot><tr style="background:var(--bg2)">
        <td colspan="2" style="font-size:11px;font-weight:700;padding:6px 10px;color:var(--text2)">Total</td>
        <td style="font-size:11px;font-weight:700;padding:6px 10px;color:var(--accent);text-align:center">${scoreCheck}/8</td>
        <td colspan="2" style="font-size:10px;color:var(--text3);padding:6px 10px">5 criteria · 8 points max</td>
      </tr></tfoot>
    </table>
  </div>`;
}

function scoreHistorySparkHtml(sym){
  const hist=scoreHistory[sym];
  if(!hist||hist.length<2) return'';
  const last5=hist.slice(-5);
  const modeIcon = { swing:'S', position:'P', breakout:'B' };
  const dots=last5.map((h,i)=>{
    const c=scoreColor(h.s,h.m||8);
    const md=h.md||'swing';
    const mismatch=md!==scanMode;
    const badge=mismatch?`<sup style="font-size:7px;color:var(--orange);font-weight:700">${modeIcon[md]||'?'}</sup>`:'';
    return`<span class="sh-dot" style="background:${c};${mismatch?'opacity:.7;outline:1px solid var(--orange);outline-offset:1px':''}" title="${h.d} [${md}]: ${h.s}/${h.m||8} — ${h.b||''}">${badge}</span>`;
  }).join('<span class="sh-arrow">→</span>');
  const scores=last5.map(h=>h.s).join(' → ');
  const modes=[...new Set(last5.map(h=>h.md||'swing'))];
  const mixedModes=modes.length>1||(modes.length===1&&modes[0]!==scanMode);
  const modeWarn=mixedModes?`<div style="font-size:9px;color:var(--orange);margin-top:3px;line-height:1.4">⚠ History includes ${modes.join('+')} mode scans — scores reflect different criteria</div>`:'';
  return`<div style="margin-top:2px"><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);margin-bottom:4px">Score over last scans</div><div class="score-hist-wrap">${dots}<span style="font-size:11px;color:var(--text2);margin-inline-start:4px">${scores}</span></div>${modeWarn}</div>`;
}

function goToVirtualBuy(sym, price){
  closeDrawer();
  const tabBtn=document.querySelector('.tab[onclick*="virtual"]');
  if(tabBtn) switchTab('positions',tabBtn);
  setTimeout(()=>{
    const symEl=document.getElementById('pos-sym');
    const entryEl=document.getElementById('pos-entry');
    const ticker=sym.includes(':')?sym.split(':')[1]:sym;
    if(symEl){symEl.value=ticker;symEl.focus();}
    if(entryEl&&price) entryEl.value=price.toFixed(2);
    symEl?.closest('.pos-add-form')?.scrollIntoView({behavior:'smooth'});
  },200);
}

function goToSetAlert(sym, name){
  closeDrawer();
  const tabBtn=document.querySelector('.tab[onclick*="criteria"]');
  if(tabBtn) switchTab('criteria',tabBtn);
  setTimeout(()=>{
    const symEl=document.getElementById('rule-sym');
    const nameEl=document.getElementById('rule-name');
    if(symEl){symEl.value=sym;symEl.focus();}
    if(nameEl) nameEl.value=(name||tickerDisplay(sym))+' Score≥6';
    symEl?.closest('.rule-form')?.scrollIntoView({behavior:'smooth'});
  },200);
}

// ─── What Changed Since Last Scan ─────────────────────────────────────────────
function critJustification(key, gained, pm, r){
  const isBear=['STRONG SELL','SELL','AVOID'].includes(r.bias);
  const emas=r.emas||{}, pEmas=(pm&&pm.emas)||{};
  const f2=v=>v!=null?v.toFixed(2):'—', f1=v=>v!=null?v.toFixed(1):'—', f4=v=>v!=null?v.toFixed(4):'—';
  switch(key){
    case 'emaStack':
      if(isBear)
        return gained
          ? `EMA 13 (${f2(emas.ema13)}) < EMA 34 (${f2(emas.ema34)}) < EMA 89 (${f2(emas.ema89)}) — price trend confirmed downward`
          : `EMA 13 (${f2(emas.ema13)}) moved above EMA 34 (${f2(emas.ema34)}) — bearish stack broken`;
      return gained
        ? `EMA 13 (${f2(emas.ema13)}) > EMA 34 (${f2(emas.ema34)}) > EMA 89 (${f2(emas.ema89)}) — trend aligned bullish`
        : `EMA 13 (${f2(emas.ema13)}) dropped below EMA 34 (${f2(emas.ema34)}) — momentum stack broken`;
    case 'ema200':
      if(isBear)
        return gained
          ? `Price ${f2(r.price)} fell below EMA 200 (${f2(emas.ema200)}) — below long-term trend`
          : `Price ${f2(r.price)} recovered above EMA 200 (${f2(emas.ema200)}) — criteria no longer met`;
      return gained
        ? `Price ${f2(r.price)} crossed above EMA 200 (${f2(emas.ema200)}) — now in long-term uptrend`
        : `Price ${f2(r.price)} dropped below EMA 200 (${f2(emas.ema200)}) — broke below long-term support`;
    case 'rsi':
      if(pm&&pm.rsi!=null)
        return isBear
          ? `RSI: ${f1(pm.rsi)} → ${f1(r.rsi)} — ${gained?'entered weak zone (22–48)':'left weak zone'}`
          : `RSI: ${f1(pm.rsi)} → ${f1(r.rsi)} — ${gained?'entered momentum zone (52–78)':'fell out of momentum zone (52–78)'}`;
      return isBear
        ? `RSI at ${f1(r.rsi)} — ${gained?'in':'not in'} weak zone (22–48)`
        : `RSI at ${f1(r.rsi)} — ${gained?'in':'not in'} momentum zone (52–78)`;
    case 'macd':
      if(pm&&pm.macd_hist!=null)
        return `MACD histogram: ${f4(pm.macd_hist)} → ${f4(r.macd_hist)} — turned ${r.macd_hist>0?'positive (bullish momentum)':'negative (bearish momentum)'}`;
      return `MACD histogram ${r.macd_hist>0?'positive':'negative'} (${f4(r.macd_hist)}) — ${gained?'momentum confirmed':'momentum lost'}`;
    case 'vol':
      if(pm&&pm.vol_ratio!=null)
        return `Volume: ${pm.vol_ratio?.toFixed(2)}× → ${r.vol_ratio?.toFixed(2)}× average — ${gained?'volume surge, possible institutional activity':'volume dropped below 1.2× threshold'}`;
      return `Volume at ${r.vol_ratio?.toFixed(2)}× average — ${gained?'above':'below'} 1.2× threshold`;
    default: return '';
  }
}

function buildDeltaCallout(d, r){
  if(!d) return '';
  const improved=d.direction==='improved';
  const scoreCol=d.score_delta>0?'var(--green)':d.score_delta<0?'#ff5252':'var(--text2)';
  const sign=d.score_delta>0?'+':'';
  const maxSc=r.maxScore||8;
  // Bias transition row
  const biasRow=`<div class="wc-bias-row">
    <span class="wc-bias-prev">${biasBadgeHtml(d.prev_bias)}</span>
    <span class="wc-arrow">→</span>
    <span class="wc-bias-curr">${biasBadgeHtml(d.curr_bias)}</span>
    <span class="wc-score-jump" style="color:${scoreCol}">${sign}${d.score_delta} pts &nbsp;·&nbsp; ${d.prev_score}/${maxSc} → ${d.curr_score}/${maxSc}</span>
  </div>`;
  // Per-criterion change rows with justification
  const pm=d.prev_metrics||{};
  let critRows='';
  if(d.criteria_changes&&d.criteria_changes.length){
    critRows=d.criteria_changes.map(c=>{
      const gained=c.now&&!c.was;
      const col=gained?'var(--green)':'#ff5252';
      const icon=gained?'✅':'❌';
      const ptsTxt=gained?`+${c.pts} pt${c.pts>1?'s':''}`:c.pts>0?`−${c.pts} pt${c.pts>1?'s':''}`:'';
      const why=critJustification(c.key,gained,pm,r);
      return`<div class="wc-crit-row">
        <div class="wc-crit-main">
          <span class="wc-crit-icon">${icon}</span>
          <span class="wc-crit-label">${c.label}</span>
          <span class="wc-crit-pts" style="color:${col}">${ptsTxt}</span>
        </div>
        ${why?`<div class="wc-crit-why">${why}</div>`:''}
      </div>`;
    }).join('');
  } else {
    // bias changed but score unchanged — show a note
    critRows=`<div class="wc-crit-row"><div class="wc-crit-main"><span class="wc-crit-icon">ℹ️</span><span class="wc-crit-label" style="color:var(--text3)">Bias reclassified at same score — threshold boundary crossed</span></div></div>`;
  }
  // Prev metric snapshot (pm already declared above)
  let metricRows='';
  if(pm.rsi!=null||pm.macd_hist!=null||pm.vol_ratio!=null){
    const rsiDiff=r.rsi!=null&&pm.rsi!=null?(r.rsi-pm.rsi):null;
    const macdFlip=pm.macd_hist!=null&&r.macd_hist!=null&&Math.sign(pm.macd_hist)!==Math.sign(r.macd_hist);
    const volDiff=r.vol_ratio!=null&&pm.vol_ratio!=null?(r.vol_ratio-pm.vol_ratio):null;
    const fmtDiff=(v,decimals=1)=>v==null?'':(v>0?`<span style="color:var(--green)">+${v.toFixed(decimals)}</span>`:`<span style="color:#ff5252">${v.toFixed(decimals)}</span>`);
    metricRows=`<div class="wc-metrics">
      ${pm.rsi!=null?`<div class="wc-metric"><span class="wc-metric-lbl">RSI</span><span class="wc-metric-val">${pm.rsi?.toFixed(1)} → <strong>${r.rsi?.toFixed(1)}</strong></span>${rsiDiff!=null?`<span class="wc-metric-diff">${fmtDiff(rsiDiff)}</span>`:''}</div>`:''}
      ${pm.macd_hist!=null?`<div class="wc-metric"><span class="wc-metric-lbl">MACD</span><span class="wc-metric-val">${pm.macd_hist?.toFixed(4)} → <strong>${r.macd_hist?.toFixed(4)}</strong></span>${macdFlip?`<span class="wc-metric-diff" style="color:${r.macd_hist>0?'var(--green)':'#ff5252'}">${r.macd_hist>0?'turned +':'turned −'}</span>`:''}</div>`:''}
      ${pm.vol_ratio!=null?`<div class="wc-metric"><span class="wc-metric-lbl">Vol</span><span class="wc-metric-val">${pm.vol_ratio?.toFixed(2)}× → <strong>${r.vol_ratio?.toFixed(2)}×</strong></span>${volDiff!=null?`<span class="wc-metric-diff">${fmtDiff(volDiff,2)}</span>`:''}</div>`:''}
      ${pm.price!=null&&r.price!=null?`<div class="wc-metric"><span class="wc-metric-lbl">Price</span><span class="wc-metric-val">${fmtPrice(pm.price,r.sym)} → <strong>${fmtPrice(r.price,r.sym)}</strong></span>${fmtDiff(r.price-pm.price,2)?`<span class="wc-metric-diff">${fmtDiff(r.price-pm.price,2)}</span>`:''}</div>`:''}
    </div>`;
  }
  // Rapid reversal warning — direction flipped dramatically in one scan
  let rapidWarn = '';
  if (d.rapid_reversal) {
    const prevStreakTxt = d.prev_streak > 1
      ? `${d.name} was ${d.prev_bias} for ${d.prev_streak} consecutive scan${d.prev_streak>1?'s':''} before this reversal.`
      : `${d.name} was ${d.prev_bias} in the previous scan.`;
    const trajHtml = (d.trajectory||[]).map(h => {
      const isBear = ['STRONG SELL','SELL','AVOID'].includes(h.b);
      const col = isBear?'#ff3d71':['STRONG BUY','BUY','WATCH'].includes(h.b)?'var(--green)':'var(--text3)';
      return `<span class="rrw-scan" style="background:rgba(255,255,255,.04);color:${col}">${h.b.replace('STRONG ','S.')} ${h.s}/${h.m}</span>`;
    }).join('<span style="color:var(--text3);font-size:9px">→</span>');
    rapidWarn = `<div class="rapid-reversal-warn">
      <div class="rrw-title">⚠️ Rapid Direction Reversal — Verify Before Acting</div>
      <div class="rrw-body">${prevStreakTxt} A one-scan flip from <strong>${d.prev_bias}</strong> to <strong>${d.curr_bias}</strong> is a real market event but warrants manual chart verification. The signal is valid — but confirm the move isn't a short-covering bounce before entering.</div>
      ${trajHtml?`<div class="rrw-traj">${trajHtml}<span class="rrw-scan" style="background:rgba(79,139,255,.15);color:var(--accent)">${d.curr_bias} ${d.curr_score}/${r.maxScore||8}</span></div>`:''}
    </div>`;
  }

  const borderCol=improved?'var(--green)':'#ff5252';
  return`<div class="wc-card" style="border-inline-start:3px solid ${borderCol}">
    <div class="wc-title">${improved?'📈':'📉'} What Changed Since Last Scan</div>
    ${rapidWarn}
    ${biasRow}
    ${critRows}
    ${metricRows}
  </div>`;
}