#!/usr/bin/env node
/**
 * Regime Report — Faz 1 Iter 3 ara rapor uretici.
 *
 * Shadow logger'in yazdigi JSONL dosyalarindan:
 *   - Piyasa basina rejim dagilimi (% sure)
 *   - False-flip orani + N=3/4 karsilastirmasi (DeepSeek tavsiyesi)
 *   - Chaos sure dagilimi: tahmin (config/chaos-windows.json) vs gercek
 *   - BIST `bist_tl_stable_domestic` tetik %'si
 *   - Rate-limit'e takilan sembol sayisi (>4 gecis/gun)
 *
 * Kullanim:
 *   node scanner/scripts/regime-report.mjs            # son 7 gun
 *   node scanner/scripts/regime-report.mjs --days=14  # son 14 gun
 *   node scanner/scripts/regime-report.mjs --json     # JSON ciktisi
 *
 * Sinyal pipeline'ina dokunmaz; sadece okuma + analiz.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRecentLogs, readLog } from '../lib/learning/regime-shadow-logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHAOS_WINDOWS_PATH = path.join(REPO_ROOT, 'config', 'chaos-windows.json');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { days: 7, json: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--days=')) args.days = Number(a.slice(7)) || 7;
    else if (a === '--json') args.json = true;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Veri yukleme
// ---------------------------------------------------------------------------

function loadRecords(days) {
  const files = listRecentLogs(days);
  const all = [];
  for (const f of files) {
    const recs = readLog(f.date);
    for (const r of recs) all.push({ ...r, _logDate: f.date });
  }
  return { records: all, files };
}

function loadChaosWindows() {
  try {
    return JSON.parse(fs.readFileSync(CHAOS_WINDOWS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Metrikler
// ---------------------------------------------------------------------------

/** Piyasa basina rejim dagilimi: { marketType: { regime: {count, pct} } } */
function regimeDistribution(records) {
  const byMarket = {};
  for (const r of records) {
    const mt = r.marketType || 'unknown';
    if (!byMarket[mt]) byMarket[mt] = {};
    const rg = r.regime || 'unknown';
    byMarket[mt][rg] = (byMarket[mt][rg] || 0) + 1;
  }
  // Yuzde hesapla
  for (const mt of Object.keys(byMarket)) {
    const total = Object.values(byMarket[mt]).reduce((a, b) => a + b, 0);
    const pct = {};
    for (const [rg, c] of Object.entries(byMarket[mt])) {
      pct[rg] = { count: c, pct: total ? +((c / total) * 100).toFixed(2) : 0 };
    }
    byMarket[mt] = { _total: total, ...pct };
  }
  return byMarket;
}

/**
 * False-flip analizi.
 * Bir flip "false-flip" sayilir eger: rejim X -> Y -> X seklinde geri donerse
 * ve Y rejimi `windowBars` icindeyse.
 *
 * N=3 default (mevcut histerezis), N=4 simulasyonu icin: log'taki rawRegime
 * dizilerine bakip "eger N=4 olsaydi" senaryosunu hesapla.
 */
function falseFlipAnalysis(records, hysteresisN = 3) {
  // Sembol+TF basina sirala
  const bySym = {};
  for (const r of records) {
    const k = `${r.symbol}|${r.timeframe}`;
    if (!bySym[k]) bySym[k] = [];
    bySym[k].push(r);
  }
  for (const k of Object.keys(bySym)) {
    bySym[k].sort((a, b) => Date.parse(a.utcTimestamp) - Date.parse(b.utcTimestamp));
  }

  let totalFlips = 0;
  let falseFlips = 0;
  const examples = [];

  for (const [k, arr] of Object.entries(bySym)) {
    // Sadece transitioned=true olanlar gercek rejim degisimleri
    const trans = arr.filter(r => r.transitioned);
    for (let i = 1; i < trans.length; i++) {
      totalFlips++;
      const prev = trans[i - 1];
      const curr = trans[i];
      // Bu transition'dan sonraki ilk transition geri donus mu?
      if (i + 1 < trans.length) {
        const next = trans[i + 1];
        if (next.regime === prev.regime) {
          // Y'de kac bar kalindi (curr.barsSinceTransition next anindaki)
          const barsInY = next.barsSinceTransition || 0;
          if (barsInY < hysteresisN + 1) {
            falseFlips++;
            if (examples.length < 5) {
              examples.push({
                key: k,
                from: prev.regime,
                via: curr.regime,
                back: next.regime,
                barsInVia: barsInY,
                at: curr.utcTimestamp,
              });
            }
          }
        }
      }
    }
  }

  return {
    totalFlips,
    falseFlips,
    falseFlipRate: totalFlips ? +((falseFlips / totalFlips) * 100).toFixed(2) : 0,
    examples,
  };
}

/** N=3 vs N=4 karsilastirmasi — N=4 olsaydi false-flip bastirma kazanci. */
function hysteresisComparison(records) {
  // N=3 mevcut log
  const n3 = falseFlipAnalysis(records, 3);
  // N=4 simulasyonu: ham log'da bir transition (transitioned=true) anini al;
  // sonraki bar hala farkli rejimi koruyor mu? Korumuyorsa N=4'te bu transition
  // gerceklesmezdi (false-flip suppression).
  const bySym = {};
  for (const r of records) {
    const k = `${r.symbol}|${r.timeframe}`;
    if (!bySym[k]) bySym[k] = [];
    bySym[k].push(r);
  }
  for (const k of Object.keys(bySym)) {
    bySym[k].sort((a, b) => Date.parse(a.utcTimestamp) - Date.parse(b.utcTimestamp));
  }
  let n4Total = 0;
  let n4False = 0;
  for (const [, arr] of Object.entries(bySym)) {
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i].transitioned) continue;
      n4Total++;
      // N=4 senaryosu: transition aninda gelecek 1 bar daha ayni ham rejimi
      // dogrulamali. Bunu rawRegime ardisikligina bakarak proxy ediyoruz.
      const nextRaw = arr[i + 1]?.rawRegime;
      const thisRaw = arr[i].rawRegime;
      if (nextRaw && nextRaw !== thisRaw) {
        // N=4'te bu transition tetiklenmezdi
        n4False++;
      }
    }
  }
  return {
    n3,
    n4Suppressed: { totalTransitions: n4Total, wouldBeSuppressed: n4False,
      suppressRate: n4Total ? +((n4False / n4Total) * 100).toFixed(2) : 0 },
  };
}

/** Rate-limit'e takilan sembol/gun cifti sayisi. */
function rateLimitHits(records) {
  const hits = {};
  for (const r of records) {
    if (r.unstable) {
      const k = `${r.symbol}|${r._logDate}`;
      hits[k] = (hits[k] || 0) + 1;
    }
  }
  return {
    distinctUnstableSymbolDays: Object.keys(hits).length,
    samples: Object.keys(hits).slice(0, 10),
  };
}

/**
 * Chaos sure dagilimi: gercek surele tahminle kiyasla.
 * Her sembol+TF icin high_vol_chaos rejimine girilen bloklarin uzunluklarini olc.
 */
function chaosDurations(records, chaosWindows) {
  const bySym = {};
  for (const r of records) {
    const k = `${r.symbol}|${r.timeframe}`;
    if (!bySym[k]) bySym[k] = [];
    bySym[k].push(r);
  }
  for (const k of Object.keys(bySym)) {
    bySym[k].sort((a, b) => Date.parse(a.utcTimestamp) - Date.parse(b.utcTimestamp));
  }

  const durations = []; // dakika cinsinden
  for (const arr of Object.values(bySym)) {
    let chaosStart = null;
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      if (r.regime === 'high_vol_chaos') {
        if (chaosStart == null) chaosStart = Date.parse(r.utcTimestamp);
      } else {
        if (chaosStart != null) {
          const end = Date.parse(arr[i].utcTimestamp);
          durations.push((end - chaosStart) / 60_000);
          chaosStart = null;
        }
      }
    }
  }

  if (!durations.length) return { count: 0, taxonomy: chaosWindows };
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  const max = durations[durations.length - 1];

  // Tahmin baseline: typical/duration_min ortalamasi
  const baselineDurations = Object.entries(chaosWindows)
    .filter(([k]) => !k.startsWith('_'))
    .map(([, v]) => v.typical || v.duration_min || 0)
    .filter(x => x > 0);
  const baselineMean = baselineDurations.length
    ? baselineDurations.reduce((a, b) => a + b, 0) / baselineDurations.length
    : null;

  return {
    count: durations.length,
    actualMedianMin: +median.toFixed(1),
    actualMeanMin: +mean.toFixed(1),
    actualMaxMin: +max.toFixed(1),
    taxonomyMeanMin: baselineMean != null ? +baselineMean.toFixed(1) : null,
    deviation: baselineMean ? `${(((mean - baselineMean) / baselineMean) * 100).toFixed(1)}%` : 'n/a',
  };
}

/** BIST `bist_tl_stable_domestic` tetik %'si */
function bistStableDomesticRate(records) {
  const bistRecords = records.filter(r => r.marketType === 'bist');
  if (!bistRecords.length) return { total: 0, stableDomesticCount: 0, pct: 0 };
  const stable = bistRecords.filter(r => r.subRegime === 'bist_tl_stable_domestic').length;
  return {
    total: bistRecords.length,
    stableDomesticCount: stable,
    pct: +((stable / bistRecords.length) * 100).toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Rapor
// ---------------------------------------------------------------------------

function buildReport({ records, files }, chaosWindows) {
  return {
    period: {
      days: files.length,
      from: files[files.length - 1]?.date || null,
      to: files[0]?.date || null,
      totalRecords: records.length,
    },
    regimeDistribution: regimeDistribution(records),
    hysteresis: hysteresisComparison(records),
    rateLimit: rateLimitHits(records),
    chaosDurations: chaosDurations(records, chaosWindows),
    bistStableDomestic: bistStableDomesticRate(records),
  };
}

function formatMarkdown(rep) {
  const lines = [];
  lines.push(`# Regime Shadow Mode — Ara Rapor`);
  lines.push(``);
  lines.push(`**Donem**: ${rep.period.from || 'n/a'} → ${rep.period.to || 'n/a'} (${rep.period.days} gun, ${rep.period.totalRecords} kayit)`);
  lines.push(``);

  lines.push(`## 1. Rejim Dagilimi (Piyasa basina)`);
  lines.push(``);
  for (const [mt, dist] of Object.entries(rep.regimeDistribution)) {
    lines.push(`### ${mt} (n=${dist._total})`);
    const rows = Object.entries(dist).filter(([k]) => !k.startsWith('_'));
    rows.sort((a, b) => b[1].count - a[1].count);
    for (const [rg, v] of rows) {
      lines.push(`  - ${rg}: ${v.pct}% (${v.count})`);
    }
    lines.push(``);
  }

  lines.push(`## 2. Histerezis False-flip Analizi`);
  lines.push(``);
  lines.push(`- **N=3 (mevcut)**: ${rep.hysteresis.n3.totalFlips} transition, ${rep.hysteresis.n3.falseFlips} false-flip → **${rep.hysteresis.n3.falseFlipRate}%**`);
  lines.push(`- **N=4 simulasyonu**: ${rep.hysteresis.n4Suppressed.totalTransitions} transition'in ${rep.hysteresis.n4Suppressed.wouldBeSuppressed}'i baska bir bar gerektirirdi → ${rep.hysteresis.n4Suppressed.suppressRate}% bastirma`);
  lines.push(``);
  if (rep.hysteresis.n3.falseFlipRate > 10) {
    lines.push(`> ⚠️ False-flip > %10 → taxonomy kuralina gore N artirma adayi (N=4 simulasyonu deger katiyorsa).`);
    lines.push(``);
  }
  if (rep.hysteresis.n3.examples.length) {
    lines.push(`### Ornek false-flip'ler:`);
    for (const e of rep.hysteresis.n3.examples) {
      lines.push(`  - ${e.key}: ${e.from} → ${e.via} (${e.barsInVia} bar) → ${e.back} @ ${e.at}`);
    }
    lines.push(``);
  }

  lines.push(`## 3. Rate-limit (Unstable sembol-gun)`);
  lines.push(``);
  lines.push(`- **${rep.rateLimit.distinctUnstableSymbolDays}** sembol-gun cifti rate-limit'e takildi (>4 gecis)`);
  if (rep.rateLimit.samples.length) {
    lines.push(`- Ornek: ${rep.rateLimit.samples.slice(0, 5).join(', ')}`);
  }
  lines.push(``);

  lines.push(`## 4. Chaos Suresi (Gercek vs Tahmin)`);
  lines.push(``);
  const cd = rep.chaosDurations;
  if (cd.count === 0) {
    lines.push(`- Bu donemde chaos rejimine girilmedi (ya da log donemi henuz cok kisa).`);
  } else {
    lines.push(`- **Ornek sayisi**: ${cd.count}`);
    lines.push(`- **Gercek median**: ${cd.actualMedianMin} dk`);
    lines.push(`- **Gercek ortalama**: ${cd.actualMeanMin} dk`);
    lines.push(`- **Maksimum**: ${cd.actualMaxMin} dk`);
    lines.push(`- **Taxonomy tahmini ortalama**: ${cd.taxonomyMeanMin ?? 'n/a'} dk`);
    lines.push(`- **Sapma**: ${cd.deviation}`);
    if (cd.taxonomyMeanMin && cd.actualMeanMin > cd.taxonomyMeanMin * 1.5) {
      lines.push(``);
      lines.push(`> ⚠️ Gercek ortalama tahminin %50+ uzerinde — config/chaos-windows.json kalibrasyon gereksinimi.`);
    }
  }
  lines.push(``);

  lines.push(`## 5. BIST \`bist_tl_stable_domestic\` Sıklığı`);
  lines.push(``);
  const b = rep.bistStableDomestic;
  if (b.total === 0) {
    lines.push(`- BIST kayit yok.`);
  } else {
    lines.push(`- BIST toplam kayit: ${b.total}`);
    lines.push(`- \`bist_tl_stable_domestic\` tetik: ${b.stableDomesticCount} → **${b.pct}%**`);
    if (b.pct < 10) {
      lines.push(``);
      lines.push(`> Taxonomy notu (§4): bu rejim < %10 ise ozel strateji yerine genel \`ranging\` mantigi yeterli.`);
    }
  }
  lines.push(``);

  lines.push(`---`);
  lines.push(`Uretildi: ${new Date().toISOString()}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  const data = loadRecords(args.days);
  const chaosWindows = loadChaosWindows();
  const report = buildReport(data, chaosWindows);

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatMarkdown(report) + '\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { buildReport, formatMarkdown, regimeDistribution, falseFlipAnalysis, hysteresisComparison, chaosDurations, bistStableDomesticRate, rateLimitHits };
