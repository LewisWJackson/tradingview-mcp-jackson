#!/usr/bin/env node
/**
 * Mevcut acik sinyallere yeni entry kurallarini uygula.
 *
 * 1) quote_price / lastbar_close / null entrySource → entryHit = true (legacy/market).
 * 2) Smart entry (smc_ob/smc_fvg/khansaab_entry) + entryHit=false:
 *    - entryDeadline = createdAt + 8 * TF dakika
 *    - deadline gecmisse → status = 'entry_expired', supersededAt = now
 *    - degilse entryDeadline alanini sinyale yaz (ileriye donuk takip icin)
 * 3) Tolerans: atr yok, bu yuzden retro tolerans uygulanmaz — forward-only.
 *
 * Backup: open.json.bak-YYYYMMDD-HHMMSS
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPEN_PATH = path.resolve(__dirname, '../data/signals/open.json');

const SMART_SOURCES = new Set(['smc_ob', 'smc_fvg', 'khansaab_entry']);

function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  const raw = fs.readFileSync(OPEN_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data.signals)) throw new Error('Beklenen data.signals array degil');

  // Backup
  const backup = OPEN_PATH + `.bak-${tsStamp()}`;
  fs.writeFileSync(backup, raw, 'utf8');
  console.log(`[Migrate] Backup: ${backup}`);

  const now = new Date();
  const nowIso = now.toISOString();

  let normalizedMarket = 0;
  let expired = 0;
  let deadlineAdded = 0;
  const expiredList = [];

  for (const s of data.signals) {
    // Sadece acik / trailing pozisyonlar
    const liveStatuses = new Set(['open', 'tp1_hit', 'tp2_hit']);
    if (!liveStatuses.has(s.status)) continue;

    const src = s.entrySource || null;
    const isSmart = src && SMART_SOURCES.has(src);

    // 1) Market/legacy → entryHit normalize
    if (!isSmart && s.entryHit === false) {
      s.entryHit = true;
      s.entryHitAt = s.entryHitAt || s.createdAt || nowIso;
      if (!Array.isArray(s.entryReasoning)) s.entryReasoning = [];
      s.entryReasoning.push('Migrate: non-smart entry, entryHit normalize edildi');
      normalizedMarket++;
      continue;
    }

    // 2) Smart entry + hit olmamis → deadline kontrolu
    if (isSmart && s.entryHit === false) {
      const tfMin = Number(s.timeframe) || 15;
      const createdAt = s.createdAt ? new Date(s.createdAt) : now;
      const deadlineMs = createdAt.getTime() + tfMin * 60 * 1000 * 8;
      const deadline = new Date(deadlineMs);

      if (now >= deadline) {
        s.status = 'entry_expired';
        s.entryExpiredAt = nowIso;
        if (!Array.isArray(s.warnings)) s.warnings = [];
        s.warnings.push(`Migrate: 8*TF (${tfMin}dk) suresi doldu, entry hit olmadi`);
        expired++;
        expiredList.push(`${s.symbol} ${s.timeframe}m ${s.direction}`);
      } else {
        s.entryDeadline = deadline.toISOString();
        deadlineAdded++;
      }
    }
  }

  fs.writeFileSync(OPEN_PATH, JSON.stringify(data, null, 2), 'utf8');

  console.log('\n=== Migrate Sonuc ===');
  console.log(`Market/legacy entryHit normalize: ${normalizedMarket}`);
  console.log(`Smart entry expired (temizlendi): ${expired}`);
  console.log(`Smart entry deadline eklendi (aktif bekleyen): ${deadlineAdded}`);
  if (expiredList.length) {
    console.log('\nExpired pozisyonlar:');
    expiredList.forEach(x => console.log('  - ' + x));
  }
}

main();
