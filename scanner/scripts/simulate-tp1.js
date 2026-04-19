#!/usr/bin/env node
/**
 * simulate-tp1.js — read-only backtest for TP1 distance variants.
 *
 * Usage:
 *   node scanner/scripts/simulate-tp1.js [--days 60] [--tp1 1.0 --tp1 1.2 --tp1 1.5]
 *
 * Veri kaynagi: scanner/data/signals/archive/*.json ({ signals: [...] }).
 * Yaklasim: her resolve olmus sinyal icin R = |entry - sl|, MFE_R = MFE / R.
 * Bir hipotetik TP1 mesafesi X icin "hit" = MFE_R >= X. sl_hit olup MFE_R >= X
 * olan sinyaller, daha yakin TP1 ile kismi kar alip SL'yi break-even'a cekebilir
 * ve haksiz demote'u engeller.
 *
 * Cikti: her TP1 varyanti icin
 *   - toplam sinyal
 *   - gercek TP1 hit sayisi (baseline)
 *   - hipotetik TP1 hit sayisi (MFE_R >= X)
 *   - kurtarilan sl_hit sayisi (status=sl_hit AND MFE_R >= X)
 *   - "sl_hit_high_mfe" adayi sayisi (MFE_R >= 0.7 * X)
 *   - ortalama MFE_R, ortalama MAE_R
 *
 * NOT: Bar-seviyesi replay yapmiyoruz — MFE ile MAE'nin zaman sirasini bilmiyoruz.
 * Bu yaklasim muhafazakar; gercek kazanc muhtemelen daha yuksek (TP1 vurdumu
 * trailing BE devreye girer, sonraki MAE zararla kapatmaz).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARCHIVE_DIR = path.resolve(__dirname, '..', 'data', 'signals', 'archive');

function parseArgs(argv) {
  const args = { days: 60, tp1: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--tp1') args.tp1.push(Number(argv[++i]));
  }
  if (args.tp1.length === 0) args.tp1 = [1.0, 1.2, 1.5];
  return args;
}

function loadArchiveSignals(days) {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    console.error(`archive dizini bulunamadi: ${ARCHIVE_DIR}`);
    process.exit(1);
  }
  const cutoff = Date.now() - days * 86400_000;
  const files = fs.readdirSync(ARCHIVE_DIR)
    .filter(f => f.endsWith('.json') && !f.includes('backup') && !f.endsWith('.bak'));
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.signals) ? parsed.signals : [];
    for (const s of list) {
      if (!s || !s.resolvedAt) continue;
      const ts = Date.parse(s.resolvedAt);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      out.push(s);
    }
  }
  return out;
}

function rMultiple(signal) {
  if (signal.entry == null || signal.sl == null) return null;
  const R = Math.abs(signal.entry - signal.sl);
  if (!(R > 0)) return null;
  const mfe = Number(signal.maxFavorableExcursion);
  const mae = Number(signal.maxAdverseExcursion);
  return {
    R,
    mfeR: Number.isFinite(mfe) ? mfe / R : 0,
    maeR: Number.isFinite(mae) ? mae / R : 0,
  };
}

function simulate(signals, tp1R) {
  const out = {
    tp1R,
    total: 0,
    actualTp1Hit: 0,
    actualSlHit: 0,
    actualNeutral: 0,
    hypotheticalTp1Hit: 0,
    rescuedSlHit: 0,
    highMfeSlCandidate: 0,   // sl_hit with MFE_R in [0.7*X, X) — yon dogru ama yetmedi
    sumMfeR: 0,
    sumMaeR: 0,
    nWithR: 0,
  };
  for (const s of signals) {
    out.total++;
    const r = rMultiple(s);
    const status = s.status || s.outcome;
    if (status === 'tp1_hit' || status === 'tp2_hit' || status === 'tp3_hit') out.actualTp1Hit++;
    else if (status === 'sl_hit') out.actualSlHit++;
    else out.actualNeutral++;
    if (!r) continue;
    out.nWithR++;
    out.sumMfeR += r.mfeR;
    out.sumMaeR += r.maeR;
    if (r.mfeR >= tp1R) out.hypotheticalTp1Hit++;
    if (status === 'sl_hit') {
      if (r.mfeR >= tp1R) out.rescuedSlHit++;
      else if (r.mfeR >= 0.7 * tp1R) out.highMfeSlCandidate++;
    }
  }
  out.avgMfeR = out.nWithR ? out.sumMfeR / out.nWithR : 0;
  out.avgMaeR = out.nWithR ? out.sumMaeR / out.nWithR : 0;
  return out;
}

function fmtPct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '  n/a'; }
function fmt(n) { return n.toFixed(3); }

function main() {
  const args = parseArgs(process.argv);
  const signals = loadArchiveSignals(args.days);

  console.log(`\nArsivden ${signals.length} resolve sinyal yuklendi (son ${args.days} gun).`);
  const byGrade = {};
  for (const s of signals) byGrade[s.grade] = (byGrade[s.grade] || 0) + 1;
  console.log('Grade dagilimi:', byGrade);

  console.log('\n--- GENEL (tum grade) ---');
  const header = ['TP1_R', 'total', 'actTP1', 'actSL', 'actNeutral', 'hypoTP1', 'rescuedSL', 'highMFE_SL', 'hypoHit%', 'rescueRatio', 'avgMFE_R', 'avgMAE_R'];
  console.log(header.join('\t'));
  for (const tp1R of args.tp1) {
    const r = simulate(signals, tp1R);
    console.log([
      tp1R.toFixed(2),
      r.total,
      r.actualTp1Hit,
      r.actualSlHit,
      r.actualNeutral,
      r.hypotheticalTp1Hit,
      r.rescuedSlHit,
      r.highMfeSlCandidate,
      fmtPct(r.hypotheticalTp1Hit, r.total),
      fmtPct(r.rescuedSlHit, r.actualSlHit),
      fmt(r.avgMfeR),
      fmt(r.avgMaeR),
    ].join('\t'));
  }

  // Grade bazli kirilim — ladder'i en cok C ve BEKLE sinyalleri etkiliyor
  for (const g of ['A', 'B', 'C', 'BEKLE']) {
    const subset = signals.filter(s => s.grade === g);
    if (subset.length < 5) continue;
    console.log(`\n--- grade=${g} (n=${subset.length}) ---`);
    console.log(header.join('\t'));
    for (const tp1R of args.tp1) {
      const r = simulate(subset, tp1R);
      console.log([
        tp1R.toFixed(2),
        r.total,
        r.actualTp1Hit,
        r.actualSlHit,
        r.actualNeutral,
        r.hypotheticalTp1Hit,
        r.rescuedSlHit,
        r.highMfeSlCandidate,
        fmtPct(r.hypotheticalTp1Hit, r.total),
        fmtPct(r.rescuedSlHit, r.actualSlHit),
        fmt(r.avgMfeR),
        fmt(r.avgMaeR),
      ].join('\t'));
    }
  }

  console.log('\nNOT: rescueRatio = sl_hit olup MFE_R >= TP1_R olan sinyal orani.');
  console.log('     Bu sinyaller daha yakin TP1 ile TP1 kismi kar + BE\'ye cekilmis SL');
  console.log('     olarak kapanabilirdi; ladder\'da loss sayilmayacakti.\n');
}

main();
