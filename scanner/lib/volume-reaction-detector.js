/**
 * Volume Reaction Detector — hacimli bar uclarinda kontra tepki setup'i.
 *
 * CLAUDE.md "Hacimli Bar Uclarinda Giris Kurali (Exhaustion & Tepki Avi)":
 *  - Hacimli YESIL bar tepesinde → SHORT tepki adayi
 *  - Hacimli KIRMIZI bar alt ucunda → LONG tepki adayi
 *
 * Bar "hacimli" sayilir: hacim son 20 barin ortalamasinin >= 1.5 kati VE
 * govde (|close-open|) toplam bar aralıginin (high-low) >= %50.
 *
 * 5 teyit kalemi: SMC zone testi, RSI/divergence, MACD, EMA9/21 cross, StochRSI.
 * En az 3 teyit + SMC zone tercihen varsa → reaction_short veya reaction_long.
 */

const VOL_MULT = 1.5;
const BODY_RATIO = 0.5;
const EDGE_ZONE = 0.20; // close top/bottom %20

/**
 * SMC bolgesinde mi (OB/FVG kenari — reaction icin uygun)?
 *   short reaction (bearish): bearish OB icinde veya premium bolgede
 *   long reaction (bullish): bullish OB icinde veya discount bolgede
 */
function priceInReactionZone(price, smc, direction) {
  if (!smc?.orderBlocks) return false;
  const blocks = smc.orderBlocks;
  for (const ob of blocks) {
    const inside = price >= ob.low && price <= ob.high;
    if (!inside) continue;
    const type = (ob.type || ob.kind || '').toLowerCase();
    const bullish = type.includes('bull') || type.includes('up');
    const bearish = type.includes('bear') || type.includes('down');
    if (direction === 'short' && bearish) return true;
    if (direction === 'long' && bullish) return true;
    // Tip bilgisi yoksa: OB icinde olmak tek basina zayif teyit sayilir
    if (!bullish && !bearish) return true;
  }
  return false;
}

/**
 * 2-bar confirm yapisi: bars[-2] exhaustion bari (hacimli, uc-pozisyonlu),
 * bars[-1] confirm bari (exhaustion yonunun TERSINE kapanmali — gercek donus).
 * Tek barda sinyal vermek trend devami durumunda SL yer; confirm bar filtresi
 * ile "gercekten donus" yakalanmis olur.
 */
function detectExhaustionBar(bars) {
  if (!Array.isArray(bars) || bars.length < 23) return null;
  const confirm = bars[bars.length - 1];
  const exhaust = bars[bars.length - 2];
  const prev20 = bars.slice(-22, -2);
  const avgVol = prev20.reduce((s, b) => s + (b.volume || 0), 0) / prev20.length;
  if (!avgVol || (exhaust.volume || 0) < avgVol * VOL_MULT) return null;

  const range = exhaust.high - exhaust.low;
  if (range <= 0) return null;
  const body = Math.abs(exhaust.close - exhaust.open);
  if (body < range * BODY_RATIO) return null;

  const posInRange = (exhaust.close - exhaust.low) / range; // 1=tepe, 0=dip
  const isGreen = exhaust.close > exhaust.open;
  const isRed = exhaust.close < exhaust.open;

  // Confirm bari: exhaustion yonune karsit kapanis
  const confirmBearish = confirm.close < confirm.open; // kirmizi confirm
  const confirmBullish = confirm.close > confirm.open; // yesil confirm

  if (isGreen && posInRange >= 1 - EDGE_ZONE && confirmBearish) {
    return {
      direction: 'short',
      reason: `Hacimli yesil bar tepesinde (vol ${(exhaust.volume / avgVol).toFixed(2)}x, govde ${(body / range * 100).toFixed(0)}%, ust ${(posInRange * 100).toFixed(0)}%) + kirmizi confirm bar`,
      volRatio: Number((exhaust.volume / avgVol).toFixed(2)),
      bodyPct: Number((body / range).toFixed(2)),
      close: confirm.close,
      confirmed: true,
    };
  }
  if (isRed && posInRange <= EDGE_ZONE && confirmBullish) {
    return {
      direction: 'long',
      reason: `Hacimli kirmizi bar alt ucunda (vol ${(exhaust.volume / avgVol).toFixed(2)}x, govde ${(body / range * 100).toFixed(0)}%, alt ${((1 - posInRange) * 100).toFixed(0)}%) + yesil confirm bar`,
      volRatio: Number((exhaust.volume / avgVol).toFixed(2)),
      bodyPct: Number((body / range).toFixed(2)),
      close: confirm.close,
      confirmed: true,
    };
  }
  return null;
}

/**
 * 5 teyit kalemini kontrol et. En az 3 gerekir; SMC zone tercihli kalem.
 * Dondurur: { confirmations:[...names], smcZoneOk:bool, count:number }
 */
function countConfirmations({ direction, close, smc, khanSaab, stochRSI, divergence }) {
  const confirmations = [];

  // 1) SMC bolge testi
  const smcZoneOk = priceInReactionZone(close, smc, direction);
  if (smcZoneOk) confirmations.push('smc_zone');

  // 2) RSI / Divergence
  const rsi = khanSaab?.rsi;
  if (typeof rsi === 'number') {
    if (direction === 'short' && rsi >= 70) confirmations.push('rsi_overbought');
    if (direction === 'long'  && rsi <= 30) confirmations.push('rsi_oversold');
  }
  if (divergence?.type) {
    const divDir = divergence.type === 'bullish' ? 'long'
                 : divergence.type === 'bearish' ? 'short' : null;
    if (divDir === direction) confirmations.push(`divergence_${divergence.type}`);
  }

  // 3) MACD
  if (khanSaab?.macd) {
    const dir = khanSaab.macd === 'BULL' ? 'long'
              : khanSaab.macd === 'BEAR' ? 'short' : null;
    if (dir === direction) confirmations.push('macd');
  }

  // 4) EMA 9/21 cross (khanSaab.emaStatus)
  if (khanSaab?.emaStatus) {
    const dir = khanSaab.emaStatus === 'BULL' ? 'long'
              : khanSaab.emaStatus === 'BEAR' ? 'short' : null;
    if (dir === direction) confirmations.push('ema_cross');
  }

  // 5) StochRSI
  if (stochRSI && typeof stochRSI.k === 'number') {
    if (direction === 'short' && stochRSI.k >= 80) confirmations.push('stoch_overbought');
    if (direction === 'long'  && stochRSI.k <= 20) confirmations.push('stoch_oversold');
    // Ek: cross sinyali
    if (stochRSI.signal === 'SELL' && direction === 'short') confirmations.push('stoch_cross');
    if (stochRSI.signal === 'BUY'  && direction === 'long')  confirmations.push('stoch_cross');
  }

  // Dedup
  const uniq = Array.from(new Set(confirmations));
  return { confirmations: uniq, smcZoneOk, count: uniq.length };
}

/**
 * Ana detektor: ohlcv + SMC + KhanSaab + stochRSI + divergence alir.
 * Donus: null VEYA
 *  {
 *    type: 'volume_reaction',
 *    direction: 'long'|'short',
 *    bar: {...barInfo},
 *    confirmations: [...],
 *    smcZoneOk: bool,
 *    count: number,
 *    qualityBoost: 0|1 (SMC zone + 3+ teyit varsa +1 kademe onerilir)
 *  }
 */
export function detectVolumeReaction({ bars, smc, khanSaab, stochRSI, divergence }) {
  const exhaust = detectExhaustionBar(bars);
  if (!exhaust) return null;

  const check = countConfirmations({
    direction: exhaust.direction,
    close: exhaust.close,
    smc, khanSaab, stochRSI, divergence,
  });
  if (check.count < 3) return null;

  // SMC zone teyidi yoksa kaliteyi 1 kademe dusur — CLAUDE.md kurali
  const qualityPenalty = check.smcZoneOk ? 0 : 1;

  return {
    type: 'volume_reaction',
    direction: exhaust.direction,
    bar: exhaust,
    confirmations: check.confirmations,
    smcZoneOk: check.smcZoneOk,
    count: check.count,
    qualityPenalty,
    reasoning: `Tepki Setup (${exhaust.direction.toUpperCase()}): ${exhaust.reason}. Teyit: ${check.confirmations.join(', ')} (${check.count}/5${check.smcZoneOk ? ', SMC zone ✓' : ', SMC zone yok'})`,
  };
}
