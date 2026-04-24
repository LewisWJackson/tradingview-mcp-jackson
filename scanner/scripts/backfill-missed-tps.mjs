#!/usr/bin/env node
/**
 * Backfill-Missed-TPs — tarihsel acik sinyallerin TP/SL hit'lerini TV'den
 * retroaktif olarak hesaplar. Outcome-checker 15 dk pencereyle calisirken
 * chart-lock gap'lerinde kaybolan fitilleri kurtarir.
 *
 * Mantik:
 *   1) open.json'daki her entryHit=true sinyal icin:
 *      - createdAt'tan su ana kadar sinyalin kendi TF'inde OHLCV cek
 *      - Barlari kronolojik yuru, SL/TP hit'lerini detect et
 *      - SL ve TP ayni barda ise 1m'e gecip gerçek siralamayi cozumle
 *   2) Hit flag'leri ve status'u guncelle; terminal ise arsivden at
 *   3) Rapor ozeti
 *
 * Kullanim: node scanner/scripts/backfill-missed-tps.mjs [--dry-run]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as bridge from '../lib/tv-bridge.js';
import { resolveSymbol, inferCategory } from '../lib/symbol-resolver.js';
import { acquireScanLock, releaseScanLock } from '../lib/scanner-engine.js';
import { readJSON, writeJSON, dataPath, appendToArchive } from '../lib/learning/persistence.js';
import { evaluateSignalOutcome } from '../lib/learning/outcome-checker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPEN_PATH = dataPath('signals', 'open.json');
const DRY_RUN = process.argv.includes('--dry-run');

const TERMINAL = new Set([
  'sl_hit', 'sl_hit_high_mfe', 'tp3_hit', 'invalid_data',
  'superseded', 'superseded_by_tf', 'superseded_by_cleanup', 'superseded_by_cap',
  'manual_close', 'trailing_stop_exit',
]);

function isTerminal(status, signal = null) {
  if (TERMINAL.has(status)) return true;
  if (status === 'tp2_hit' && signal && signal.tp3 == null) return true;
  return false;
}

// Signal TF'ina gore tarama icin OHLCV TF'i sec. Sinyalin kendi TF'i daha
// uzun aralik icin daha fazla bar/gun verir; wick detection icin yine yeterli
// cunku her bar'da high/low dogrudur. Sadece ayni-bar SL+TP durumunda 1m'e
// zoom gerekir.
function scanTfFor(sigTf) {
  const tf = String(sigTf);
  if (tf === '1D' || tf === '3D' || tf === '1W' || tf === '1M') return '60';
  if (tf === '240') return '15';
  if (tf === '45' || tf === '30' || tf === '60') return '5';
  return '5';
}

function tfMinutes(tf) {
  const s = String(tf);
  if (s === '1D') return 1440;
  if (s === '3D') return 4320;
  if (s === '1W') return 10080;
  const n = parseInt(s, 10);
  return isNaN(n) ? 60 : n;
}

function barTimeMs(b) {
  const t = b.time;
  return typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : new Date(t).getTime();
}

function bothHit(sig, bar) {
  if (!sig.sl || !sig.tp1 || !sig.entry) return false;
  const dir = sig.direction;
  const slHit = (dir === 'long' && bar.low <= sig.sl) || (dir === 'short' && bar.high >= sig.sl);
  const tpHit = (dir === 'long' && bar.high >= sig.tp1) || (dir === 'short' && bar.low <= sig.tp1);
  return slHit && tpHit;
}

async function tieBreak1m(sig, bar, scanTFMinutes) {
  const barTMs = barTimeMs(bar);
  const barEndMs = barTMs + scanTFMinutes * 60000;
  try {
    await bridge.setTimeframe('1');
    await new Promise(r => setTimeout(r, 1200));
    const oneMin = await bridge.getOhlcv(Math.max(scanTFMinutes + 5, 20), false);
    const oneBars = (oneMin?.bars || []).filter(b => {
      const t = barTimeMs(b);
      return t >= barTMs && t < barEndMs;
    });
    return oneBars;
  } catch (e) {
    return null;
  }
}

async function restoreTF(tf) {
  try {
    await bridge.setTimeframe(tf);
    await new Promise(r => setTimeout(r, 800));
  } catch {}
}

function withinBounds(bar, sig) {
  if (!sig.entry) return true;
  const dev = Math.abs(bar.close - sig.entry) / sig.entry;
  return dev < 0.5;
}

async function processSignal(sig) {
  const report = {
    id: sig.id,
    symbol: sig.symbol,
    timeframe: sig.timeframe,
    direction: sig.direction,
    before: {
      status: sig.status,
      tp1Hit: !!sig.tp1Hit,
      tp2Hit: !!sig.tp2Hit,
      tp3Hit: !!sig.tp3Hit,
      slHit: !!sig.slHit,
    },
    after: null,
    changes: [],
    terminal: false,
    sameBarConflicts: 0,
    error: null,
  };

  if (!sig.entry || !sig.sl || !sig.tp1) {
    report.error = 'incomplete_data';
    return report;
  }
  if (!sig.entryHit) {
    report.error = 'entry_not_hit';
    return report;
  }
  if (isTerminal(sig.status, sig)) {
    report.error = 'already_terminal';
    return report;
  }

  const chartSymbol = sig.symbol.includes(':') ? sig.symbol : resolveSymbol(sig.symbol, inferCategory(sig.symbol));
  try {
    await bridge.setSymbol(chartSymbol);
  } catch (e) {
    report.error = `setSymbol_failed:${e.message}`;
    return report;
  }

  const scanTF = scanTfFor(sig.timeframe);
  const scanMins = tfMinutes(scanTF);
  try {
    await bridge.setTimeframe(scanTF);
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    report.error = `setTF_failed:${e.message}`;
    return report;
  }

  // Sinyalin yaslanma suresi kadar bar cek (+ safety), max 500
  const createdMs = new Date(sig.entryHitAt || sig.createdAt).getTime();
  const ageBars = Math.ceil((Date.now() - createdMs) / (scanMins * 60000));
  const count = Math.max(50, Math.min(500, ageBars + 8));
  let ohlcv;
  try {
    ohlcv = await bridge.getOhlcv(count, false);
  } catch (e) {
    report.error = `getOhlcv_failed:${e.message}`;
    return report;
  }
  const allBars = (ohlcv?.bars || []).filter(b => barTimeMs(b) >= createdMs - scanMins * 60000);
  if (allBars.length === 0) {
    report.error = 'no_bars';
    return report;
  }

  // Saglik kontrolu: son fiyat sapmasi cok yuksekse yanlis sembol
  const lastBar = allBars[allBars.length - 1];
  if (!withinBounds(lastBar, sig)) {
    report.error = `price_deviation:last=${lastBar.close}_vs_entry=${sig.entry}`;
    return report;
  }

  // Baslangic state'i: mevcut sinyali al; tp1Hit/tp2Hit/tp3Hit/slHit alanlarini
  // olmus kabul et ve barlari kronolojik yuru. evaluateSignalOutcome
  // idempotenttir; zaten set olmus flag'leri tekrar set etmez.
  let cur = { ...sig };
  let terminated = false;

  for (const bar of allBars) {
    if (terminated) break;
    // Ayni barda SL+TP varsa 1m tie-break
    if (!cur.slHit && !cur.tp1Hit && bothHit(cur, bar)) {
      report.sameBarConflicts++;
      const oneBars = await tieBreak1m(cur, bar, scanMins);
      await restoreTF(scanTF);
      if (oneBars && oneBars.length > 0) {
        for (const m of oneBars) {
          const u = evaluateSignalOutcome(cur, m);
          if (!u) continue;
          cur = { ...cur, ...u };
          if (isTerminal(cur.status, cur)) { terminated = true; break; }
        }
        continue;
      }
      // 1m alinamadiysa SL-oncelik fallback (pesimist, dogru)
    }
    const u = evaluateSignalOutcome(cur, bar);
    if (!u) continue;
    cur = { ...cur, ...u };
    if (isTerminal(cur.status, cur)) { terminated = true; }
  }

  // Degisiklikleri hesapla
  const diff = {};
  const FIELDS = [
    'tp1Hit', 'tp2Hit', 'tp3Hit', 'slHit',
    'tp1HitAt', 'tp2HitAt', 'tp3HitAt', 'slHitAt',
    'tp1HitPrice', 'tp2HitPrice', 'tp3HitPrice', 'slHitPrice',
    'highestFavorable', 'lowestAdverse',
    'trailingStopActive', 'trailingStopLevel', 'trailingStopExit', 'trailingExitTier',
    'status', 'sl',
    'lastCheckedAt', 'lastCheckedPrice', 'checkCount',
  ];
  for (const k of FIELDS) {
    const before = sig[k];
    const after = cur[k];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      diff[k] = { before, after };
      report.changes.push(k);
    }
  }

  report.after = {
    status: cur.status,
    tp1Hit: !!cur.tp1Hit,
    tp2Hit: !!cur.tp2Hit,
    tp3Hit: !!cur.tp3Hit,
    slHit: !!cur.slHit,
    highestFavorable: cur.highestFavorable,
  };
  report.terminal = isTerminal(cur.status, cur);
  report.diff = diff;
  report.finalSignal = cur;
  return report;
}

function computeActualRR(signal) {
  if (!signal.entry || !signal.sl) return null;
  const risk = Math.abs(signal.entry - (signal.slOriginal || signal.sl));
  if (risk === 0) return null;
  let reward = 0;
  if (signal.status === 'trailing_stop_exit' && signal.slHitPrice != null) {
    reward = signal.direction === 'long' ? (signal.slHitPrice - signal.entry) : (signal.entry - signal.slHitPrice);
  } else if (signal.tp3Hit && signal.tp3) reward = Math.abs(signal.tp3 - signal.entry);
  else if (signal.tp2Hit && signal.tp2) reward = Math.abs(signal.tp2 - signal.entry);
  else if (signal.tp1Hit && signal.tp1) reward = Math.abs(signal.tp1 - signal.entry);
  else if (signal.slHit) reward = -risk;
  return Math.round((reward / risk) * 100) / 100;
}

function buildArchiveRecord(signal) {
  const resolvedAt = new Date().toISOString();
  const holdingMinutes = Math.round((new Date(resolvedAt) - new Date(signal.createdAt)) / 60000);
  return {
    ...signal,
    resolvedAt,
    outcome: signal.status,
    actualRR: computeActualRR(signal),
    holdingPeriodMinutes: holdingMinutes,
    maxFavorableExcursion: signal.highestFavorable,
    maxAdverseExcursion: signal.lowestAdverse,
    win: !!signal.tp1Hit,
    backfilled: true,
  };
}

export async function runBackfill({ dryRun = false, log = console.log } = {}) {
  const openData = readJSON(OPEN_PATH, { signals: [] });
  const signals = openData.signals || [];
  log(`[Backfill] open.json: ${signals.length} sinyal | DRY_RUN=${dryRun}`);

  try {
    await acquireScanLock('backfill-missed-tps', 120000);
  } catch (e) {
    log(`[Backfill] scan kilidi alinamadi: ${e.message}`);
    throw e;
  }

  const reports = [];
  try {
    for (const sig of signals) {
      log(`[${reports.length + 1}/${signals.length}] ${sig.symbol} ${sig.timeframe} ${sig.direction}`);
      let r;
      try {
        r = await processSignal(sig);
      } catch (e) {
        r = { id: sig.id, symbol: sig.symbol, error: `exception:${e.message}` };
      }
      reports.push(r);
      if (r.error) { log(`  SKIP (${r.error})`); continue; }
      const changed = r.changes.length > 0;
      let line = changed ? `  CHANGED [${r.changes.join(',')}]` : '  no-change';
      if (r.terminal) line += ` TERMINAL→${r.after.status}`;
      if (r.sameBarConflicts) line += ` conflicts=${r.sameBarConflicts}`;
      log(line);
    }

    // Apply changes
    if (!dryRun) {
      const newOpen = [];
      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i];
        const r = reports[i];
        if (r.error || !r.finalSignal) { newOpen.push(sig); continue; }
        const updated = r.finalSignal;
        if (r.terminal) {
          const archive = buildArchiveRecord(updated);
          const ym = new Date().toISOString().slice(0, 7);
          appendToArchive(ym, archive);
          log(`[Archive] ${sig.id} → ${updated.status}`);
        } else {
          newOpen.push(updated);
        }
      }
      writeJSON(OPEN_PATH, { signals: newOpen });
      log(`[Backfill] open.json yazildi: ${newOpen.length} acik sinyal kaldi`);
    }
  } finally {
    releaseScanLock();
  }

  const outPath = dataPath('signals', `backfill-report-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), dryRun, reports }, null, 2));
  log(`rapor: ${outPath}`);
  return { reports, outPath };
}

// Standalone CLI
const isMain = process.argv[1] && process.argv[1].includes('backfill-missed-tps');
if (isMain) {
  runBackfill({ dryRun: DRY_RUN }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
