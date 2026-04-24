/**
 * Risk flag evaluators: earnings, liquidity, spread, news gap, merger, short float.
 *
 * Each dimension returns { flag: 'green'|'yellow'|'red', ...reasonFields }.
 * The overallRiskBand is red if any flag is red, yellow if any yellow, else green.
 */

function flagEarnings(daysOut) {
  // Corrupt sentinel (like ITT's -20547) → yellow with "unverified"
  if (daysOut == null || daysOut < 0 || Number.isNaN(daysOut)) {
    return { flag: 'yellow', daysUntil: null, reason: 'earnings date unverified — check broker' };
  }
  if (daysOut >= 0 && daysOut <= 2) return { flag: 'red',    daysUntil: daysOut, reason: `earnings in ${daysOut}d` };
  if (daysOut >= 3 && daysOut <= 7) return { flag: 'yellow', daysUntil: daysOut, reason: `earnings in ${daysOut}d` };
  return { flag: 'green', daysUntil: daysOut };
}

function flagLiquidity(adv10d, currentVolume) {
  const relVol = (adv10d && currentVolume) ? +(currentVolume / adv10d).toFixed(2) : null;
  if (adv10d == null) return { flag: 'yellow', avgDailyVol: null, reason: 'ADV unavailable', todayRelVolAtFire: relVol };
  if (adv10d >= 500_000) return { flag: 'green',  avgDailyVol: adv10d, todayRelVolAtFire: relVol };
  if (adv10d >= 200_000) return { flag: 'yellow', avgDailyVol: adv10d, todayRelVolAtFire: relVol };
  return { flag: 'red', avgDailyVol: adv10d, reason: 'ADV < 200k shares', todayRelVolAtFire: relVol };
}

function flagSpread(spreadPct) {
  if (spreadPct == null) return { flag: 'yellow', bpsOfPrice: null, reason: 'bid/ask unavailable' };
  const bps = +(spreadPct * 100).toFixed(1);
  if (spreadPct <= 0.10) return { flag: 'green',  bpsOfPrice: bps };
  if (spreadPct <= 0.50) return { flag: 'yellow', bpsOfPrice: bps };
  return { flag: 'red', bpsOfPrice: bps, reason: 'spread > 50 bps' };
}

function flagNewsGap(quote, atr14, newsCount24h) {
  if (!quote || quote.prevClose == null || quote.openToday == null || atr14 == null || atr14 === 0) {
    return { flag: 'yellow', todayGapSigma: null, reason: 'gap data unavailable' };
  }
  const gap = Math.abs(quote.openToday - quote.prevClose);
  const sigma = +(gap / atr14).toFixed(2);
  if (sigma <= 1) return { flag: 'green',  todayGapSigma: sigma, newsCount24h };
  if (sigma <= 2) return { flag: 'yellow', todayGapSigma: sigma, newsCount24h };
  return { flag: 'red', todayGapSigma: sigma, newsCount24h, reason: `open gapped ${sigma.toFixed(1)} ATR` };
}

function flagShortFloat(sfPct) {
  if (sfPct == null || Number.isNaN(sfPct)) {
    return { flag: 'yellow', pct: null, reason: 'short float unavailable' };
  }
  if (sfPct >= 20) return { flag: 'red',    pct: sfPct, reason: `short float ${sfPct}%` };
  if (sfPct >= 10) return { flag: 'yellow', pct: sfPct };
  return { flag: 'green', pct: sfPct };
}

export function evaluateRiskFlags({ scannerRow = {}, quote = {}, recentNewsCount24h = 0, atr14 = null } = {}) {
  const details = scannerRow.details || {};
  const earnings   = flagEarnings(details.earningsDaysOut);
  const liquidity  = flagLiquidity(quote.averageDailyVolume10Day, quote.volume);
  const spread     = flagSpread(quote.spreadPctOfPrice);
  const newsGap    = flagNewsGap(quote, atr14, recentNewsCount24h);
  const shortFloat = flagShortFloat(details.shortFloat);
  const mergerPending = !!(scannerRow.mergerPending || /merger[_\- ]?pending/i.test(scannerRow.notes || ''));

  const dims = { earnings, liquidity, spread, newsGap, shortFloat };
  const anyRed = Object.values(dims).some(d => d.flag === 'red') || mergerPending;
  const anyYellow = Object.values(dims).some(d => d.flag === 'yellow');
  const overallRiskBand = anyRed ? 'red' : (anyYellow ? 'yellow' : 'green');

  return { ...dims, mergerPending, recentNewsCount24h, overallRiskBand };
}
