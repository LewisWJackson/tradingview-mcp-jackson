/**
 * Barrier Detector (sadelesmis) — sadece HTF (1D, 1W) seviyeleri dikkate alinir.
 *
 * Felsefe:
 *   - Sinyal TF'nin kendi SMC/fib seviyeleri PRIMARY'dir; TP/SL olusumunu sinyal
 *     hesabi (entry/sl/tp = ATR/OB/R-multiple) zaten dogru sekilde ayarlar.
 *   - HTF (1D, 1W) seviyeleri sadece REVISION icin kullanilir: TP gercekten
 *     "onemli" bir HTF direnc/desteginin otesine gecmek uzereyse, TP o seviyenin
 *     hemen onune cekilir (over-reach koruma).
 *   - Orta TF gurultulerle TP capped edilmez (eski progressive zone capping
 *     sinyalleri toptan ipt al ediyordu — 4H orta zone'lari TP1'i entry'ye yapisti riyordu).
 *
 * Kurallar:
 *   1. Sadece 1D ve 1W levels: fib retracement/extension + HTF SMC cizgileri.
 *   2. Noise filtresi: entry'ye `max(1×ATR, %2×entry)` mesafeden yakin seviyeler
 *      atlanir (orta zone zaten signal-TF'nin isi).
 *   3. Sanity: `price > 0`, `isFinite`, entry'ye %20'den yakin.
 *   4. Zone cluster: `1×ATR` icinde ardisik seviyeler tek zone. Temsilci = en
 *      yuksek TF uyesi (1W > 1D).
 *   5. "Onemli" zone = zone.strength >= 3.0 (1D fib alone, veya 1W herhangi).
 *      TP cap yalnizca onemli zone'a yapilir.
 *   6. Bos input → bos cikti, exception firlatilmaz.
 */

const TF_WEIGHT = {
  '1W': 4.0,
  '1D': 3.0,
};

function normalizeTF(tf) {
  if (!tf) return null;
  const s = String(tf).toUpperCase();
  if (s === '1W' || s === 'W') return '1W';
  if (s === '1D' || s === 'D') return '1D';
  return null; // HTF degil → reddet
}

function noiseThreshold(entry, atr) {
  // ATR-driven primary + kucuk %0.1 floor. Eski %2 floor FX gibi dusuk-volatilite
  // enstrumanlarda tum HTF seviyeleri filtreliyordu (EURUSD@1.10, ATR=0.004 →
  // eski noise 0.022, gunluk seviyelerin neredeyse hepsi entry'ye 2 cent'ten
  // yakin → hicbir barrier kalmazdi).
  const byAtr = (atr > 0 ? atr : entry * 0.005) * 1.0;
  const byPctFloor = entry * 0.001;
  return Math.max(byAtr, byPctFloor);
}

/**
 * HTF (1D, 1W) barrier'larini topla. Entry'nin ustu ve alti olmak uzere
 * cluster'lanmis zone listeleri dondurur.
 */
export function buildBarriers({ entry, atr, currentTF: _currentTF, currentTFSmcLines: _currentTFSmcLines, fibCache }) {
  void _currentTF; void _currentTFSmcLines; // signal-TF artik burada kullanilmiyor
  const rawLevels = [];
  if (fibCache && fibCache.timeframes) {
    for (const [tfRaw, tfData] of Object.entries(fibCache.timeframes)) {
      const tf = normalizeTF(tfRaw);
      if (!tf || !tfData) continue;
      if (Array.isArray(tfData.smcLines)) {
        for (const p of tfData.smcLines) {
          if (typeof p === 'number' && isFinite(p) && p > 0) {
            rawLevels.push({ price: p, tf, source: 'smc' });
          }
        }
      }
      if (tfData.fib) {
        const fibBasis = {
          direction: tfData.fib.direction || null,
          swing: tfData.fib.swing || null,
        };
        for (const r of (tfData.fib.retracement || [])) {
          if (r && typeof r.price === 'number' && isFinite(r.price) && r.price > 0) {
            rawLevels.push({
              price: r.price,
              tf,
              source: 'htf_fib',
              fib: { ...fibBasis, kind: 'retracement', level: r.level, price: r.price },
            });
          }
        }
        // fib-engine.computeFibLevels field adi `extensions` (cogul). Eski kod
        // singular `extension` okuyup hicbir extension seviyesi (1.272/1.618/...)
        // toplamiyordu — TP cap'te HTF extension'lar gorulmuyordu.
        for (const e of (tfData.fib.extensions || tfData.fib.extension || [])) {
          if (e && typeof e.price === 'number' && isFinite(e.price) && e.price > 0) {
            rawLevels.push({
              price: e.price,
              tf,
              source: 'htf_fib',
              multiplier: 0.8,
              fib: { ...fibBasis, kind: 'extension', level: e.level, price: e.price },
            });
          }
        }
      }
    }
  }

  if (!entry || entry <= 0 || !rawLevels.length) {
    return { aboveBarriers: [], belowBarriers: [], totalLevels: 0, totalZones: 0, debug: { rawCount: rawLevels.length, afterFilter: 0, noiseThreshold: noiseThreshold(entry, atr) } };
  }

  const noise = noiseThreshold(entry, atr);
  const maxDist = entry * 0.20;
  const prepared = rawLevels
    .map(lv => ({ ...lv, strength: (TF_WEIGHT[lv.tf] || 0) * (lv.multiplier || 1.0) }))
    .filter(lv => {
      const d = Math.abs(lv.price - entry);
      return d >= noise && d <= maxDist;
    });

  const above = prepared.filter(l => l.price > entry).sort((a, b) => a.price - b.price);
  const below = prepared.filter(l => l.price < entry).sort((a, b) => b.price - a.price);

  const clusterGap = Math.max(atr * 1.0, entry * 0.005);
  const cluster = (sorted, side) => {
    if (!sorted.length) return [];
    const zones = [];
    let cur = null;
    for (const lv of sorted) {
      if (!cur) { cur = { members: [lv], zoneLow: lv.price, zoneHigh: lv.price }; continue; }
      const ref = side === 'above' ? cur.zoneHigh : cur.zoneLow;
      if (Math.abs(lv.price - ref) <= clusterGap) {
        cur.members.push(lv);
        cur.zoneLow = Math.min(cur.zoneLow, lv.price);
        cur.zoneHigh = Math.max(cur.zoneHigh, lv.price);
      } else {
        zones.push(cur);
        cur = { members: [lv], zoneLow: lv.price, zoneHigh: lv.price };
      }
    }
    if (cur) zones.push(cur);
    return zones.map(z => {
      const rep = z.members.slice().sort((a, b) => (TF_WEIGHT[b.tf] || 0) - (TF_WEIGHT[a.tf] || 0) || b.strength - a.strength)[0];
      const hasSMC = z.members.some(m => m.source === 'smc');
      const hasFib = z.members.some(m => m.source === 'htf_fib');
      const fibDetails = z.members
        .filter(m => m.source === 'htf_fib' && m.fib)
        .map(m => ({
          tf: m.tf,
          kind: m.fib.kind,
          level: m.fib.level,
          price: m.fib.price,
          direction: m.fib.direction,
          swing: m.fib.swing,
        }));
      let strength = z.members.reduce((s, m) => s + m.strength, 0);
      if (hasSMC && hasFib) strength *= 1.5;
      return {
        price: rep.price,
        tf: rep.tf,
        sources: Array.from(new Set(z.members.map(m => `${m.source}_${m.tf}`))),
        strength: Number(strength.toFixed(2)),
        members: z.members.length,
        zoneLow: z.zoneLow,
        zoneHigh: z.zoneHigh,
        fibDetails,
      };
    });
  };

  const aboveBarriers = cluster(above, 'above');
  const belowBarriers = cluster(below, 'below');
  return {
    aboveBarriers,
    belowBarriers,
    totalLevels: prepared.length,
    totalZones: aboveBarriers.length + belowBarriers.length,
    debug: { rawCount: rawLevels.length, afterFilter: prepared.length, noiseThreshold: noise },
  };
}

/**
 * Entry HTF zone'unun icinde mi? Sadece bilgilendirme amacli — grade'i
 * dogrudan etkilemez, sadece reasoning'e not dusulur.
 */
export function classifyEntryVsBarriers({ entry, atr, direction, aboveBarriers, belowBarriers }) {
  const tolerance = Math.max(atr * 0.3, entry * 0.003);
  const nearestAbove = aboveBarriers[0] || null;
  const nearestBelow = belowBarriers[0] || null;

  const inside = (z) => z && (
    Math.abs(z.price - entry) <= tolerance ||
    (entry >= z.zoneLow - tolerance && entry <= z.zoneHigh + tolerance)
  );

  if (inside(nearestAbove)) {
    const align = direction === 'short' ? 'confirm' : 'conflict';
    return { inZone: true, zoneType: 'resistance', alignment: align, scoreDelta: 0, zone: nearestAbove };
  }
  if (inside(nearestBelow)) {
    const align = direction === 'long' ? 'confirm' : 'conflict';
    return { inZone: true, zoneType: 'support', alignment: align, scoreDelta: 0, zone: nearestBelow };
  }
  return { inZone: false, zoneType: null, alignment: null, scoreDelta: 0, zone: null };
}

export const MAJOR_ZONE_STRENGTH = 3.0;
export const _internal = { TF_WEIGHT, noiseThreshold };
