/**
 * Core replay mode logic.
 */
import { evaluate, withWriteLock, getReplayApi } from '../connection.js';

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

// All replay control functions hold the write mutex for their entire
// sequence — replay state is a single-machine state machine, and
// interleaving two clients' start/step/autoplay/stop/trade calls would
// corrupt the playback session (and possibly the chart itself, per the
// "Data point unavailable" toast handling in start()).

export async function start({ date } = {}) {
  const rp = await getReplayApi();
  return withWriteLock(async (evalInside) => {
    const available = await evalInside(wv(`${rp}.isReplayAvailable()`));
    if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

    await evalInside(`${rp}.showReplayToolbar()`);
    await new Promise(r => setTimeout(r, 500));

    if (date) await evalInside(`${rp}.selectDate(new Date('${date}'))`);
    else await evalInside(`${rp}.selectFirstAvailableDate()`);
    await new Promise(r => setTimeout(r, 1000));

    const toast = await evalInside(`
      (function() {
        var toasts = document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="banner"]');
        for (var i = 0; i < toasts.length; i++) {
          var text = toasts[i].textContent || '';
          if (/data point unavailable|not available for playback/i.test(text)) return text.trim().substring(0, 200);
        }
        return null;
      })()
    `);

    if (toast) {
      try { await evalInside(`${rp}.stopReplay()`); } catch {}
      try { await evalInside(`${rp}.hideReplayToolbar()`); } catch {}
      throw new Error(`Replay date unavailable: "${toast}". The requested date has no data for this timeframe. Try a more recent date or switch to a higher timeframe (e.g., Daily).`);
    }

    const started = await evalInside(wv(`${rp}.isReplayStarted()`));
    const currentDate = await evalInside(wv(`${rp}.currentDate()`));
    return { success: true, replay_started: !!started, date: date || '(first available)', current_date: currentDate };
  });
}

export async function step() {
  const rp = await getReplayApi();
  return withWriteLock(async (evalInside) => {
    const started = await evalInside(wv(`${rp}.isReplayStarted()`));
    if (!started) throw new Error('Replay is not started. Use replay_start first.');
    await evalInside(`${rp}.doStep()`);
    const currentDate = await evalInside(wv(`${rp}.currentDate()`));
    return { success: true, action: 'step', current_date: currentDate };
  });
}

export async function autoplay({ speed } = {}) {
  const rp = await getReplayApi();
  return withWriteLock(async (evalInside) => {
    const started = await evalInside(wv(`${rp}.isReplayStarted()`));
    if (!started) throw new Error('Replay is not started. Use replay_start first.');
    if (speed > 0) await evalInside(`${rp}.changeAutoplayDelay(${speed})`);
    await evalInside(`${rp}.toggleAutoplay()`);
    const isAutoplay = await evalInside(wv(`${rp}.isAutoplayStarted()`));
    const currentDelay = await evalInside(wv(`${rp}.autoplayDelay()`));
    return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
  });
}

export async function stop() {
  const rp = await getReplayApi();
  return withWriteLock(async (evalInside) => {
    const started = await evalInside(wv(`${rp}.isReplayStarted()`));
    if (!started) {
      try { await evalInside(`${rp}.hideReplayToolbar()`); } catch {}
      return { success: true, action: 'already_stopped' };
    }
    await evalInside(`${rp}.stopReplay()`);
    try { await evalInside(`${rp}.hideReplayToolbar()`); } catch {}
    return { success: true, action: 'replay_stopped' };
  });
}

export async function trade({ action }) {
  const rp = await getReplayApi();
  return withWriteLock(async (evalInside) => {
    const started = await evalInside(wv(`${rp}.isReplayStarted()`));
    if (!started) throw new Error('Replay is not started. Use replay_start first.');

    if (action === 'buy') await evalInside(`${rp}.buy()`);
    else if (action === 'sell') await evalInside(`${rp}.sell()`);
    else if (action === 'close') await evalInside(`${rp}.closePosition()`);
    else throw new Error('Invalid action. Use: buy, sell, or close');

    const position = await evalInside(wv(`${rp}.position()`));
    const pnl = await evalInside(wv(`${rp}.realizedPL()`));
    return { success: true, action, position, realized_pnl: pnl };
  });
}

export async function status() {
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
