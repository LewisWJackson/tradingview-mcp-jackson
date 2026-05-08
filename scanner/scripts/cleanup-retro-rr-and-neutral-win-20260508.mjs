#!/usr/bin/env node
/**
 * 2026-05-08 — PF zehirlenmesi temizligi.
 *
 * Iki sorun:
 *  A) cleanup-mfe-tp1-bugs script'inden gelen 19 retro-classified sinyal
 *     `status=trailing_stop_exit, win=true, actualRR=-0.5`. Win=true ama
 *     RR<0 → PF hesabinda yalanci negatif-RR win → grossWin azaliyor.
 *     Duzeltme: slHitPrice=entry, actualRR=0.
 *
 *  B) Neutral status'lu sinyaller (entry_missed_tp, entry_expired,
 *     superseded_*, sl_hit_high_mfe, manual_close, invalid_data) `win=false`
 *     ile arsivlenmis → anomaly-detector loss bucket'ina dusuruyor. Bunlar
 *     ladder'da neutral. `win=null` yap → anomaly otomatik filtreler.
 *
 * Idempotent: yeniden calistirilirsa zaten temiz olanlar atlanir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const ARCHIVE_FILES = [
  path.join(ROOT, 'data/signals/archive/2026-04.json'),
  path.join(ROOT, 'data/signals/archive/2026-05.json'),
  path.join(ROOT, 'data/signals/archive_legacy/2026-04.json'),
  path.join(ROOT, 'data/signals/archive_legacy/2026-05.json'),
];

const NEUTRAL_STATUSES = new Set([
  'entry_missed_tp', 'entry_expired',
  'superseded', 'superseded_by_tf', 'superseded_by_cleanup',
  'superseded_by_cap', 'superseded_by_reverse',
  'sl_hit_high_mfe', 'manual_close', 'invalid_data',
]);

function readJSON(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJSON(p, v) {
  if (DRY) return;
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}
function backup(p) {
  if (DRY || !fs.existsSync(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(p, `${p}.pre-retrorr-cleanup-${stamp}.bak`);
}

const report = { retroFixed: [], neutralWinNulled: [] };

for (const file of ARCHIVE_FILES) {
  const data = readJSON(file);
  if (!data || !Array.isArray(data.signals)) continue;
  let dirty = false;

  for (const s of data.signals) {
    // A) Retro-TP1 → BE (RR=0)
    if (s.retroTp1FromMfe && s.status === 'trailing_stop_exit' && s.actualRR !== 0) {
      const before = { actualRR: s.actualRR, slHitPrice: s.slHitPrice, trailingStopLevel: s.trailingStopLevel };
      s.slHitPrice = s.entry;
      s.trailingStopLevel = s.entry;
      s.actualRR = 0;
      s.slReason = `MFE>=TP1 retroaktif: TP1 hit + BE exit (RR=0)`;
      report.retroFixed.push({ file, id: s.id, sym: s.symbol, before });
      dirty = true;
    }

    // B) Neutral status → win=null
    if (NEUTRAL_STATUSES.has(s.status) && s.win !== null) {
      const before = { win: s.win };
      s.win = null;
      report.neutralWinNulled.push({ file, id: s.id, sym: s.symbol, status: s.status, before });
      dirty = true;
    }
  }

  if (dirty) {
    backup(file);
    writeJSON(file, data);
    console.log(`[write] ${path.basename(file)} guncellendi`);
  }
}

console.log('\n=== Rapor ===');
console.log(`Retro RR fix (RR=-0.5 → 0): ${report.retroFixed.length}`);
report.retroFixed.slice(0, 20).forEach(r => console.log(`  ${r.id} (${r.sym}): RR=${r.before.actualRR} → 0`));
console.log(`Neutral win=null: ${report.neutralWinNulled.length}`);
const byStatus = {};
for (const r of report.neutralWinNulled) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
for (const [st, n] of Object.entries(byStatus).sort((a,b) => b[1]-a[1])) console.log(`  ${st}: ${n}`);
console.log(DRY ? '\n[DRY-RUN — degisiklik yazilmadi]' : '\n[Yazildi]');
