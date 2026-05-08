/**
 * Strategic TP Engine — 2026-05-03
 *
 * TP1 mevcut R-multiple kalır (kademeli kâr + breakeven tetikleyici).
 * TP2 ve TP3 stratejik seviyelerden seçilir:
 *   - Sinyal TF'inin 100-bar fib seviyeleri (canlı hesap)
 *   - 1D ve 1W cache fib seviyeleri
 *   - Signal-TF SMC order block / FVG band orta noktaları
 *   - Cache'lenmiş HTF SMC line'ları
 *
 * Confluence: 0.5×ATR mesafede çakışan kaynaklar tek seviyeye birleştirilir.
 * Min R:R esnek (TP2 >= 1.6R, TP3 >= 2.4R); aday yoksa R-multiple fallback.
 *
 * Kullanıcının her TF için 100-bar pencere kuralı: cache zaten 1D/1W için
 * 100-bar pencerede; sinyal TF (örn. 4H) için bars üzerinden computeFibLevels
 * çağrılır. Swing yoksa o TF'den seviye gelmez (uydurulmuyor).
 */

import { computeFibLevels } from './fib-engine.js';

const TP2_MIN_R = 1.6;
const TP3_MIN_R = 2.4;
const TP_GAP_R = 0.3; // TP2-TP3 arasında min R farkı
const NOISE_ATR = 0.25; // entry ± 0.25×ATR içindeki seviyeler atılır
const CLUSTER_ATR = 0.5;

function pushFib(out, fibObj, tf) {
  if (!fibObj) return;
  for (const r of (fibObj.retracement || [])) {
    if (Number.isFinite(r?.price) && r.price > 0) {
      out.push({ price: r.price, source: `fib_${r.level}`, tf, kind: 'fib' });
    }
  }
  for (const e of (fibObj.extensions || [])) {
    if (Number.isFinite(e?.price) && e.price > 0) {
      out.push({ price: e.price, source: `fib_ext_${e.level}`, tf, kind: 'fib_ext' });
    }
  }
  if (Number.isFinite(fibObj?.swing?.high?.price)) {
    out.push({ price: fibObj.swing.high.price, source: 'swing_high', tf, kind: 'swing' });
  }
  if (Number.isFinite(fibObj?.swing?.low?.price)) {
    out.push({ price: fibObj.swing.low.price, source: 'swing_low', tf, kind: 'swing' });
  }
}

export function buildStrategicLevels({ signalTF, signalBars, fibCache, parsedBoxes, currentPrice }) {
  const levels = [];

  // 1) Sinyal TF — canlı 100-bar fib (4H gibi cache'de olmayan TF'ler için kritik)
  if (Array.isArray(signalBars) && signalBars.length >= 30) {
    try {
      const liveFib = computeFibLevels(signalBars, signalTF);
      pushFib(levels, liveFib, signalTF);
    } catch { /* swing yoksa atla */ }
  }

  // 2) 1D + 1W cache
  for (const tf of ['1D', '1W']) {
    const tfData = fibCache?.timeframes?.[tf];
    if (!tfData) continue;
    pushFib(levels, tfData.fib, tf);
    for (const lv of (tfData.smcLines || [])) {
      if (Number.isFinite(lv) && lv > 0) {
        levels.push({ price: lv, source: 'smc_line', tf, kind: 'smc_line' });
      }
    }
  }

  // 3) Sinyal TF SMC OB / FVG bantları (parsedBoxes)
  if (parsedBoxes?.orderBlocks?.length) {
    for (const ob of parsedBoxes.orderBlocks) {
      if (!Number.isFinite(ob?.high) || !Number.isFinite(ob?.low)) continue;
      const above = ob.low > currentPrice;
      const below = ob.high < currentPrice;
      // Long için yukarıdaki OB'nin LOW kenarı (ilk dokunuş), aşağıdakinin HIGH kenarı.
      // Short için tersi. Hem mid hem ilgili kenar eklenir.
      levels.push({
        price: (ob.high + ob.low) / 2,
        source: above ? 'ob_above_mid' : (below ? 'ob_below_mid' : 'ob_inside_mid'),
        tf: signalTF, kind: 'ob', band: { high: ob.high, low: ob.low },
      });
      if (above) levels.push({ price: ob.low,  source: 'ob_above_low',  tf: signalTF, kind: 'ob_edge', band: { high: ob.high, low: ob.low } });
      if (below) levels.push({ price: ob.high, source: 'ob_below_high', tf: signalTF, kind: 'ob_edge', band: { high: ob.high, low: ob.low } });
    }
  }
  if (parsedBoxes?.fvgZones?.length) {
    for (const fvg of parsedBoxes.fvgZones) {
      if (!Number.isFinite(fvg?.high) || !Number.isFinite(fvg?.low)) continue;
      levels.push({
        price: (fvg.high + fvg.low) / 2,
        source: 'fvg_mid',
        tf: signalTF, kind: 'fvg', band: { high: fvg.high, low: fvg.low },
      });
    }
  }

  return levels;
}

/**
 * Adayları yön + mesafe filtresi → confluence cluster → sıralı liste.
 */
function clusterCandidates({ levels, direction, entry, atr }) {
  const sign = direction === 'long' ? 1 : -1;
  const minDist = Math.max(atr * NOISE_ATR, 0);
  const clusterDist = Math.max(atr * CLUSTER_ATR, entry * 0.002);

  const filtered = levels
    .filter(l => Number.isFinite(l.price) && l.price > 0)
    .filter(l => sign * (l.price - entry) > minDist)
    .sort((a, b) => sign * (a.price - b.price));

  const clusters = [];
  for (const lv of filtered) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(lv.price - last.price) <= clusterDist) {
      last.sources.push({ source: lv.source, tf: lv.tf, kind: lv.kind, price: lv.price });
      last.confluence = last.sources.length;
      // ağırlıklı ort.
      last.price = (last.price * (last.sources.length - 1) + lv.price) / last.sources.length;
      // band varsa genişlet
      if (lv.band) {
        last.band = last.band
          ? { high: Math.max(last.band.high, lv.band.high), low: Math.min(last.band.low, lv.band.low) }
          : { ...lv.band };
      }
    } else {
      clusters.push({
        price: lv.price,
        sources: [{ source: lv.source, tf: lv.tf, kind: lv.kind, price: lv.price }],
        confluence: 1,
        band: lv.band ? { ...lv.band } : null,
      });
    }
  }
  return clusters;
}

function describeCluster(c) {
  // Kaynakları kısa metne çevir: "1D fib_0.382 + ob_above_low (4H)"
  const parts = c.sources.map(s => {
    if (s.kind === 'fib') return `${s.tf} ${s.source}`;
    if (s.kind === 'fib_ext') return `${s.tf} ${s.source}`;
    if (s.kind === 'swing') return `${s.tf} ${s.source}`;
    if (s.kind === 'smc_line') return `${s.tf} smc_line`;
    if (s.kind === 'ob' || s.kind === 'ob_edge') return `${s.tf} ${s.source}`;
    if (s.kind === 'fvg') return `${s.tf} ${s.source}`;
    return `${s.tf} ${s.source}`;
  });
  return parts.slice(0, 3).join(' + ') + (c.confluence > 3 ? ` (+${c.confluence - 3})` : '');
}

/**
 * TP2 ve TP3 seçimi. TP1 dışarıda hesaplanır (R-multiple).
 * Returns: { tp2, tp2Source, tp3, tp3Source, candidates }
 */
export function pickStrategicTp2Tp3({ levels, direction, entry, sl, atr }) {
  const risk = Math.abs(entry - sl);
  if (!Number.isFinite(risk) || risk <= 0) return { tp2: null, tp3: null, candidates: [] };

  const clusters = clusterCandidates({ levels, direction, entry, atr });
  for (const c of clusters) c.distR = Math.abs(c.price - entry) / risk;

  // TP2: distR >= TP2_MIN_R, confluence>=2 tercih
  let tp2Idx = -1;
  for (let i = 0; i < clusters.length; i++) {
    if (clusters[i].distR >= TP2_MIN_R) {
      // ilk confluence >= 2'ye bakmak için 2 cluster ileriye kadar tarama
      if (clusters[i].confluence >= 2) { tp2Idx = i; break; }
      if (tp2Idx === -1) tp2Idx = i; // ilk uygun
    }
  }
  // TP3: TP2 sonrası, gap >= TP_GAP_R, distR >= TP3_MIN_R, confluence>=2 tercih
  let tp3Idx = -1;
  if (tp2Idx >= 0) {
    const tp2R = clusters[tp2Idx].distR;
    for (let i = tp2Idx + 1; i < clusters.length; i++) {
      if (clusters[i].distR >= Math.max(TP3_MIN_R, tp2R + TP_GAP_R)) {
        if (clusters[i].confluence >= 2) { tp3Idx = i; break; }
        if (tp3Idx === -1) tp3Idx = i;
      }
    }
  }

  const tp2 = tp2Idx >= 0 ? clusters[tp2Idx] : null;
  const tp3 = tp3Idx >= 0 ? clusters[tp3Idx] : null;

  return {
    tp2: tp2 ? Number(tp2.price.toFixed(6)) : null,
    tp2Source: tp2 ? `${describeCluster(tp2)} [${tp2.distR.toFixed(2)}R, conf ${tp2.confluence}]` : null,
    tp2Meta: tp2 ? { confluence: tp2.confluence, distR: Number(tp2.distR.toFixed(2)), sources: tp2.sources, band: tp2.band } : null,
    tp3: tp3 ? Number(tp3.price.toFixed(6)) : null,
    tp3Source: tp3 ? `${describeCluster(tp3)} [${tp3.distR.toFixed(2)}R, conf ${tp3.confluence}]` : null,
    tp3Meta: tp3 ? { confluence: tp3.confluence, distR: Number(tp3.distR.toFixed(2)), sources: tp3.sources, band: tp3.band } : null,
    candidates: clusters.slice(0, 8).map(c => ({
      price: Number(c.price.toFixed(6)),
      distR: Number(c.distR.toFixed(2)),
      confluence: c.confluence,
      label: describeCluster(c),
    })),
  };
}
