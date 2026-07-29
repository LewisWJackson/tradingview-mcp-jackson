/**
 * Core replay mode logic.
 */
import { evaluate, getReplayApi } from '../connection.js';

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

export async function start({ date } = {}) {
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  await evaluate(`${rp}.showReplayToolbar()`);
  await new Promise(r => setTimeout(r, 500));

  if (date) await evaluate(`${rp}.selectDate(new Date('${date}'))`);
  else await evaluate(`${rp}.selectFirstAvailableDate()`);
  await new Promise(r => setTimeout(r, 1000));

  // Check for "Data point unavailable" toast which corrupts the chart
  const toast = await evaluate(`
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
    // Stop replay to recover chart
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    try { await evaluate(`${rp}.hideReplayToolbar()`); } catch {}
    throw new Error(`Replay date unavailable: "${toast}". The requested date has no data for this timeframe. Try a more recent date or switch to a higher timeframe (e.g., Daily).`);
  }

  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  const currentDate = await evaluate(wv(`${rp}.currentDate()`));
  return { success: true, replay_started: !!started, date: date || '(first available)', current_date: currentDate };
}

export async function step() {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  await evaluate(`${rp}.doStep()`);
  const currentDate = await evaluate(wv(`${rp}.currentDate()`));
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed } = {}) {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

/**
 * stopReplay() opens a "Leave current replay?" confirmation and does nothing
 * until it is answered, so it cannot be trusted on its own. Dismiss the dialog
 * (declining the "Save this replay" checkbox, which is ticked by default) and
 * report whether it actually went away.
 */
async function dismissLeaveReplayDialog() {
  return evaluate(`
    (function() {
      var dialog = document.querySelector('[data-name="replay-exit-confirm"], [class*="dialog"]');
      if (!dialog || !/leave current replay/i.test(dialog.textContent || '')) return 'no_dialog';
      var save = dialog.querySelector('input[type="checkbox"]');
      if (save && save.checked) save.click();
      var buttons = dialog.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        if (/^\\s*leave\\s*$/i.test(buttons[i].textContent || '')) { buttons[i].click(); return 'confirmed'; }
      }
      return 'dialog_without_leave_button';
    })()
  `);
}

/**
 * Is any pane actually in replay?
 *
 * Neither of the obvious signals can be trusted. `isReplayStarted()` stays true
 * after replay has genuinely ended, and `replaySessionState()` lingers as a
 * saved session descriptor on charts that are demonstrably live. Per-pane
 * `model().isInReplay()` is the one that tracks reality.
 */
async function anyPaneInReplay() {
  return evaluate(`
    (function () {
      try {
        var widgets = window.TradingViewApi._chartWidgetCollection.getAll();
        for (var i = 0; i < widgets.length; i++) {
          try {
            var v = widgets[i].model().isInReplay();
            if (v && typeof v.value === 'function' ? v.value() : v) return true;
          } catch (e) { /* skip this pane */ }
        }
        return false;
      } catch (e) { return false; }
    })()
  `);
}

/** Last resort: drop each chart model back to realtime directly, no dialog. */
async function forceModelsToRealtime() {
  return evaluate(`
    (function() {
      try {
        var widgets = window.TradingViewApi._chartWidgetCollection.getAll();
        var switched = 0;
        for (var i = 0; i < widgets.length; i++) {
          try {
            var m = widgets[i].model();
            if (typeof m.switchToRealtime === 'function') { m.switchToRealtime(); switched++; }
          } catch (e) { /* skip this pane */ }
        }
        return switched;
      } catch (e) { return 0; }
    })()
  `);
}

export async function stop() {
  const rp = await getReplayApi();
  if (!(await anyPaneInReplay())) {
    // Try to hide toolbar even if not started
    try { await evaluate(`${rp}.hideReplayToolbar()`); } catch {}
    return { success: true, action: 'already_stopped' };
  }

  await evaluate(`${rp}.stopReplay()`);
  await new Promise(r => setTimeout(r, 500));
  const dialog = await dismissLeaveReplayDialog();
  await new Promise(r => setTimeout(r, 500));

  try { await evaluate(`${rp}.goToRealtime()`); } catch { /* ignore */ }

  let stillRunning = await anyPaneInReplay();
  let forced = 0;
  if (stillRunning) {
    // Leaving a chart parked in replay makes every symbol read "doesn't
    // exist", so fall back rather than reporting a stop that didn't happen.
    forced = await forceModelsToRealtime();
    await new Promise(r => setTimeout(r, 1000));
    stillRunning = await anyPaneInReplay();
  }

  try { await evaluate(`${rp}.hideReplayToolbar()`); } catch { /* ignore */ }

  return {
    success: !stillRunning,
    action: stillRunning ? 'replay_stop_failed' : 'replay_stopped',
    confirm_dialog: dialog,
    panes_forced_to_realtime: forced,
    ...(stillRunning && {
      warning: 'Replay is still active. The chart may show "This symbol doesn\'t exist" until it exits replay — dismiss the "Leave current replay?" dialog on the chart.',
    }),
  };
}

export async function trade({ action }) {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
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
