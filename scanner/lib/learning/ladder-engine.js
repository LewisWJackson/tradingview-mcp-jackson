/**
 * Ladder Engine — per-symbol, per-grade üç-liga state makinesi.
 *
 * Ligler: 'real' (GERCEK), 'ara' (ARA), 'virtual' (SANAL).
 *
 * 2026-04-23: A ve B gradeler de ladder'a dahil. TF'ler buyudugu icin sinyal
 * seyrekleti; A/B nin da symbol bazli kalite takibi yapiliyor.
 *
 * Grade -> league mapping:
 *   A, B  -> varsayilan 'real'. 3 loss streak ile ARA/SANAL'a dusebilir;
 *           3 win streak + WR ile geri cikar.
 *   C     -> varsayilan 'ara'. SANAL'a dusebilir, GERCEK'e cikabilir (2 streak).
 *   BEKLE -> varsayilan 'virtual'. ARA'ya/GERCEK'e cikabilir, geri dusebilir.
 *
 * Outcome sinifi:
 *   win  = TP1/TP2/TP3 hit, trailing_stop_exit
 *   loss = SL hit
 *   netr = entry_expired / superseded* / manual_close / reverse_close / invalid_data /
 *          sl_hit_high_mfe → streak ve pencere ETKILENMEZ.
 *
 * Geçis kurallari:
 *   Promotion (lig yukselme):
 *     A/B:   SANAL   --3 win streak + WR>=%30--> ARA
 *     A/B:   ARA     --3 win streak + WR>=%40--> GERCEK
 *     C:     ARA     --2 win streak + WR>=%40--> GERCEK
 *     BEKLE: SANAL   --3 win streak + WR>=%30--> ARA
 *     BEKLE: ARA     --3 win streak + WR>=%40--> GERCEK
 *   Demotion (lig düsme) — WR esigi YOK, sadece streak:
 *     A/B:   GERCEK  --3 loss streak--> ARA
 *     A/B:   ARA     --3 loss streak--> SANAL
 *     C:     GERCEK  --2 loss streak--> ARA
 *     C:     ARA     --2 loss streak--> SANAL
 *     BEKLE: GERCEK  --2 loss streak--> ARA
 *     BEKLE: ARA     --2 loss streak--> SANAL
 *
 * Cooldown: her tier geçisi sonrasi 3 yeni resolved sinyal (per symbol+grade)
 * gelmeden yeni geçis tetiklenmez. Whipsaw'a karsi.
 *
 * Sliding WR penceresi: her (symbol, grade) için son 10 kapanmis outcome
 * (sadece win/loss, netr'ler pencereye girmez) tutulur. WR = win / toplam * 100.
 *
 * Learning hook: her transition `transitionListeners` uzerinden yayilir;
 * learning-loop.js bu event'i WS'e broadcast eder ve kalite istatistiklerine isler.
 */

import { readJSON, writeJSON, dataPath } from './persistence.js';

const LADDER_PATH = dataPath('ladder.json');

const TIERS = /** @type {const} */ (['real', 'ara', 'virtual']);
const WINDOW_SIZE = 10;
const COOLDOWN_N = 3;
const TRANSITIONS_KEEP = 200;

// Grade -> rule set. { promote: { fromTier → { streakNeeded, minWR } }, demote: { fromTier → streakNeeded } }
const RULES = {
  A: {
    defaultTier: 'real',
    promote: {
      virtual: { to: 'ara',  streak: 3, minWR: 30 },
      ara:     { to: 'real', streak: 3, minWR: 40 },
    },
    demote: {
      real:    { to: 'ara',     streak: 3 },
      ara:     { to: 'virtual', streak: 3 },
    },
  },
  B: {
    defaultTier: 'real',
    promote: {
      virtual: { to: 'ara',  streak: 3, minWR: 30 },
      ara:     { to: 'real', streak: 3, minWR: 40 },
    },
    demote: {
      real:    { to: 'ara',     streak: 3 },
      ara:     { to: 'virtual', streak: 3 },
    },
  },
  C: {
    defaultTier: 'ara',
    promote: {
      ara:     { to: 'real', streak: 2, minWR: 40 },
    },
    demote: {
      real:    { to: 'ara',     streak: 2 },
      ara:     { to: 'virtual', streak: 2 },
    },
  },
  BEKLE: {
    defaultTier: 'virtual',
    promote: {
      virtual: { to: 'ara',  streak: 3, minWR: 30 },
      ara:     { to: 'real', streak: 3, minWR: 40 },
    },
    demote: {
      real:    { to: 'ara',     streak: 2 },
      ara:     { to: 'virtual', streak: 2 },
    },
  },
};

// Transition listeners — learning-loop, analytics, WS broadcast bunlara baglanir.
const transitionListeners = [];

/**
 * Transition event subscriber kaydi. Gelen event formati:
 * { symbol, grade, from, to, kind: 'promote'|'demote', streak, windowWR,
 *   triggeredBy, signalId, at }
 */
export function onTransition(callback) {
  if (typeof callback === 'function') transitionListeners.push(callback);
  return () => {
    const idx = transitionListeners.indexOf(callback);
    if (idx >= 0) transitionListeners.splice(idx, 1);
  };
}

function emitTransition(event) {
  for (const cb of transitionListeners) {
    try { cb(event); } catch (e) { console.log(`[Ladder] transition listener hata: ${e.message}`); }
  }
}

function defaultState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {},      // { [symbol]: { [grade]: Entry } }
    transitions: [],  // append-only (son N)
  };
}

function defaultEntry(grade, when = new Date().toISOString()) {
  const rule = RULES[grade];
  return {
    tier: rule ? rule.defaultTier : 'real',
    winStreak: 0,
    lossStreak: 0,
    resolvedCount: 0,          // toplam win+loss (netrler sayilmaz)
    recentOutcomes: [],        // son WINDOW_SIZE 'w'|'l' — surasiyla
    lastOutcomeAt: null,
    lastTransitionAt: when,
    cooldownUntilCount: 0,     // resolvedCount bu degeri asana dek gecis yok
  };
}

/**
 * Current ladder state'i oku.
 */
export function loadLadder() {
  return readJSON(LADDER_PATH, defaultState());
}

/**
 * Ladder state'i diske yaz. Caller updatedAt guncellemeli.
 */
export function saveLadder(state) {
  state.updatedAt = new Date().toISOString();
  writeJSON(LADDER_PATH, state);
}

function ensureEntry(state, symbol, grade) {
  if (!RULES[grade]) return null;       // A/B veya IPTAL/HATA — ladder dısı
  if (!state.entries[symbol]) state.entries[symbol] = {};
  if (!state.entries[symbol][grade]) {
    state.entries[symbol][grade] = defaultEntry(grade);
  }
  return state.entries[symbol][grade];
}

function windowWR(entry) {
  const n = entry.recentOutcomes.length;
  if (n === 0) return 0;
  const wins = entry.recentOutcomes.filter(o => o === 'w').length;
  return Math.round((wins / n) * 10000) / 100;
}

/**
 * Bir (symbol, grade) için mevcut ligi dondur. A/B icin her zaman 'real'.
 * State dosyasini modifiye etmez; eger entry yoksa in-memory default uretir.
 */
export function resolveLeague(symbol, grade) {
  if (!RULES[grade]) return 'real';     // A, B
  const state = loadLadder();
  const entry = state.entries[symbol]?.[grade];
  if (!entry) return RULES[grade].defaultTier;
  return entry.tier;
}

/**
 * Bir (symbol, grade) entry bilgisini dondur (ui/api icin).
 */
export function getEntrySnapshot(symbol, grade) {
  if (!RULES[grade]) return { tier: 'real', reason: 'grade_always_real' };
  const state = loadLadder();
  const entry = state.entries[symbol]?.[grade];
  if (!entry) return { tier: RULES[grade].defaultTier, defaulted: true };
  return {
    ...entry,
    windowWR: windowWR(entry),
    windowSize: entry.recentOutcomes.length,
  };
}

/**
 * Internal: bir entry'ye outcome uygula ve olasi gecisi dondur. State'i mutate eder.
 * Caller save ve transition log'dan sorumlu.
 */
function applyOutcome(entry, outcomeClass /* 'win' | 'loss' | 'neutral' */, whenISO) {
  if (outcomeClass === 'neutral') {
    entry.lastOutcomeAt = whenISO;
    return { transitioned: false };
  }

  // Win/loss: streak ve pencere guncelle
  if (outcomeClass === 'win') {
    entry.winStreak = (entry.winStreak || 0) + 1;
    entry.lossStreak = 0;
  } else {
    entry.lossStreak = (entry.lossStreak || 0) + 1;
    entry.winStreak = 0;
  }
  entry.resolvedCount = (entry.resolvedCount || 0) + 1;
  const tag = outcomeClass === 'win' ? 'w' : 'l';
  entry.recentOutcomes = [...(entry.recentOutcomes || []), tag].slice(-WINDOW_SIZE);
  entry.lastOutcomeAt = whenISO;

  return { transitioned: false, readyToCheck: true };
}

function evaluateTransition(entry, grade) {
  const rule = RULES[grade];
  if (!rule) return null;
  const curTier = entry.tier;

  // Cooldown: yeterli resolved sinyal gecmedi mi?
  if (entry.cooldownUntilCount && entry.resolvedCount < entry.cooldownUntilCount) {
    return null;
  }

  // Demotion once kontrol — "WR esigi saglansa bile 2 SL lig dusurur"
  const demote = rule.demote?.[curTier];
  if (demote && entry.lossStreak >= demote.streak) {
    return { to: demote.to, kind: 'demote', streak: entry.lossStreak, wr: windowWR(entry) };
  }

  // Promotion
  const promote = rule.promote?.[curTier];
  if (promote && entry.winStreak >= promote.streak) {
    const wr = windowWR(entry);
    if (wr >= (promote.minWR || 0)) {
      return { to: promote.to, kind: 'promote', streak: entry.winStreak, wr };
    }
  }

  return null;
}

function applyTransition(entry, transition, whenISO) {
  const fromTier = entry.tier;
  entry.tier = transition.to;
  entry.winStreak = 0;
  entry.lossStreak = 0;
  entry.lastTransitionAt = whenISO;
  entry.cooldownUntilCount = entry.resolvedCount + COOLDOWN_N;
  return { from: fromTier, to: transition.to, kind: transition.kind, streak: transition.streak, wr: transition.wr };
}

/**
 * Bir kapanan sinyal icin ladder state'ini guncelle.
 * outcome parametresi signal arsiv kaydindan cikarilir:
 *   { status: 'tp1_hit'|'tp2_hit'|'tp3_hit'|'sl_hit'|'entry_expired'|'superseded*'|'manual_close'|'reverse_close'|'invalid_data', resolvedAt?: ISO }
 * Donus: { changed: bool, transition?: { from, to, kind, ... } }
 */
export function recordOutcome(symbol, grade, outcome) {
  if (!RULES[grade]) return { changed: false, skipped: 'grade_always_real' };
  if (!symbol) return { changed: false, skipped: 'no_symbol' };

  const cls = classifyOutcome(outcome?.status);
  const whenISO = outcome?.resolvedAt || new Date().toISOString();

  const state = loadLadder();
  const entry = ensureEntry(state, symbol, grade);
  if (!entry) return { changed: false };

  const applied = applyOutcome(entry, cls, whenISO);
  let transitionEvent = null;
  let persistedEvent = null;
  if (applied.readyToCheck) {
    const t = evaluateTransition(entry, grade);
    if (t) {
      transitionEvent = applyTransition(entry, t, whenISO);
      persistedEvent = {
        at: whenISO,
        symbol,
        grade,
        from: transitionEvent.from,
        to: transitionEvent.to,
        kind: transitionEvent.kind,
        streak: transitionEvent.streak,
        windowWR: transitionEvent.wr,
        triggeredBy: outcome?.status,
        signalId: outcome?.signalId,
      };
      state.transitions.push(persistedEvent);
      if (state.transitions.length > TRANSITIONS_KEEP) {
        state.transitions = state.transitions.slice(-TRANSITIONS_KEEP);
      }
    }
  }

  saveLadder(state);

  // Learning/UI hook — state kaydedildikten sonra listener'lara yay.
  if (persistedEvent) emitTransition(persistedEvent);

  return { changed: true, transition: transitionEvent, outcomeClass: cls };
}

/**
 * Status string'i outcome sinifina cevir.
 * Netr = entry_expired, superseded*, manual_close, reverse_close, invalid_data,
 *        sl_hit_high_mfe (yon dogru ama TP'ye ulasmadi — ladder'da haksiz
 *        demote'u onlemek icin loss sayilmaz).
 */
export function classifyOutcome(status) {
  if (!status) return 'neutral';
  if (status === 'sl_hit') return 'loss';
  if (status === 'tp1_hit' || status === 'tp2_hit' || status === 'tp3_hit') return 'win';
  if (status === 'trailing_stop_exit') return 'win';
  return 'neutral';
}

/**
 * Ladder'i arsivden yeniden hesapla. Tum (symbol, grade=C|BEKLE) sinyalleri
 * resolvedAt'e gore siraya koyup sirayla recordOutcome uygulanir. Sonuc: final
 * state. Isim karmasasi yaratmamak icin dogrudan state olusturur, loadLadder
 * cagrisi yapmaz.
 *
 * signals: arsivden gelen sinyaller (readAllArchives() ciktisi).
 */
export function rebuildFromArchive(signals) {
  const state = defaultState();
  const relevant = (signals || [])
    .filter(s => s && s.symbol && RULES[s.grade])
    .filter(s => s.status && s.resolvedAt)
    .filter(s => {
      const cls = classifyOutcome(s.status);
      return cls === 'win' || cls === 'loss';  // netr'ler ladder'i etkilemez
    })
    .sort((a, b) => new Date(a.resolvedAt) - new Date(b.resolvedAt));

  for (const s of relevant) {
    const entry = ensureEntry(state, s.symbol, s.grade);
    if (!entry) continue;

    const cls = classifyOutcome(s.status);
    applyOutcome(entry, cls, s.resolvedAt);
    const t = evaluateTransition(entry, s.grade);
    if (t) {
      const event = applyTransition(entry, t, s.resolvedAt);
      state.transitions.push({
        at: s.resolvedAt,
        symbol: s.symbol,
        grade: s.grade,
        from: event.from,
        to: event.to,
        kind: event.kind,
        streak: event.streak,
        windowWR: event.wr,
        triggeredBy: s.status,
        signalId: s.id,
        backfill: true,
      });
    }
  }

  if (state.transitions.length > TRANSITIONS_KEEP) {
    state.transitions = state.transitions.slice(-TRANSITIONS_KEEP);
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

/**
 * Mevcut arsivden state hesaplayip diske yaz. CLI/admin kullanimi.
 */
export function rebuildAndPersist(signals) {
  const fresh = rebuildFromArchive(signals);
  writeJSON(LADDER_PATH, fresh);
  return fresh;
}

/**
 * Audit log'dan son N gecis donus.
 */
export function getRecentTransitions(limit = 50) {
  const state = loadLadder();
  const list = state.transitions || [];
  return list.slice(-limit).reverse();
}

/**
 * Flat ozet: her (symbol, grade) icin tier + stats. API icin.
 */
export function getLadderSummary() {
  const state = loadLadder();
  const rows = [];
  for (const [symbol, grades] of Object.entries(state.entries || {})) {
    for (const [grade, entry] of Object.entries(grades)) {
      rows.push({
        symbol,
        grade,
        tier: entry.tier,
        winStreak: entry.winStreak,
        lossStreak: entry.lossStreak,
        resolvedCount: entry.resolvedCount,
        windowWR: windowWR(entry),
        windowSize: entry.recentOutcomes.length,
        cooldownRemaining: Math.max(0, (entry.cooldownUntilCount || 0) - (entry.resolvedCount || 0)),
        lastOutcomeAt: entry.lastOutcomeAt,
        lastTransitionAt: entry.lastTransitionAt,
      });
    }
  }
  // Ligdeki buyuklukte, ardindan son outcome tarihine gore sirala
  const order = { real: 0, ara: 1, virtual: 2 };
  rows.sort((a, b) => (order[a.tier] - order[b.tier]) || (b.lastOutcomeAt || '').localeCompare(a.lastOutcomeAt || ''));
  return { updatedAt: state.updatedAt, rows };
}

export const LADDER_CONSTANTS = {
  TIERS,
  RULES,
  WINDOW_SIZE,
  COOLDOWN_N,
};
