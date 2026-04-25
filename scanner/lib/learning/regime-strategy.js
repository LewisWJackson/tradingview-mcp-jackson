/**
 * Regime Strategy Wrapper — Faz 2 çekirdek modülü.
 *
 * docs/phase-2-design.md §3 + §6.5 spec'i. computeRegime() çıktısını alır,
 * mevcut sinyal-grader oylarını rejim-aware olarak yeniden ağırlıklandırır,
 * REGIME_GATES eşiklerini uygular, dispatch kararı verir.
 *
 * **Tasarım prensibi**: signal-grader.js'in mevcut votes/filter mantığını
 * yeniden yazmıyoruz — wrapper olarak öncesinde/sonrasında çalışır:
 *   collectVotes() → applyRegimeStrategy(votes) → adjusted votes → kanaat
 *   skoru → REGIME_GATES kontrol → dispatch kararı
 *
 * Faz 2 boyunca (24h shadow + sonrası live), tüm kararlar
 * `scanner/data/wrapper-shadow-decisions.jsonl`'a kaydedilir (audit trail).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REGIME_GATES,
  REGIME_SL_MULT,
  REGIME_VOTE_WEIGHTS,
  familyOf,
} from './regime-profiles.js';
import { isLive, isShadow, getWrapperMode } from './wrapper-mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', '..', 'data');

const GRADE_RANK = { 'A': 4, 'B': 3, 'C': 2, 'BEKLE': 1, null: 0, undefined: 0 };

function gradeRank(g) {
  return GRADE_RANK[g] ?? 0;
}

// ---------------------------------------------------------------------------
// Vote suppression — rejim-aware ağırlıklandırma
// ---------------------------------------------------------------------------

/**
 * Ham oyları rejim ağırlıklarıyla yeniden ölçeklendir.
 * @param {Array<{indicator:string, direction?:string, weight:number}>} votes
 * @param {string} regime
 * @returns {{adjusted: Array, suppressedKeys: string[], boostedKeys: string[]}}
 */
export function suppressVotes(votes, regime) {
  if (!Array.isArray(votes)) return { adjusted: [], suppressedKeys: [], boostedKeys: [] };
  const weights = REGIME_VOTE_WEIGHTS[regime] || null;
  if (!weights) {
    // Bilinmeyen rejim — passthrough
    return { adjusted: votes.slice(), suppressedKeys: [], boostedKeys: [] };
  }
  const suppressedKeys = [];
  const boostedKeys = [];
  const adjusted = votes.map(v => {
    // signal-grader.js vote.source kullanır; harici callerlar vote.indicator
    // kullanabilir → ikisini de destekle.
    const key = v.indicator || v.source || null;
    const family = familyOf(key);
    const mult = (family && weights[family] != null) ? weights[family] : 1.0;
    const newWeight = (v.weight ?? 1) * mult;
    if (mult === 0 && key) suppressedKeys.push(key);
    else if (mult >= 1.3 && key) boostedKeys.push(key);
    return { ...v, weight: newWeight, _origWeight: v.weight ?? 1, _family: family, _mult: mult };
  });
  return { adjusted, suppressedKeys, boostedKeys };
}

// ---------------------------------------------------------------------------
// Gate kontrolleri — REGIME_GATES tablosu
// ---------------------------------------------------------------------------

/**
 * @param {{regime:string, draftGrade:string, htfConfidence?:number, mtfAlignment?:number}} opts
 * @returns {{pass:boolean, decision:string, gate:object}}
 */
export function checkGates({ regime, draftGrade, htfConfidence = null, mtfAlignment = null }) {
  const gate = REGIME_GATES[regime];
  if (!gate) {
    return { pass: false, decision: 'REJECT_UNKNOWN_REGIME', gate: null };
  }
  if (!gate.allowNewPosition) {
    return { pass: false, decision: regime === 'high_vol_chaos' ? 'REJECT_CHAOS' : 'REJECT_DRIFT', gate };
  }
  if (gate.minGrade && gradeRank(draftGrade) < gradeRank(gate.minGrade)) {
    return { pass: false, decision: 'REJECT_GATE_GRADE', gate };
  }
  if (gate.htfConfMin != null && htfConfidence != null && htfConfidence < gate.htfConfMin) {
    return { pass: false, decision: 'REJECT_GATE_HTF', gate };
  }
  if (gate.mtfAlignMin != null && mtfAlignment != null && mtfAlignment < gate.mtfAlignMin) {
    return { pass: false, decision: 'REJECT_GATE_MTF', gate };
  }
  return { pass: true, decision: 'PASS', gate };
}

// ---------------------------------------------------------------------------
// Decision logger — wrapper-shadow-decisions.jsonl
// ---------------------------------------------------------------------------

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function logPathFor(date) {
  return path.join(LOG_DIR, `wrapper-decisions-${date}.jsonl`);
}

function logDecision(record) {
  try {
    const filePath = logPathFor(todayUtc());
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.warn('[regime-strategy] log write failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// applyRegimeStrategy() — ana arayüz
// ---------------------------------------------------------------------------

/**
 * docs/phase-2-design.md §3 sözleşmesi.
 *
 * @param {Object} opts
 * @param {{regime, subRegime, strategyHint, confidence, newPositionAllowed}} opts.regimeContext
 * @param {Array} opts.votes  — collectVotes() ham çıktısı
 * @param {Object} opts.signalDraft  — { direction, entry, sl, tp1, tp2, tp3, grade }
 * @param {string} opts.symbol
 * @param {string} opts.timeframe
 * @param {string} opts.marketType
 * @param {number|null} opts.htfConfidence  — alignment-filters HTF confidence (0-100)
 * @param {number|null} opts.mtfAlignment   — multi-TF uyum (0-100)
 *
 * @returns {{
 *   rejected: boolean,
 *   rejectionReason: string|null,
 *   decision: string,                         // PASS | REJECT_*
 *   adjustedVotes: Array,
 *   suppressedVotes: string[],
 *   boostedVotes: string[],
 *   slMultiplier: number|null,                // rejim profilinden
 *   tpProfile: 'normal'|'aggressive'|'tight'|null,
 *   notes: string[],
 *   gateApplied: object|null,
 *   shadowMode: boolean,                      // true ise dispatch yok
 *   wouldDispatch: boolean,                   // shadow olmasa dispatch ederdi mi?
 * }}
 */
export function applyRegimeStrategy({
  regimeContext,
  votes = [],
  signalDraft = {},
  symbol = null,
  timeframe = null,
  marketType = null,
  htfConfidence = null,
  mtfAlignment = null,
} = {}) {
  const notes = [];
  const regime = regimeContext?.regime || 'unknown';
  const subRegime = regimeContext?.subRegime || null;

  // 1. computeRegime'in newPositionAllowed=false dediği durumlar — anında red
  if (regimeContext && regimeContext.newPositionAllowed === false) {
    const result = {
      rejected: true,
      rejectionReason: `rejim ${regime} yeni pozisyon kapali (computeRegime)`,
      decision: regime === 'high_vol_chaos' ? 'REJECT_CHAOS'
              : regime === 'low_vol_drift' ? 'REJECT_DRIFT'
              : regime === 'market_closed' ? 'REJECT_CLOSED'
              : 'REJECT_TRANSITION',
      adjustedVotes: votes,
      suppressedVotes: [],
      boostedVotes: [],
      slMultiplier: REGIME_SL_MULT[regime] ?? null,
      tpProfile: null,
      notes: [`computeRegime newPositionAllowed=false`],
      gateApplied: REGIME_GATES[regime] || null,
      shadowMode: isShadow(),
      wouldDispatch: false,
    };
    _logAndReturn(result, { regime, subRegime, signalDraft, symbol, timeframe, marketType, htfConfidence, mtfAlignment });
    return result;
  }

  // 2. BIST decoupled_stress alt-rejim özel kuralı
  if (subRegime === 'bist_decoupled_stress' && signalDraft.direction === 'long') {
    notes.push('bist_decoupled_stress + long → kesin red');
    const result = {
      rejected: true,
      rejectionReason: 'BIST decoupled_stress: long sinyal kesilir',
      decision: 'REJECT_BIST_LONG',
      adjustedVotes: votes,
      suppressedVotes: [],
      boostedVotes: [],
      slMultiplier: null,
      tpProfile: null,
      notes,
      gateApplied: REGIME_GATES[regime] || null,
      shadowMode: isShadow(),
      wouldDispatch: false,
    };
    _logAndReturn(result, { regime, subRegime, signalDraft, symbol, timeframe, marketType, htfConfidence, mtfAlignment });
    return result;
  }

  // 3. Vote suppression — rejim-aware ağırlıklandırma
  const { adjusted, suppressedKeys, boostedKeys } = suppressVotes(votes, regime);

  // 4. Gate kontrolü — REGIME_GATES tablosu
  const gateResult = checkGates({
    regime,
    draftGrade: signalDraft.grade,
    htfConfidence,
    mtfAlignment,
  });

  if (!gateResult.pass) {
    notes.push(`gate=${gateResult.decision}`);
  }

  // 5. SL multiplier + TP profile
  const slMultiplier = REGIME_SL_MULT[regime] ?? null;
  let tpProfile = 'normal';
  if (regime === 'ranging') tpProfile = 'tight';
  else if (regime === 'breakout_pending') tpProfile = 'aggressive';

  const wouldDispatch = gateResult.pass;
  const shadowMode = isShadow();

  const result = {
    rejected: !gateResult.pass,
    rejectionReason: gateResult.pass ? null : gateResult.decision,
    decision: gateResult.decision,
    adjustedVotes: adjusted,
    suppressedVotes: suppressedKeys,
    boostedVotes: boostedKeys,
    slMultiplier,
    tpProfile,
    notes,
    gateApplied: gateResult.gate,
    shadowMode,
    wouldDispatch,
  };

  _logAndReturn(result, { regime, subRegime, signalDraft, symbol, timeframe, marketType, htfConfidence, mtfAlignment });
  return result;
}

function _logAndReturn(result, ctx) {
  const record = {
    utcTimestamp: new Date().toISOString(),
    symbol: ctx.symbol,
    timeframe: ctx.timeframe ? String(ctx.timeframe) : null,
    marketType: ctx.marketType,
    regime: ctx.regime,
    subRegime: ctx.subRegime,
    originalGrade: ctx.signalDraft?.grade ?? null,
    direction: ctx.signalDraft?.direction ?? null,
    htfConfidence: ctx.htfConfidence,
    mtfAlignment: ctx.mtfAlignment,
    decision: result.decision,
    rejected: result.rejected,
    suppressedVotes: result.suppressedVotes,
    boostedVotes: result.boostedVotes,
    gateApplied: result.gateApplied,
    slMultiplier: result.slMultiplier,
    tpProfile: result.tpProfile,
    notes: result.notes,
    mode: getWrapperMode().mode,
    wouldDispatch: result.wouldDispatch,
  };
  logDecision(record);
}

export const __internals = {
  GRADE_RANK,
  gradeRank,
  logPathFor,
};
