#!/usr/bin/env node
/**
 * seed-regime-state.mjs
 *
 * Shadow log'larından `scanner/data/regime-state.json` seed üretir.
 * Amaç: scanner restart sonrası 3 cycle'lık warmup (~3-4 saat) beklemeden,
 * Faz 1 boyunca biriken computeRegime gözlemlerinden state'i hidrate etmek.
 *
 * Kullanım:
 *   1. Scanner'ı DURDUR (state dosyasını overwrite etmemesi için).
 *   2. node scanner/scripts/seed-regime-state.mjs [--days N] [--dry-run]
 *   3. Scanner'ı başlat — load aşamasında seed devralınır.
 *
 * Algoritma:
 *   - Son N gün (varsayılan 7) regime-log-*.jsonl dosyalarını oku.
 *   - (symbol, timeframe) bazında grupla, kronolojik sırala.
 *   - Son 3 kayıt aynı `regime` ise → stableBars = HYSTERESIS_BARS (warmup tamam).
 *   - Aksi halde son kaydın barsSinceTransition'ı kullan.
 *   - recentRaw = son 3 rawRegime.
 *   - transitions = log'taki regime değişikliği gözlemleri (bugünkü sayı için).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'regime-state.json');
const STATE_VERSION = 1;
const HYSTERESIS_BARS = 3;

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const daysArg = process.argv.find(a => a.startsWith('--days='));
const days = daysArg ? Math.max(1, parseInt(daysArg.split('=')[1], 10)) : 7;

function logFilesForLastNDays(n) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const d = new Date(now - i * 86_400_000);
    const dateStr = d.toISOString().slice(0, 10);
    const p = path.join(DATA_DIR, `regime-log-${dateStr}.jsonl`);
    if (fs.existsSync(p)) out.push({ date: dateStr, path: p });
  }
  return out.reverse(); // eskiden yeniye
}

function readJsonl(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { records.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return records;
}

function buildStateEntry(records) {
  // records: kronolojik (eskiden yeniye), aynı (symbol, tf)
  const last = records[records.length - 1];
  const last3 = records.slice(-3);
  const allSame = last3.length >= HYSTERESIS_BARS
    && last3.every(r => r.regime === last.regime);

  const stableBars = allSame
    ? Math.max(HYSTERESIS_BARS, last.barsSinceTransition || HYSTERESIS_BARS)
    : (last.barsSinceTransition || 1);

  // recentRaw: son N rawRegime (compute-regime histerezis buffer'ı)
  const recentRaw = records.slice(-HYSTERESIS_BARS).map(r => r.rawRegime || r.regime);

  // transitions: bugünkü transition sayısını korumak için son günün geçişlerini topla
  const today = new Date().toISOString().slice(0, 10);
  const transitions = [];
  let prev = null;
  for (const r of records) {
    if (r.regime && r.regime !== prev) {
      const day = r.utcTimestamp ? r.utcTimestamp.slice(0, 10) : today;
      transitions.push({
        day,
        at: r.utcTimestamp ? Date.parse(r.utcTimestamp) : Date.now(),
        from: prev,
        to: r.regime,
        raw: r.rawRegime || r.regime,
      });
      prev = r.regime;
    }
  }

  // since: son transition zamanı (yoksa son kayıt zamanı)
  const lastTransition = transitions[transitions.length - 1];
  const since = lastTransition
    ? lastTransition.at
    : (last.utcTimestamp ? Date.parse(last.utcTimestamp) : Date.now());

  return {
    regime: last.regime ?? null,
    subRegime: last.subRegime ?? null,
    since,
    stableBars,
    recentRaw,
    transitions,
  };
}

function main() {
  const files = logFilesForLastNDays(days);
  if (files.length === 0) {
    console.error(`[seed] son ${days} günde regime-log-*.jsonl bulunamadi (${DATA_DIR})`);
    process.exit(1);
  }

  console.log(`[seed] ${files.length} log dosyasi okunuyor:`);
  for (const f of files) console.log(`  - ${f.date}: ${path.basename(f.path)}`);

  // Tüm kayıtları (symbol|tf) bazında topla, kronolojik sırala
  const groups = new Map();
  for (const f of files) {
    for (const rec of readJsonl(f.path)) {
      if (!rec.symbol || !rec.timeframe) continue;
      const key = `${rec.symbol}|${rec.timeframe}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
    }
  }

  // Her grup zaten kronolojik (log append-only); yine de güvence için sırala
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.utcTimestamp || '').localeCompare(b.utcTimestamp || ''));
  }

  const entries = {};
  let warmComplete = 0;
  let partial = 0;
  for (const [key, recs] of groups.entries()) {
    const st = buildStateEntry(recs);
    entries[key] = st;
    if (st.stableBars >= HYSTERESIS_BARS) warmComplete++; else partial++;
  }

  console.log(`\n[seed] ozet:`);
  console.log(`  toplam (symbol,tf): ${Object.keys(entries).length}`);
  console.log(`  warmup tamam (stableBars>=${HYSTERESIS_BARS}): ${warmComplete}`);
  console.log(`  warmup kismi: ${partial}`);

  // Rejim dağılımı
  const regimeDist = {};
  for (const e of Object.values(entries)) {
    regimeDist[e.regime || 'null'] = (regimeDist[e.regime || 'null'] || 0) + 1;
  }
  console.log(`  rejim dagilimi: ${JSON.stringify(regimeDist)}`);

  if (dryRun) {
    console.log('\n[seed] --dry-run: dosya yazilmadi.');
    return;
  }

  // Mevcut state dosyası varsa backup
  if (fs.existsSync(STATE_PATH)) {
    const backup = STATE_PATH + '.bak.' + Date.now();
    fs.copyFileSync(STATE_PATH, backup);
    console.log(`\n[seed] mevcut state yedeklendi → ${path.basename(backup)}`);
  }

  const payload = {
    version: STATE_VERSION,
    savedAt: new Date().toISOString(),
    seededFrom: 'shadow-log',
    entries,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2));
  console.log(`[seed] yazildi → ${STATE_PATH}`);
}

main();
