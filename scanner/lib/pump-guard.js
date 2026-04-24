/**
 * Pump-Top / Dip-Short Entry Guard
 *
 * Sorun: Hacimli yesil mum kapaninca yazilim "ortam yesillendi" diye long
 * sinyali uretip mum tepesinden giriliyor; aksi yonde kirmizi hacimli mumun
 * dibinde short aciliyor. Tepeden alinmis long ilk pullback'te SL'ye gidiyor.
 *
 * Bu modul son kapanmis muma bakar:
 *   - Long sinyali geliyorsa: hacimli yesil mum tepesinde miyiz?
 *   - Short sinyali geliyorsa: hacimli kirmizi mum dibinde miyiz?
 *
 * Tespit edilirse `isPumpTop=true` doner. Severity:
 *   - 'hard': spike izole (oncesinde momentum yok) → entry tamamen iptal,
 *     normal smart-entry akisina dusulur (OB/FVG/pullback aranir)
 *   - 'soft': spike trend devami (oncesinde momentum var) → pullback bekle
 *     ama sinyal iptal edilmesin
 */

const VOL_MULT = 1.6;          // hacim >= 20-bar ort × 1.6
const BODY_RATIO_MIN = 0.6;    // |close-open|/range >= 0.6 (gerçekten yönlü mum)
const BODY_ATR_MIN = 0.8;      // mum gövdesi >= 0.8 × ATR (büyük hareket)
const POS_IN_RANGE_MIN = 0.7;  // long için tepe, short için (1-0.7)=0.3 dip

/**
 * @param {Array} bars - OHLCV bar array (kronolojik). Son eleman = en son
 *   kapanmis bar (live bar dahil DEGIL — engine kapanmis bar pasları).
 * @param {'long'|'short'} direction - Sinyal yönü
 * @param {number} atr - 14-bar ATR
 * @param {object} [opts]
 * @returns {{ isPumpTop: boolean, severity?: 'soft'|'hard', spikeBar?: object,
 *             volRatio?: number, bodyAtr?: number, posInRange?: number,
 *             continuity?: number, reason?: string }}
 */
export function detectPumpTop(bars, direction, atr, opts = {}) {
  if (!Array.isArray(bars) || bars.length < 24) return { isPumpTop: false };
  if (!atr || atr <= 0) return { isPumpTop: false };
  if (direction !== 'long' && direction !== 'short') return { isPumpTop: false };

  const spike = bars[bars.length - 1];
  if (!spike || !Number.isFinite(spike.open) || !Number.isFinite(spike.close)) {
    return { isPumpTop: false };
  }

  const range = spike.high - spike.low;
  if (range <= 0) return { isPumpTop: false };

  const body = Math.abs(spike.close - spike.open);
  const bodyRatio = body / range;
  if (bodyRatio < BODY_RATIO_MIN) return { isPumpTop: false };

  const bodyAtr = body / atr;
  if (bodyAtr < BODY_ATR_MIN) return { isPumpTop: false };

  // Yön eşleşmesi
  const isGreen = spike.close > spike.open;
  const isRed = spike.close < spike.open;
  if (direction === 'long' && !isGreen) return { isPumpTop: false };
  if (direction === 'short' && !isRed) return { isPumpTop: false };

  // Hacim filtresi (son 20 bar ortalamasi, spike haric)
  const prev20 = bars.slice(-21, -1);
  const avgVol = prev20.reduce((s, b) => s + (b.volume || 0), 0) / prev20.length;
  if (!avgVol) return { isPumpTop: false };
  const volRatio = (spike.volume || 0) / avgVol;
  if (volRatio < VOL_MULT) return { isPumpTop: false };

  // Pozisyon: long için tepe (close üst kısımda), short için dip
  const posInRange = (spike.close - spike.low) / range; // 1=tepe, 0=dip
  if (direction === 'long' && posInRange < POS_IN_RANGE_MIN) return { isPumpTop: false };
  if (direction === 'short' && posInRange > (1 - POS_IN_RANGE_MIN)) return { isPumpTop: false };

  // Süreklilik: son 3 mumun yönlü kümülatif return / ATR
  // > 1.5 → trend devamı (soft), < 1.0 → izole spike (hard), arası → soft
  const last3 = bars.slice(-3);
  let cumReturn = 0;
  for (const b of last3) {
    const change = b.close - b.open;
    cumReturn += direction === 'long' ? change : -change;
  }
  const continuity = atr > 0 ? cumReturn / atr : 0;
  const severity = continuity < 1.0 ? 'hard' : 'soft';

  return {
    isPumpTop: true,
    severity,
    spikeBar: spike,
    volRatio: Number(volRatio.toFixed(2)),
    bodyAtr: Number(bodyAtr.toFixed(2)),
    posInRange: Number(posInRange.toFixed(2)),
    continuity: Number(continuity.toFixed(2)),
    reason: direction === 'long'
      ? `Hacimli yesil mum tepesinde (vol ${volRatio.toFixed(2)}x, govde ${bodyAtr.toFixed(2)}xATR, pos ${(posInRange * 100).toFixed(0)}%, 3-bar continuity ${continuity.toFixed(2)})`
      : `Hacimli kirmizi mum dibinde (vol ${volRatio.toFixed(2)}x, govde ${bodyAtr.toFixed(2)}xATR, pos ${((1 - posInRange) * 100).toFixed(0)}%, 3-bar continuity ${continuity.toFixed(2)})`,
  };
}

/**
 * Pullback hedef seviyesi: spike mumun gövde ortası — long için (open+close)/2,
 * short için aynı (yön tarafsız). Burası "fitil orta noktası" yerine gövde
 * ortası: spike gövdesi büyükse fitil ortası daha agresif olur, gövde ortası
 * daha gerçekçi bir tutunma seviyesi.
 *
 * @param {object} spikeBar
 * @returns {number}
 */
export function pumpPullbackLevel(spikeBar) {
  if (!spikeBar) return null;
  return (spikeBar.open + spikeBar.close) / 2;
}
