#!/usr/bin/env node
/**
 * A-Grade Attribution Report (last 30 days)
 *
 * Hangi indicator/vote bileseni A sinyalinin (TP hit vs SL hit) outcome'una
 * yon veriyor? Eski kayitlarda voteBreakdown yok — `indicators` snapshot'u
 * uzerinden proxy attribution ureteriz. Yeni kayitlarda (voteBreakdown'lı)
 * gerçek vote-weighted attribution.
 *
 * Cikti: scanner/data/stats/a-grade-attribution.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join(ROOT, 'data/signals/archive');
const OUT_PATH = path.join(ROOT, 'data/stats/a-grade-attribution.md');

const DAYS = 30;
const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

function loadArchive() {
  const files = fs.readdirSync(ARCHIVE_DIR).filter(f => /^\d{4}-\d{2}\.json$/.test(f));
  const all = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8'));
      const arr = raw.signals || (Array.isArray(raw) ? raw : Object.values(raw));
      for (const s of arr) all.push(s);
    } catch (e) {
      console.error(`[skip] ${f}: ${e.message}`);
    }
  }
  return all;
}

function pct(n, d) {
  if (!d) return '0.0%';
  return ((n / d) * 100).toFixed(1) + '%';
}

function fmtR(r) {
  if (r == null || !Number.isFinite(r)) return 'n/a';
  return (r >= 0 ? '+' : '') + Number(r).toFixed(2) + 'R';
}

function isWinOutcome(s) {
  return s.outcome === 'tp1_hit' || s.outcome === 'tp2_hit' || s.outcome === 'tp3_hit'
      || s.outcome === 'trailing_stop_exit'; // BE+ exit treat as win
}

function isLossOutcome(s) {
  return s.outcome === 'sl_hit' || s.outcome === 'faultyTrade';
}

function indicatorPresence(sig) {
  const ind = sig.indicators || {};
  const present = [];
  if (ind.khanSaab) {
    if (ind.khanSaab.bias) present.push(`khanSaab:${ind.khanSaab.bias}`);
    if (ind.khanSaab.macd === 'BULL' || ind.khanSaab.macd === 'BEAR') present.push(`macd:${ind.khanSaab.macd}`);
    if (ind.khanSaab.emaStatus === 'BULL' || ind.khanSaab.emaStatus === 'BEAR') present.push(`ema_cross:${ind.khanSaab.emaStatus}`);
  }
  if (ind.smc) {
    if (ind.smc.bos) present.push(`smc_bos:${ind.smc.bos}`);
    if (ind.smc.choch) present.push(`smc_choch:${ind.smc.choch}`);
    if (ind.smc.ob) present.push('smc_ob');
    if (ind.smc.fvg) present.push('smc_fvg');
  }
  if (ind.formation) present.push(`formation:${ind.formation.name || 'unknown'}`);
  if (ind.divergence) present.push(`divergence:${ind.divergence.type || 'unknown'}`);
  if (ind.cdv) present.push(`cdv:${ind.cdv.direction || 'unknown'}`);
  if (ind.squeeze && ind.squeeze.active) present.push('squeeze:active');
  if (ind.mtfConfirmation) present.push(`mtf:${ind.mtfConfirmation.confidence || 0}`);
  return present;
}

function main() {
  const all = loadArchive();
  const aSignals = all.filter(s => s.grade === 'A' && s.outcome && new Date(s.createdAt).getTime() >= cutoff);

  if (aSignals.length === 0) {
    console.error(`[report] Son ${DAYS} gunde kapanmis A sinyali bulunamadi.`);
    process.exit(1);
  }

  const wins = aSignals.filter(isWinOutcome);
  const losses = aSignals.filter(isLossOutcome);
  const winRate = wins.length / aSignals.length;
  const avgR = aSignals.reduce((s, x) => s + (Number(x.actualRR) || 0), 0) / aSignals.length;

  // --- Bolum 1: Indicator presence × outcome matrix (proxy)
  const presenceMatrix = new Map(); // key -> {wins, losses, totalR}
  for (const sig of aSignals) {
    const present = indicatorPresence(sig);
    const isWin = isWinOutcome(sig);
    const isLoss = isLossOutcome(sig);
    const r = Number(sig.actualRR) || 0;
    for (const key of present) {
      const cur = presenceMatrix.get(key) || { wins: 0, losses: 0, totalR: 0, total: 0 };
      cur.total += 1;
      if (isWin) cur.wins += 1;
      if (isLoss) cur.losses += 1;
      cur.totalR += r;
      presenceMatrix.set(key, cur);
    }
  }
  const presenceRows = [...presenceMatrix.entries()]
    .filter(([, v]) => v.total >= 3)
    .map(([k, v]) => ({
      key: k,
      total: v.total,
      wins: v.wins,
      losses: v.losses,
      winRate: v.wins / v.total,
      avgR: v.totalR / v.total,
    }))
    .sort((a, b) => a.avgR - b.avgR); // worst (most negative) first

  // --- Bolum 2: voteBreakdown attribution (yeni veriler)
  const voteAttribution = new Map(); // source -> {wins, losses, totalWeight}
  let withVotes = 0;
  for (const sig of aSignals) {
    if (!Array.isArray(sig.voteBreakdown)) continue;
    withVotes += 1;
    const isWin = isWinOutcome(sig);
    const sigDir = sig.direction;
    for (const v of sig.voteBreakdown) {
      const aligned = v.direction === sigDir; // sinyal yonune mi oy verdi?
      const key = `${v.source}${aligned ? '' : '(against)'}`;
      const cur = voteAttribution.get(key) || { wins: 0, losses: 0, total: 0, totalWeight: 0 };
      cur.total += 1;
      if (isWin) cur.wins += 1;
      else cur.losses += 1;
      cur.totalWeight += Math.abs(Number(v.weight) || 0);
      voteAttribution.set(key, cur);
    }
  }
  const voteRows = [...voteAttribution.entries()]
    .filter(([, v]) => v.total >= 3)
    .map(([k, v]) => ({
      key: k,
      total: v.total,
      winRate: v.wins / v.total,
      avgWeight: v.totalWeight / v.total,
    }))
    .sort((a, b) => a.winRate - b.winRate);

  // --- Bolum 3: SL hit eden A trade'lerinin top-5 indicator combo
  const comboCount = new Map();
  for (const sig of losses) {
    const present = indicatorPresence(sig).sort();
    const key = present.slice(0, 4).join(' + ') || '(no indicators)';
    comboCount.set(key, (comboCount.get(key) || 0) + 1);
  }
  const topCombos = [...comboCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // --- Bolum 4: Faulty trade (reverseAttempts >= 1 + SL)
  const faultyTrades = aSignals.filter(s =>
    isLossOutcome(s) && Array.isArray(s.reverseAttempts) && s.reverseAttempts.length >= 1
  );

  // --- Markdown
  const lines = [];
  lines.push(`# A-Grade Attribution Report`);
  lines.push(``);
  lines.push(`**Generated:** ${new Date().toISOString()}  `);
  lines.push(`**Window:** Last ${DAYS} days  `);
  lines.push(`**A-grade closed signals:** ${aSignals.length}  `);
  lines.push(`**Win rate:** ${pct(wins.length, aSignals.length)}  `);
  lines.push(`**Avg R:** ${fmtR(avgR)}  `);
  lines.push(`**With voteBreakdown:** ${withVotes} / ${aSignals.length} (yeni kayit alani — eski kayitlar proxy)`);
  lines.push(``);

  // Bolum 1
  lines.push(`## 1. Indicator Presence × Outcome (proxy)`);
  lines.push(``);
  lines.push(`Her A sinyalde mevcut olan indicator etiketleri ile outcome eslestirilir.`);
  lines.push(`En altta (en zararli) indicator imzalari: bunlar A sinyalde varsa SL hit olasiligi yuksek.`);
  lines.push(``);
  lines.push(`| Indicator | Total | Wins | Losses | WinRate | AvgR |`);
  lines.push(`|-----------|-------|------|--------|---------|------|`);
  for (const r of presenceRows) {
    lines.push(`| ${r.key} | ${r.total} | ${r.wins} | ${r.losses} | ${pct(r.wins, r.total)} | ${fmtR(r.avgR)} |`);
  }
  lines.push(``);

  // Bolum 2
  lines.push(`## 2. Vote Breakdown Attribution (gerçek)`);
  lines.push(``);
  if (voteRows.length === 0) {
    lines.push(`_Bu rapor uretildiginde voteBreakdown alanli A sinyali yok. Yeni sinyaller geldikçe veriler birikecek; ~14 gun sonra anlamli çikti olur._`);
  } else {
    lines.push(`| Source (yön) | Total | WinRate | Avg|Weight| |`);
    lines.push(`|--------------|-------|---------|---------------|`);
    for (const r of voteRows) {
      lines.push(`| ${r.key} | ${r.total} | ${pct(r.winRate, 1)} | ${r.avgWeight.toFixed(2)} |`);
    }
  }
  lines.push(``);

  // Bolum 3
  lines.push(`## 3. SL Hit A-Trade — Top 5 Indicator Combos`);
  lines.push(``);
  if (topCombos.length === 0) {
    lines.push(`_(SL hit A-trade yok)_`);
  } else {
    lines.push(`| Combo | SL Hit Count |`);
    lines.push(`|-------|--------------|`);
    for (const [combo, n] of topCombos) {
      lines.push(`| ${combo} | ${n} |`);
    }
  }
  lines.push(``);

  // Bolum 4
  lines.push(`## 4. Faulty Trades (reverseAttempts ≥ 1 + SL)`);
  lines.push(``);
  if (faultyTrades.length === 0) {
    lines.push(`_(Faulty A-trade yok)_`);
  } else {
    lines.push(`| Symbol | TF | Direction | Outcome | R | reverseAttempts |`);
    lines.push(`|--------|----|-----------|---------|---|-----------------|`);
    for (const s of faultyTrades) {
      lines.push(`| ${s.symbol} | ${s.timeframe} | ${s.direction} | ${s.outcome} | ${fmtR(s.actualRR)} | ${s.reverseAttempts.length} |`);
    }
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(`_Generated by scanner/scripts/report-a-grade-attribution.mjs_`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf8');
  console.log(`[report] Wrote ${OUT_PATH}`);
  console.log(`[report] A signals: ${aSignals.length}, WR: ${pct(wins.length, aSignals.length)}, AvgR: ${fmtR(avgR)}`);
}

main();
