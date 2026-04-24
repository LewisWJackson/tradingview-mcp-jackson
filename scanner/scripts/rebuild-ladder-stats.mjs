#!/usr/bin/env node
import { rebuildAndPersist, getLadderSummary, loadLadder } from '../lib/learning/ladder-engine.js';
import { readAllArchives } from '../lib/learning/persistence.js';
import { recomputeAllStats } from '../lib/learning/stats-engine.js';

const beforeState = loadLadder();
const archive = readAllArchives();
console.log(`[Rebuild] Arsivdeki toplam sinyal: ${archive.length}`);

const beforeRows = Object.entries(beforeState.entries || {}).flatMap(([sym, g]) =>
  Object.entries(g).map(([grade, e]) => ({ key: `${sym}:${grade}`, tier: e.tier, ws: e.winStreak, ls: e.lossStreak }))
);
const beforeMap = new Map(beforeRows.map(r => [r.key, r]));

rebuildAndPersist(archive);
const summary = getLadderSummary();

const changes = [];
for (const row of summary.rows) {
  const key = `${row.symbol}:${row.grade}`;
  const prev = beforeMap.get(key);
  const prevTier = prev?.tier ?? '(yok)';
  if (prev && prev.tier === row.tier && prev.ws === row.winStreak && prev.ls === row.lossStreak) continue;
  changes.push({ key, from: prevTier, to: row.tier, ws: row.winStreak, ls: row.lossStreak, wr: row.windowWR });
}

console.log(`\n[Ladder] ${changes.length} giriste degisiklik:`);
for (const c of changes) {
  const dir = (c.from === 'virtual' && (c.to === 'ara' || c.to === 'real')) ? '↑' :
              (c.from === 'real' && (c.to === 'ara' || c.to === 'virtual')) ? '↓' :
              (c.from === 'ara' && c.to === 'real') ? '↑' :
              (c.from === 'ara' && c.to === 'virtual') ? '↓' : '≈';
  console.log(`  ${dir} ${c.key}: ${c.from} → ${c.to} | winStreak=${c.ws} lossStreak=${c.ls} WR=${c.wr}%`);
}

console.log(`\n[Stats] recompute ediliyor...`);
const stats = recomputeAllStats();
console.log(`  Toplam cozulmus: ${stats.totalSignals || stats.overall?.total || '?'}`);
console.log(`  Real WR: ${stats.realSignals?.winRate ?? stats.overall?.winRate ?? '?'}%`);
