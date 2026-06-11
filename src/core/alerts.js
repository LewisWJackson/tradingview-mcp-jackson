/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// The TV Desktop alert dialog carries no stable data-name or "alert" class — its
// container is `dialog-<hash>` and the locale changes every button's text (Korean:
// 얼러트 만들기 / 생성). The one stable anchor across versions/locales is the submit
// button (`button[type="submit"][class*="submitBtn"]`); we locate the dialog as its
// nearest dialog ancestor and scope every field query to that, so nothing depends on
// the unstable hash or on English labels.
const DIALOG_FROM_SUBMIT = `
  (function() {
    var sub = document.querySelector('button[type="submit"][class*="submitBtn"]');
    return sub ? sub.closest('[class*="dialog"]') : null;
  })`;

export async function create({ condition, price, message }) {
  // 1. Open the alert dialog. Header button id is stable; aria-label is localized
  //    (Korean "얼러트 만들기"), so match it loosely. Alt+A stays as last resort.
  const opened = await evaluate(`
    (function() {
      var btn = document.getElementById('header-toolbar-alerts')
        || document.querySelector('[aria-label*="얼러트"], [aria-label*="Alert"], [aria-label*="alert"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  // Poll for the dialog instead of a fixed sleep — it can take a beat to mount.
  let dialogReady = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 150));
    dialogReady = await evaluate(`!!${DIALOG_FROM_SUBMIT}()`);
    if (dialogReady) break;
  }
  if (!dialogReady) {
    return { success: false, price, condition, message: message || '(none)', price_set: false, error: 'alert dialog did not open', source: 'dom' };
  }

  // 2. Set the price. The value field is the dialog's text input (TV pre-fills it
  //    with the current price). It is a controlled numeric widget: a native value
  //    setter updates the DOM but NOT TV's model (the alert submits with the stale
  //    pre-filled price — verified against list_alerts). The model only commits on
  //    real keystrokes followed by a blur. So focus+select the field, type the
  //    digits through CDP (real key events), then Tab to commit before submitting.
  const client = await getClient();
  const focused = await evaluate(`
    (function() {
      var dlg = ${DIALOG_FROM_SUBMIT}();
      if (!dlg) return false;
      var input = dlg.querySelector('input[type="text"]');
      if (!input) return false;
      input.focus();
      input.select();
      return document.activeElement === input;
    })()
  `);
  if (focused) {
    await client.Input.insertText({ text: String(price) });
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await new Promise(r => setTimeout(r, 200));
  }
  // Verify against the committed value (the input reformats to the model value after
  // the blur), not the raw DOM write that the old code trusted.
  const priceSet = await evaluate(`
    (function() {
      var dlg = ${DIALOG_FROM_SUBMIT}();
      if (!dlg) return false;
      var input = dlg.querySelector('input[type="text"]');
      if (!input) return false;
      return String(input.value).replace(/[^0-9.]/g, '') === String(${price}).replace(/[^0-9.]/g, '');
    })()
  `);

  // 3. Custom message: intentionally NOT set. TV renders the message field as a
  //    collapsed section; expanding it to type a custom message reflows the dialog
  //    and CLEARS the committed price, so the alert then submits with an empty price
  //    and is silently dropped server-side. Until that reflow is solved (e.g. set the
  //    message BEFORE the price, or re-commit the price after expanding), we leave the
  //    message alone — TV auto-fills a sensible "<symbol> <condition> <price>" default,
  //    which is reliable. `message` is still accepted for API compatibility.
  const messageSet = false;

  // 4. Submit via the stable submit button (text is localized — don't match on it).
  await new Promise(r => setTimeout(r, 400));
  const created = await evaluate(`
    (function() {
      var btn = document.querySelector('button[type="submit"][class*="submitBtn"]');
      if (btn && !btn.disabled) { btn.click(); return true; }
      return false;
    })()
  `);

  return {
    success: !!created && !!priceSet,
    price,
    condition,
    message: message || '(none)',
    price_set: !!priceSet,
    message_set: !!messageSet,
    submitted: !!created,
    source: 'dom',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
