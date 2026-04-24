#!/usr/bin/env node
/**
 * Retroaktif migration: acik sinyallerdeki SL ve TP'leri yeni alignment-filters
 * mantigi ile yeniden hesaplar (HTF fib cache tabanli — live TV bridge gerektirmez).
 *
 * GUVENLIK KURALLARI:
 *  1) SL asla SIKILASTIRILMAZ (long icin sadece asagi, short icin sadece yukari).
 *     Guards zaten sadece genisletir, yine de explicit assert ediyoruz.
 *  2) Yeni SL `lastCheckedPrice` tarafindaki "zarar" bolgesine dusmesin —
 *     yani open LONG icin newSL >= lastCheckedPrice OLMAMALI (zaten SL altta).
 *     newSL <= lastCheckedPrice olmali. Short icin newSL >= lastCheckedPrice olmali.
 *     Bu kontrol, edge case'leri yakalamak icin.
 *  3) Terminal statusler (sl_hit, tp3_hit, manual_close...) dokunulmaz.
 *  4) Dry-run default acik. Uygulamak icin --apply gecin.
 *
 * Kullanim:
 *   node scripts/migrate-align-sl-tp.mjs           # dry-run (rapor)
 *   node scripts/migrate-align-sl-tp.mjs --apply   # yaz
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enforceHTFFibAlignment,
  enforceHTFFibSLGuard,
} from '../lib/alignment-filters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OPEN_PATH = path.join(DATA_DIR, 'signals', 'open.json');

const APPLY = process.argv.includes('--apply');

const TERMINAL = new Set([
  'sl_hit', 'tp3_hit', 'invalid_data',
  'superseded', 'superseded_by_tf', 'superseded_by_cleanup', 'superseded_by_cap',
  'manual_close', 'entry_expired', 'trailing_stop_exit',
]);

const readJSON = (p, def) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
};
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

function estimateATR(signal) {
  // Tercih sirasi: kaydedilmis indikatorler → SL mesafesinden turet (atr≈|entry-sl|/slMultiplier)
  const stored = signal.indicators?.atrValue || signal.atr || null;
  if (typeof stored === 'number' && stored > 0) return stored;
  const slMult = signal.slMultiplier || 2.0;
  if (signal.entry && signal.sl && slMult > 0) {
    return Math.abs(signal.entry - signal.sl) / slMult;
  }
  return null;
}

function applyRetroGuards(signal) {
  const dir = signal.direction;
  const entry = signal.entry;
  const oldSL = signal.sl;
  const oldTP1 = signal.tp1, oldTP2 = signal.tp2, oldTP3 = signal.tp3;
  const atr = estimateATR(signal);
  const lcp = signal.lastCheckedPrice || signal.quotePrice || entry;

  const out = {
    changed: false,
    newSL: oldSL, newTP1: oldTP1, newTP2: oldTP2, newTP3: oldTP3,
    reasons: [],
    warnings: [],
  };
  if (!atr || atr <= 0 || !entry || !oldSL || !dir) {
    out.warnings.push('atr/entry/sl/direction eksik — atlandi');
    return out;
  }

  // 1) HTF fib alignment (TP capping + trend reject olmayacak — sadece cap uyguluyoruz)
  const fib = enforceHTFFibAlignment({
    symbol: signal.symbol, direction: dir, entry,
    sl: oldSL, tp1: oldTP1, tp2: oldTP2, tp3: oldTP3,
  });
  // Reject etmiyoruz — sinyal zaten acik ve takip ediliyor.
  let sl = oldSL;
  let tp1 = fib.adjusted.tp1, tp2 = fib.adjusted.tp2, tp3 = fib.adjusted.tp3;
  out.warnings.push(...fib.warnings);

  // 2) HTF fib SL guard (sadece GENISLETIR)
  const allLevels = fib.htfSummary?._allLevels || [];
  if (allLevels.length > 0) {
    const guard = enforceHTFFibSLGuard({ direction: dir, entry, sl, atr, htfLevels: allLevels });
    if (guard.moved) {
      // Sadece genisleyen SL'yi kabul et
      const widens = dir === 'long' ? guard.sl < sl : guard.sl > sl;
      if (widens) {
        sl = guard.sl;
        out.reasons.push(guard.reason);
      }
    }
  }

  // 3) GUVENLIK: yeni SL canli fiyatin "zarar" tarafinda olmasin
  //    Long: SL price altinda olmali (price > SL). Tersi olursa hemen stop hit olur.
  //    Short: SL price ustunde olmali (price < SL).
  if (lcp && isFinite(lcp)) {
    if (dir === 'long' && sl >= lcp) {
      out.warnings.push(`SL (${sl.toFixed(4)}) canli fiyatin (${lcp.toFixed(4)}) ustunde — SL guncellemesi IPTAL (anlik stop riski)`);
      sl = oldSL;
    } else if (dir === 'short' && sl <= lcp) {
      out.warnings.push(`SL (${sl.toFixed(4)}) canli fiyatin (${lcp.toFixed(4)}) altinda — SL guncellemesi IPTAL (anlik stop riski)`);
      sl = oldSL;
    }
  }

  // 4) Monotonluk kontrolu: SL sadece genisledi (safety belt)
  if (dir === 'long' && sl > oldSL) sl = oldSL;
  if (dir === 'short' && sl < oldSL) sl = oldSL;

  // 5) TP capping — GUVENLIK:
  //    a) Yeni TP entry'nin yanlis tarafinda olamaz (long→TP<entry olmasin).
  //    b) Yeni TP canli fiyatin zaten asilmis tarafinda olamaz (long→newTP<=lcp
  //       olursa retroaktif "TP hit at loss" yaratir). Bu durumda TP'yi koru.
  const capTPSafe = (oldTP, newTP) => {
    if (newTP == null || oldTP == null) return oldTP;
    if (Math.abs(newTP - oldTP) < 1e-9) return oldTP;
    // Yon kontrolu (entry'nin dogru tarafinda mi)
    if (dir === 'long' && newTP <= entry) {
      out.warnings.push(`TP cap ${newTP.toFixed(4)} entry (${entry.toFixed(4)}) altina dustu — eski TP korundu`);
      return oldTP;
    }
    if (dir === 'short' && newTP >= entry) {
      out.warnings.push(`TP cap ${newTP.toFixed(4)} entry (${entry.toFixed(4)}) ustune cikti — eski TP korundu`);
      return oldTP;
    }
    // Canli fiyat asilmis mi kontrolu
    if (lcp && isFinite(lcp)) {
      if (dir === 'long' && newTP <= lcp) {
        out.warnings.push(`TP cap ${newTP.toFixed(4)} canli fiyatin (${lcp.toFixed(4)}) altinda — retro TP-hit onlendi, eski TP korundu`);
        return oldTP;
      }
      if (dir === 'short' && newTP >= lcp) {
        out.warnings.push(`TP cap ${newTP.toFixed(4)} canli fiyatin (${lcp.toFixed(4)}) ustunde — retro TP-hit onlendi, eski TP korundu`);
        return oldTP;
      }
    }
    return newTP;
  };

  out.newSL = sl;
  out.newTP1 = capTPSafe(oldTP1, tp1);
  out.newTP2 = capTPSafe(oldTP2, tp2);
  out.newTP3 = capTPSafe(oldTP3, tp3);

  // Monotonluk: TP hierarsisi korunsun (long: tp1<=tp2<=tp3; short: tp1>=tp2>=tp3)
  if (dir === 'long') {
    if (out.newTP2 != null && out.newTP1 != null && out.newTP2 < out.newTP1) out.newTP2 = out.newTP1;
    if (out.newTP3 != null && out.newTP2 != null && out.newTP3 < out.newTP2) out.newTP3 = out.newTP2;
  } else {
    if (out.newTP2 != null && out.newTP1 != null && out.newTP2 > out.newTP1) out.newTP2 = out.newTP1;
    if (out.newTP3 != null && out.newTP2 != null && out.newTP3 > out.newTP2) out.newTP3 = out.newTP2;
  }

  out.changed = out.newSL !== oldSL
    || out.newTP1 !== oldTP1
    || out.newTP2 !== oldTP2
    || out.newTP3 !== oldTP3;

  return out;
}

const openData = readJSON(OPEN_PATH, { signals: [] });
if (!Array.isArray(openData.signals)) {
  console.error('open.json formati beklenmedik');
  process.exit(1);
}

if (APPLY) {
  fs.copyFileSync(OPEN_PATH, OPEN_PATH + '.pre-align-migration.bak');
  console.log(`[Migrate] Yedek: ${OPEN_PATH}.pre-align-migration.bak`);
}

let inspected = 0, patched = 0, skippedTerminal = 0, skippedNoChange = 0;
const patchLog = [];

for (const s of openData.signals) {
  if (TERMINAL.has(s.status)) { skippedTerminal++; continue; }
  inspected++;
  const res = applyRetroGuards(s);
  if (!res.changed) { skippedNoChange++; continue; }

  patchLog.push({
    id: s.id, symbol: s.symbol, direction: s.direction,
    entry: s.entry,
    oldSL: s.sl, newSL: res.newSL,
    oldTP1: s.tp1, newTP1: res.newTP1,
    oldTP2: s.tp2, newTP2: res.newTP2,
    oldTP3: s.tp3, newTP3: res.newTP3,
    reasons: res.reasons,
    warnings: res.warnings,
  });

  if (APPLY) {
    s.sl = res.newSL;
    s.tp1 = res.newTP1;
    s.tp2 = res.newTP2;
    s.tp3 = res.newTP3;
    s.slSource = (s.slSource || 'atr_based') + '+retro_htf_guard';
    s.migratedAt = new Date().toISOString();
    s.migratedBy = 'align-sl-tp-retro';
    if (!Array.isArray(s.warnings)) s.warnings = [];
    s.warnings.push(`[Migrate] HTF fib retro: ${res.reasons.join(' | ') || 'TP cap'}`);
    patched++;
  }
}

console.log(`\n=== Retro Align Migration ${APPLY ? '(APPLIED)' : '(DRY-RUN)'} ===`);
console.log(`Incelenen acik sinyal: ${inspected}`);
console.log(`Degisiklik gereken:    ${patchLog.length}`);
console.log(`Uygulanan:             ${APPLY ? patched : 0}`);
console.log(`Atlanan (terminal):    ${skippedTerminal}`);
console.log(`Atlanan (degisiklik yok): ${skippedNoChange}`);

for (const p of patchLog) {
  const fmt = (v) => v == null ? '—' : Number(v).toFixed(4);
  console.log(`\n[${p.symbol} ${p.direction.toUpperCase()}] ${p.id}`);
  console.log(`  entry=${fmt(p.entry)}  SL ${fmt(p.oldSL)} → ${fmt(p.newSL)}`);
  console.log(`  TP1  ${fmt(p.oldTP1)} → ${fmt(p.newTP1)}`);
  console.log(`  TP2  ${fmt(p.oldTP2)} → ${fmt(p.newTP2)}`);
  console.log(`  TP3  ${fmt(p.oldTP3)} → ${fmt(p.newTP3)}`);
  for (const r of p.reasons) console.log(`  + ${r}`);
  for (const w of p.warnings) console.log(`  ! ${w}`);
}

if (APPLY) {
  writeJSON(OPEN_PATH, openData);
  console.log(`\n✅ ${OPEN_PATH} guncellendi.`);
} else {
  console.log('\nℹ️  Dry-run bitti. Uygulamak icin: node scripts/migrate-align-sl-tp.mjs --apply');
}
