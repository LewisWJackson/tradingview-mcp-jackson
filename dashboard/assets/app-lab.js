(function(){
  const tip = document.getElementById('mwj-tt');
  if (!tip) return;
  let active = null;

  function place(cx, cy) {
    const tw = tip.offsetWidth || 0, th = tip.offsetHeight || 0;
    const vw = window.innerWidth, vh = window.innerHeight, pad = 12;
    let x = cx + 16, y = cy + 14;
    if (x + tw > vw - pad) x = cx - tw - 12;
    if (y + th > vh - pad) y = cy - th - 8;
    tip.style.left = Math.max(pad, x) + 'px';
    tip.style.top  = Math.max(pad, y) + 'px';
  }

  function show(text, cx, cy) {
    // Support "Title::body" split — renders a styled header above the description
    const parts = text.split('::');
    if (parts.length >= 2) {
      const head = parts[0].trim().replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const body = parts.slice(1).join('::').trim().replace(/&/g,'&amp;').replace(/</g,'&lt;');
      tip.innerHTML = `<div class="tt-head">${head}</div>${body}`;
    } else {
      tip.textContent = text;
    }
    tip.style.display = 'block';
    tip.style.opacity = '0';
    place(cx, cy);
    requestAnimationFrame(() => { tip.style.opacity = '1'; });
  }

  function hide() {
    tip.style.opacity = '0';
    setTimeout(() => { if (tip.style.opacity === '0') tip.style.display = 'none'; }, 120);
    if (active) {
      try { active.el.setAttribute('title', active.text); } catch(_) {}
      delete active.el._tipActive;
      active = null;
    }
  }

  document.addEventListener('mouseover', function(e) {
    // Walk up the DOM to find a titled element or one we already activated
    let el = e.target;
    while (el && el !== document.body) {
      if (el._tipActive || el.hasAttribute('title')) break;
      el = el.parentElement;
    }
    if (!el || el === document.body) { if (active) hide(); return; }
    if (active && active.el === el) return; // same element — already showing
    if (active) hide();
    const text = el._tipText || el.getAttribute('title');
    if (!text) return;
    active = { el, text };
    el._tipText = text;
    el._tipActive = true;
    el.removeAttribute('title');
    show(text, e.clientX, e.clientY);
  });

  document.addEventListener('mousemove', function(e) {
    if (active) place(e.clientX, e.clientY);
  });

  document.addEventListener('mouseout', function(e) {
    if (!active || active.el !== e.target) return;
    if (!active.el.contains(e.relatedTarget)) hide();
  });

  document.addEventListener('mouseleave', hide);
  document.addEventListener('scroll', hide, true);
})();

// ── Platform-wide plain-English glossary: auto-attaches hover tooltips to jargon ──
// One place to maintain. An auto-binder scans table headers + metric labels (and known
// signal words), matches their text to the glossary, and sets a Header::body title that
// the tooltip engine above renders. A MutationObserver covers dynamically-rendered tables.
(function(){
  // key = normalized on-screen text → "Header::plain-English explanation"
  const G = {
    'ticker': 'Ticker::The stock\'s short code on the exchange (e.g. 1120).',
    'symbol': 'Symbol::The stock\'s exchange code.',
    'price': 'Price::Most recent traded price, in Saudi Riyals.',
    'scan price': 'Scan Price::The price at the moment this scan was run.',
    'score': 'Score::A 0–9 strength rating. Higher means more buy signals are lining up at once.',
    'pts': 'Pts::Points this single criterion added to the total score.',
    'bias': 'Bias::The engine\'s overall call for the stock — e.g. STRONG BUY, BUY, NEUTRAL, SELL.',
    'signal': 'Signal::The engine\'s call, from combining all the indicators together.',
    'signal type': 'Signal Type::Which kind of trigger fired — e.g. breakout, oversold bounce, dividend.',
    'signals': 'Signals::How many separate triggers are active for this stock.',
    'rsi': 'RSI (Relative Strength Index)::A 0–100 momentum gauge. Above 70 = stretched up (overbought), below 30 = stretched down (oversold).',
    'macd': 'MACD::A trend-and-momentum indicator. Turning up hints buyers are taking control.',
    'atr': 'ATR (Average True Range)::How much the stock typically moves in a day, in riyals. Used to set stop distance — bigger ATR means a wider stop.',
    'ema': 'EMA (Exponential Moving Average)::A smoothed average price. The 200-EMA is the common dividing line between long-term up- and down-trends.',
    'adx': 'ADX::How strong the trend is (not its direction). Above ~25 means a real trend rather than choppy drift.',
    'vwap': 'VWAP::The volume-weighted average price — a fair-value reference line for the day.',
    'obv': 'OBV (On-Balance Volume)::Tallies volume on up-days vs down-days to show whether money is flowing in or out.',
    'rs': 'RS (Relative Strength)::How the stock is doing versus the market. Positive = beating the market.',
    'beta': 'Beta::How much the stock swings compared with the market. Above 1 = swings more than the market.',
    'r-multiple': 'R-Multiple::Profit measured in units of risk. +2R means you made twice what you risked.',
    'r multiple': 'R-Multiple::Profit measured in units of risk. +2R means you made twice what you risked.',
    'win%': 'Win Rate::The share of trades that ended in profit.',
    'win rate': 'Win Rate::The share of trades that ended in profit.',
    'pf': 'PF (Profit Factor)::Total winnings ÷ total losses. Above 1 is profitable; above 1.5 is solid.',
    'expectancy': 'Expectancy::Average profit per trade in risk units. Positive means a real edge over many trades.',
    'net': 'Net::Return after trading costs (fees) are subtracted.',
    'excess': 'Excess::How much more than a fair equal-weight benchmark — the honest measure of skill, not just riding the market.',
    'return': 'Return::Percentage gain or loss over the period.',
    'p(profit)': 'P(profit)::The chance a pick simply makes money.',
    'p(beat)': 'P(beat)::The chance a pick beats just buying and holding — the honest yardstick.',
    '±ci': '±CI (Confidence Interval)::The uncertainty band around a number. Wider = less certain (usually a small sample).',
    'ci': 'CI (Confidence Interval)::The uncertainty band around a number. Wider = less certain.',
    'n': 'n::How many samples are behind this number. A small n means treat it with caution.',
    't1': 'T1::First take-profit target price.',
    't2': 'T2::Second take-profit target price.',
    'stop': 'Stop::The exit price that caps your loss if the trade goes wrong.',
    'entry': 'Entry::The price you bought at (or plan to).',
    'drawdown': 'Drawdown::The drop from a peak to a later low — the pain you sit through before recovery.',
    'sharpe': 'Sharpe::Return earned per unit of risk. Higher = a smoother ride for the same gain.',
    'p&l': 'P&L::Profit and Loss — money made or lost.',
    'p&l vs entry': 'P&L vs Entry::Profit or loss measured from your entry price.',
    'sector': 'Sector::The industry group — banks, materials, energy, etc.',
    'style': 'Style::The trade type / timeframe (e.g. swing, scalp, position).',
    'rating': 'Rating::A quality grade — strong, moderate, or weak.',
    'outcome': 'Outcome::How the trade resolved — hit target, stopped out, or still open.',
    'r:r': 'R:R (Risk-to-Reward)::How much you stand to gain versus lose. 1:3 means risking 1 to make 3.',
    'div yield': 'Dividend Yield::Yearly dividend as a % of the share price.',
    'p/e': 'P/E (Price-to-Earnings)::Price divided by yearly profit per share. A rough gauge of how expensive a stock is.',
    'mkt cap': 'Market Cap::Total value of the company (share price × number of shares).',
    'liquidity': 'Liquidity::How easily you can buy/sell without moving the price. Higher = easier to trade.',
  };
  // exact-text signal words (matched only on small tag/badge elements to stay safe)
  const SIG = {
    'strong buy': 'STRONG BUY::Most criteria aligned — descriptive trend state, not a buy signal (lagged buy-and-hold in testing). Validated buy-list = Momentum tab.',
    'buy': 'BUY::Uptrend state, weaker than STRONG BUY — descriptive, not a buy signal.',
    'neutral': 'NEUTRAL::No clear edge either way — the engine has no strong opinion.',
    'hold': 'HOLD::Stay put — no action suggested right now.',
    'sell': 'SELL::A negative signal — the engine sees weakness.',
    'strong sell': 'STRONG SELL::Highest-conviction negative signal.',
  };
  const norm = s => (s||'').replace(/ | /g,' ').trim().toLowerCase().replace(/\s+/g,' ').replace(/[:•★\s]+$/,'').trim();
  const LABEL_SEL = 'th,.bt-stat-lbl,.lab-stat-lbl,.regime-metric-lbl,.sizer-lbl,.atr-label,.crit-label,.sublabel,.goal-field-label,.exec-lvl-label,.stat-lbl,.crit-label,.label';
  const SIG_SEL = '.tag,.badge,[class*="bias"],[class*="-pill"],[class*="signal-"]';
  function tag(el, text){ if(!el||el.hasAttribute('title')||el._tipActive||el._g) return; el.setAttribute('title', text); el.style.cursor='help'; el._g=1; }
  function apply(root){
    const r = root && root.querySelectorAll ? root : document;
    try {
      r.querySelectorAll(LABEL_SEL).forEach(el => { const v = G[norm(el.textContent)]; if(v) tag(el, v); });
      r.querySelectorAll(SIG_SEL).forEach(el => { const v = SIG[norm(el.textContent)]; if(v) tag(el, v); });
    } catch(_){}
  }
  let pend = null;
  function schedule(){ if(pend) return; pend = setTimeout(()=>{ pend=null; apply(document); }, 300); }
  function start(){ apply(document); new MutationObserver(schedule).observe(document.body, { childList:true, subtree:true }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

// ════════════════════════════════════════════════════════════
// GOALS PAGE
// ════════════════════════════════════════════════════════════
let goalsData = null;
let goalsSuggested = [];
let goalsEditing = false;

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch(_) { return { error: `Server returned: ${text.slice(0,200)}` }; }
}

async function loadGoalsPanel() {
  const el = document.getElementById('goals-content');
  if (!el) return;
  el.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text3);font-size:12px">Loading…</div>`;
  try {
    const [profRes, sugRes] = await Promise.all([
      fetch('/api/goals/profile').then(safeJson),
      fetch('/api/goals/suggested').then(safeJson),
    ]);
    if (profRes.error) throw new Error(profRes.error);
    goalsData = profRes.profile || {};
    goalsSuggested = sugRes.suggested || [];
    window._goalsMeta = { slots_left: sugRes.slots_left, open_positions: sugRes.open_positions };
    renderGoalsPanel(sugRes);
  } catch(e) {
    el.innerHTML = `<div style="padding:20px;color:var(--red);font-size:12px;line-height:1.6">
      <strong>Could not load Goals page.</strong><br>
      ${e.message}<br><br>
      <span style="color:var(--text3)">Make sure the server is running with the latest code. Restart with: <code style="background:var(--bg2);padding:2px 6px;border-radius:4px">node dashboard/server.mjs</code></span>
    </div>`;
  }
}

function renderGoalsPanel(sugRes) {
  const el = document.getElementById('goals-content');
  if (!el || !goalsData) return;
  const p = goalsData;
  const fmtN = (v, dec=0) => v != null ? (+v).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec}) : '—';
  const fmtP = v => v != null ? `${v>=0?'+':''}${(+v).toFixed(1)}%` : '—';

  // Progress from real positions only — virtual portfolio is independent
  const realPos = positionsData || {};
  const capitalSAR = p.capital_sar || 100000;
  const targetGain = capitalSAR * (p.target_return_pct / 100);

  const openEntries = Object.entries(realPos).filter(([k]) => !k.startsWith('_'));
  const closedEntries = Object.values(realPos._closed || {});

  const unrealizedPL = openEntries.reduce((a, [sym, pos]) => {
    const match = scanData.find(x => x.sym === sym);
    if (!match?.price || !pos.avg_cost || !pos.shares) return a;
    return a + pos.shares * (match.price - pos.avg_cost);
  }, 0);
  const realizedPL = closedEntries.reduce((a, pos) => {
    if (!pos.exit_price || !pos.avg_cost || !pos.shares) return a;
    return a + pos.shares * (pos.exit_price - pos.avg_cost);
  }, 0);
  const totalPL = realizedPL + unrealizedPL;
  const progressPct = targetGain > 0 ? Math.min(Math.round(totalPL / targetGain * 100), 999) : 0;
  const progressFill = Math.max(0, Math.min(progressPct, 100));
  const fillCol = progressPct >= 100 ? 'var(--green)' : progressPct >= 60 ? 'var(--lime)' : progressPct >= 30 ? 'var(--yellow)' : 'var(--accent)';

  const reqMonthly = p.horizon_months > 0
    ? +((Math.pow(1 + p.target_return_pct/100, 1/p.horizon_months) - 1) * 100).toFixed(2)
    : 0;

  // Zakat drag — ~2.5%/yr on tradeable-asset value; modeled nowhere else, so the
  // target is shown net of it for an honest expectation.
  const zakatPct = p.zakat_pct ?? 2.5;
  const zakatYrSAR = capitalSAR * zakatPct / 100;
  const zakatHorizonPct = +(zakatPct * ((p.horizon_months || 12) / 12)).toFixed(1);
  const netTargetPct = +((p.target_return_pct || 0) - zakatHorizonPct).toFixed(1);

  // Goal start date info
  const startDate = p.goal_start_date ? new Date(p.goal_start_date) : null;
  const endDate   = startDate ? new Date(startDate.getTime() + p.horizon_months * 30.44 * 86400000) : null;
  const daysLeft  = endDate ? Math.max(0, Math.round((endDate - Date.now()) / 86400000)) : null;

  const MARKET_OPTS = [['tasi','TASI'],['us','US Equity'],['crypto','Crypto'],['etf','ETF'],['commodity','Commodities']];
  const STYLE_OPTS  = ['Momentum','Trend','Breakout','Recovery','Pullback'];

  el.innerHTML = `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
  <!-- Profile Card -->
  <div class="goal-profile-card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--text)">${p.goal_name||'My Trading Goal'}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Target: +${fmtN(p.target_return_pct,1)}% in ${p.horizon_months} months · ${fmtN(capitalSAR)} SAR capital</div>
        <div style="font-size:10.5px;color:var(--text3);margin-top:3px;cursor:help" title="Zakat::Zakat on tradeable assets is ~2.5%/yr of your portfolio value — a real annual obligation that NO return figure includes. The target is shown net of it so the plan is honest, not optimistic. Edit the rate if your zakat base differs.">− Zakat ~${fmtN(zakatPct,1)}%/yr (≈ ${fmtN(zakatYrSAR)} SAR) → <strong style="color:var(--text2)">net ≈ +${fmtN(netTargetPct,1)}%</strong> over ${p.horizon_months}mo</div>
      </div>
      <button class="btn btn-secondary" style="font-size:11px;padding:5px 12px" onclick="toggleGoalEdit()">✏ Edit</button>
    </div>
    <div id="goal-display-fields" style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px">
      <span style="background:var(--bg2);padding:4px 10px;border-radius:20px;color:var(--text2)">Risk/trade: ${p.risk_per_trade_pct}%</span>
      <span style="background:var(--bg2);padding:4px 10px;border-radius:20px;color:var(--text2)">Max positions: ${p.max_open_positions}</span>
      <span style="background:var(--bg2);padding:4px 10px;border-radius:20px;color:var(--text2)">Max drawdown: ${p.max_drawdown_pct}%</span>
      ${p.sharia_required?'<span style="background:rgba(0,200,83,.1);padding:4px 10px;border-radius:20px;color:var(--green)">Sharia ✓</span>':''}
      <span style="background:var(--bg2);padding:4px 10px;border-radius:20px;color:var(--text2)">Markets: ${(p.preferred_markets||[]).join(', ')||'All'}</span>
      <span style="background:var(--bg2);padding:4px 10px;border-radius:20px;color:var(--text2)">Styles: ${(p.style_preference||[]).join(', ')||'All'}</span>
    </div>
    <div id="goal-edit-form" style="display:none;margin-top:12px">
      <div class="goal-profile-grid">
        <div class="goal-field"><div class="goal-field-label">Goal Name</div><input class="goal-input goal-input-sm" id="gf-name" value="${p.goal_name||''}"></div>
        <div class="goal-field"><div class="goal-field-label">Capital (SAR)</div><input class="goal-input goal-input-sm" id="gf-capital" type="number" value="${p.capital_sar||100000}"></div>
        <div class="goal-field"><div class="goal-field-label">Target Return (%)</div><input class="goal-input goal-input-sm" id="gf-return" type="number" step="0.5" value="${p.target_return_pct||15}"></div>
        <div class="goal-field"><div class="goal-field-label">Horizon (months)</div><input class="goal-input goal-input-sm" id="gf-horizon" type="number" value="${p.horizon_months||12}"></div>
        <div class="goal-field"><div class="goal-field-label">Risk per Trade (%)</div><input class="goal-input goal-input-sm" id="gf-risk" type="number" step="0.1" value="${p.risk_per_trade_pct||1.5}"></div>
        <div class="goal-field"><div class="goal-field-label">Max Open Positions</div><input class="goal-input goal-input-sm" id="gf-maxpos" type="number" value="${p.max_open_positions||5}"></div>
        <div class="goal-field"><div class="goal-field-label">Max Drawdown (%)</div><input class="goal-input goal-input-sm" id="gf-dd" type="number" value="${p.max_drawdown_pct||10}"></div>
        <div class="goal-field"><div class="goal-field-label">Zakat (%/yr)</div><input class="goal-input goal-input-sm" id="gf-zakat" type="number" step="0.1" value="${p.zakat_pct??2.5}"></div>
        <div class="goal-field"><div class="goal-field-label">Start Date</div><input class="goal-input goal-input-sm" id="gf-start" type="date" value="${p.goal_start_date||new Date().toISOString().split('T')[0]}"></div>
      </div>
      <div style="margin-bottom:10px">
        <div class="goal-field-label" style="margin-bottom:6px">Markets</div>
        <div class="goal-chips" id="gf-markets">
          ${MARKET_OPTS.map(([v,l])=>`<span class="goal-chip ${(p.preferred_markets||[]).includes(v)?'active':''}" onclick="toggleGoalChip(this,'markets','${v}')">${l}</span>`).join('')}
        </div>
      </div>
      <div style="margin-bottom:10px">
        <div class="goal-field-label" style="margin-bottom:6px">Style Preference</div>
        <div class="goal-chips" id="gf-styles">
          ${STYLE_OPTS.map(s=>`<span class="goal-chip ${(p.style_preference||[]).includes(s)?'active':''}" onclick="toggleGoalChip(this,'styles','${s}')">${s}</span>`).join('')}
        </div>
      </div>
      <div style="margin-bottom:12px;display:flex;align-items:center;gap:10px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
          <input type="checkbox" id="gf-sharia" ${p.sharia_required?'checked':''} style="accent-color:var(--accent)">
          <span>Sharia compliant only</span>
        </label>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="saveGoalProfile()">Save Goal</button>
        <button class="btn btn-secondary" onclick="toggleGoalEdit()">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Progress Card -->
  <div class="goal-progress-card">
    <div class="goal-section-title">Progress Toward Goal</div>
    <div class="goal-progress-stats">
      <div class="goal-stat">
        <div class="goal-stat-val" style="color:var(--accent)">${fmtN(totalPL, 0)}</div>
        <div class="goal-stat-lbl">Total P&amp;L (SAR)</div>
      </div>
      <div class="goal-stat">
        <div class="goal-stat-val" style="color:var(--green)">${fmtN(realizedPL,0)}</div>
        <div class="goal-stat-lbl">Realized</div>
      </div>
      <div class="goal-stat">
        <div class="goal-stat-val" style="color:${unrealizedPL>=0?'var(--yellow)':'#ff5252'}">${fmtN(unrealizedPL,0)}</div>
        <div class="goal-stat-lbl">Unrealized</div>
      </div>
      <div class="goal-stat">
        <div class="goal-stat-val" style="color:var(--text2)">${daysLeft!=null?daysLeft+'d':'—'}</div>
        <div class="goal-stat-lbl">Days Left</div>
      </div>
    </div>
    <div class="goal-progress-bar">
      <div class="goal-progress-fill" style="width:${progressFill}%;background:${fillCol}"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2)">
      <span>${progressPct}% of <strong style="color:var(--text)">${fmtN(targetGain,0)} SAR</strong> target</span>
      <span>Req. monthly: <strong style="color:var(--text)">${reqMonthly}%</strong></span>
    </div>
    ${progressPct >= 100 ? `<div style="margin-top:10px;padding:9px;background:rgba(0,230,118,.1);border:1px solid rgba(0,230,118,.2);border-radius:8px;font-size:12px;color:var(--green);font-weight:700">🎉 Goal reached! Consider resetting or raising the target.</div>` : ''}
    ${totalPL < -capitalSAR*(p.max_drawdown_pct/100) ? `<div style="margin-top:10px;padding:9px;background:rgba(255,61,113,.08);border:1px solid rgba(255,61,113,.2);border-radius:8px;font-size:12px;color:#ff5252;font-weight:700">⚠ Max drawdown limit (${p.max_drawdown_pct}%) breached — consider pausing new entries.</div>` : ''}
  </div>
</div>

<!-- Suggested Positions -->
<div class="goal-section-title" style="margin-bottom:8px">
  ✨ Suggested Positions
  <span style="font-weight:400;font-size:10px;color:var(--text3);margin-inline-start:6px">${sugRes?.total_candidates||0} liquid Sharia names screened · top quintile · ranked by the validated 6-month-momentum × 52-week-high combo (the one tested edge)${sugRes?.nextRebalance?` · next rebalance ${sugRes.nextRebalance}`:''}</span>
  <button class="btn btn-secondary" style="font-size:10px;padding:3px 10px;margin-inline-start:10px" onclick="loadGoalsPanel()">↻ Refresh</button>
</div>
${!goalsSuggested.length ? `<div class="suggested-empty"><div style="font-size:32px;margin-bottom:8px">🔍</div>Run a scan first, then come back to see personalized suggestions.<br><button class="btn btn-primary" style="margin-top:10px" onclick="switchTab('screener',document.querySelector('.tab'));startScan()">Run Scan</button></div>`
: (()=>{
  const slotsLeft = (window._goalsMeta||{}).slots_left;
  const openCount = (window._goalsMeta||{}).open_positions;
  const maxPos    = goalsData?.max_open_positions || 5;
  const slotsHtml = slotsLeft != null
    ? `<div style="font-size:11px;color:var(--text2);margin-bottom:12px;display:flex;align-items:center;gap:8px">
        <span>${openCount} of ${maxPos} position slots used</span>
        <span style="color:${slotsLeft===0?'#ff5252':slotsLeft<=1?'#ffd740':'var(--green)'};font-weight:700">${slotsLeft === 0 ? '⛔ Portfolio full' : slotsLeft === 1 ? '⚠ 1 slot remaining' : `✓ ${slotsLeft} slots open`}</span>
       </div>`
    : '';
  const tiers = [
    { key:'scale_in', label:'🔄 Scale In',           sub:'Already held · signal still strong — consider adding to position' },
    { key:'enter',    label:'🟢 Buy List',            sub:'Top-quintile momentum name — buy at the next monthly rebalance' },
    { key:'watch',    label:'🟡 Watch — Building',   sub:'Half size — add second half when score hits 7' },
    { key:'monitor',  label:'🔵 Monitor — Early',    sub:'No capital yet — watch for score 5+ to upgrade' },
  ];
  return slotsHtml + tiers.map(t => {
    const cards = goalsSuggested.filter(r => (r.tier||'enter') === t.key);
    if (!cards.length) return '';
    return `<div class="suggested-tier-header"><span>${t.label}</span><span style="font-weight:400;font-size:9px;text-transform:none;letter-spacing:0">${t.sub}</span></div><div class="suggested-grid">${cards.map((r, idx) => buildSuggestedCard(r, t.key === 'enter' && idx === 0)).join('')}</div>`;
  }).join('');
})()}
`;
}

function buildSuggestedCard(r, isFeature = false) {
  const fmt = v => v != null ? (+v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
  const styleColors = {Momentum:'#5ba3ff',Trend:'#00e676',Breakout:'#ffd740',Recovery:'#3d8bff',Pullback:'#6b7394'};
  const primaryCol = styleColors[r.primaryStyle] || 'var(--accent)';
  const tagHtml = (r.style_tags||[]).map(s=>`<span style="font-size:9px;font-weight:700;padding:1px 7px;border-radius:10px;background:${styleColors[s]||'var(--border2)'}22;color:${styleColors[s]||'var(--text2)'};border:1px solid ${styleColors[s]||'var(--border)'}44">${s}</span>`).join('');
  const hurstNote = r.hurst!=null ? (r.hurst>0.55?'Trending ✓':r.hurst<0.45?'Mean-Rev ⚠':'Random') : '';
  const atrNote   = r.atr_pct_rank!=null ? (r.atr_pct_rank<=20?'Coiling ⭐':r.atr_pct_rank>=80?'Volatile ⚠':'Normal vol') : '';
  const shariaHtml = r.sharia?.status === 'compliant' ? '<span style="font-size:9px;color:var(--green);font-weight:700">Sharia ✓</span>' : '';
  const tier = r.tier || 'enter';
  const tierBadgeMap = { enter:'🟢 Buy List', watch:'🟡 Watch — Building', monitor:'🔵 Monitor — Early', scale_in:'🔄 Scale In — Add to Position' };
  const tierBadge = `<span class="tier-badge ${tier}">${tierBadgeMap[tier]||tier}</span>`;
  const sizeNote = tier === 'watch'
    ? `<div class="tier-size-note">Half size — enter at 0.75% risk, add second half if score reaches 7</div>`
    : tier === 'monitor'
    ? `<div class="tier-size-note">No capital yet — watch for score 5+ before entering</div>`
    : tier === 'scale_in'
    ? `<div class="tier-size-note" style="color:#00e5ff">Already held · signal remains strong — consider adding the second half of your planned position</div>`
    : '';
  return `<div class="suggested-card${isFeature ? ' feature-card' : ''}" data-tier="${tier}" onclick="openDrawer(scanData.find(x=>x.sym==='${r.sym}')||{sym:'${r.sym}',name:'${(r.name||'').replace(/'/g,'')}'})">
  ${tierBadge}
  <div class="suggested-card-header">
    <div style="flex:1">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
        <span class="suggested-card-ticker">${r.sym.includes(':')?r.sym.split(':')[1]:r.sym}</span>
        ${biasBadgeHtml(r.bias)}
        <span style="font-size:10px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--text2)">${r.score}/${r.maxScore||9}</span>
        ${shariaHtml}
      </div>
      <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">${r.name}</div>
      <div style="display:flex;gap:4px">${tagHtml}</div>
    </div>
    <div style="text-align:end">
      <div style="font-size:20px;font-weight:800;font-family:'JetBrains Mono',monospace;color:var(--text)">${fmt(r.price)}</div>
      <div style="font-size:9px;color:var(--text3)">${[hurstNote,atrNote].filter(Boolean).join(' · ')}</div>
    </div>
  </div>
  <div class="suggested-why">${r.why}</div>
  <div class="suggested-plan">
    <div class="plan-cell"><div class="plan-cell-label">Entry</div><div class="plan-cell-val" style="color:var(--text)">${fmt(r.price)}</div></div>
    <div class="plan-cell"><div class="plan-cell-label">Stop</div><div class="plan-cell-val" style="color:#ff5252">${fmt(r.stop)}</div></div>
    <div class="plan-cell"><div class="plan-cell-label">T1</div><div class="plan-cell-val" style="color:var(--lime)">${fmt(r.t1)}</div></div>
    <div class="plan-cell"><div class="plan-cell-label">T2</div><div class="plan-cell-val" style="color:var(--green)">${fmt(r.t2)}</div></div>
  </div>
  ${sizeNote}
  ${r.shares ? `<div style="display:flex;gap:8px;margin-bottom:8px;font-size:11px;color:var(--text2)">
    <span>Shares: <strong style="color:var(--text)">${r.shares.toLocaleString()}</strong></span>
    <span>Value: <strong style="color:var(--text)">${r.positionValue?Math.round(r.positionValue).toLocaleString():'—'} SAR</strong></span>
    ${tier==='watch'?'<span style="color:#ffd740;font-size:10px">(half size)</span>':tier==='scale_in'?'<span style="color:#00e5ff;font-size:10px">(2nd half)</span>':''}
  </div>` : ''}
  ${r.t2Gain ? `<div class="suggested-contrib">
    If T2 hit → <strong>+${r.t2Gain.toLocaleString()} SAR (+${r.t2Pct}%)</strong>
    ${r.contributionPct ? ` · that's <strong>${r.contributionPct}% of your annual goal</strong>` : ''}
  </div>` : ''}
</div>`;
}

function toggleGoalEdit() {
  goalsEditing = !goalsEditing;
  const form = document.getElementById('goal-edit-form');
  const display = document.getElementById('goal-display-fields');
  if (form) form.style.display = goalsEditing ? 'block' : 'none';
  if (display) display.style.display = goalsEditing ? 'none' : 'flex';
}

function toggleGoalChip(el, group, value) {
  el.classList.toggle('active');
}

async function saveGoalProfile() {
  const getInput = id => document.getElementById(id);
  const getChips = id => [...document.querySelectorAll(`#${id} .goal-chip.active`)].map(c=>{
    const m=c.getAttribute('onclick').match(/'([^']+)'\)$/);
    return m?m[1]:null;
  }).filter(Boolean);

  const updates = {
    goal_name:           getInput('gf-name')?.value || 'My Trading Goal',
    capital_sar:         parseFloat(getInput('gf-capital')?.value) || 100000,
    target_return_pct:   parseFloat(getInput('gf-return')?.value)  || 15,
    horizon_months:      parseInt(getInput('gf-horizon')?.value)   || 12,
    risk_per_trade_pct:  parseFloat(getInput('gf-risk')?.value)    || 1.5,
    max_open_positions:  parseInt(getInput('gf-maxpos')?.value)    || 5,
    max_drawdown_pct:    parseFloat(getInput('gf-dd')?.value)      || 10,
    zakat_pct:           (v => isNaN(v) ? 2.5 : v)(parseFloat(getInput('gf-zakat')?.value)),
    goal_start_date:     getInput('gf-start')?.value || null,
    sharia_required:     document.getElementById('gf-sharia')?.checked || false,
    preferred_markets:   getChips('gf-markets'),
    style_preference:    getChips('gf-styles'),
  };

  try {
    await fetch('/api/goals/profile', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(updates) });
    goalsData = { ...goalsData, ...updates };
    goalsEditing = false;
    await loadGoalsPanel();
  } catch(e) { alert('Save failed: ' + e.message); }
}

// ════════════════════════════════════════════════════════════
// MULTI-ASSET ALLOCATION (Goals tab)
// ════════════════════════════════════════════════════════════
let allocationData = null;

async function loadAllocationPanel() {
  const el = document.getElementById('allocation-content');
  if (!el) return;
  el.innerHTML = `<div class="lab-insight-card" style="border-color:var(--accent)"><div style="font-size:11px;color:var(--text3)">Loading allocation policy…</div></div>`;
  try {
    const d = await fetch('/api/allocation').then(safeJson);
    if (d.error) throw new Error(d.error);
    allocationData = d;
    renderAllocationPanel();
  } catch(e) {
    el.innerHTML = `<div class="lab-insight-card"><div style="font-size:11px;color:var(--red)">Could not load allocation: ${e.message}</div></div>`;
  }
}

function renderAllocationPanel() {
  const el = document.getElementById('allocation-content');
  if (!el || !allocationData) return;
  const { policy, sleeves, rebalance, validated } = allocationData;
  const fmt = v => (+v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtPct = v => `${(((+v) || 0) * 100).toFixed(0)}%`;
  const byKey = Object.fromEntries(rebalance.sleeves.map(s => [s.key, s]));

  const weightRows = sleeves.map(s => {
    const w = policy.weights?.[s.key] ?? 0;
    const val = policy.values?.[s.key] ?? 0;
    return `
    <div style="display:grid;grid-template-columns:1.4fr 0.8fr 1fr;gap:10px;align-items:center;padding-block:6px;border-block-end:1px solid var(--border)">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--text)">${s.label}</div>
        <div style="font-size:9px;color:var(--text3)">${s.note}</div>
      </div>
      <div>
        <div style="font-size:9px;color:var(--text3);margin-block-end:2px">Weight %</div>
        <input class="goal-input goal-input-sm" id="alloc-w-${s.key}" type="number" step="1" min="0" value="${(w*100).toFixed(0)}" style="width:100%">
      </div>
      <div>
        <div style="font-size:9px;color:var(--text3);margin-block-end:2px">Current SAR</div>
        <input class="goal-input goal-input-sm" id="alloc-v-${s.key}" type="number" step="100" min="0" value="${(+val||0)}" style="width:100%">
      </div>
    </div>`;
  }).join('');

  const actionRows = sleeves.map(s => {
    const r = byKey[s.key] || {};
    const col = r.action === 'BUY' ? 'var(--green)' : r.action === 'SELL' ? 'var(--red)' : 'var(--text3)';
    const actionTxt = r.action === 'HOLD' ? 'HOLD' : `${r.action} ${fmt(r.amount)} SAR`;
    return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding-block:5px;border-block-end:1px solid var(--border);font-size:11px">
      <span style="color:var(--text2)">${s.label}</span>
      <span style="color:var(--text3);font-size:10px">${fmtPct(r.currentPct)} → ${fmtPct(r.targetPct)}</span>
      <span style="color:${col};font-weight:600">${actionTxt}</span>
    </div>`;
  }).join('');

  const totalTxt = rebalance.total > 0
    ? `Book value ${fmt(rebalance.total)} SAR · max drift ${rebalance.maxDriftPct.toFixed(1)}%`
    : 'Enter current SAR values per sleeve to see rebalance actions.';

  el.innerHTML = `
<div class="lab-insight-card" style="border-color:var(--accent)">
  <div style="font-size:14px;font-weight:700;color:var(--text);margin-block-end:4px">🧭 Multi-Asset Allocation</div>
  <div style="font-size:10px;color:var(--text3);line-height:1.5;margin-block-end:12px">
    A fixed-weight policy across your validated TASI momentum book, US-Sharia equity, and gold.
    Quarterly rebalancing lifted Sharpe ${validated.sharpe}, cut maxDD ${validated.maxDD},
    and added ${validated.rebalancePremium} (${validated.window}).
    <em style="color:var(--text3)">~5y sample, gold's run flatters it; weights are yours to set.</em>
  </div>

  <div style="margin-block-end:14px">${weightRows}</div>

  <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-block-end:6px">Rebalance actions</div>
  <div style="margin-block-end:6px">${actionRows}</div>
  <div style="font-size:9px;color:var(--text3);margin-block-end:12px">${totalTxt}</div>

  <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
    <span style="font-size:9px;color:var(--text3)">Cadence: <strong style="color:var(--text2)">${policy.cadence || 'quarterly'}</strong> — rebalance every 3 months back to target.</span>
    <button class="btn btn-primary" style="font-size:11px;padding:5px 14px" onclick="saveAllocationPolicy()">Save policy</button>
  </div>
</div>`;
}

async function saveAllocationPolicy() {
  if (!allocationData) return;
  const sleeves = allocationData.sleeves || [];
  const weights = {}, values = {};
  for (const s of sleeves) {
    const wEl = document.getElementById(`alloc-w-${s.key}`);
    const vEl = document.getElementById(`alloc-v-${s.key}`);
    weights[s.key] = (parseFloat(wEl?.value) || 0) / 100;
    values[s.key]  = parseFloat(vEl?.value) || 0;
  }
  try {
    const d = await fetch('/api/allocation', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weights, values, cadence: allocationData.policy?.cadence || 'quarterly' }),
    }).then(safeJson);
    if (d.error) throw new Error(d.error);
    allocationData = d;
    renderAllocationPanel();
  } catch(e) { alert('Save failed: ' + e.message); }
}

// ════════════════════════════════════════════════════════════
// ACCURACY LAB
// ════════════════════════════════════════════════════════════
let labData = null;

async function loadLabPanel() {
  const el = document.getElementById('lab-content');
  if (!el) return;
  el.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text3);font-size:12px">Loading accuracy data…</div>`;
  try {
    const res = await fetch('/api/lab/signals?limit=200').then(safeJson);
    if (res.error) throw new Error(res.error);
    labData = res;
    renderLabPanel(res);
  } catch(e) {
    el.innerHTML = `<div style="padding:20px;color:var(--red);font-size:12px;line-height:1.6">
      <strong>Could not load Lab page.</strong><br>
      ${e.message}<br><br>
      <span style="color:var(--text3)">Restart the server: <code style="background:var(--bg2);padding:2px 6px;border-radius:4px">node dashboard/server.mjs</code></span>
    </div>`;
  }
}

function renderLabPanel(d) {
  const el = document.getElementById('lab-content');
  if (!el) return;
  const s = d.stats || {};
  const fmt2 = v => v != null ? (+v).toFixed(2) : '—';

  // Raw outcomes row — CONTEXT ONLY. Hit-rates flatter signals in a rising market; the
  // True Edge card above (excess vs equal-weight basket, net cost) is the real scorecard.
  const statCol = v => v >= 70 ? 'var(--green)' : v >= 50 ? 'var(--yellow)' : '#ff5252';
  const statsHtml = `<div style="display:flex;align-items:center;gap:8px;margin:14px 0 6px" title="Raw outcomes (context only)::These count how often a signal hit its target or stop — but in a rising market most things hit targets, so a high number here is NOT proof of skill. The honest scorecard is the True Edge card above, which measures whether the signal beats a fair equal-weight basket after costs. Read these as descriptive history, not as an edge.">
      <span style="font-size:11px;font-weight:700;color:var(--text2)">Raw outcomes</span>
      <span style="font-size:10px;color:var(--text3)">context only · flattered by a rising market · not proof of edge (see True Edge above)</span>
    </div>
    <div class="lab-stats-grid">
    <div class="lab-stat"><div class="lab-stat-val" style="color:var(--accent)">${s.total||0}</div><div class="lab-stat-lbl">Total Signals</div></div>
    <div class="lab-stat"><div class="lab-stat-val" style="color:${statCol(s.t1_rate||0)}">${s.t1_rate||0}%</div><div class="lab-stat-lbl">T1 Hit Rate</div></div>
    <div class="lab-stat"><div class="lab-stat-val" style="color:${statCol(s.t2_rate||0)}">${s.t2_rate||0}%</div><div class="lab-stat-lbl">T2 Hit Rate</div></div>
    <div class="lab-stat"><div class="lab-stat-val" style="color:${(s.stop_rate||0)<=30?'var(--green)':'#ff5252'}">${s.stop_rate||0}%</div><div class="lab-stat-lbl">Stop Rate</div></div>
    <div class="lab-stat"><div class="lab-stat-val" style="color:${(s.avg_r||0)>=0?'var(--green)':'#ff5252'}">${fmt2(s.avg_r)}R</div><div class="lab-stat-lbl">Avg R-Multiple</div></div>
  </div>`;

  // Regime strip — what this means
  const regimeNote = s.total < 10
    ? `<div class="lab-regime-strip">Log at least 10 completed signals to unlock insights. The system automatically logs all STRONG BUY/SELL signals (score ≥7). <strong>Active signals: ${s.active||0}</strong></div>`
    : `<div class="lab-regime-strip">Based on <strong>${s.total} completed signals</strong>, raw expectancy is <strong style="color:${(s.avg_r||0)>=0?'var(--green)':'#ff5252'}">${fmt2(s.avg_r)}R per trade</strong> — but this just counts target-hits vs stop-outs, which a rising market inflates. <strong>Whether the signal has a real edge is the True Edge card above</strong> (excess vs an equal-weight basket, net of cost). Treat this R number as descriptive history, not proof of skill.</div>`;

  // Insights
  const insights = d.insights || [];
  const insightsHtml = insights.length < 2 ? '' : `
  <div class="lab-insight-card">
    <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:8px">What's Working For You</div>
    ${insights.map(ins => {
      const badgeCol = ins.rating==='strong'?'rgba(0,230,118,.15)':ins.rating==='moderate'?'rgba(255,215,64,.12)':'rgba(255,61,113,.1)';
      const badgeTxt = ins.rating==='strong'?'var(--green)':ins.rating==='moderate'?'var(--yellow)':'#ff5252';
      return `<div class="lab-insight-row">
        <span class="lab-insight-badge" style="background:${badgeCol};color:${badgeTxt}">${ins.rating.toUpperCase()}</span>
        <span style="font-weight:600;min-width:100px">${ins.style}</span>
        <span style="color:var(--text3);font-size:11px">${ins.market.toUpperCase()}</span>
        <span style="margin-inline-start:auto;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700">T1: ${ins.t1_rate}%</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${ins.avg_r>=0?'var(--green)':'#ff5252'}">${ins.avg_r>=0?'+':''}${fmt2(ins.avg_r)}R</span>
        <span style="font-size:10px;color:var(--text3)">${ins.count} signals</span>
      </div>`;
    }).join('')}
  </div>`;

  // Active signals table
  const active = d.active || [];
  const activeHtml = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div style="font-size:12px;font-weight:700;color:var(--text)">Active Signals <span style="color:var(--text3);font-weight:400">(${active.length})</span></div>
    <button class="btn btn-secondary" style="font-size:10px;padding:3px 10px" onclick="showLabLogForm()">+ Log Signal</button>
  </div>
  <div id="lab-log-form" style="display:none;background:var(--card);border:1px solid var(--glass-border);border-radius:var(--radius);padding:12px 14px;margin-bottom:10px">
    <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:10px">Manually Log a Signal</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:8px">
      <div><div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:3px">Symbol</div><input id="lab-sym" class="goal-input goal-input-sm" placeholder="TADAWUL:1120"></div>
      <div><div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:3px">Entry Price</div><input id="lab-entry" class="goal-input goal-input-sm" type="number" step="0.01"></div>
      <div><div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:3px">Stop</div><input id="lab-stop" class="goal-input goal-input-sm" type="number" step="0.01"></div>
      <div><div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:3px">T1</div><input id="lab-t1" class="goal-input goal-input-sm" type="number" step="0.01"></div>
      <div><div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:3px">T2</div><input id="lab-t2" class="goal-input goal-input-sm" type="number" step="0.01"></div>
      <div><div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:3px">Bias</div><select id="lab-bias" class="goal-input goal-input-sm"><option>STRONG BUY</option><option>BUY</option><option>STRONG SELL</option><option>SELL</option></select></div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" style="font-size:11px" onclick="submitLabSignal()">Log Signal</button>
      <button class="btn btn-secondary" style="font-size:11px" onclick="document.getElementById('lab-log-form').style.display='none'">Cancel</button>
    </div>
  </div>
  ${!active.length ? `<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">No active signals. Run a scan to auto-log strong signals.</div>` :
    `<div class="lab-table-wrap"><table class="lab-table">
      <thead><tr><th>Symbol</th><th>Logged</th><th>Entry</th><th>Stop</th><th>T1</th><th>T2</th><th>P&L vs Entry</th><th>Days Open</th><th>Action</th></tr></thead>
      <tbody>${active.map(sig => {
        const r = scanData.find(x=>x.sym===sig.sym);
        const curr = r?.price;
        const pnlPct = curr && sig.price_entry ? +((curr-sig.price_entry)/sig.price_entry*100).toFixed(2) : null;
        const pnlCol = pnlPct==null?'var(--text3)':pnlPct>=0?'var(--green)':'#ff5252';
        const daysOpen = sig.logged_at ? Math.round((Date.now()-new Date(sig.logged_at).getTime())/86400000) : '?';
        const fmt = v => v!=null?(+v).toFixed(2):'—';
        const tags = JSON.parse(sig.style_tags||'[]');
        const displayName = sig.name && sig.name !== sig.sym ? sig.name : (r?.name || '');
        return `<tr>
          <td><span class="td-ticker" style="font-size:11px">${tickerDisplay(sig.sym)}</span>${displayName?`<br><span style="font-size:10px;color:var(--text2);font-weight:500">${displayName}</span>`:''}${tags.length?`<br><span style="font-size:9px;color:var(--text3)">${tags.join(', ')}</span>`:sig.scan_mode?`<br><span style="font-size:9px;color:var(--text3)">${sig.scan_mode}</span>`:''}</td>
          <td style="color:var(--text3);font-size:11px">${sig.logged_at||'—'}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${fmt(sig.price_entry)}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#ff5252">${fmt(sig.price_stop)}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--lime)">${fmt(sig.price_t1)}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--green)">${fmt(sig.price_t2)}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:${pnlCol}">${pnlPct!=null?(pnlPct>=0?'+':'')+pnlPct+'%':'—'}</td>
          <td style="color:${daysOpen>=8?'var(--orange)':'var(--text2)'};font-size:11px">${daysOpen}d${daysOpen>=8?' ⚠':''}</td>
          <td><button onclick="markLabOutcome(${sig.id},'manual')" class="alert-btn" style="font-size:10px">Mark</button> <button onclick="deleteLabSignal(${sig.id})" class="pos-del-btn" style="font-size:12px">✕</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`
  }`;

  // Completed signals
  const completed = (d.completed || []).filter(x=>x.outcome!==null);
  const completedHtml = completed.length ? `
  <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:8px;margin-top:6px">Completed (${completed.length})</div>
  <div class="lab-table-wrap"><table class="lab-table">
    <thead><tr><th>Symbol</th><th>Date</th><th>Entry</th><th>Outcome</th><th>R-Multiple</th><th>Days</th><th>Style</th></tr></thead>
    <tbody>${completed.slice(0,50).map(sig => {
      const oc = sig.outcome;
      const cls = oc==='t2'?'outcome-t2':oc==='t1'?'outcome-t1':oc==='stop'?'outcome-stop':oc==='expired'?'outcome-exp':'outcome-open';
      const icon = oc==='t2'?'🎯 T2':oc==='t1'?'✅ T1':oc==='stop'?'🛑 Stop':oc==='expired'?'⏱ Expired':'◆';
      const fmt = v => v!=null?(+v).toFixed(2):'—';
      const rCol = (sig.r_multiple||0)>=0?'var(--green)':'#ff5252';
      const tags = JSON.parse(sig.style_tags||'[]');
      const rComp = scanData.find(x=>x.sym===sig.sym);
      const dispName = sig.name && sig.name !== sig.sym ? sig.name : (rComp?.name || '');
      return `<tr>
        <td><span class="td-ticker" style="font-size:11px">${tickerDisplay(sig.sym)}</span>${dispName?`<br><span style="font-size:10px;color:var(--text2);font-weight:500">${dispName}</span>`:''}</td>
        <td style="color:var(--text3);font-size:10px">${sig.logged_at||'—'}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${fmt(sig.price_entry)}</td>
        <td class="${cls}" style="font-size:11px">${icon}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:11px;color:${rCol}">${sig.r_multiple!=null?(sig.r_multiple>=0?'+':'')+fmt(sig.r_multiple)+'R':'—'}</td>
        <td style="color:var(--text3);font-size:11px">${sig.days_to_outcome||'—'}</td>
        <td style="font-size:10px;color:var(--text3)">${tags.join(', ')||sig.scan_mode||'—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>` : '';

  // Win-rate breakdown by category (loaded async after main render)
  const momentumPointer = `<div class="lab-insight-card" style="border-color:var(--accent);display:flex;align-items:center;gap:10px;cursor:pointer" onclick="switchTab('momentum',document.getElementById('tab-momentum'))" title="Momentum Screen::The one validated edge that beats the market on your real constraints. It now lives in its own tab — click to open the monthly buy-list.">
    <span style="font-size:20px">📈</span>
    <div style="flex:1">
      <div style="font-size:12px;font-weight:800;color:var(--text)">Momentum Screen — the validated edge</div>
      <div style="font-size:10px;color:var(--text3);line-height:1.4">Sharia-compliant, liquid, ≥2y-listed names ranked by 6-month momentum; excess +10–15%/yr vs basket, t=2.6–3.2, OOS-stable. The Lab proves the engine works — the buy-list lives in its own tab.</div>
    </div>
    <span style="font-size:11px;font-weight:700;color:var(--accent);white-space:nowrap">Open Signals →</span>
  </div>`;
  el.innerHTML = momentumPointer + `<div id="lab-strategy-section"></div>` + `<div id="lab-validation-section"></div>` + statsHtml + regimeNote + insightsHtml + `<div id="lab-win-rates-section"></div>` + activeHtml + completedHtml;
  loadLabStrategy();
  loadLabValidation();
  loadLabWinRates();
}

// ── Momentum Screen: the validated monthly buy-list (Sharia + liquid + ≥2y + top-quintile 6mo momentum) ──
async function loadMomentumScreen() {
  const el = document.getElementById('momentum-content');
  if (!el) return;
  el.innerHTML = `<div class="lab-insight-card" style="border-color:var(--accent)"><div style="font-size:11px;color:var(--text3)">Loading momentum screen…</div></div>`;
  try {
    const d = await fetch('/api/lab/momentum').then(r => r.json());
    if (!d.success) { el.innerHTML = `<div class="lab-insight-card"><div style="font-size:10px;color:var(--text3)">Momentum screen unavailable: ${d.error || 'error'}</div></div>`; return; }
    const col = v => v > 0 ? 'var(--green)' : v < 0 ? '#ff5252' : 'var(--text3)';
    const rows = d.holdings.map(h => `<tr>
      <td style="font-size:10px;color:var(--text3);text-align:center">${h.rank}</td>
      <td style="font-size:11px;font-weight:600;color:var(--text);cursor:help" title="${h.name} (${h.code})::Why it's eligible (Sharia): ${(h.sharia||'').replace(/"/g,'')}">${h.name} <span style="color:var(--text3);font-weight:400">${h.code}</span></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--text2)">${h.price}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;font-weight:700;color:${col(h.mom6)}">${h.mom6 >= 0 ? '+' : ''}${h.mom6}%</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:${col(h.ret1m)}">${h.ret1m >= 0 ? '+' : ''}${h.ret1m}%</td>
    </tr>`).join('');
    const v = d.validated, p = d.params, u = d.universe, sn = d.seasonal || {};
    const seasonBanner = sn.currentMonthName ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:7px 10px;border-radius:8px;cursor:help;background:${sn.inSeason ? 'var(--green)' : '#ff5252'}1a;border:1px solid ${sn.inSeason ? 'var(--green)' : '#ff5252'}55" title="Seasonal overlay::Over many years, two calendar months (here May & Oct) have been reliably weak for Saudi stocks. Sitting in cash during just those months shrank the scary drops without giving up returns. This banner tells you whether the current month is safe to be invested (IN SEASON) or one to wait out (SIT OUT).">
        <span style="font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px;background:${sn.inSeason ? 'var(--green)' : '#ff5252'};color:#000">${sn.inSeason ? 'IN SEASON' : 'SIT OUT'}</span>
        <span style="font-size:10px;color:var(--text2);line-height:1.4">Seasonal overlay · ${sn.note} <span style="color:var(--text3)">Weakest months: ${(sn.weakestMonthNames || []).join(' & ')}.</span></span>
      </div>` : '';
    const sz = d.sizing || {};
    const ts = d.turnover || { buy: [], hold: [], sell: [] };
    const stt = d.state || {};
    const stColor = stt.status === 'promoted' ? 'var(--green)' : stt.status === 'decaying' ? 'var(--yellow)' : '#ff5252';
    const stateBadge = stt.status ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:7px 10px;border-radius:8px;cursor:help;background:${stColor}1a;border:1px solid ${stColor}55" title="Strategy state::An automatic governor on how hard to size this strategy. PROMOTED = full size (the edge is proven and holding). DECAYING = risk halved (recent performance slipped). RETIRED/CANDIDATE = 0% (not trusted right now). It moves down automatically if the edge weakens.">
        <span style="font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px;background:${stColor};color:#000">${String(stt.status).toUpperCase()}</span>
        <span style="font-size:10px;color:var(--text2);line-height:1.4">Effective sizing ${Math.round((stt.exposure_mult ?? 0) * 100)}% of Scheme-D${stt.reason ? ` · ${stt.reason}` : ''}</span>
      </div>` : '';
    const nm = h => `${h.name} <span style="color:var(--text3);font-weight:400">${h.code || ''}</span>`;
    const listLine = (label, arr, color, render) => `<div style="margin-bottom:5px"><span style="font-size:9px;font-weight:800;color:${color};text-transform:uppercase;letter-spacing:.5px">${label} (${arr.length})</span> <span style="font-size:11px;color:var(--text2)">${arr.length ? arr.map(render).join(', ') : '—'}</span></div>`;
    const turnoverBlock = `<div style="margin-bottom:10px;padding:8px 10px;border-radius:8px;background:var(--bg2);border:1px solid var(--border)" title="This month's trades::What to do vs what you currently hold. BUY = new picks you don't own. HOLD = picks you already own (keep them). SELL = names you own that fell out of the top list (exit). Based on your logged positions.">
        <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px">This month's trades</div>
        ${listLine('Buy', ts.buy || [], 'var(--green)', nm)}
        ${listLine('Hold', ts.hold || [], 'var(--text2)', nm)}
        ${listLine('Sell', ts.sell || [], '#ff5252', h => nm(h))}
        ${(!(ts.hold||[]).length && !(ts.sell||[]).length) ? `<div style="font-size:9px;color:var(--text3);margin-top:4px">You hold nothing in these names yet — this is your starting buy-list. Log positions to track HOLD/SELL.</div>` : ''}
      </div>`;
    const sarCalc = sz.exposurePct != null ? `<div style="margin-bottom:10px;padding:8px 10px;border-radius:8px;background:var(--bg2);border:1px solid var(--border)" title="Order-size calculator::Type your account size; it splits the invested fraction equally across the picks so you know how many Riyals to put in each name.">
        <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px">Order sizing</div>
        <label style="font-size:10px;color:var(--text2)">Account (SAR) <input id="mom-acct" type="number" value="100000" style="width:110px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 6px;font-family:'JetBrains Mono',monospace;font-size:11px"></label>
        <span id="mom-sar-out" style="font-size:11px;color:var(--text2);margin-left:8px"></span>
      </div>` : '';
    const sizingBanner = sz.exposurePct != null ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:8px 10px;border-radius:8px;cursor:help;background:var(--accent)14;border:1px solid var(--accent)44" title="Position sizing (how much to invest)::Owning the right stocks is only half the job — the other half is how much money to put in. This model shrinks how much of your account is invested when the market gets jumpy (high volatility) and pushes it back up when things calm down, aiming for a steady ${sz.targetVolPct}%/yr risk level. In the backtest this turned a brutal −21% year into about −8%, for a smaller cut to long-run returns. In a weak month it goes fully to cash.">
        <div style="display:flex;flex-direction:column;align-items:center;min-width:54px">
          <span style="font-size:20px;font-weight:800;color:var(--accent);line-height:1">${sz.exposurePct}%</span>
          <span style="font-size:8px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">invested</span>
        </div>
        <span style="font-size:10px;color:var(--text2);line-height:1.45">${sz.note}</span>
      </div>` : '';
    const hero = `<div class="mom-hero">
      <div class="eyebrow">The one validated edge</div>
      <h2>This month's momentum buy-list</h2>
      <p>${d.universe?.liquid ?? ''} liquid Sharia names screened · top quintile · ranked by the 6-month-momentum × 52-week-high combo${d.nextRebalance ? ` · next rebalance ${d.nextRebalance}` : ''}.</p>
    </div>`;
    el.innerHTML = hero + `<div class="lab-insight-card" style="border-color:var(--accent)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
        <span style="font-size:12px;font-weight:800;color:var(--text);cursor:help" title="Momentum Screen::A monthly shopping list of stocks to buy. It picks the Saudi shares that have climbed the most over the past 6 months — the idea (called momentum) is that recent winners tend to keep winning for a while. You refresh the list once a month.">Momentum Screen</span>
        <span style="font-size:10px;color:var(--text3);cursor:help" title="How the list is filtered::Start with Sharia-compliant stocks only → keep the easier-to-trade half (liquid) → keep only companies listed at least 2 years (skip fresh IPOs, whose prices are too jumpy) → then take the top 20% by 6-month gain.">monthly buy-list · Sharia-compliant · liquid · ≥2y listed · top-quintile 6mo momentum</span>
      </div>
      ${stateBadge}
      ${seasonBanner}
      ${sizingBanner}
      ${turnoverBlock}
      ${sarCalc}
      <div style="font-size:10px;color:var(--text3);line-height:1.5;margin-bottom:10px">The one validated edge on your real constraints (<span style="cursor:help" title="Trading cost::Derayah charges no commission — only ~0.11% in regulatory fees for a full buy-and-sell round trip. Low cost is what makes a monthly-rebalanced strategy worthwhile.">Derayah ${p.cost}</span>). Backtest: <span style="cursor:help" title="Excess return::How much MORE this strategy made per year than just owning every compliant stock equally. This is the honest measure of skill — beating a fair benchmark, not just going up with the market.">excess</span> <strong style="color:var(--green)">${v.excessPerYr}</strong> vs equal-weight compliant basket · <span style="cursor:help" title="Absolute return (CAGR)::The actual compounded yearly growth of the money itself — what your account balance would do per year, on average.">abs CAGR ${v.absCagr}</span> · <span style="cursor:help" title="Statistical significance (t-stat)::How sure we are this is a real pattern and not luck. Above 2 means it would rarely happen by chance; this scores 2.6–3.2, which is solid.">t=${v.nwT}</span> · <span style="cursor:help" title="Maximum drawdown::The worst drop from a peak to a low you'd have lived through. Smaller is better — and this strategy's worst drop was milder than the market's.">maxDD ${v.maxDD}</span>. <span style="color:var(--yellow);cursor:help" title="Important caveats::The numbers are honest but not bulletproof: the data only includes companies still trading today (shave ~1–1.5%/yr for that), and the Sharia screen is partly sector-based — double-check each name's financial ratios (debt, interest income) before you actually buy it.">${v.caveat}</span></div>
      <div class="lab-stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px">
        <div class="lab-stat" style="cursor:help" title="Equal-weight picks::How many stocks to hold. You split your money evenly across all of them (about ${p.weighting.replace('equal-weight (~','').replace(')','')}), so no single stock can sink you.">${''}<div class="lab-stat-val" style="font-size:18px;color:var(--text)">${u.holdings}</div><div class="lab-stat-lbl">equal-weight picks</div><div style="font-size:9px;color:var(--text3);margin-top:3px">${p.weighting}</div></div>
        <div class="lab-stat" style="cursor:help" title="How the list narrows::Of ${u.compliant} Sharia-compliant names, ${u.eligible} have enough price history to rank. We then keep the ${u.liquid} most-liquid (easiest to buy and sell) and pick the top fifth of those by momentum."><div class="lab-stat-val" style="font-size:18px;color:var(--text)">${u.eligible}</div><div class="lab-stat-lbl">eligible / ${u.compliant} compliant</div><div style="font-size:9px;color:var(--text3);margin-top:3px">liquid half = ${u.liquid}</div></div>
        <div class="lab-stat" style="border-color:var(--accent);cursor:help" title="Next rebalance::The date to redo this screen — re-rank, drop names that fell out of the top list, add new winners. Momentum fades, so it must be refreshed monthly."><div class="lab-stat-val" style="font-size:15px;color:var(--accent)">${d.nextRebalance}</div><div class="lab-stat-lbl">next rebalance</div><div style="font-size:9px;color:var(--text3);margin-top:3px">as of ${d.asOf}</div></div>
      </div>
      <div class="lab-table-wrap"><table class="lab-table">
        <thead><tr><th style="text-align:center;cursor:help" title="Rank::Position by 6-month gain. #1 is the strongest recent performer.">#</th><th style="cursor:help" title="Company::The stock name and its 4-digit Tadawul code. Hover a row to see why it counts as Sharia-compliant.">Name</th><th style="text-align:end;cursor:help" title="Price::Most recent closing price, in Saudi Riyals.">Price</th><th style="text-align:end;cursor:help" title="6-month momentum::How much the share rose (or fell) over roughly the last 6 months, ignoring the most recent month. This number decides the ranking.">Mom 6mo</th><th style="text-align:end;cursor:help" title="Last month::Return over the past month — shown for context only. The strategy deliberately skips this most-recent month when ranking, because very-recent moves tend to reverse.">Last 1mo</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div style="font-size:9px;color:var(--text3);margin-top:8px">Hold equal-weight until ${d.nextRebalance}, then re-screen. Sit out the 2 historically-weakest months (seasonal overlay) for lower drawdown.</div>
    </div>`;
    const acct = document.getElementById('mom-acct'), out = document.getElementById('mom-sar-out');
    if (acct && out) {
      const recompute = () => {
        const n = (d.holdings || []).length;
        const exp = (d.sizing?.exposurePct) || 0;
        const A = +acct.value || 0;
        const perName = n > 0 ? Math.round(A * (exp / 100) / n) : 0;
        const deployed = perName * n, cash = Math.round(A) - deployed;
        out.textContent = n ? `→ ${perName.toLocaleString()} SAR/name × ${n} = ${deployed.toLocaleString()} invested, ${cash.toLocaleString()} cash` : 'no eligible picks this month';
      };
      acct.addEventListener('input', recompute);
      recompute();
    }
  } catch(_) { el.innerHTML = `<div class="lab-insight-card"><div style="font-size:10px;color:var(--text3)">Momentum screen failed to load.</div></div>`; }
}

// ── PEAD Satellite: validated 2nd edge (conditioned PEAD, guillotine t 2.14) but BORDERLINE ──
// Small orthogonal sleeve (~10% risk budget). Event-driven → usually empty between earnings seasons.
async function loadPeadScreen() {
  const el = document.getElementById('pead-content');
  if (!el) return;
  el.innerHTML = `<div class="lab-insight-card" style="margin-top:12px"><div style="font-size:11px;color:var(--text3)">Loading PEAD satellite…</div></div>`;
  try {
    const d = await fetch('/api/lab/pead').then(r => r.json());
    if (!d.success) { el.innerHTML = `<div class="lab-insight-card" style="margin-top:12px"><div style="font-size:10px;color:var(--text3)">PEAD satellite unavailable: ${d.error || 'error'}</div></div>`; return; }
    const st = d.status || {}, sz = d.sizing || {}, p = d.params || {};
    const rows = (d.holdings || []).map(h => `<tr>
      <td style="font-size:11px;font-weight:600;color:var(--text)">${h.name} <span style="color:var(--text3);font-weight:400">${h.code}</span></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--text2)">${h.price}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;font-weight:700;color:var(--green)">+${(h.reaction).toFixed?.(1) ?? h.reaction}%</td>
      <td style="font-size:10px;text-align:end;color:var(--text3)">${h.entryDate || '—'}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:center;color:var(--text2)">${h.sessionsRemaining ?? '—'}</td>
    </tr>`).join('');
    const body = (d.holdings || []).length
      ? `<div class="lab-table-wrap"><table class="lab-table">
          <thead><tr>
            <th title="Company that just reported earnings with a strong reaction, while in a momentum uptrend.">Name</th>
            <th style="text-align:end">Price</th>
            <th style="text-align:end" title="Earnings-day abnormal reaction vs the market — the surprise that drives the drift.">Reaction</th>
            <th style="text-align:end" title="Buy 2 sessions after the earnings reaction.">Entry</th>
            <th style="text-align:center" title="Sessions left in the ~20-session (1-month) hold before you exit.">Days left</th>
          </tr></thead>
          <tbody>${rows}</tbody></table></div>
         <div style="font-size:9px;color:var(--text3);margin-top:8px">${sz.note || ''} Exit each name at the end of its ~20-session window.</div>`
      : `<div style="font-size:11px;color:var(--text2);padding:10px 0;line-height:1.6">${d.note || 'No open PEAD candidates right now.'}</div>`;
    el.innerHTML = `<div class="lab-insight-card" style="margin-top:12px;border-color:var(--yellow)55">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="font-size:12px;font-weight:800;color:var(--text)">🛰 PEAD Satellite</span>
        <span style="font-size:9px;font-weight:800;padding:2px 8px;border-radius:10px;background:var(--yellow);color:#000">EXPERIMENTAL · 2nd sleeve</span>
      </div>
      <div style="font-size:10px;color:var(--text3);line-height:1.5;margin-bottom:10px" title="A second, smaller strategy: when a stock that's already in a momentum uptrend reports earnings with a strong, high-volume market reaction, it tends to keep drifting up for about a month. Validated but borderline — keep it small.">${st.detail || 'Post-earnings drift, conditioned on momentum + volume. Small experimental sleeve.'} <span style="color:var(--text3)">Rule: ${p.rule || ''} · hold ${p.hold || ''}.</span></div>
      ${body}
    </div>`;
  } catch(_) { el.innerHTML = `<div class="lab-insight-card" style="margin-top:12px"><div style="font-size:10px;color:var(--text3)">PEAD satellite failed to load.</div></div>`; }
}

// ── Block-Deal Watch: EXPERIMENTAL — fails the per-period gate (t 1.94), underpowered ~1y ──
async function loadBlockDealSignal() {
  const el = document.getElementById('blockdeal-content');
  if (!el) return;
  el.innerHTML = `<div class="lab-insight-card" style="margin-top:12px"><div style="font-size:11px;color:var(--text3)">Loading block-deal signal…</div></div>`;
  try {
    const d = await fetch('/api/lab/blockdeals').then(r => r.json());
    if (!d.success) { el.innerHTML = ''; return; }
    const col = v => v > 0 ? 'var(--green)' : v < 0 ? '#ff5252' : 'var(--text3)';
    const sh = s => s === 'compliant' ? '<span style="color:#2dd4bf" title="Sharia::Passes the compliance screen — verify financial ratios before buying.">✓ halal</span>' : `<span style="color:var(--yellow)" title="Sharia::Not on the compliant list (${s}). Excluded from your tradeable set.">⚠ ${s}</span>`;
    const rows = (d.signals || []).map(s => `<tr style="${s.sharia === 'compliant' ? '' : 'opacity:.55'}">
      <td style="font-size:11px;font-weight:600;color:var(--text)" title="Block deal on ${s.dealDate} at ${s.dealPrice} (${s.valueM}M SAR), ${s.premiumPct >= 0 ? '+' : ''}${s.premiumPct}% vs market.::${s.cls === 'premium' ? 'A buyer paid up — the bullish case.' : 'Traded at market — clean accumulation.'}">${s.name} <span style="color:var(--text3);font-weight:400">${s.code}</span></td>
      <td style="font-size:10px;text-align:center"><span style="padding:1px 6px;border-radius:10px;background:rgba(45,212,191,.14);color:#2dd4bf;font-weight:700">${s.cls}</span></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--text2)" title="How far above the market price the block traded — bigger premium = more aggressive buyer.">${s.premiumPct >= 0 ? '+' : ''}${s.premiumPct}%</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:${col(s.sinceDealPct)}" title="Price change since the deal day.">${s.sinceDealPct >= 0 ? '+' : ''}${s.sinceDealPct}%</td>
      <td style="font-size:10px;text-align:end;color:var(--text2)" title="Trading days left in the validated ~20-session (1-month) hold window.">${s.sessionsLeft}d</td>
      <td style="font-size:10px;text-align:end">${sh(s.sharia)}</td>
    </tr>`).join('');
    const st = d.status || {}, u = d.universe || {};
    const body = !(d.signals || []).length
      ? `<div style="font-size:10px;color:var(--text3);padding:4px 0">${d.note || 'No active big-premium block deals right now.'}</div>`
      : `<div class="lab-table-wrap"><table class="lab-table">
          <thead><tr><th>Name</th><th style="text-align:center">Sign</th><th style="text-align:end">Premium</th><th style="text-align:end">Since deal</th><th style="text-align:end">Window</th><th style="text-align:end">Halal</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <div style="font-size:9px;color:var(--text3);margin-top:8px">${u.skippedDiscount || 0} discount deals skipped (informed sellers). Data as of ${d.asOf}.</div>`;
    el.innerHTML = `<div class="lab-insight-card" style="border-color:var(--yellow);margin-top:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
        <span style="font-size:12px;font-weight:800;color:var(--text)">Block-Deal Watch 🐋</span>
        <span style="font-size:10px;color:var(--yellow);font-weight:700">EXPERIMENTAL · not a validated edge</span>
      </div>
      <div style="font-size:10px;color:var(--text3);line-height:1.5;margin-bottom:10px" title="Status::Big trades at/above market (aggressive buyers) drift up modestly over ~1 month in the data, but this does NOT clear the per-period significance gate (t 1.94 < 2) and rests on only ~1 year of deal history. Shown for awareness — do not size on it.">Big trades printing <strong>at or above</strong> market are a possible accumulation tell, but <strong style="color:var(--yellow)">this fails the significance gate (t 1.94 &lt; 2)</strong> and is underpowered (~1y of data). ${st.effect || ''}. <span style="color:var(--text3)">Awareness only — not a tradeable edge.</span></div>
      ${body}
    </div>`;
  } catch(_) { el.innerHTML = ''; }
}

// ── Real Fill Ledger: your actual Derayah book — log fills, see HOLD/SELL + live P&L ──
let fillData = null;
let trackingData = null;

async function loadFillLedger() {
  const el = document.getElementById('fills-content');
  if (!el) return;
  if (!fillData) el.innerHTML = `<div class="lab-insight-card" style="border-color:var(--accent)"><div style="font-size:11px;color:var(--text3)">Loading fill ledger…</div></div>`;
  try {
    const [d, t] = await Promise.all([
      fetch('/api/fills').then(safeJson),
      fetch('/api/tracking').then(safeJson).catch(() => ({})),
    ]);
    if (d.error) throw new Error(d.error);
    fillData = d;
    trackingData = t && !t.error ? t : null;
    renderFillLedger();
  } catch(e) {
    el.innerHTML = `<div class="lab-insight-card"><div style="font-size:11px;color:var(--red)">Could not load fills: ${e.message}</div></div>`;
  }
}

function renderFillLedger() {
  const el = document.getElementById('fills-content');
  if (!el || !fillData) return;
  const { ledger = [], open = [], summary = {}, prices = {} } = fillData;
  const sar = n => 'SAR ' + Math.round(+n || 0).toLocaleString('en-US');
  const sign = n => ((+n) >= 0 ? '+' : '−') + Math.abs(Math.round(+n || 0)).toLocaleString('en-US');
  const pct1 = n => ((+n) >= 0 ? '+' : '−') + Math.abs(+n || 0).toFixed(1) + '%';   // slippage keeps a decimal
  const pcol = n => (+n) > 0 ? 'var(--green)' : (+n) < 0 ? 'var(--red)' : 'var(--text3)';
  const code = s => (s || '').replace('TADAWUL:', '');

  // Open book rows — avg cost vs latest scan price = unrealized P&L
  const openRows = open.map(p => {
    const px = prices[p.sym];
    const upl = px != null ? p.shares * (px - p.avgCost) : null;
    return `<tr>
      <td style="font-size:11px;font-weight:600;color:var(--text)">${p.name && p.name !== p.sym ? p.name : ''} <span style="color:var(--text3);font-weight:400">${code(p.sym)}</span></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--text2)">${p.shares}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--text2)">${p.avgCost}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--text3)">${px != null ? px : '—'}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;font-weight:700;color:${upl != null ? pcol(upl) : 'var(--text3)'}">${upl != null ? sign(upl) : '—'}</td>
    </tr>`;
  }).join('');

  // Full ledger, newest first, each removable
  const ledgerRows = [...ledger].reverse().map(f => `<tr>
    <td style="font-size:10px;color:var(--text3)">${f.date}</td>
    <td style="font-size:10px;font-weight:700;color:${f.action === 'buy' ? 'var(--green)' : 'var(--red)'}">${f.action.toUpperCase()}</td>
    <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--text2)">${f.shares}</td>
    <td style="font-size:11px;color:var(--text)">${code(f.sym)}</td>
    <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--text2)">${f.price}</td>
    <td style="font-family:'JetBrains Mono',monospace;font-size:10px;text-align:end;color:var(--text3)">${f.fees || 0}</td>
    <td style="font-size:9px;color:var(--text3)">${f.note || ''}</td>
    <td style="text-align:end"><button onclick="deleteFill(${f.id})" title="Remove this fill" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px;padding:0 4px">✕</button></td>
  </tr>`).join('');

  const unrealTxt = summary.priced
    ? `<span style="color:${pcol(summary.unrealized)};font-weight:700">${sign(summary.unrealized)}</span> <span style="font-size:9px;color:var(--text3)">(${summary.priced} priced${summary.unpriced ? `, ${summary.unpriced} no price` : ''})</span>`
    : `<span style="color:var(--text3)">— scan to price the book</span>`;

  // Plan vs Actual — execution fidelity against the saved decision snapshot
  const cmp = trackingData?.comparison;
  const statusBadge = {
    filled:   `<span style="color:var(--green)" title="Held at or above the planned size.">✓ filled</span>`,
    partial:  `<span style="color:var(--yellow)" title="Held, but below the planned size.">~ partial</span>`,
    missed:   `<span style="color:var(--red)" title="In the plan, but you don't hold it.">✗ missed</span>`,
    off_plan: `<span style="color:var(--text3)" title="You hold this, but it wasn't in the plan.">! off-plan</span>`,
  };
  let planBlock = '';
  if (cmp && cmp.summary) {
    const s = cmp.summary;
    const slipTxt = s.avgEntrySlippagePct != null
      ? `<span style="color:${s.avgEntrySlippagePct <= 0 ? 'var(--green)' : 'var(--red)'};font-weight:700">${pct1(s.avgEntrySlippagePct)}</span>`
      : '<span style="color:var(--text3)">—</span>';
    const cmpRows = cmp.rows.map(r => `<tr>
      <td style="font-size:10px">${statusBadge[r.status] || r.status}</td>
      <td style="font-size:11px;color:var(--text)">${r.rank != null ? `<span style="color:var(--text3)">#${r.rank}</span> ` : ''}${code(r.sym)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:10px;text-align:end;color:var(--text3)">${r.targetShares ?? '—'} @ ${r.decisionPrice ?? '—'}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:10px;text-align:end;color:var(--text2)">${r.actualShares || 0} @ ${r.avgCost ?? '—'}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:10px;text-align:end;color:${r.slippagePct == null ? 'var(--text3)' : (r.slippagePct <= 0 ? 'var(--green)' : 'var(--red)')}">${r.slippagePct != null ? pct1(r.slippagePct) : '—'}</td>
    </tr>`).join('');
    planBlock = `
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-block-end:6px">
    <span style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3)">Plan vs Actual <span style="text-transform:none;letter-spacing:0">· plan for ${s.period}</span></span>
    <button class="btn btn-secondary" style="font-size:10px;padding:3px 10px" onclick="saveDecisionPlan(this)" title="Recompute this month's momentum picks and save them as the plan to measure against.">↻ Re-save plan</button>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin-block-end:10px">
    <div style="background:var(--bg2);border-radius:8px;padding:7px 9px"><div style="font-size:9px;color:var(--text3)" title="Share of the planned names you actually hold.">Coverage</div><div style="font-size:14px;font-weight:700;color:var(--text)">${s.coveragePct}% <span style="font-size:9px;color:var(--text3)">${s.held}/${s.planCount}</span></div></div>
    <div style="background:var(--bg2);border-radius:8px;padding:7px 9px"><div style="font-size:9px;color:var(--text3)" title="Average gap between your fill price and the decision price. Negative = you filled cheaper.">Entry slippage</div><div style="font-size:14px;font-weight:700">${slipTxt}</div></div>
    <div style="background:var(--bg2);border-radius:8px;padding:7px 9px"><div style="font-size:9px;color:var(--text3)">Missed / off-plan</div><div style="font-size:14px;font-weight:700;color:var(--text2)">${s.missed} / ${s.offPlan}</div></div>
    <div style="background:var(--bg2);border-radius:8px;padding:7px 9px"><div style="font-size:9px;color:var(--text3)" title="Planned capital vs what you actually deployed.">Intended → actual</div><div style="font-size:12px;font-weight:700;color:var(--text2)">${sar(s.intendedBasis)} → ${sar(s.actualBasis)}</div></div>
  </div>
  <div class="lab-table-wrap" style="margin-block-end:14px"><table class="lab-table">
    <thead><tr><th>Status</th><th>Sym</th><th style="text-align:end" title="Planned shares @ decision price.">Planned</th><th style="text-align:end" title="Held shares @ your avg cost.">Actual</th><th style="text-align:end" title="Fill price vs decision price.">Slip</th></tr></thead>
    <tbody>${cmpRows}</tbody></table></div>`;
  }

  el.innerHTML = `
<div class="lab-insight-card" style="border-color:var(--accent)">
  <div style="display:flex;align-items:center;gap:8px;margin-block-end:4px;flex-wrap:wrap">
    <span style="font-size:14px;font-weight:800;color:var(--text)">📒 Real Fill Ledger</span>
    <span style="font-size:9px;font-weight:700;padding:2px 8px;border-radius:10px;background:var(--accent);color:#fff">your actual book</span>
  </div>
  <div style="font-size:10px;color:var(--text3);line-height:1.5;margin-block-end:12px" title="Log the trades you actually placed on Derayah. These become next month's HOLD/SELL in the decision, and your realized profit/loss builds a live track record.">
    Log the fills you actually placed. They feed next month's HOLD/SELL and accrue a live profit/loss (P&amp;L) record.
  </div>

  <!-- P&L summary -->
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-block-end:14px">
    <div style="background:var(--bg2);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:var(--text3)">Open positions</div><div style="font-size:15px;font-weight:700;color:var(--text)">${summary.openCount || 0}</div></div>
    <div style="background:var(--bg2);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:var(--text3)" title="Profit/loss already banked from closed sells.">Realized P&amp;L</div><div style="font-size:15px;font-weight:700;color:${pcol(summary.realized)}">${sign(summary.realized || 0)}</div></div>
    <div style="background:var(--bg2);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:var(--text3)" title="On-paper gain/loss of open positions at the latest scan price.">Unrealized P&amp;L</div><div style="font-size:15px;font-weight:700">${unrealTxt}</div></div>
    <div style="background:var(--bg2);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:var(--text3)">Open cost basis</div><div style="font-size:15px;font-weight:700;color:var(--text2)">${sar(summary.costBasis)}</div></div>
  </div>

  <!-- Log a fill -->
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(64px,1fr));gap:6px;align-items:end;margin-block-end:6px">
    <div><div style="font-size:9px;color:var(--text3);margin-block-end:2px">Symbol</div><input class="goal-input goal-input-sm" id="fill-sym" placeholder="1120" style="width:100%"></div>
    <div><div style="font-size:9px;color:var(--text3);margin-block-end:2px">Side</div><select class="goal-input goal-input-sm" id="fill-action" style="width:100%"><option value="buy">Buy</option><option value="sell">Sell</option></select></div>
    <div><div style="font-size:9px;color:var(--text3);margin-block-end:2px">Shares</div><input class="goal-input goal-input-sm" id="fill-shares" type="number" min="0" step="1" style="width:100%"></div>
    <div><div style="font-size:9px;color:var(--text3);margin-block-end:2px">Price</div><input class="goal-input goal-input-sm" id="fill-price" type="number" min="0" step="0.01" style="width:100%"></div>
    <div><div style="font-size:9px;color:var(--text3);margin-block-end:2px" title="Broker commission for this fill (optional). Folds into cost on buys, reduces proceeds on sells.">Fees</div><input class="goal-input goal-input-sm" id="fill-fees" type="number" min="0" step="0.01" placeholder="0" style="width:100%"></div>
    <div><div style="font-size:9px;color:var(--text3);margin-block-end:2px">Date</div><input class="goal-input goal-input-sm" id="fill-date" type="date" style="width:100%"></div>
    <div><button class="btn btn-primary" style="font-size:11px;padding:6px 10px;width:100%" onclick="submitFill()">Log</button></div>
  </div>
  <div style="font-size:9px;color:var(--text3);margin-block-end:14px">4-digit codes auto-prefix to TADAWUL. Date defaults to today.</div>

  ${open.length ? `
  <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-block-end:6px">Open book</div>
  <div class="lab-table-wrap" style="margin-block-end:14px"><table class="lab-table">
    <thead><tr><th>Name</th><th style="text-align:end">Shares</th><th style="text-align:end" title="Weighted-average buy price including fees.">Avg cost</th><th style="text-align:end" title="Latest scan price.">Last</th><th style="text-align:end">Unreal. P&amp;L</th></tr></thead>
    <tbody>${openRows}</tbody></table></div>` : ''}

  ${planBlock || `<div style="display:flex;align-items:center;gap:10px;margin-block-end:14px;padding:8px 10px;background:var(--bg2);border-radius:8px">
    <span style="font-size:10px;color:var(--text3);flex:1">No saved plan yet. Save this month's momentum picks to track how faithfully you execute them.</span>
    <button class="btn btn-secondary" style="font-size:10px;padding:4px 12px" onclick="saveDecisionPlan(this)">Save this month's plan</button>
  </div>`}

  ${ledger.length ? `
  <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-block-end:6px">Fills (${ledger.length})</div>
  <div class="lab-table-wrap"><table class="lab-table">
    <thead><tr><th>Date</th><th>Side</th><th style="text-align:end">Shares</th><th>Sym</th><th style="text-align:end">Price</th><th style="text-align:end">Fees</th><th>Note</th><th></th></tr></thead>
    <tbody>${ledgerRows}</tbody></table></div>`
  : `<div style="font-size:11px;color:var(--text2);padding:8px 0">No fills logged yet. After you trade the monthly picks, log them here.</div>`}
</div>`;
}

async function submitFill() {
  const sym    = document.getElementById('fill-sym')?.value?.trim();
  const action = document.getElementById('fill-action')?.value;
  const shares = parseFloat(document.getElementById('fill-shares')?.value);
  const price  = parseFloat(document.getElementById('fill-price')?.value);
  const fees   = parseFloat(document.getElementById('fill-fees')?.value) || 0;
  const date   = document.getElementById('fill-date')?.value || undefined;
  if (!sym) return alert('Symbol required (e.g. 1120)');
  if (!(shares > 0)) return alert('Shares must be greater than 0');
  if (!(price > 0)) return alert('Price must be greater than 0');
  try {
    const r = await fetch('/api/fills', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sym, action, shares, price, fees, date }),
    }).then(safeJson);
    if (r.error) throw new Error(r.error);
    await loadFillLedger();
  } catch(e) { alert('Log failed: ' + e.message); }
}

async function deleteFill(id) {
  if (!confirm('Remove this fill? The book and P&L recompute from the remaining fills.')) return;
  try {
    const r = await fetch(`/api/fills/${id}`, { method: 'DELETE' }).then(safeJson);
    if (r.error) throw new Error(r.error);
    await loadFillLedger();
  } catch(e) { alert('Remove failed: ' + e.message); }
}

// Recompute this month's momentum picks server-side and save them as the plan to
// measure execution against. Slow (recomputes the screen) — disable the button while it runs.
async function saveDecisionPlan(btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const r = await fetch('/api/decision/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(safeJson);
    if (r.error) throw new Error(r.error);
    await loadFillLedger();
  } catch(e) {
    alert('Save plan failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// ── True Edge: forward excess vs equal-weight TASI basket, net cost (the honest metric) ──
// Strategy edge — graded per rebalance period (the honest unit for a portfolio strategy).
async function loadLabStrategy() {
  const el = document.getElementById('lab-strategy-section');
  if (!el) return;
  try {
    const d = await fetch('/api/lab/strategy').then(r => r.json());
    if (!d.ok || !d.strategies?.length) { el.innerHTML = ''; return; }
    const col = v => v > 0 ? 'var(--green)' : v < 0 ? '#ff5252' : 'var(--text3)';
    const badge = s => {
      const m = { promoted: ['var(--green)', 'PROMOTED'], candidate: ['var(--yellow)', 'CANDIDATE'], experimental: ['var(--text3)', 'EXPERIMENTAL'], retired: ['#ff5252', 'RETIRED'] }[s] || ['var(--text3)', s.toUpperCase()];
      return `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:10px;background:${m[0]};color:#000">${m[1]}</span>`;
    };
    const cards = d.strategies.map(s => {
      const yrs = Object.entries(s.yearly || {}).map(([y, v]) => `<span title="${y}: ${v.n} periods, t=${v.t}" style="font-size:10px;font-family:'JetBrains Mono',monospace;color:${col(v.excess_mean)}">${y.slice(2)} ${v.excess_mean >= 0 ? '+' : ''}${v.excess_mean}%</span>`).join('<span style="color:var(--text3)">·</span> ');
      return `<div class="lab-insight-card" style="border-color:var(--accent)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
          <span style="font-size:12px;font-weight:800;color:var(--text);cursor:help" title="Strategy Edge::This grades the whole strategy as you'd actually trade it — buy the basket, hold to the monthly rebalance, count ONE result per period. That avoids the trap where many stocks fire the same day and fake a strong signal. This is the real scorecard for momentum.">📈 Strategy Edge — ${s.name}</span>
          ${badge(s.status)}
          <span style="font-size:9px;color:var(--text3)">${s.periods} rebalances · ${s.span}</span>
        </div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:8px">${s.spec}</div>
        <div class="lab-stats-grid" style="grid-template-columns:repeat(5,1fr)">
          <div class="lab-stat" style="cursor:help" title="Excess per rebalance vs an equal-weight basket, net of 0.11% cost. The honest edge.">${''}<div class="lab-stat-val" style="font-size:18px;color:${col(s.excess_per_period)}">${s.excess_per_period >= 0 ? '+' : ''}${s.excess_per_period}%</div><div class="lab-stat-lbl">excess / rebalance</div></div>
          <div class="lab-stat" style="cursor:help" title="Significance. Above 2 = unlikely to be luck. This already absorbs cross-stock clustering (one obs per period).">${''}<div class="lab-stat-val" style="font-size:18px;color:${s.t >= 2 ? 'var(--green)' : 'var(--yellow)'}">${s.t}</div><div class="lab-stat-lbl">t-stat ${s.t >= 2 ? '✓' : ''}</div></div>
          <div class="lab-stat" style="cursor:help" title="Compounded yearly growth of the money itself (Sharia-compliant universe, after the compliance fix).">${''}<div class="lab-stat-val" style="font-size:18px;color:${col(s.cagr_abs)}">${s.cagr_abs}%</div><div class="lab-stat-lbl">~CAGR</div></div>
          <div class="lab-stat" style="cursor:help" title="Share of rebalance periods that beat the basket.">${''}<div class="lab-stat-val" style="font-size:18px;color:var(--text)">${s.win_rate}%</div><div class="lab-stat-lbl">beat-basket</div></div>
          <div class="lab-stat" style="cursor:help" title="Worst peak-to-trough you'd have lived through. Size for this.">${''}<div class="lab-stat-val" style="font-size:18px;color:#ff5252">${s.maxDD}%</div><div class="lab-stat-lbl">worst drop</div></div>
        </div>
        <div class="lab-regime-strip" style="margin-top:10px;font-size:10px" title="Promotion gate::A strategy is PROMOTED only when its edge is positive, statistically real (t>2), holds across BOTH halves of history, and has enough periods (≥24). Otherwise it stays a CANDIDATE until the data earns it.">
          <strong>${s.status === 'promoted' ? '✓ Promoted' : s.status === 'candidate' ? '◷ Candidate' : s.status}:</strong> ${s.statusWhy}. Halves t = ${s.half1_t} / ${s.half2_t}.
        </div>
        ${s.recommendedAction === 'promote' ? `<div style="margin-top:8px"><button class="btn btn-primary" style="font-size:11px;padding:4px 12px" onclick="promoteStrategy('${s.id}')" title="Promote::The strategy cleared the gate (real, significant, stable). Click to deploy it at full Scheme-D sizing. Cutting back later is automatic; adding risk needs this click.">▲ Promote to live (${s.exposure_mult > 0 ? 'increase' : 'deploy'})</button></div>` : ''}
        ${(s.transitions && s.transitions.length) ? `<div style="font-size:9px;color:var(--text3);margin-top:8px;line-height:1.6">History: ${s.transitions.map(t => `${t.at} ${t.from || '—'}→${t.to} <span style="opacity:.7">(${t.actor})</span>`).join(' · ')}</div>` : ''}
        <div style="font-size:10px;color:var(--text2);margin-top:6px">Effective exposure now: <strong>${Math.round((s.exposure_mult || 0) * 100)}%</strong> of Scheme-D sizing (state: ${s.status}).</div>
        <div style="font-size:10px;color:var(--text3);margin-top:8px;line-height:1.5">Per-year excess (develops over time): ${yrs}</div>
      </div>`;
    }).join('');
    el.innerHTML = cards;
  } catch(_) { el.innerHTML = ''; }
}

async function promoteStrategy(id) {
  if (!confirm('Promote this strategy to live (full Scheme-D sizing)? Risk-reduction stays automatic; this confirms adding risk.')) return;
  const r = await fetch('/api/lab/strategy/promote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) { alert('Could not promote: ' + (r.error || 'error')); return; }
  loadLabStrategy();
}

async function loadLabValidation() {
  const el = document.getElementById('lab-validation-section');
  if (!el) return;
  try {
    const d = await fetch('/api/lab/validation').then(r => r.json());
    if (!d.ok) return;
    const HH = d.headline_horizon || 20;
    const pc = v => (v == null || isNaN(v)) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
    const col = v => (v == null || isNaN(v)) ? 'var(--text3)' : v > 0 ? 'var(--green)' : '#ff5252';

    // horizon cards (5/10/20) — overlap-corrected net is the honest number
    const cards = [5, 10, 20].map(h => {
      const s = d.horizons[h] || {};
      const oc = s.overlap_corrected;
      const graded = s.all?.n || 0;
      const emph = h === HH;
      if (!oc || !graded) {
        return `<div class="lab-stat" style="${emph ? 'border-color:var(--accent)' : ''}">
          <div class="lab-stat-val" style="font-size:18px;color:var(--text3)">—</div>
          <div class="lab-stat-lbl">${h}-session${emph ? ' ★' : ''}</div>
          <div style="font-size:9px;color:var(--text3);margin-top:3px">${s.pending ? s.pending + ' maturing' : 'no data'}</div>
        </div>`;
      }
      const sig = Math.abs(oc.t_raw) >= 2;
      return `<div class="lab-stat" style="${emph ? 'border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)' : ''}">
        <div class="lab-stat-val" style="font-size:20px;color:${col(oc.net_mean)}">${pc(oc.net_mean)}</div>
        <div class="lab-stat-lbl">${h}-session net${emph ? ' ★' : ''}</div>
        <div style="font-size:9px;margin-top:3px;color:${sig ? 'var(--text2)' : 'var(--text3)'}">t=${oc.t_raw} ${sig ? '✓' : '(weak)'} · n=${oc.n}</div>
      </div>`;
    }).join('');

    // headline verdict
    const H = d.horizons[HH] || {};
    const oc = H.overlap_corrected;
    let verdict;
    if (!oc || !H.all?.n) {
      verdict = `Headline (${HH}-session) edge not gradable yet — <strong>${H.pending || 0} signals maturing</strong>. Fills in as signals reach ${HH} trading sessions.`;
    } else {
      const sig = Math.abs(oc.t_raw) >= 2, pos = oc.net_mean > 0;
      verdict = `Over <strong>${oc.n}</strong> near-independent signals, this engine beats an equal-weight TASI basket by <strong style="color:${col(oc.net_mean)}">${pc(oc.net_mean)} net of cost</strong> at a ${HH}-session hold` +
        (sig ? (pos ? ' — statistically real (t≥2).' : ' — significantly negative (t≥2). The logic is anti-predictive at this horizon.')
             : ' — but <strong>not statistically significant</strong> (t&lt;2); treat as no proven edge yet.');
    }

    // by signal type (headline horizon)
    const bt = (H.by_type && Object.entries(H.by_type)) || [];
    const typeRows = bt.sort((a, b) => b[1].net_mean - a[1].net_mean).map(([k, v]) => `<tr>
      <td style="font-size:11px;font-weight:600;color:var(--text)">${k}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:${col(v.excess_mean)}">${pc(v.excess_mean)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;font-weight:700;color:${col(v.net_mean)}">${pc(v.net_mean)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--text2)">${(v.beat_rate*100).toFixed(0)}%</td>
      <td style="font-size:10px;color:var(--text3);text-align:end">${v.n}</td>
    </tr>`).join('');

    el.innerHTML = `<div class="lab-insight-card" style="border-color:var(--accent)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-size:12px;font-weight:800;color:var(--text)">True Edge</span>
        <span style="font-size:10px;color:var(--text3)">excess vs equal-weight TASI basket · net of cost · the honest metric</span>
      </div>
      <div style="font-size:10px;color:var(--text3);line-height:1.5;margin-bottom:10px">The hit-rate below flatters signals in a rising market (the cap-weighted TASI index is Aramco-dominated, so most names "beat" it for free). This measures whether a signal beats a <em>random equal-weight basket</em> — the only fair test.</div>
      <div class="lab-stats-grid" style="grid-template-columns:repeat(3,1fr)">${cards}</div>
      <div class="lab-regime-strip" style="margin-top:10px;margin-bottom:${typeRows ? '10px' : '0'}">${verdict}</div>
      ${typeRows ? `<div class="lab-table-wrap"><table class="lab-table">
        <thead><tr><th>Signal Type (@${HH}-session)</th><th style="text-align:end">Excess</th><th style="text-align:end">Net</th><th style="text-align:end">Beat</th><th style="text-align:end">n</th></tr></thead>
        <tbody>${typeRows}</tbody></table></div>` : ''}
      <div id="lab-calibration-block"></div>
    </div>`;
    loadLabCalibration(HH);
  } catch(_) {}
}

// Per-pick odds: empirical P(profit) and P(beat buy-and-hold) with sample-size honesty.
async function loadLabCalibration(headlineHorizon) {
  const el = document.getElementById('lab-calibration-block');
  if (!el) return;
  try {
    // headline horizon may have nothing graded yet — fall back to the longest horizon with data
    let horizon = headlineHorizon, d = await fetch(`/api/lab/calibration?horizon=${horizon}`).then(r => r.json());
    if (!d.ok || !d.graded) { for (const h of [10, 5]) { const f = await fetch(`/api/lab/calibration?horizon=${h}`).then(r => r.json()); if (f.ok && f.graded) { d = f; horizon = h; break; } } }
    if (!d.ok || !d.graded) { el.innerHTML = `<div style="font-size:10px;color:var(--text3);margin-top:10px">Per-pick odds unlock once signals are graded (${d.pending || 0} maturing).</div>`; return; }

    const pp = v => v == null ? '—' : Math.round(v * 100) + '%';
    const ov = d.overall;
    const interim = horizon !== headlineHorizon ? ` <span style="color:var(--text3);font-weight:400">(interim — ${horizon}-session; ${headlineHorizon}-session still maturing)</span>` : '';
    const profCol = ov.p_profit >= 0.5 ? 'var(--green)' : 'var(--yellow)';
    const beatCol = ov.p_beat >= 0.5 ? 'var(--green)' : '#ff5252';

    const rows = Object.entries(d.by_type).sort((a, b) => (b[1].p_beat||0) - (a[1].p_beat||0)).map(([k, v]) => `<tr style="${v.reliable ? '' : 'opacity:.5'}">
      <td style="font-size:11px;font-weight:600;color:var(--text)">${k}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:${v.p_profit>=0.5?'var(--green)':'var(--yellow)'}">${pp(v.p_profit)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;font-weight:700;color:${v.p_beat>=0.5?'var(--green)':'#ff5252'}">${pp(v.p_beat)}</td>
      <td style="font-size:10px;color:var(--text3);text-align:end">±${Math.round((v.ci_beat[1]-v.ci_beat[0])/2*100)}%</td>
      <td style="font-size:10px;color:var(--text3);text-align:end">${v.n}${v.reliable?'':' ⚠'}</td>
    </tr>`).join('');

    el.innerHTML = `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      <div style="font-size:11px;font-weight:800;color:var(--text);margin-bottom:2px">Per-Pick Odds${interim}</div>
      <div style="font-size:10px;color:var(--text3);line-height:1.5;margin-bottom:10px">What an individual STRONG BUY pick actually does. <strong>"% beat hold" is the honest one</strong> — "% profit" rides the market and flatters in an up year.</div>
      <div class="lab-stats-grid" style="grid-template-columns:repeat(2,1fr)">
        <div class="lab-stat"><div class="lab-stat-val" style="font-size:24px;color:${profCol}">${pp(ov.p_profit)}</div><div class="lab-stat-lbl">made any profit</div><div style="font-size:9px;color:var(--text3);margin-top:3px">CI ${pp(ov.ci_profit[0])}–${pp(ov.ci_profit[1])} · n=${ov.n}</div></div>
        <div class="lab-stat" style="border-color:var(--accent)"><div class="lab-stat-val" style="font-size:24px;color:${beatCol}">${pp(ov.p_beat)}</div><div class="lab-stat-lbl">beat buy-and-hold ★</div><div style="font-size:9px;color:var(--text3);margin-top:3px">CI ${pp(ov.ci_beat[0])}–${pp(ov.ci_beat[1])}</div></div>
      </div>
      <div class="lab-table-wrap" style="margin-top:10px"><table class="lab-table">
        <thead><tr><th>Signal Type</th><th style="text-align:end">P(profit)</th><th style="text-align:end">P(beat)</th><th style="text-align:end">±CI</th><th style="text-align:end">n</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>`;
  } catch(_) {}
}

async function loadLabWinRates() {
  const el = document.getElementById('lab-win-rates-section');
  if (!el) return;
  try {
    const d = await fetch('/api/lab/win-rates').then(r => r.json());
    const cats = d.categories || [];
    if (!cats.length) return;
    const rows = cats.map(c => {
      const ratingCol = c.rating === 'strong' ? 'var(--green)' : c.rating === 'moderate' ? 'var(--yellow)' : '#ff5252';
      const wrCol = c.win_rate_pct >= 60 ? 'var(--green)' : c.win_rate_pct >= 45 ? 'var(--yellow)' : '#ff5252';
      const expCol = c.expectancy >= 1 ? 'var(--green)' : c.expectancy >= 0 ? 'var(--yellow)' : '#ff5252';
      return `<tr>
        <td style="font-size:11px;font-weight:600;color:var(--text)">${c.style}</td>
        <td style="font-size:10px;color:var(--text3)">${c.market.toUpperCase()}</td>
        <td style="text-align:center"><span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;background:${ratingCol}22;color:${ratingCol}">${c.rating.toUpperCase()}</span></td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;text-align:end;color:${wrCol}">${c.win_rate_pct}%</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:var(--green)">${c.avg_win_r}R</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:end;color:#ff5252">${c.avg_loss_r}R</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;text-align:end;color:${expCol}">${c.expectancy >= 0 ? '+' : ''}${c.expectancy}R</td>
        <td style="font-size:10px;color:var(--text3);text-align:end">${c.total}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<div style="margin:10px 0">
      <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px">Edge by Setup Type
        <span style="font-size:10px;font-weight:400;color:var(--text3);margin-inline-start:8px">Kelly sizing uses this data · updates after each scan</span>
      </div>
      <div class="lab-table-wrap"><table class="lab-table">
        <thead><tr><th>Style</th><th>Market</th><th>Rating</th><th style="text-align:end">Win%</th><th style="text-align:end">Avg Win</th><th style="text-align:end">Avg Loss</th><th style="text-align:end">Expectancy</th><th style="text-align:end">Signals</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  } catch(_) {}
}

function showLabLogForm() {
  const f = document.getElementById('lab-log-form');
  if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

async function submitLabSignal() {
  const sym   = document.getElementById('lab-sym')?.value?.trim();
  const entry = parseFloat(document.getElementById('lab-entry')?.value);
  const stop  = parseFloat(document.getElementById('lab-stop')?.value)||null;
  const t1    = parseFloat(document.getElementById('lab-t1')?.value)||null;
  const t2    = parseFloat(document.getElementById('lab-t2')?.value)||null;
  const bias  = document.getElementById('lab-bias')?.value;
  if (!sym || !entry) return alert('Symbol and entry price required');
  try {
    const r = await fetch('/api/lab/signal', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sym, price_entry:entry, price_stop:stop, price_t1:t1, price_t2:t2, bias }) }).then(safeJson);
    if (r.error) throw new Error(r.error);
    document.getElementById('lab-log-form').style.display = 'none';
    await loadLabPanel();
  } catch(e) { alert(e.message); }
}

async function markLabOutcome(id, outcome) {
  const choices = ['t1','t2','stop','expired','manual'];
  const sel = prompt(`Mark outcome for signal ${id}:\n${choices.map((c,i)=>`${i+1}. ${c}`).join('\n')}\n\nEnter number or outcome name:`);
  if (!sel) return;
  const oc = choices[parseInt(sel)-1] || sel;
  if (!choices.includes(oc)) return alert('Invalid outcome');
  const priceStr = prompt(`Price at outcome (optional, press OK to skip):`);
  const price = priceStr ? parseFloat(priceStr) : null;
  try {
    await fetch(`/api/lab/signal/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ outcome: oc, price_outcome: price }) });
    await loadLabPanel();
  } catch(e) { alert(e.message); }
}

async function deleteLabSignal(id) {
  if (!confirm('Remove this signal from the lab?')) return;
  try {
    await fetch(`/api/lab/signal/${id}`, { method:'DELETE' });
    await loadLabPanel();
  } catch(e) { alert(e.message); }
}