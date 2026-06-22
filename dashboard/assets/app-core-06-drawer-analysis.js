// ─── Drawer tab builders ──────────────────────────────────────────────────────
// ─── 360° Analysis ────────────────────────────────────────────────────────────
function get360TechPillar(r) {
  const bull = ['STRONG BUY','BUY','WATCH'].includes(r.bias);
  const bear = ['STRONG SELL','SELL','AVOID'].includes(r.bias);
  const strong = ['STRONG BUY','STRONG SELL'].includes(r.bias);
  const col = bull ? 'var(--green)' : bear ? 'var(--red)' : 'var(--yellow)';
  const pct = Math.round((r.score / (r.maxScore||8)) * 100);
  const signal = bull ? (strong ? 'Strong Buy' : r.bias==='WATCH'?'Watch':'Buy')
               : bear ? (strong ? 'Strong Sell' : r.bias==='AVOID'?'Avoid':'Sell')
               : 'Neutral';
  return { bull, bear, neutral:!bull&&!bear, strong, col, pct, signal,
           sub: `${r.score}/${r.maxScore||8} pts · ${r.bias}` };
}

function get360FundPillar(fscore) {
  if (!fscore) return { bull:false, bear:false, neutral:true, col:'var(--text3)', pct:50,
                        signal:'Loading...', sub:'Fetching fundamentals', loading:true };
  const bull = fscore.score >= 65;
  const bear = fscore.score < 40;
  const col = bull ? 'var(--green)' : bear ? 'var(--red)' : 'var(--yellow)';
  return { bull, bear, neutral:!bull&&!bear, col, pct:fscore.score,
           signal: fscore.signal, sub: `Score ${fscore.score}/100`, loading:false };
}

function get360WhalePillar(r) {
  const mfi = r.mfi ?? 50;
  const obv = r.obv_trend;

  // ── Block deal cross-reference ──────────────────────────────────────────
  const ticker = tickerDisplay(r.sym).replace('TADAWUL:','');
  const deals  = blockDealsCache.filter(d => {
    const ds = (d.sym||'').replace('TADAWUL:','');
    return ds === ticker || d.sym === r.sym || tickerDisplay(d.sym||'') === ticker;
  });
  const dealVal    = deals.reduce((a, b) => a + (b.value || b.price * b.qty || 0), 0);
  const latestDeal = deals[0] || null;
  // priceDiff: deal price vs today's close (positive = deal above close)
  const priceDiff  = latestDeal && r.price > 0
    ? ((latestDeal.price - r.price) / r.price * 100) : null;
  // Direction from MFI + OBV — this is the authoritative direction signal
  const dealAccum  = dealVal > 0 && (mfi > 55 || obv === 'rising');
  const dealDist   = dealVal > 0 && (mfi < 40 && obv === 'falling');
  const hasBigDiff = priceDiff != null && Math.abs(priceDiff) > 0.5;

  // Correct interpretation: combine MFI/OBV direction WITH price differential
  //   Accum + deal above close  → buyer paid premium, conviction entry
  //   Accum + deal below close  → buyer entered early, stock rallied after (already profitable)
  //   Dist  + deal above close  → seller got premium exit, systematic distribution
  //   Dist  + deal below close  → seller discounted to exit quickly
  let dealNote = '', dealBullish = false, dealBearish = false;
  if (dealVal > 0 && hasBigDiff) {
    if (dealAccum && priceDiff > 0) {
      dealNote = `+${priceDiff.toFixed(1)}% premium entry`;  dealBullish = true;
    } else if (dealAccum && priceDiff < 0) {
      dealNote = `early entry +${Math.abs(priceDiff).toFixed(1)}% profitable`;  dealBullish = true;
    } else if (dealDist && priceDiff > 0) {
      dealNote = `seller exited +${priceDiff.toFixed(1)}% above close`;  dealBearish = true;
    } else if (dealDist && priceDiff < 0) {
      dealNote = `seller discounted ${priceDiff.toFixed(1)}% to exit`;  dealBearish = true;
    }
  } else if (dealVal > 0) {
    dealNote = dealAccum ? 'accumulation' : dealDist ? 'distribution' : '';
  }

  // Block deals do NOT determine direction — MFI + OBV are authoritative.
  // Block deals only add context to the note. Letting a single deal flip
  // the pillar outcome overstates its reliability (no buyer/seller label available).
  // whale_score (ws) removed from direction — validated as noise (showdown t=-1.47). MFI + OBV only.
  const bull = mfi > 65 || obv === 'rising';
  const bear = mfi < 35 && obv === 'falling';
  const col  = bull ? 'var(--green)' : bear ? 'var(--red)' : 'var(--yellow)';

  // CMA filing cross-reference — authoritative direction (±5 day window)
  const cmaMatches = cmaForSym(r.sym, null, 5).slice(0, 3);
  const cmaConfirmed = cmaMatches.length > 0;
  const cmaBuyCount  = cmaMatches.filter(f => f.direction === 'buy').length;
  const cmaSellCount = cmaMatches.filter(f => f.direction === 'sell').length;
  const cmaNet = cmaBuyCount - cmaSellCount;

  const fmtVal = v => v >= 1e6 ? (v/1e6).toFixed(1)+'M SAR' : v >= 1e3 ? (v/1e3).toFixed(0)+'K SAR' : v.toFixed(0)+' SAR';
  const cmaLabel = cmaConfirmed
    ? (cmaNet > 0 ? ' · CMA ✓ Buy' : cmaNet < 0 ? ' · CMA ✓ Sell' : ' · CMA filing')
    : '';
  const signal = bull ? (dealVal > 0 ? 'Accumulation + Block' : 'Accumulation')
               : bear ? (dealVal > 0 ? 'Distribution + Block' : 'Distribution') : 'Neutral';
  const pct    = Math.round(mfi != null ? mfi : 50);   // gauge on MFI (0-100), not noise whale_score
  const mfiTxt = mfi != null ? `MFI ${mfi.toFixed(0)}` : '';
  const obvTxt = obv ? `OBV ${obv}` : '';
  const dealTxt = dealVal > 0 ? `${fmtVal(dealVal)}${dealNote ? ' · ' + dealNote : ''}` : '';
  const cmaTxt = cmaConfirmed
    ? (cmaNet > 0 ? `CMA: ${cmaBuyCount}× confirmed buy` : cmaNet < 0 ? `CMA: ${cmaSellCount}× confirmed sell` : 'CMA filing exists')
    : '';
  const sub    = [mfiTxt, obvTxt, dealTxt, cmaTxt].filter(Boolean).join(' · ') || 'No volume-flow data';

  return { bull, bear, neutral:!bull&&!bear, col, pct, signal: signal + cmaLabel, sub,
           dealVal, deals, priceDiff, dealAccum, dealDist, dealNote, dealBullish, dealBearish,
           cmaMatches, cmaConfirmed, cmaNet };
}

function generate360Synthesis(r, tech, fund, whale) {
  const bullCount = [tech.bull, fund.bull, whale.bull].filter(Boolean).length;
  const bearCount = [tech.bear, fund.bear, whale.bear].filter(Boolean).length;
  const conf = Math.max(bullCount, bearCount) >= 3 ? 'HIGH'
             : Math.max(bullCount, bearCount) >= 2 ? 'MEDIUM' : 'LOW';

  // Block deal sentence: always factual on size/note, cautious on direction.
  // Direction is MFI/OBV inference — not confirmed by buyer/seller identity.
  function bdCtx() {
    if (!whale.dealVal) return '';
    const fmtV = v => v >= 1e6 ? (v/1e6).toFixed(1)+'M SAR' : (v/1e3).toFixed(0)+'K SAR';
    const noteStr = whale.dealNote ? ` — ${whale.dealNote}` : '';
    // Detect conflict: block deal direction opposes technical bias
    const isTechBear = ['STRONG SELL','SELL','AVOID'].includes(r.bias);
    const isTechBull = ['STRONG BUY','BUY'].includes(r.bias);
    const conflict = (whale.dealAccum && isTechBear) || (whale.dealDist && isTechBull);
    const conflictNote = conflict
      ? ` <em style="color:var(--yellow)">Note: block deal direction conflicts with technical bias — treat as ambiguous.</em>`
      : '';
    // Soft language: "consistent with" not "confirmed by"
    const dir = whale.dealAccum
      ? ` MFI/OBV are consistent with accumulation (direction is inferred — no buyer/seller label available).`
      : whale.dealDist
      ? ` MFI/OBV are consistent with distribution (direction is inferred — no buyer/seller label available).`
      : ` Direction ambiguous — no buyer/seller data available from Argaam.`;
    const cmaLine = whale.cmaConfirmed
      ? ` <strong style="color:var(--green)">CMA filing confirms direction.</strong>`
      : '';
    return ` <strong>Block deal: ${fmtV(whale.dealVal)}${noteStr}.</strong>${dir}${cmaLine}${conflictNote}`;
  }

  const isBear = tech.bear;
  let headline, body, action;

  if (bullCount === 3) {
    headline = 'Full alignment — all three dimensions in an uptrend';
    body = `Technical momentum is present (${r.score}/8), the stock is ${fund.signal.toLowerCase()} on fundamentals, and volume flow (MFI/OBV) shows ${whale.signal.toLowerCase()} (${whale.sub}). This rare three-way convergence is the strongest trend-alignment state — descriptive, not a buy signal (the 9-pt score lagged buy-and-hold in testing). Validated buy-list = Momentum tab.${bdCtx()}`;
    action = `<strong>Strongest trend-alignment state</strong> — descriptive, not a buy trigger (this score had no validated edge). If you do trade it, EMA 34 (${r.emas?.ema34?.toFixed(2)??'—'}) and ATR / EMA 89 are reasonable stop references. Validated buy-list = Momentum tab.`;
  } else if (bearCount === 3) {
    headline = 'Full alignment — all three dimensions confirm bearish';
    body = `Technicals are deteriorating (${r.score}/8 bearish), fundamentals score ${fund.pct}/100 (${fund.signal.toLowerCase()}), and volume flow (MFI/OBV) shows ${whale.signal.toLowerCase()} (${whale.sub}). Strong multi-dimensional bear case.${bdCtx()}`;
    action = `<strong>Avoid new long positions.</strong> If holding, consider exiting on any bounce toward EMA 34 (${r.emas?.ema34?.toFixed(2)??'—'}).`;
  } else if (bullCount === 2 && !fund.loading) {
    const missing = tech.neutral?'a technical breakout':fund.neutral?'fundamental value':whale.neutral?'volume-flow confirmation':'full alignment';
    headline = `Two pillars aligned bullish — awaiting ${missing}`;
    body = `Technical score ${r.score}/8, fundamentals ${fund.signal.toLowerCase()} (${fund.pct}/100), volume flow ${whale.signal.toLowerCase()} (${whale.sub}). Two of three dimensions lean bullish.${bdCtx()}`;
    action = `<strong>Partial trend alignment</strong> (two pillars). Descriptive only, not a buy signal. If trading, smaller size + a tighter 1× ATR stop fit the unconfirmed risk. Validated buy-list = Momentum tab.`;
  } else if (bearCount === 2 && !fund.loading) {
    const missing = tech.neutral?'technical breakdown':fund.neutral?'fundamental weakness':whale.neutral?'volume-flow breakdown':'full alignment';
    headline = `Two pillars aligned bearish — ${missing} pending`;
    body = `Risk is elevated with two of three dimensions bearish. Technical ${tech.signal}, fundamentals ${fund.signal.toLowerCase()}, volume flow ${whale.signal.toLowerCase()}.${bdCtx()}`;
    action = `<strong>Avoid.</strong> Wait for the third pillar to confirm before any contrarian entry.`;
  } else if (tech.bull && fund.bull && whale.neutral && !fund.loading) {
    headline = 'Technical + Fundamental aligned, volume flow not yet confirming';
    body = `Strong price action (${r.score}/8) on a ${fund.signal.toLowerCase()} stock. Volume flow (MFI/OBV) is neutral — no unusual-volume confirmation yet.${bdCtx()}`;
    action = `<strong>Trend + fundamentals aligned; volume not confirming yet.</strong> Descriptive context, not a buy signal. Validated buy-list = Momentum tab.`;
  } else if (tech.bull && whale.bull && fund.neutral && !fund.loading) {
    headline = 'Momentum + volume flow aligned, fair valuation';
    body = `Technical momentum (${r.score}/8) and volume flow (MFI/OBV: ${whale.sub}) align. The stock is fairly valued — this is a momentum character, not a deep-value play. The trend has volume-flow support.${bdCtx()}`;
    action = `<strong>Momentum + volume flow aligned, fair valuation.</strong> Descriptive trend state, not a buy trigger — tighten stops if momentum stalls. The validated momentum buy-list is the Momentum tab.`;
  } else if (fund.bull && whale.bull && tech.neutral && !fund.loading) {
    headline = 'Value + volume flow, waiting on technical confirmation';
    body = `Fundamentals look attractive (${fund.pct}/100) and volume flow is constructive (MFI/OBV: ${whale.sub}), but technical structure hasn't confirmed yet (${r.score}/8). This may be early-stage accumulation before a breakout.${bdCtx()}`;
    action = `<strong>Fundamentals + volume flow constructive; technical unconfirmed.</strong> Descriptive only, not a buy signal. Validated buy-list = Momentum tab.`;
  } else if (tech.bull && fund.bear && !fund.loading) {
    headline = 'Technical breakout on stretched valuation';
    body = `Price momentum is real (${r.score}/8) but the stock trades at a fundamental premium (${fund.pct}/100 — ${fund.signal.toLowerCase()}). Momentum can persist, but the margin of safety is thin.${bdCtx()}`;
    action = `<strong>Momentum on a stretched valuation</strong> — thin margin of safety. Descriptive, not a buy signal; this score isn't a validated entry. Validated buy-list = Momentum tab.`;
  } else if (fund.loading) {
    headline = 'Technical + volume flow assessed, loading fundamentals...';
    body = `Technical: ${tech.signal} (${r.score}/8). Volume flow: ${whale.signal} (${whale.sub}). Fundamental analysis loading — full synthesis will update shortly.${bdCtx()}`;
    action = 'Partial assessment available now. Full 360° analysis updating...';
  } else {
    headline = 'Mixed signals — no clear multi-dimensional edge';
    body = `Technical ${tech.signal} (${r.score}/8), fundamentals ${fund.signal.toLowerCase()} (${fund.pct}/100), volume flow ${whale.signal.toLowerCase()} (${whale.sub}). The three dimensions don't yet align.${bdCtx()}`;
    action = `<strong>Wait for clearer alignment.</strong> No strong edge across all pillars — preserve capital.`;
  }

  return { headline, body, action, confidence:conf, bullCount, bearCount };
}

function build360Card(r, fscore) {
  const tech  = get360TechPillar(r);
  const fund  = get360FundPillar(fscore);
  const whale = get360WhalePillar(r);
  const syn   = generate360Synthesis(r, tech, fund, whale);

  const pillar = (icon, name, p) => `
    <div class="a360-pillar">
      <div class="a360-pillar-icon">${icon}</div>
      <div class="a360-pillar-name">${name}</div>
      <div class="a360-pillar-signal" style="color:${p.col}">${p.signal}</div>
      <div class="a360-pillar-sub">${p.sub}</div>
      <div class="a360-bar"><div class="a360-bar-fill" style="width:${p.pct}%;background:${p.col}"></div></div>
    </div>`;

  const confCls = syn.confidence==='HIGH'?'a360-conf-high':syn.confidence==='MEDIUM'?'a360-conf-medium':'a360-conf-low';
  const alignIcon = syn.bullCount===3?'🟢':syn.bearCount===3?'🔴':syn.bullCount>=2?'🟡':syn.bearCount>=2?'🟠':'⚪';

  // Block deal evidence strip — shown only when deals exist for this stock
  const bdStrip = whale.deals?.length > 0 ? (() => {
    const maxV = Math.max(...whale.deals.map(d => d.value || d.price * d.qty || 0), 1);
    const fmtV = v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v.toFixed(0);
    const rows = whale.deals.map(deal => {
      const sarV    = deal.value || deal.price * deal.qty || 0;
      const relPct  = Math.round(sarV / maxV * 100);
      const sigData = dealSignificanceVsADTV(sarV, deal.sym);
      const sigCol  = sigData.col;
      const sigLbl  = sigData.label + (sigData.pct != null ? ` ${sigData.pct.toFixed(0)}% ADTV` : '');
      // Context-aware label: direction + price diff combined
      const pDiff = whale.priceDiff;
      let prem = '';
      if (pDiff != null && Math.abs(pDiff) > 0.5) {
        if (whale.dealAccum && pDiff > 0)
          prem = `<span class="a360-deal-premium">+${pDiff.toFixed(1)}% premium entry</span>`;
        else if (whale.dealAccum && pDiff < 0)
          prem = `<span class="a360-deal-premium">+${Math.abs(pDiff).toFixed(1)}% profitable</span>`;
        else if (whale.dealDist && pDiff > 0)
          prem = `<span class="a360-deal-discount">seller +${pDiff.toFixed(1)}% exit</span>`;
        else if (whale.dealDist && pDiff < 0)
          prem = `<span class="a360-deal-discount">${pDiff.toFixed(1)}% discount exit</span>`;
      }
      const t = deal.time ? new Date(deal.time).toLocaleTimeString('en-SA',{hour:'2-digit',minute:'2-digit'}) : '';
      return `<div class="a360-deal-row">
        <span class="a360-deal-sig" style="background:${sigCol}22;color:${sigCol};border:1px solid ${sigCol}44">${sigLbl}</span>
        <div class="a360-deal-bar-wrap"><div class="a360-deal-bar" style="width:${relPct}%;background:${sigCol}"></div></div>
        <span class="a360-deal-val" style="color:${sigCol}">${fmtV(sarV)} SAR</span>
        ${prem}
        <span class="a360-deal-meta">${deal.qty.toLocaleString()} @ ${deal.price.toFixed(2)}${t?' · '+t:''}</span>
      </div>`;
    }).join('');
    const dir = whale.dealAccum ? '↑ Consistent with accumulation' : whale.dealDist ? '↓ Consistent with distribution' : '~ Direction ambiguous';
    const dirCol = whale.dealAccum ? 'var(--green)' : whale.dealDist ? '#ff5252' : 'var(--yellow)';
    // Conflict: inferred deal direction opposes technical bias
    const isTechBear = ['STRONG SELL','SELL','AVOID'].includes(r.bias);
    const isTechBull = ['STRONG BUY','BUY'].includes(r.bias);
    const hasConflict = (whale.dealAccum && isTechBear) || (whale.dealDist && isTechBull);
    const conflictBadge = hasConflict
      ? `<span style="font-size:9px;font-weight:700;padding:1px 7px;border-radius:8px;background:rgba(255,215,64,.12);color:var(--yellow);border:1px solid rgba(255,215,64,.25)">⚠ Conflicts with technical bias</span>`
      : `<span style="font-weight:400;letter-spacing:0;text-transform:none;color:var(--text3);font-size:9px">inferred from MFI/OBV · no buyer/seller label</span>`;
    return `<div class="a360-deal-strip">
      <div class="a360-deal-hdr">Block Deals Today
        <span style="color:${dirCol};font-weight:700">${dir}</span>
        <span style="font-weight:400;letter-spacing:0;text-transform:none;color:var(--yellow);font-size:9px">experimental — not a validated edge (event-level t 1.94)</span>
        ${conflictBadge}
      </div>
      ${rows}
    </div>`;
  })() : '';

  return `<div class="a360-card">
    <div class="a360-header">
      <span class="a360-title">🔮 360° Analysis</span>
      <span class="a360-confidence ${confCls}">${alignIcon} ${syn.confidence} confidence</span>
    </div>
    <div class="a360-pillars">
      ${pillar('📈','Technical', tech)}
      ${pillar('💰','Fundamental', fund)}
      ${pillar('📊','Volume Flow', whale)}
    </div>
    ${bdStrip}
    ${whale.cmaConfirmed ? (() => {
      const f = whale.cmaMatches[0];
      const cls = f.direction === 'buy' ? 'a360-cma-confirmed' : f.direction === 'sell' ? 'a360-cma-confirmed a360-cma-sell' : 'a360-cma-confirmed';
      const icon = f.direction === 'buy' ? '↑' : f.direction === 'sell' ? '↓' : '~';
      const instLabel = f.institution_en || f.institution || 'Institution';
      const deltaStr = f.prev_pct != null && f.new_pct != null
        ? ` · ${f.prev_pct.toFixed(1)}% → ${f.new_pct.toFixed(1)}%` : '';
      return `<div class="a360-deal-strip">
        <div class="${cls}">
          <strong>🏛 CMA Confirmed</strong> ${icon} ${instLabel} ${f.direction} filing${deltaStr} · ${f.filing_date}
          ${whale.cmaMatches.length > 1 ? `<span style="opacity:.6;margin-inline-start:6px">+${whale.cmaMatches.length-1} more</span>` : ''}
        </div>
      </div>`;
    })() : ''}
    <div class="a360-divider"></div>
    <div class="a360-headline">${syn.headline}</div>
    <div class="a360-body">${syn.body}</div>
    <div class="a360-action">${syn.action}</div>
  </div>`;
}

async function load360Analysis(sym, r) {
  const el = document.getElementById('a360-card-wrap');
  if (!el) return;
  try {
    const res  = await fetch('/api/fundamentals?sym=' + encodeURIComponent(sym));
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Fund load failed');
    el.innerHTML = build360Card(r, json.score);
  } catch(_) {
    // Keep the partial card (with loading fundamentals) — don't error out
  }
}

function buildDynamicsCard(r) {
  const H    = r.hurst;
  const rank = r.atr_pct_rank;
  if (H == null && rank == null) return '';

  let html = `<div class="crit-section-title">Market Dynamics</div>`;

  if (H != null) {
    const isTrending = H > 0.55, isMR = H < 0.45;
    const hLabel = isTrending ? 'Trending' : isMR ? 'Mean-Reverting' : 'Random Walk';
    const hCol   = isTrending ? 'var(--green)' : isMR ? 'var(--orange)' : 'var(--yellow)';
    const hDesc  = isTrending
      ? `Price shows <strong>persistence</strong> — it tends to continue in the same direction. The EMA trend stack and MACD signals are more reliable in this regime. Momentum entries have higher follow-through probability.`
      : isMR
      ? `Price oscillates around a mean — moves tend to <strong>reverse</strong>. Trend signals (EMA crossovers, breakouts) generate more false positives here. Wait for a stronger score before entering, or consider tighter targets.`
      : `Price movement is close to a <strong>random walk</strong> — no dominant trending or mean-reverting character. This is the baseline; use other signals to determine edge.`;
    html += `<div class="crit-card ${isTrending?'pass':isMR?'warn':''}">
      <div class="crit-card-header">
        <span class="crit-icon">${isTrending?'📈':isMR?'↔️':'〜'}</span>
        <span class="crit-label">Hurst Exponent (R/S)</span>
        <span class="crit-value" style="color:${hCol}">${H} — ${hLabel}</span>
      </div>
      <div class="crit-explain">${hDesc}</div>
    </div>`;
  }

  if (rank != null) {
    const isCoil = rank <= 20, isExp = rank >= 80;
    const rLabel = isCoil ? 'Compressed — volatility coil' : isExp ? 'Expanded — high volatility' : 'Normal range';
    const rCol   = isCoil ? 'var(--green)' : isExp ? 'var(--red)' : 'var(--yellow)';
    const rDesc  = isCoil
      ? `ATR is in its <strong>bottom ${rank}th percentile</strong> for the year. The stock is unusually calm — a coiling phase. Compressed volatility followed by a strong signal often produces sharp, sustained moves. This is the ideal setup to watch.`
      : isExp
      ? `ATR is in its <strong>top ${100 - rank}th percentile</strong> for the year. The stock is moving aggressively. Risk per share is elevated — <strong>reduce position size 30–50%</strong> and widen stops to avoid being shaken out by noise.`
      : `ATR is at its <strong>${rank}th percentile</strong> — within normal historical volatility range. Standard position sizing applies. No adjustment needed.`;
    html += `<div class="crit-card ${isCoil?'pass':isExp?'warn':''}">
      <div class="crit-card-header">
        <span class="crit-icon">${isCoil?'🪤':isExp?'⚡':'〜'}</span>
        <span class="crit-label">ATR Percentile Rank (252d)</span>
        <span class="crit-value" style="color:${rCol}">${rank}th %ile — ${rLabel}</span>
      </div>
      <div class="crit-explain">${rDesc}</div>
    </div>`;
  }

  // Combined synthesis when both values are available
  if (H != null && rank != null) {
    const isTrend = H > 0.55, isMR = H < 0.45, isCoil = rank <= 20, isExp = rank >= 80;
    let synth, synthCol;
    if (isTrend && isCoil) {
      synth = '⭐ Best-case character: trending + compressed volatility. The stock is building energy in a confirmed trend direction. Strongest trend-alignment when the score is 7+ — descriptive, not a buy signal (validated buy-list = Momentum tab).';
      synthCol = 'var(--green)';
    } else if (isTrend && isExp) {
      synth = '⚠ Trending but volatile: momentum is real, but risk per bar is elevated. Size down 30–40%, widen stops, and consider waiting for an intra-day pullback to reduce entry risk.';
      synthCol = 'var(--yellow)';
    } else if (isMR && isCoil) {
      synth = '⚠ Mean-reverting + compressed: the next move could snap back hard in either direction. Do not chase breakouts here — wait for the breakout to establish and close above key resistance.';
      synthCol = 'var(--yellow)';
    } else if (isMR && isExp) {
      synth = '🛑 Challenging environment: price tends to reverse AND volatility is high. Trend signals here have the lowest reliability. Reduce position size significantly or wait for a calmer regime.';
      synthCol = 'var(--red)';
    } else {
      synth = null;
    }
    if (synth) {
      html += `<div style="background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px 13px;font-size:11px;color:${synthCol};line-height:1.6">${synth}</div>`;
    }
  }

  return html;
}

function buildVolCard(r) {
  const vol = r.vol_ratio ?? 0;
  const isBear = ['STRONG SELL','SELL','AVOID'].includes(r.bias);
  // Zones: thin <0.8, normal 0.8-1.2, active 1.2-2, surge >2
  const THRESHOLD = 1.2;
  const MAX_DISPLAY = 3.0; // bar fills to max 3×
  const fillPct = Math.min(vol / MAX_DISPLAY * 100, 100);
  const thresholdPct = (THRESHOLD / MAX_DISPLAY) * 100;

  // Colour and zone label
  let zoneCol, zoneBg, zoneLabel, zoneDesc;
  if (vol >= 2.0) {
    zoneCol = isBear ? 'var(--red)' : 'var(--green)';
    zoneBg  = isBear ? 'var(--red-dim)' : 'var(--green-dim)';
    zoneLabel = isBear ? 'Surge — heavy selling' : 'Surge — strong demand';
    zoneDesc  = isBear
      ? `Volume at <strong>${vol}×</strong> average. A surge during a downtrend accelerates the selloff — institutions are actively distributing.`
      : `Volume at <strong>${vol}×</strong> average. Surging volume on an uptrend is a strong confirmation of genuine institutional buying demand.`;
  } else if (vol >= THRESHOLD) {
    zoneCol = isBear ? 'var(--orange)' : 'var(--green)';
    zoneBg  = isBear ? 'rgba(255,145,0,.12)' : 'var(--green-dim)';
    zoneLabel = isBear ? 'Active — confirms selling pressure' : 'Active — confirms participation (+1 pt)';
    zoneDesc  = isBear
      ? `Volume at <strong>${vol}×</strong> average. Above-average volume on a bearish setup confirms selling pressure, not buying. Check MFI in Whale Watch for direction.`
      : `Volume at <strong>${vol}×</strong> average. Above the 1.2× threshold — enough participation to validate the price move.`;
  } else if (vol >= 0.8) {
    zoneCol = 'var(--yellow)';
    zoneBg  = 'var(--yellow-dim)';
    zoneLabel = 'Moderate — below threshold (0 pts)';
    zoneDesc  = `Volume at <strong>${vol}×</strong> average. Below the 1.2× threshold. The price move lacks strong participation — higher risk of reversal without a volume follow-through.`;
  } else {
    zoneCol = 'var(--text3)';
    zoneBg  = 'rgba(255,255,255,.04)';
    zoneLabel = 'Thin — weak participation (0 pts)';
    zoneDesc  = `Volume at <strong>${vol}×</strong> average. Very low participation. Moves on thin volume are unreliable and often reversed when bigger players return.`;
  }

  // Bar segments shown as background gradient
  const barFill = `linear-gradient(90deg, ${zoneCol} 0%, ${zoneCol} ${fillPct}%, rgba(255,255,255,.06) ${fillPct}%, rgba(255,255,255,.06) 100%)`;

  return `<div class="crit-section-title">${t('lVol')}</div>
  <div class="vol-meter-card">
    <div class="vol-meter-top">
      <div class="vol-meter-reading">
        <span class="vol-meter-num" style="color:${zoneCol}">${vol}<span class="vol-meter-unit">×</span></span>
        <span class="vol-meter-avg">avg</span>
      </div>
      <span class="vol-meter-zone" style="background:${zoneBg};color:${zoneCol}">${zoneLabel}</span>
    </div>
    <div class="vol-meter-bar-wrap">
      <div class="vol-meter-bar" style="background:${barFill}"></div>
      <div class="vol-meter-threshold" style="left:${thresholdPct}%">
        <div class="vol-threshold-tick"></div>
        <div class="vol-threshold-label">1.2×</div>
      </div>
    </div>
    <div class="vol-meter-zones-row">
      <span>Thin</span><span>Moderate</span><span style="padding-inline-start:${thresholdPct * .6}%">Active</span><span>Surge</span>
    </div>
    <div class="crit-explain" style="margin-top:8px">${zoneDesc}</div>
  </div>`;
}

function buildSignalTab(r){
  if(r.bias==='NO_DATA'||r.bias==='ERROR'){
    document.getElementById('dtab-signal').innerHTML=`<div class="crit-card fail"><div class="crit-card-header"><span class="crit-icon">✗</span><span class="crit-label">${t('bNoData')}</span></div><div class="crit-explain">${r.error||''}</div></div>`;
    return;
  }
  const{ema13,ema34,ema89,ema200}=r.emas||{};
  const isBear=['STRONG SELL','SELL','AVOID'].includes(r.bias);
  const col=isBear?'#ff1744':scoreColor(r.score,r.maxScore||8);
  const pct=Math.round((r.score/(r.maxScore||8))*100);
  const verdict=(EXPL.verdicts[lang]||EXPL.verdicts.en)[r.bias];
  const verdictText=verdict?verdict(r.name):'';
  let crits;
  if(isBear){
    const stackBear=ema13<ema34&&ema34<ema89,below200=r.price<ema200,rsiWeak=r.rsi>22&&r.rsi<=48,rsiOs=r.rsi<=22,macdBear=r.macd_hist<0;
    crits=[
      buildCrit(stackBear,t('lEmaStackBear')+' (2'+t('pts')+')',`EMA 13: <strong>${ema13?.toFixed(2)}</strong> | EMA 34: <strong>${ema34?.toFixed(2)}</strong> | EMA 89: <strong>${ema89?.toFixed(2)}</strong>`,stackBear?EXPL.emaStackBear[lang].pass:EXPL.emaStackBear[lang].fail,null,buildProximityBar('emaStack',stackBear,r)),
      buildCrit(below200,t('lEma200Bear')+' (2'+t('pts')+')',`${lang==='ar'?'السعر':'Price'}: <strong>${r.price?.toFixed(2)}</strong> | EMA 200: <strong>${ema200?.toFixed(2)}</strong>`,below200?EXPL.ema200Bear[lang].pass:EXPL.ema200Bear[lang].fail,null,buildProximityBar('ema200',below200,r)),
      buildCrit(rsiWeak&&!rsiOs,t('lRsiBear')+' (2'+t('pts')+')',`RSI(14): <strong>${r.rsi?.toFixed(1)}</strong>`,rsiOs?EXPL.rsiOs[lang]:rsiWeak?EXPL.rsiWeakBear[lang]:EXPL.rsiNotWeak[lang],rsiOs?'warn':null,buildProximityBar('rsi',rsiWeak&&!rsiOs,r)),
      buildCrit(macdBear,t('lMacd')+' (1'+t('pts')+')',`${lang==='ar'?'هيستوجرام':'Histogram'}: <strong>${r.macd_hist?.toFixed(4)}</strong>`,macdBear?EXPL.macdBear[lang].pass:EXPL.macdBear[lang].fail,null,buildProximityBar('macd',macdBear,r)),
    ];
  } else {
    const stack=ema13>ema34&&ema34>ema89,above200=r.price>ema200,rsiOk=r.rsi>=52&&r.rsi<78,rsiOb=r.rsi>=78,macdOk=r.macd_hist>0;
    crits=[
      buildCrit(stack,t('lEmaStack')+' (2'+t('pts')+')',`EMA 13: <strong>${ema13?.toFixed(2)}</strong> | EMA 34: <strong>${ema34?.toFixed(2)}</strong> | EMA 89: <strong>${ema89?.toFixed(2)}</strong>`,stack?EXPL.emaStack[lang].pass:EXPL.emaStack[lang].fail,null,buildProximityBar('emaStack',stack,r)),
      buildCrit(above200,t('lEma200')+' (2'+t('pts')+')',`${lang==='ar'?'السعر':'Price'}: <strong>${r.price?.toFixed(2)}</strong> | EMA 200: <strong>${ema200?.toFixed(2)}</strong>`,above200?EXPL.ema200[lang].pass:EXPL.ema200[lang].fail,null,buildProximityBar('ema200',above200,r)),
      buildCrit(rsiOk&&!rsiOb,t('lRsi')+' (2'+t('pts')+')',`RSI(14): <strong>${r.rsi?.toFixed(1)}</strong>`,rsiOb?EXPL.rsiOb[lang]:rsiOk?EXPL.rsiOk[lang]:EXPL.rsiWeak[lang],rsiOb?'warn':null,buildProximityBar('rsi',rsiOk,r)),
      buildCrit(macdOk,t('lMacd')+' (1'+t('pts')+')',`${lang==='ar'?'هيستوجرام':'Histogram'}: <strong>${r.macd_hist>0?'+':''}${r.macd_hist?.toFixed(4)}</strong>`,macdOk?EXPL.macd[lang].pass:EXPL.macd[lang].fail,null,buildProximityBar('macd',macdOk,r)),
    ];
  }
  const shd=shariaMap[r.sym];
  const shCard=shd?`<div class="crit-section-title">${t('shariaTitle')}</div>
    <div class="crit-card ${'compliant'===shd.status?'pass':'non_compliant'===shd.status?'fail':'warn'}">
      <div class="crit-card-header"><span class="crit-icon">${'compliant'===shd.status?'✅':'non_compliant'===shd.status?'❌':'⚠️'}</span><span class="crit-label">${t('shariaTitle')}</span><span class="crit-value" style="color:${'compliant'===shd.status?'var(--green)':'non_compliant'===shd.status?'var(--red)':'var(--yellow)'}">${{'compliant':t('sHalal'),'non_compliant':t('sNonHalal'),'review':t('sReview')}[shd.status]||t('sUnknown')}</span></div>
      <div class="crit-explain">${shd.basis}</div><div class="crit-explain" style="margin-top:5px;font-size:11px;color:var(--text3)">${t('shariaDisc')}</div>
    </div>`:'';
  let rsCard='';
  if(r.rs_score!=null){
    const isLead=r.rs_score>2,isLag=r.rs_score<-2;
    const rsCol=isLead?'var(--green)':isLag?'#ff5252':'var(--yellow)';
    const sign=r.rs_score>0?'+':'';
    rsCard=`<div class="crit-section-title">${t('rsTitle')}</div>
    <div class="crit-card ${isLead?'pass':isLag?'fail':'warn'}">
      <div class="crit-card-header"><span class="crit-icon">${isLead?'📈':isLag?'📉':'➡️'}</span><span class="crit-label">${t('rsTitle')} vs index</span><span class="crit-value" style="color:${rsCol}">${sign}${r.rs_score.toFixed(1)}% — ${isLead?t('rsLeader'):isLag?t('rsLaggard'):'Neutral'}</span></div>
      <div class="crit-explain">${isLead?`Outperformed index by <strong>${sign}${r.rs_score.toFixed(1)}%</strong> over 20 sessions.`:isLag?`Underperformed index by <strong>${r.rs_score.toFixed(1)}%</strong> over 20 sessions.`:'Performing in line with its market index.'}</div>
    </div>`;
  }
  let weeklyCard='';
  if(scanMode==='position'&&r.weekly){
    const{ema_stack,above200,score}=r.weekly;
    weeklyCard=`<div class="crit-section-title">${t('weeklyTitle')}</div>
    <div class="crit-card ${score===4?'pass':score===0?'fail':'warn'}">
      <div class="crit-card-header"><span class="crit-icon">${score===4?'✅':score===0?'❌':'⚠️'}</span><span class="crit-label">${t('weeklyTitle')}</span><span class="crit-value" style="color:${score===4?'var(--green)':score===0?'var(--red)':'var(--yellow)'}">${weeklyBadgeHtml(r)}</span></div>
      <div class="crit-nums">${t('wEmaStack')}: ${ema_stack?'✓':'✗'} | ${t('wAbove200')}: ${above200===null?'N/A':above200?'✓':'✗'}</div>
      <div class="crit-explain">${score===4?'Weekly timeframe fully aligned.':score===0?'Weekly trend against daily — wait for alignment.':'Partially aligned — monitor for confirmation.'}</div>
    </div>`;
  }
  let divCard='';
  if(r.divergence){
    const isBullDiv=r.divergence==='bullish';
    divCard=`<div class="crit-section-title">RSI Divergence</div>
    <div class="crit-card ${isBullDiv?'pass':'warn'}">
      <div class="crit-card-header"><span class="crit-icon">${isBullDiv?'📈':'📉'}</span><span class="crit-label">${isBullDiv?'Bullish Divergence':'Bearish Divergence'}</span><span class="crit-value" style="color:${isBullDiv?'var(--green)':'var(--orange)'}">${isBullDiv?'↗ Bullish':'↘ Bearish'}</span></div>
      <div class="crit-explain">${isBullDiv?'Price made a lower low but RSI made a higher low — hidden bullish strength, potential reversal up.':'Price made a higher high but RSI made a lower high — momentum waning, potential reversal down.'}</div>
    </div>`;
  }
  let actionHtml='';
  if(r.bias==='STRONG BUY'||r.bias==='BUY') actionHtml=`<div class="entry-box"><div class="entry-box-title">${t('entryGuidanceTitle')}</div><p>${EXPL.entryGuide[lang](ema34?.toFixed(2),ema89?.toFixed(2))}</p></div>`;
  else if(r.bias==='WATCH') actionHtml=`<div class="entry-box"><div class="entry-box-title">${t('watchTitle')}</div><p>${EXPL.watchGuide[lang](r.warnings||[],ema34?.toFixed(2))}</p></div>`;
  else if(r.bias==='STRONG SELL'||r.bias==='SELL') actionHtml=`<div class="entry-box" style="background:rgba(255,23,68,.06);border-color:rgba(255,23,68,.25)"><div class="entry-box-title" style="color:#ff1744">${t('sellGuidanceTitle')}</div><p>${EXPL.sellGuide[lang](ema34?.toFixed(2),ema89?.toFixed(2))}</p></div>`;
  else if(r.bias==='AVOID') actionHtml=`<div class="entry-box" style="background:rgba(255,145,0,.06);border-color:rgba(255,145,0,.25)"><div class="entry-box-title" style="color:var(--orange)">${t('avoidTitle')}</div><p>${EXPL.avoidGuide[lang](r.warnings||[],ema34?.toFixed(2))}</p></div>`;
  // ── Executive Summary ────────────────────────────────────────────────────────
  const isBearExec=['STRONG SELL','SELL','AVOID'].includes(r.bias);
  const fmt2=v=>v!=null?fmtPrice(v,r.sym):'—';
  let execStop=null,execT1=null,execT2=null,execEntry=null;
  if(r.atr!=null){
    execStop = isBearExec?r.price+1.5*r.atr:r.price-1.5*r.atr;
    execT1   = isBearExec?r.price-1.5*r.atr:r.price+1.5*r.atr;
    execT2   = isBearExec?r.price-3*r.atr:r.price+3*r.atr;
    execEntry= isBearExec?r.price:r.emas?.ema34||r.price;
  }
  const rrRatio=execStop&&execT1?Math.abs(execT1-r.price)/Math.abs(r.price-execStop):null;
  const topRes=(r.sr?.resistance||[]).slice(0,2);
  const topSup=(r.sr?.support||[]).slice(0,2);
  const ind=(pass,label,tip='')=>`<span class="exec-ind ${pass?'exec-ind-pass':'exec-ind-fail'}"${tip?' title="'+tip+'"':''}>${pass?'✓':'✗'} ${label}</span>`;
  const indWarn=(label,tip='')=>`<span class="exec-ind exec-ind-warn"${tip?' title="'+tip+'"':''}>⚠ ${label}</span>`;
  const {ema13:ei13,ema34:ei34,ema89:ei89,ema200:ei200}=r.emas||{};
  const stackOk=isBearExec?(ei13<ei34&&ei34<ei89):(ei13>ei34&&ei34>ei89);
  const a200ok=isBearExec?r.price<ei200:r.price>ei200;
  const rsiOk=isBearExec?(r.rsi>22&&r.rsi<=48):(r.rsi>=52&&r.rsi<78);
  // Precomputed natural-language tooltip strings (avoid nested backtick escaping)
  const _eTip = isBearExec
    ? (stackOk ? 'EMA 13 < 34 < 89 — moving averages are stacked in downtrend order, confirming sellers are structurally in control.' : 'EMAs are not in downtrend order — the bear structure is incomplete. Downtrend lacks full confirmation.')
    : (stackOk ? 'EMA 13 > 34 > 89 — short, mid, and long averages all stacked in uptrend order. This is the core trend confirmation — buyers are structurally in control.' : 'EMAs are not in uptrend order — trend structure is broken or not yet formed. High risk zone for longs.');
  const _200Tip = isBearExec
    ? (a200ok ? 'Price is below its 200-day moving average — in a long-term downtrend. Most institutions treat this as the line below which a stock is worth avoiding.' : 'Price is above the 200-day average — the long-term bull trend is intact. This weakens the bearish thesis significantly.')
    : (a200ok ? 'Price is above its 200-day moving average — in a long-term bull regime. The single most-watched filter by institutional buyers for whether a stock is worth owning.' : 'Price is below the 200-day average — in a long-term downtrend. Risk is materially higher for longs below this line.');
  const _rsiTip = rsiOk ? 'RSI is in the momentum zone (52–78) — buyers are in control without the stock being overstretched. This is the ideal RSI territory for entering a swing trade.'
    : r.rsi>=78 ? 'RSI is overbought at '+r.rsi?.toFixed(0)+' — the stock has run too far without a pause. Entering here risks buying the peak of a stretched move. Wait for a pullback first.'
    : r.rsi<=48 ? 'RSI is at '+r.rsi?.toFixed(0)+' — sellers dominate. The trend signal lacks momentum support and is more likely to fail.'
    : 'RSI is at '+r.rsi?.toFixed(0)+' — not yet in the momentum zone (52–78). Wait for RSI to confirm before acting on this setup.';
  const _macdTip = r.macd_hist>0
    ? 'MACD histogram is positive ('+r.macd_hist?.toFixed(4)+') — the price trend has bullish momentum behind it. A growing histogram means momentum is still accelerating.'
    : 'MACD histogram is negative ('+r.macd_hist?.toFixed(4)+') — momentum has turned bearish. Upward price moves lack the internal force needed for follow-through.';
  const _volTip = r.vol_ratio!=null ? (r.vol_ratio>=1.2
    ? 'Volume is at '+r.vol_ratio?.toFixed(1)+'× the 20-day average — real buyers are driving this move. Above-average participation adds conviction to the signal.'
    : 'Volume is at '+r.vol_ratio?.toFixed(1)+'× average — below the 1.2× threshold. Moves on low volume are easier to reverse when larger players return.') : '';
  const _vwapTip = r.above_vwap ? 'Price is above the 20-day VWAP ('+r.vwap20?.toFixed(2)+') — the average buyer from the past month is profitable, reducing their incentive to sell. Bullish pressure structure.'
    : 'Price is below the 20-day VWAP ('+r.vwap20?.toFixed(2)+') — the average buyer from the past month is sitting at a loss. That overhead supply makes it harder to push price higher.';
  const _hurstTip = r.hurst==null ? '' : r.hurst>0.55 ? 'Hurst '+r.hurst+' — trending. Price shows persistence in one direction. EMA and momentum signals are more reliable here than usual.'
    : r.hurst<0.45 ? 'Hurst '+r.hurst+' — mean-reverting. Price tends to oscillate and reverse rather than trend. Trend signals have more false positives here — require a stronger overall score before acting.'
    : 'Hurst '+r.hurst+' — random walk. No dominant trending or mean-reverting character detected. Use other signals to determine edge.';
  const _atrTip = r.atr_pct_rank==null ? '' : r.atr_pct_rank<=20 ? 'ATR at '+r.atr_pct_rank+'th percentile — volatility is unusually compressed. This coiling phase often precedes a sharp, sustained breakout when combined with a strong signal. Ideal setup to watch.'
    : r.atr_pct_rank>=80 ? 'ATR at '+r.atr_pct_rank+'th percentile — volatility is expanded and the stock is moving aggressively. Reduce your position size and widen stops to avoid being shaken out by normal noise.'
    : 'ATR at '+r.atr_pct_rank+'th percentile — within normal historical volatility range. Standard position sizing applies.';
  const _divTip = r.divergence=='bullish' ? 'Bullish divergence — price made a lower low but RSI did not. Downward momentum is quietly fading. A reversal or bounce is likely brewing even though price looks weak.'
    : 'Bearish divergence — price made a higher high but RSI did not. Upward momentum is secretly fading. The rally may be running out of fuel.';
  const execCard=`<div class="exec-card">
    <div class="exec-top">
      <div>
        <div class="exec-score-num" style="color:${col}">${r.score}<span style="font-size:13px;color:var(--text3);font-weight:400">/${r.maxScore||8}</span></div>
        <div class="exec-score-lbl">${t('execTitle')}</div>
      </div>
      <div style="flex:1">
        <div style="margin-bottom:4px">${biasBadgeHtml(r.bias)}</div>
        <div class="exec-inds">
          ${ind(stackOk,'EMA',_eTip)}${ind(a200ok,'200',_200Tip)}
          ${rsiOk?ind(true,'RSI '+r.rsi?.toFixed(0),_rsiTip):r.rsi>=78?indWarn('RSI OB',_rsiTip):ind(false,'RSI '+r.rsi?.toFixed(0),_rsiTip)}
          ${ind(r.macd_hist>0,'MACD',_macdTip)}${ind(r.vol_ratio>=1.2,'Vol',_volTip)}
          ${r.above_vwap!=null?ind(r.above_vwap,'VWAP',_vwapTip):''}
          ${r.hurst!=null?`<span class="exec-ind ${r.hurst>0.55?'exec-ind-pass':r.hurst<0.45?'exec-ind-warn':'exec-ind-dim'}" title="${_hurstTip}">H ${r.hurst}</span>`:''}
          ${r.atr_pct_rank!=null?`<span class="exec-ind ${r.atr_pct_rank<=20?'exec-ind-pass':r.atr_pct_rank>=80?'exec-ind-warn':'exec-ind-dim'}" title="${_atrTip}">ATR ${r.atr_pct_rank}%</span>`:''}
          ${r.divergence?`<span class="exec-ind ${r.divergence==='bullish'?'exec-ind-pass':'exec-ind-warn'}" title="${_divTip}">${r.divergence==='bullish'?'↗':'↘'} Div</span>`:''}
        </div>
      </div>
    </div>
    <div class="exec-levels">
      <div class="exec-lvl exec-lvl-res" title="Nearest price level above where sellers previously stopped the advance. The stock needs to break cleanly above this ceiling before it can continue higher.">
        <div class="exec-lvl-label">${t('execRes')}</div>
        <div class="exec-lvl-val">${topRes.length?topRes.map(v=>fmt2(v)).join(' · '):'<span class="exec-lvl-na">—</span>'}</div>
      </div>
      <div class="exec-lvl exec-lvl-entry" title="${isBearExec?'Illustrative reference at the current price — this score is not a validated short trigger. Validated buy-list = Momentum tab.':'Illustrative pullback reference near EMA 34 (mid-term trend line) — not a validated buy trigger. If you do trade it, returning here is lower-risk than chasing. Validated buy-list = Momentum tab.'}">
        <div class="exec-lvl-label">${isBearExec?t('execEntry'):'Pullback entry <span style="font-size:9px;color:var(--text3)">(EMA 34)</span>'}</div>
        <div class="exec-lvl-val">${execEntry!=null?fmt2(execEntry):'<span class="exec-lvl-na">—</span>'}</div>
      </div>
      <div class="exec-lvl exec-lvl-t1" title="First profit target — your gain equals your risk (1:1 reward-to-risk). Taking partial profits here is prudent. If the stock keeps running, hold the rest toward T2.">
        <div class="exec-lvl-label">${t('execT1')} <span style="font-size:9px;color:var(--text3)">(1:1 R:R)</span></div>
        <div class="exec-lvl-val">${execT1!=null?fmt2(execT1):'<span class="exec-lvl-na">—</span>'}</div>
      </div>
      <div class="exec-lvl exec-lvl-sup" title="Nearest price level below where buyers previously stepped in and stopped a decline. A natural floor — if price falls here and holds, that is a sign of strength.">
        <div class="exec-lvl-label">${t('execSup')}</div>
        <div class="exec-lvl-val">${topSup.length?topSup.map(v=>fmt2(v)).join(' · '):'<span class="exec-lvl-na">—</span>'}</div>
      </div>
      <div class="exec-lvl exec-lvl-stop" title="Stop loss — 1.5× ATR from your entry price. If the stock closes at or below this level, the trade thesis is invalidated. Exit immediately to protect your capital — this is not negotiable.">
        <div class="exec-lvl-label">${t('execStop')}</div>
        <div class="exec-lvl-val">${execStop!=null?fmt2(execStop):'<span class="exec-lvl-na">—</span>'}</div>
      </div>
      <div class="exec-lvl exec-lvl-t2" title="Second profit target — your gain is twice your risk (2:1 reward-to-risk). This is the strategy's primary target. Hold for this when the trend is clearly in your favour and momentum is still building.">
        <div class="exec-lvl-label">${t('execT2')} <span style="font-size:9px;color:var(--text3)">(2:1 R:R)</span></div>
        <div class="exec-lvl-val">${execT2!=null?fmt2(execT2):'<span class="exec-lvl-na">—</span>'}</div>
      </div>
    </div>
    ${r.atr==null?`<div class="exec-atr-warn">⚠ Entry · Stop · Target levels require ATR — run a fresh scan to populate</div>`:''}
    <div class="exec-footer">
      ${rrRatio!=null?`<span class="exec-tag" style="background:rgba(61,142,255,.12);color:var(--accent)" title="Risk-to-reward ratio: for every 1 unit you risk, you stand to gain ${rrRatio.toFixed(1)}. Most professionals require at least 1.5:1 before entering a trade.">${t('execRR')} ${rrRatio.toFixed(1)}:1</span>`:''}
      <span class="exec-tag ${r.rs_score!=null?(r.rs_score>2?'exec-ind-pass':r.rs_score<-2?'exec-ind-fail':'exec-ind-dim'):'exec-ind-dim'}" title="${r.rs_score!=null?(r.rs_score>0?'Outperformed its market index by +'+r.rs_score.toFixed(1)+'% over the past 20 days — a relative strength leader. Institutions rotate into leaders first.':'Underperformed its market index by '+Math.abs(r.rs_score).toFixed(1)+'% over the past 20 days — a laggard. Money is rotating away from it.'):'Relative strength vs index not available.'}">RS ${r.rs_score!=null?(r.rs_score>0?'+':'')+r.rs_score.toFixed(1)+'%':'—'}</span>
      ${r.vwap20!=null?`<span class="exec-tag ${r.above_vwap?'exec-ind-pass':'exec-ind-fail'}" title="${r.above_vwap?'Price is above the 20-day VWAP ('+r.vwap20.toFixed(2)+') — buyers from the past month are profitable on average, reducing their incentive to sell. Bullish pressure.':'Price is below the 20-day VWAP ('+r.vwap20.toFixed(2)+') — the average buyer from the past month is underwater. That overhead supply makes it harder to push price higher.'}">VWAP ${r.above_vwap?'▲':'▼'} ${r.vwap20?.toFixed(2)}</span>`:''}
      ${r.weekly&&scanMode==='position'?`<span class="exec-tag exec-ind-${r.weekly.score===4?'pass':r.weekly.score===0?'fail':'warn'}" title="${r.weekly.score===4?'Weekly trend is fully confirmed — EMA stack and price above 200-day are both passing on the weekly chart. Adds strong conviction for longer-term positions.':r.weekly.score===0?'Weekly trend is not confirmed — the daily signal is not supported by the bigger weekly picture. Extra caution advised.':'Weekly trend is partially confirmed — some but not all weekly criteria are passing.'}">${weeklyBadgeHtml(r)}</span>`:''}
      <span style="margin-inline-start:auto;color:var(--text3)" title="ATR (Average True Range) — how much this stock typically moves in a single day. Used to calculate stop loss and profit targets. Wider ATR = larger stops needed.">ATR ${r.atr!=null?fmt2(r.atr):'—'}</span>
    </div>
  </div>`;

  // TF Alignment card (loads async)
  const tfCard=`<div class="tf-card">
    <div class="tf-header"><span>${t('tfTitle')}</span><button class="regime-refresh-btn" onclick="loadTFAlignment('${r.sym}')">⟳</button></div>
    <div id="tf-align-content"><div class="tf-loading">${t('tfLoading')}</div></div>
  </div>`;

  // News card (loads async)
  const newsCard=`<div class="crit-section-title">${t('newsTitle')}</div>
    <div class="vh-card"><div id="news-content"><div class="tf-loading"><span class="spin">⟳</span></div></div></div>`;

  // Score delta display
  const drawerDelta=deltaData.find(d=>d.sym===r.sym);
  let deltaLine='';
  if(drawerDelta){
    const dsign=drawerDelta.score_delta>0?'+':'';
    const dcol=drawerDelta.score_delta>0?'var(--green)':'#ff5252';
    deltaLine=`<div style="font-size:11px;color:var(--text3);margin-top:2px">Score <span style="color:${dcol}">${dsign}${drawerDelta.score_delta}</span> since last scan (was ${drawerDelta.prev_score}/${r.maxScore||8} · ${drawerDelta.prev_bias})</div>`;
  }
  // Action buttons
  const watchNow=watchlistData.includes(r.sym);
  const actBtns=`<div class="signal-actions">
    <button class="sig-act-btn${watchNow?' sig-watch-on':''}" id="sig-wl-btn"
      onclick="toggleWatchlist('${r.sym}',event)">${watchNow?'★ Watchlist':'☆ Watchlist'}</button>
    <button class="goto-btn" onclick="goToVirtualBuy('${r.sym}',${r.price||0})" title="Pre-fill Virtual Portfolio">💰 Virtual Buy</button>
    <button class="goto-btn" onclick="goToSetAlert('${r.sym}','${r.name.replace(/'/g,"\\'")}')" title="Pre-fill Smart Alert Rule">📋 Set Rule</button>
    <button class="goto-btn" onclick="openOnChart('${r.sym}')" title="Open on TradingView chart">📈 Chart</button>
  </div>`;

  // Score history spark + "What Changed" callout
  const histSpark=scoreHistorySparkHtml(r.sym);
  const deltaCallout=buildDeltaCallout(drawerDelta,r);

  // Criteria breakdown — natural language cards, with direction-aware heading
  const critHeading = isBear
    ? `<div class="crit-section-title crit-section-bear">⚠️ Bearish Criteria (Daily Chart) — checkmarks mean downtrend signals are active, NOT buy signals</div>`
    : `<div class="crit-section-title">✅ ${t('critBreakdown')} <span style="font-size:9px;font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0;margin-inline-start:4px">· Daily · 7 pts here · volume (+1 pt) shown above</span></div>`;
  const criteriaSection=`${critHeading}${crits.join('')}`;

  // Plain-language banner for non-financial users
  const sl=scoreLabel(r.score,r.maxScore||8);
  const passCount=crits.filter ? (r.flags||[]).length : 0;
  const plainBannerText={
    'STRONG BUY': `${r.name} is showing strong bullish signals — price trend, momentum, and volume are all aligned for an upward move.`,
    'BUY':        `${r.name} looks positive — the main indicators are supportive of a buy. Consider entering near current price.`,
    'WATCH':      `${r.name} shows some promise but isn't fully ready yet. Monitor it — a breakout could confirm entry.`,
    'SKIP':       `${r.name} doesn't show a clear direction right now. No strong buy or sell signal — better opportunities may exist elsewhere.`,
    'AVOID':      `${r.name} has warning signs. Risk is elevated — best to avoid until conditions improve.`,
    'SELL':       `${r.name} is losing momentum. Existing holders may want to consider an exit or tighten stop-losses.`,
    'STRONG SELL':`${r.name} is showing multiple bearish signals. Price trend, momentum, and volume all point downward — exit positions.`,
  }[r.bias]||'';
  const plainBanner=plainBannerText?`<div class="plain-banner plain-banner-${isBear?'bear':'bull'}">
    <div class="pb-score" style="color:${sl.col}">${sl.text} signal &nbsp;·&nbsp; ${r.score}/${r.maxScore||8} pts</div>
    <div class="pb-text">${plainBannerText}</div>
    <button class="pb-glossary-btn" onclick="openGlossary()">📖 What do these terms mean?</button>
  </div>`:'';

  // ── Mode context banner ─────────────────────────────────────────────────────
  const isPosition = scanMode === 'position';
  const isBreakout = scanMode === 'breakout';
  const modeCtxIcon = isPosition ? '📊' : isBreakout ? '⚡' : '📈';
  const modeCtxTitle = isPosition ? 'Long-Term Position Analysis' : isBreakout ? 'Breakout Hunter Analysis' : 'Short-Term Swing Analysis';
  const modeCtxPillClass = isPosition ? 'position' : isBreakout ? 'breakout' : 'swing';
  const modeCtxPillLabel = isPosition ? 'Position' : isBreakout ? 'Breakout' : 'Swing';
  const modeCtxDesc = isPosition
    ? `This analysis uses <strong>daily + weekly</strong> timeframes. All 9 criteria are evaluated on the daily chart, then cross-referenced against weekly trend alignment. Best suited for investors holding <strong>weeks to months</strong>.`
    : isBreakout
    ? `This analysis uses <strong>volume surge + relative strength</strong> to find early movers. Criteria: price above EMA 200, 2× volume spike, RS outperformance vs index, RSI momentum zone, and MACD positive. Best suited for <strong>breakout entries</strong>.`
    : `This analysis uses the <strong>daily timeframe only</strong>. All 9 criteria — EMA stack, RSI momentum, MACD, volume, and VWAP — are evaluated on the daily chart. Best suited for swing traders holding <strong>days to a few weeks</strong>.`;
  const modeCtxTag3 = isPosition ? '<span class="mode-ctx-tag">🏛 Weekly alignment: separate pass/fail check</span>' : isBreakout ? '<span class="mode-ctx-tag">📡 RS vs index: 20-day outperformance</span>' : '<span class="mode-ctx-tag">⚡ Entry zone: EMA 34 pullback</span>';
  const modeCtx = `<div class="mode-ctx">
    <div class="mode-ctx-icon">${modeCtxIcon}</div>
    <div class="mode-ctx-body">
      <div class="mode-ctx-title">
        ${modeCtxTitle}
        <span id="mode-ctx-pill" class="mode-ctx-pill ${modeCtxPillClass}">${modeCtxPillLabel}</span>
      </div>
      <div class="mode-ctx-desc">${modeCtxDesc}
      </div>
      <div class="mode-ctx-tags">
        <span class="mode-ctx-tag">📅 ${isPosition ? 'Daily + Weekly' : 'Daily chart'}</span>
        <span class="mode-ctx-tag">⏳ ${isPosition ? 'Weeks – months' : isBreakout ? 'Early entry' : 'Days – weeks'}</span>
        <span class="mode-ctx-tag">🎯 ${isBreakout?'8':'9'}-pt score (daily only)</span>
        ${modeCtxTag3}
      </div>
    </div>
  </div>`;

  // Risk warnings (extension, near resistance, regime adjustment)
  const riskWarnings = [];
  if (r.extension_pct > 25) riskWarnings.push(`<span style="background:rgba(255,145,0,.1);color:var(--orange);border-radius:4px;padding:2px 6px;font-size:10px">⚠ Extended ${r.extension_pct}% from 20d low</span>`);
  if (r.near_resistance)     riskWarnings.push(`<span style="background:rgba(255,80,80,.08);color:var(--red);border-radius:4px;padding:2px 6px;font-size:10px">⚠ Near resistance</span>`);
  if (r.regime_discount > 0) riskWarnings.push(`<span style="background:rgba(255,145,0,.08);color:var(--orange);border-radius:4px;padding:2px 6px;font-size:10px">Market ${r.market_regime} → score adjusted to ${r.regime_score}/${r.maxScore||8}</span>`);
  const riskWarningsHtml = riskWarnings.length > 0
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 0 4px">${riskWarnings.join(' ')}</div>`
    : '';

  // Overview tab: verdict, score, action, what changed, entry guidance
  const initial360 = build360Card(r, null); // no fund data yet — shows loading
  document.getElementById('dtab-signal').innerHTML=`
    <div id="a360-card-wrap">${initial360}</div>
    ${plainBanner}
    ${execCard}
    ${riskWarningsHtml}
    ${modeCtx}
    ${actBtns}
    ${deltaCallout}
    ${histSpark}
    <div id="drawer-block-deals" style="display:none"></div>
    ${shCard}
    ${actionHtml}`;

  // Show block deals for this stock in the Overview tab (instant — uses cache)
  renderDrawerBlockDeals(r.sym);

  // Load fundamentals async and update the 360 card
  load360Analysis(r.sym, r);

  // Setup tab: all the supporting evidence
  document.getElementById('dtab-analysis').innerHTML=`
    <div class="crit-section-title" style="margin-bottom:8px">Price Chart — 1 Year Daily</div>
    <div class="native-chart-wrap" id="drawer-native-chart"><div class="native-chart-loading">Loading chart…</div></div>
    ${criteriaSection}
    ${buildVolCard(r)}
    ${buildDynamicsCard(r)}
    ${rsCard}
    ${weeklyCard}
    ${divCard}
    ${tfCard}
    ${newsCard}`;

  // Async sections live in Setup tab now
  loadTFAlignment(r.sym);
  loadNewsForDrawer(r.sym);
  // Store chart params on the container; load lazily when the Chart tab becomes visible
  const _chartWrap = document.getElementById('drawer-native-chart');
  if (_chartWrap) {
    const _dp = ((window._oppCache || []).find(o => o.sym === r.sym) || {}).discovery_price || null;
    _chartWrap.dataset.sym = r.sym;
    _chartWrap.dataset.dp  = _dp ?? '';
    _chartWrap.dataset.cp  = r.price ?? '';
  }
}

function buildTradeTab(r){
  const isBear=['STRONG SELL','SELL','AVOID'].includes(r.bias);
  const fmt=v=>v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  let atrHtml='';
  if(r.atr!=null){
    const stop=isBear?r.price+1.5*r.atr:r.price-1.5*r.atr;
    const tgt1=isBear?r.price-1.5*r.atr:r.price+1.5*r.atr;
    const tgt2=isBear?r.price-3*r.atr:r.price+3*r.atr;
    const stopCol=isBear?'var(--green)':'#ff5252',tgtCol=isBear?'#ff5252':'var(--green)';
    atrHtml=`<div class="crit-section-title">${t('atrTitle')} <span style="font-size:9px;font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0;margin-inline-start:4px">· volatility-based · see Signal tab for structure stop (EMA 89)</span></div>
    <div class="atr-panel">
      <div class="atr-row"><span class="atr-label">ATR(14) <span style="font-size:10px;color:var(--text3);font-weight:400">daily volatility unit</span></span><span class="atr-val" style="color:var(--text2)">${fmt(r.atr)}</span></div>
      <div class="atr-row"><span class="atr-label">${t('atrStop')} <span style="font-size:10px;color:var(--text3);font-weight:400">1.5× ATR</span></span><span class="atr-val" style="color:${stopCol}">${fmt(stop)}</span><button class="alert-btn" onclick="createAlertFromDrawer(${stop.toFixed(4)},'${t('atrStop')}')">${t('setAlert')}</button></div>
      <div class="atr-row"><span class="atr-label">${t('atrT1')} <span style="font-size:10px;color:var(--text3);font-weight:400">1.5× · 1:1 R:R · partial exit</span></span><span class="atr-val" style="color:${tgtCol}">${fmt(tgt1)}</span><button class="alert-btn" onclick="createAlertFromDrawer(${tgt1.toFixed(4)},'T1')">${t('setAlert')}</button></div>
      <div class="atr-row"><span class="atr-label">${t('atrT2')} <span style="font-size:10px;color:var(--text3);font-weight:400">3× · 2:1 R:R · main target</span></span><span class="atr-val" style="color:${tgtCol}">${fmt(tgt2)}</span><button class="alert-btn" onclick="createAlertFromDrawer(${tgt2.toFixed(4)},'T2')">${t('setAlert')}</button></div>
    </div>`;
  }
  let srHtml='';
  if(r.sr&&(r.sr.resistance?.length||r.sr.support?.length)){
    const dist=v=>r.price?((v-r.price)/r.price*100).toFixed(1)+'%':'';
    const res=(r.sr.resistance||[]).slice(0,4);
    const sup=(r.sr.support||[]).slice(0,4);
    srHtml=`<div class="crit-section-title">Support &amp; Resistance</div>
    <div class="sr-panel">
      ${res.map(v=>`<div class="sr-level"><span class="sr-price sr-res">R ${fmt(v)}</span><span class="sr-dist">${dist(v)}</span><button class="alert-btn" onclick="createAlertFromDrawer(${v.toFixed(4)},'R')">${t('setAlert')}</button></div>`).join('')}
      ${sup.map(v=>`<div class="sr-level"><span class="sr-price sr-sup">S ${fmt(v)}</span><span class="sr-dist">${dist(v)}</span><button class="alert-btn" onclick="createAlertFromDrawer(${v.toFixed(4)},'S')">${t('setAlert')}</button></div>`).join('')}
    </div>`;
  }
  const defBalance=settingsData?.account_balance||100000;
  const defRisk=settingsData?.risk_percent||1.5;
  const defStop=r.atr!=null?(isBear?r.price+1.5*r.atr:r.price-1.5*r.atr):0;
  // ATR rank context banner for position sizer
  let atrRankBanner='';
  if(r.atr_pct_rank!=null){
    if(r.atr_pct_rank>=80){
      atrRankBanner=`<div style="background:rgba(255,61,113,.08);border:1px solid rgba(255,61,113,.22);border-radius:7px;padding:9px 12px;margin-bottom:8px;font-size:11px;line-height:1.55;color:rgba(255,255,255,.8)">
        <strong style="color:#ff5252">⚠ High Volatility (ATR Rank ${r.atr_pct_rank}%)</strong><br>
        ATR is in the top 20% of its 252-day range — market is unusually volatile right now. Consider <strong>reducing position size by 30–50%</strong> or widening your stop to avoid being shaken out. The standard 1.5× ATR stop may be too tight.
      </div>`;
    } else if(r.atr_pct_rank<=20){
      atrRankBanner=`<div style="background:rgba(0,230,118,.06);border:1px solid rgba(0,230,118,.18);border-radius:7px;padding:9px 12px;margin-bottom:8px;font-size:11px;line-height:1.55;color:rgba(255,255,255,.8)">
        <strong style="color:var(--green)">● Volatility Compressed (ATR Rank ${r.atr_pct_rank}%)</strong><br>
        ATR is in the bottom 20% of its 252-day range — price is coiling. If this is a valid setup, <strong>tighter stops are viable</strong> and potential reward is asymmetric. Watch for an expansion breakout.
      </div>`;
    } else {
      atrRankBanner=`<div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:7px;padding:7px 12px;margin-bottom:8px;font-size:11px;color:var(--text3)">
        ATR Rank ${r.atr_pct_rank}% — normal volatility range. Standard position sizing applies.
      </div>`;
    }
  }
  const sizerHtml=`<div class="crit-section-title">Position Sizer</div>
  ${atrRankBanner}
  <div class="sizer-panel">
    <div class="sizer-inputs">
      <div class="sizer-input-group"><label class="sizer-label">Balance</label><input class="sizer-input" id="sz-balance" type="number" value="${defBalance}" onchange="calcSizer()"></div>
      <div class="sizer-input-group"><label class="sizer-label">Risk %</label><input class="sizer-input" id="sz-risk" type="number" value="${defRisk}" step="0.1" min="0.1" max="10" onchange="calcSizer()"></div>
      <div class="sizer-input-group"><label class="sizer-label">Entry</label><input class="sizer-input" id="sz-entry" type="number" value="${r.price?.toFixed(2)||''}" step="0.01" onchange="calcSizer()"></div>
      <div class="sizer-input-group"><label class="sizer-label">Stop</label><input class="sizer-input" id="sz-stop" type="number" value="${defStop?defStop.toFixed(2):''}" step="0.01" onchange="calcSizer()"></div>
    </div>
    <div id="sz-result"></div>
  </div>`;
  const vpPos = virtualData?.positions?.[r.sym];
  const vpSharesHeld = vpPos ? vpPos.shares : 0;
  const _commNote = r.sym?.startsWith('TADAWUL:') ? '<span style="color:var(--text3);font-size:9px;margin-inline-start:4px">· 0.31% brokerage included</span>' : '<span style="color:var(--text3);font-size:9px;margin-inline-start:4px">· 0.1% commission included</span>';
  const vpSection = `<div class="vp-drawer">
    <div class="vp-drawer-title">${t('tabVirtual')}${_commNote} ${vpSharesHeld ? `<span style="color:var(--accent);margin-inline-start:4px">${vpSharesHeld} shares held @ ${fmtPrice(vpPos.avg_cost, r.sym)}</span>` : ''}</div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input id="vp-buy-shares" class="vp-shares-input" type="number" placeholder="${t('vpShares')}" min="1" step="1">
      <button class="btn btn-success" style="font-size:11px;padding:5px 10px" onclick="virtualBuyFromDrawer()">${t('vpBuy')}</button>
      ${vpSharesHeld ? `<button class="btn btn-secondary" style="font-size:11px;padding:5px 10px;color:#ff5252" onclick="virtualSellFromDrawer()">${t('vpSell')}</button>` : ''}
    </div>
    <div id="vp-trade-status" style="font-size:10px;color:var(--text3);margin-top:4px"></div>
  </div>`;
  const tvEmbedSection='';

  // Trade Plan Card — assembled summary at the top
  const isBearPlan=['STRONG SELL','SELL','AVOID'].includes(r.bias);
  const fmtN=v=>v!=null?v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  const planStop=r.atr!=null?(isBearPlan?r.price+1.5*r.atr:r.price-1.5*r.atr):null;
  const planT1  =r.atr!=null?(isBearPlan?r.price-1.5*r.atr:r.price+1.5*r.atr):null;
  const planT2  =r.atr!=null?(isBearPlan?r.price-3*r.atr  :r.price+3*r.atr  ):null;
  const stopCol =isBearPlan?'var(--green)':'#ff5252';
  const tgtCol  =isBearPlan?'#ff5252':'var(--green)';
  const tradePlanCard=`<div class="trade-plan-card">
    <div class="tpc-header">Trade Plan <span style="font-size:9px;font-weight:400;color:var(--text3);letter-spacing:0">${isBearPlan?'▼▼ Short / Avoid':'▲▲ Long'} · ATR-based levels</span></div>
    <div class="tpc-levels">
      <div class="tpc-lvl"><div class="tpc-lvl-label">Entry</div><div class="tpc-lvl-val" style="color:var(--text)">${fmtN(r.price)}</div></div>
      <div class="tpc-lvl"><div class="tpc-lvl-label">Stop</div><div class="tpc-lvl-val" style="color:${stopCol}">${planStop!=null?fmtN(planStop):'—'}</div></div>
      <div class="tpc-lvl"><div class="tpc-lvl-label">T1</div><div class="tpc-lvl-val" style="color:${tgtCol}">${planT1!=null?fmtN(planT1):'—'}</div></div>
      <div class="tpc-lvl"><div class="tpc-lvl-label">T2</div><div class="tpc-lvl-val" style="color:${tgtCol}">${planT2!=null?fmtN(planT2):'—'}</div></div>
    </div>
    <div class="tpc-stats">
      <div class="tpc-stat"><div class="tpc-stat-label">Shares</div><div class="tpc-stat-val" id="tpc-shares" style="color:var(--accent)">—</div></div>
      <div class="tpc-stat"><div class="tpc-stat-label">Risk</div><div class="tpc-stat-val" id="tpc-risk" style="color:#ff5252">—</div></div>
      <div class="tpc-stat"><div class="tpc-stat-label">R:R (T1)</div><div class="tpc-stat-val" id="tpc-rr" style="color:var(--yellow)">—</div></div>
    </div>
    ${planStop!=null?`<button class="tpc-set-all-btn" id="tpc-set-all-btn" onclick="setAllAtrAlerts(${planStop.toFixed(4)},${planT1.toFixed(4)},${planT2.toFixed(4)})">Set Stop + T1 + T2 Alerts</button>`:''}
  </div>`;

  document.getElementById('dtab-trade').innerHTML=`
    ${tradePlanCard}
    <div id="kelly-sizing-panel" style="margin-top:8px">
      <div style="font-size:10px;color:var(--text3);padding:4px 0">Loading historical edge…</div>
    </div>
    <div id="drawer-live-price" class="live-price-row">
      <span style="font-size:11px;color:var(--text2)">Scan: <strong>${ccySign(r.sym)} ${fmtPrice(r.price, r.sym)}</strong></span>
      <button class="live-refresh-btn" onclick="refreshLivePrice('${r.sym}')">${t('posLivePrice')}</button>
    </div>
    ${atrHtml}${sizerHtml}${srHtml}
    ${vpSection}`;
  setTimeout(calcSizer, 0);
  loadKellySizing(r.sym);
}

async function loadKellySizing(sym) {
  const el = document.getElementById('kelly-sizing-panel');
  if (!el) return;
  try {
    const d = await fetch('/api/kelly/' + encodeURIComponent(sym)).then(r => r.json());
    if (!d.lab) {
      el.innerHTML = `<div style="font-size:10px;color:var(--text3);padding:4px 0;border:1px solid var(--border);border-radius:6px;padding:7px 10px">
        <strong style="color:var(--text2)">Historical Edge</strong><br>${d.note}
      </div>`;
      return;
    }
    const l = d.lab;
    const confCol = l.confidence === 'high' ? 'var(--green)' : l.confidence === 'moderate' ? 'var(--yellow)' : 'var(--orange)';
    const expCol  = l.expectancy >= 1 ? 'var(--green)' : l.expectancy >= 0 ? 'var(--yellow)' : '#ff5252';
    const szHtml  = d.sizing
      ? `<div style="display:flex;gap:12px;margin-top:6px;flex-wrap:wrap">
          <div><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Recommended</div><div style="font-size:14px;font-weight:800;color:var(--accent)">${d.sizing.recommended_shares} shares</div></div>
          <div><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Position Value</div><div style="font-size:14px;font-weight:800;color:var(--text)">${d.sizing.position_value_sar.toLocaleString('en-US',{maximumFractionDigits:0})} SAR</div></div>
          <div><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Portfolio %</div><div style="font-size:14px;font-weight:800;color:var(--yellow)">${d.sizing.position_pct}%</div></div>
          <div><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Risk (1R)</div><div style="font-size:14px;font-weight:800;color:#ff5252">${d.sizing.risk_per_trade_sar.toLocaleString('en-US',{maximumFractionDigits:0})} SAR</div></div>
        </div>`
      : '';
    el.innerHTML = `<div style="background:rgba(255,255,255,.025);border:1px solid var(--border);border-radius:6px;padding:9px 12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:11px;font-weight:700;color:var(--text)">Historical Edge · ${d.style_tag}</span>
        <span style="font-size:10px;color:${confCol}">${l.confidence} confidence · ${l.sample} signals</span>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Win Rate</div><div style="font-size:13px;font-weight:700;color:${l.win_rate_pct>=55?'var(--green)':l.win_rate_pct>=45?'var(--yellow)':'#ff5252'}">${l.win_rate_pct}%</div></div>
        <div><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Avg Win</div><div style="font-size:13px;font-weight:700;color:var(--green)">${l.avg_win_r}R</div></div>
        <div><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Avg Loss</div><div style="font-size:13px;font-weight:700;color:#ff5252">${l.avg_loss_r}R</div></div>
        <div><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Expectancy</div><div style="font-size:13px;font-weight:700;color:${expCol}">${l.expectancy >= 0 ? '+' : ''}${l.expectancy}R</div></div>
        <div title="Full Kelly = mathematically optimal fraction. Half-Kelly = safer, recommended."><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">½-Kelly</div><div style="font-size:13px;font-weight:700;color:var(--accent)">${l.kelly_half_pct}%</div></div>
      </div>
      ${szHtml}
      <div style="font-size:10px;color:var(--text3);margin-top:6px">${d.note}</div>
    </div>`;
  } catch(e) {
    const el2 = document.getElementById('kelly-sizing-panel');
    if (el2) el2.innerHTML = '';
  }
}

function buildAnalysisTab(r){
  // Content is now built inside buildSignalTab (Setup tab = dtab-analysis)
  // This function handles the backtest/seasonality which moved to buildFundamentalsTab
  // No-op: dtab-analysis content is set by buildSignalTab
}

function buildSeasonalHtml(r){
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if(!r.seasonality) return '';
  const cells=months.map((m,i)=>{
    const val=r.seasonality[i+1];
    if(val==null) return`<div class="season-cell" style="background:var(--border2)"><div class="season-month">${m}</div><div class="season-val" style="color:var(--text3)">—</div></div>`;
    const pct=parseFloat(val.toFixed(1));
    const intensity=Math.min(Math.abs(pct)/5,1);
    const bg=pct>0?`rgba(0,230,118,${(0.08+0.3*intensity).toFixed(2)})`:
                   `rgba(255,61,113,${(0.08+0.3*intensity).toFixed(2)})`;
    return`<div class="season-cell" style="background:${bg}"><div class="season-month">${m}</div><div class="season-val" style="color:${pct>0?'var(--green)':'var(--red)'}">${pct>0?'+':''}${pct}%</div></div>`;
  }).join('');
  return `<div class="crit-section-title">Seasonality <span style="font-size:9px;font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0;margin-inline-start:4px">· avg monthly return over past 5 years</span></div><div class="season-grid">${cells}</div>`;
}

function buildFundamentalsTab(r){
  const sec=sectorOf(r.sym);
  const bm=SECTOR_BENCHMARKS[sec]||SECTOR_BENCHMARKS.other;
  document.getElementById('dtab-fund').innerHTML=`
    <div id="d-value-highlights"></div>
    <div class="fund-section-title">${t('fundTitle')}</div>
    <div id="d-fund-section"><div class="fund-loading">${t('fundLoading')}</div></div>
    <div class="crit-section-title" style="margin-top:14px">${t('btTitle')}</div>
    <div id="drawer-bt"><button class="btn btn-secondary" style="width:100%;font-size:11px" onclick="runBacktestInDrawer('${r.sym}')">${t('btRun')}</button></div>
    ${buildSeasonalHtml(r)}`;
  loadFundamentals(r.sym).then(fdata=>{
    if(!fdata) return;
    renderValueHighlights(fdata, sec, bm, r);
  });
}

function renderValueHighlights(f, sec, bm, r){
  const el=document.getElementById('d-value-highlights');
  if(!el) return;
  const rate=(val,bench,lower_is_better)=>{
    if(val==null||bench==null) return null;
    const ratio=val/bench;
    if(lower_is_better) return ratio<=0.8?'cheap':ratio<=1.2?'fair':'pricey';
    return ratio>=1.2?'cheap':ratio>=0.8?'fair':'pricey';
  };
  const ratingHtml=(r)=>{
    if(!r) return`<span class="vh-rating vh-na">${t('vhNa')}</span>`;
    const cls={'cheap':'vh-cheap','fair':'vh-fair','pricey':'vh-pricey'}[r];
    const lbl={'cheap':t('vhCheap'),'fair':t('vhFair2'),'pricey':t('vhPricey')}[r];
    return`<span class="vh-rating ${cls}">${lbl}</span>`;
  };
  const barRow=(label,val,bench,lowerIsBetter)=>{
    if(val==null) return`<div class="vh-row"><span class="vh-label">${label}</span><div class="vh-bar-wrap"><div class="vh-bar-fill" style="width:0%;background:var(--border2)"></div></div><span class="vh-vals" style="color:var(--text3)">N/A</span>${ratingHtml(null)}</div>`;
    const maxVal=Math.max(val,bench||val)*1.5||1;
    const fillPct=Math.min(val/maxVal*100,100);
    const peerPct=bench?Math.min(bench/maxVal*100,100):50;
    const rt=rate(val,bench,lowerIsBetter);
    const fillCol={'cheap':'var(--green)','fair':'var(--yellow)','pricey':'#ff5252',null:'var(--border2)'}[rt];
    return`<div class="vh-row">
      <span class="vh-label">${label}</span>
      <div class="vh-bar-wrap"><div class="vh-bar-fill" style="width:${fillPct}%;background:${fillCol}"></div>${bench?`<div class="vh-peer-line" style="inset-inline-start:${peerPct}%" title="Sector avg: ${bench}"></div>`:''}</div>
      <span class="vh-vals">${val.toFixed(1)} <span style="color:var(--text3);font-size:10px">vs ${bench??'—'}</span></span>
      ${ratingHtml(rt)}
    </div>`;
  };
  // Fair value estimate
  let fairHtml='';
  if(f.epsForward!=null&&bm.pe!=null){
    const fair=+(f.epsForward*bm.pe).toFixed(2);
    const upside=r.price?+((fair-r.price)/r.price*100).toFixed(1):null;
    const uCol=upside>0?'var(--green)':upside<0?'#ff5252':'var(--text2)';
    fairHtml=`<div class="vh-fair-val"><div><div style="font-size:10px;color:var(--text3);margin-bottom:2px">${t('vhFair')} (EPS×PEbench)</div><div style="font-size:11px;color:var(--text2)">EPS(fwd) ${f.epsForward.toFixed(2)} × ${bm.pe}x</div></div><div style="text-align:end"><span class="vh-fair-price">${fmtPrice(fair,r.sym)}</span>${upside!=null?`<div style="font-size:11px;color:${uCol}">${upside>0?'+':''}${upside}% vs current</div>`:''}</div></div>`;
  }
  const sectorLabel2=SECTOR_BENCHMARKS[sec]?sec.charAt(0).toUpperCase()+sec.slice(1):'General';
  el.innerHTML=`<div class="vh-card">
    <div class="vh-header"><span>${t('vhTitle')}</span><span style="color:var(--text3);font-size:9px">${sectorLabel2} benchmarks (▏= sector avg)</span></div>
    ${barRow(t('vhPe'), f.peTrailing, bm.pe, true)}
    ${barRow(t('vhPb'), f.pb, bm.pb, true)}
    ${barRow(t('vhDe'), f.debtToEquity!=null?f.debtToEquity/100:null, bm.de, true)}
  </div>
  ${fairHtml}`;
}

async function loadFundamentals(sym){
  const el=document.getElementById('d-fund-section');
  if(!el) return null;
  try{
    const res=await fetch('/api/fundamentals?sym='+encodeURIComponent(sym));
    const json2=await res.json();
    if(!json2.success) throw new Error(json2.error||'Failed');
    el.innerHTML=buildFundamentalsSection(json2.data,json2.score);
    return json2.data;
  }catch(e){
    el.innerHTML=`<div class="crit-card fail"><div class="crit-card-header"><span class="crit-icon">⚠️</span><span class="crit-label">${t('fundError')}</span></div><div class="crit-explain" style="font-size:11px;color:var(--text3)">${e.message}</div></div>`;
    return null;
  }
}
