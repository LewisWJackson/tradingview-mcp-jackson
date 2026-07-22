/*
 * pharm-alert-sync.js — browser-injected helper for TradingView native price alerts.
 *
 * This is NOT a node script. Its entire contents are meant to be passed as the
 * `expression` argument to the tradingview MCP tool `ui_evaluate`, which eval's it
 * inside the live TradingView Desktop page. Doing so defines a set of window.__pharm*
 * helpers that create/delete the "early-warning" price alerts described in
 * pharm-setups.json. The live monitor (pharm-monitor.js) remains the confirmation layer.
 *
 * It ONLY ever touches alerts whose message begins with the "[PHARM]" tag, so alerts
 * you created by hand are never deleted.
 *
 * Why the odd ordering inside makeAlert (message first, price last + Enter):
 *   - The alert dialog's price field silently reverts to the live market price whenever
 *     the "Edit message" sub-panel closes. So the price MUST be set after the message,
 *     as the final step.
 *   - Setting the price with the native input setter alone does not "commit" it; pressing
 *     Enter both commits the typed price AND submits the dialog at that exact value.
 *   - Replay mode must be OFF first. If the replay toolbar is open, creating an alert pops
 *     a "Leave current replay?" dialog instead of the alert dialog. The skill exits replay
 *     before injecting this file.
 *
 * Typical use from the /pharm skill (via ui_evaluate):
 *   1. inject this file's contents  -> defines the helpers
 *   2. window.__pharmSync(setupsObj, lastPrice) and poll window.__pharmSyncResult
 *
 * Verify the outcome with the MCP tool `alert_list` (the source of truth) — never trust
 * these return values alone.
 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const om = () => document.getElementById('overlap-manager-root');
  const findDlg = () =>
    Array.from(om().children).find((c) => c.textContent.includes('Create alert on'));
  const findMsgPanel = () =>
    Array.from(om().children).find((c) => c.textContent.includes('Edit message'));
  const findConfirm = () =>
    Array.from(om().children).find((c) => c.textContent.includes('Delete this alert'));

  // Fire a full, framework-friendly click sequence on an element.
  const fire = (el, types) => {
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    types.forEach((t) => {
      const E = t.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(
        new E(t, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: cx,
          clientY: cy,
          button: 0,
          buttons: t.endsWith('up') || t === 'click' ? 0 : 1,
          pointerId: 1,
          isPrimary: true,
        })
      );
    });
  };
  const CLICK = ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];

  // Set a controlled (React) input/textarea value so the framework registers it.
  const setNative = (el, val, proto) => {
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const numOf = (s) => parseFloat(String(s).replace(/[^0-9.]/g, ''));

  // ---- Public: choose the zone edge price will reach first from where it trades now.
  // zone = [low, high]. Above the zone -> touches the high first. Below -> the low first.
  // A single-price "zone" ([x, x]) returns x.
  window.__pharmEdge = (zone, last) => {
    const lo = Math.min(zone[0], zone[1]);
    const hi = Math.max(zone[0], zone[1]);
    if (lo === hi) return lo;
    if (last >= hi) return hi;
    if (last <= lo) return lo;
    return Math.abs(last - hi) <= Math.abs(last - lo) ? hi : lo; // inside: nearest edge
  };

  // ---- Public: build the phone-alert message from a setup + the risk defaults block.
  window.__pharmMsg = (setup, riskDefaults) => {
    const rd = riskDefaults || {};
    const maxR = setup.max_risk_R != null ? setup.max_risk_R : rd.max_risk_R;
    const adds = setup.max_adds != null ? setup.max_adds : rd.max_adds;
    const lo = Math.min(setup.zone[0], setup.zone[1]);
    const hi = Math.max(setup.zone[0], setup.zone[1]);
    const where = lo === hi ? `level ${lo} reached` : `zone ${lo}-${hi} reached`;
    const dir = (setup.dir || '').toUpperCase();
    const rating = setup.rating ? `, rating ${setup.rating}` : '';
    const t1 = setup.targets && setup.targets.length ? `T1 ${setup.targets[0]}` : 'no target';
    const inv = setup.invalidation != null ? `invalidation ${setup.invalidation}` : 'no invalidation given';
    const addWord = adds === 1 ? 'add' : 'adds';
    const tight = setup.max_risk_R != null && rd.max_risk_R != null && setup.max_risk_R < rd.max_risk_R
      ? ' (tight leash)'
      : '';
    return `[PHARM] ${dir} ${setup.type} — ${where}${rating}. ${t1}, ${inv}. ` +
      `Risk: max ${maxR}R total, ${adds} ${addWord}${tight}. Early warning — wait for monitor trigger confirmation.`;
  };

  // ---- Ensure the right-hand Alerts panel is open AND populated (needed for deletes).
  // On a freshly loaded page a single click doesn't reliably open/fill the panel, so we
  // retry the click and poll until alert rows actually appear (or give up cleanly, which
  // is correct when there are simply no [PHARM] alerts to delete).
  const anyAlertRows = () =>
    document.querySelectorAll('[class*="itemBody"]').length > 0;
  const openAlertsPanel = async () => {
    const btn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(
      (b) => (b.getAttribute('aria-label') || '') === 'Alerts' && b.getAttribute('data-name') === 'alerts'
    );
    if (!btn) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (btn.getAttribute('aria-pressed') !== 'true') fire(btn, CLICK);
      for (let i = 0; i < 16; i++) {
        if (anyAlertRows()) return;
        await sleep(150);
      }
      // panel may be open but empty (no alerts) — if it reports open, stop waiting
      if (btn.getAttribute('aria-pressed') === 'true') return;
    }
  };

  // ---- Public: delete every alert whose message starts with "[PHARM]". Others untouched.
  window.__pharmDeletePharm = async () => {
    await openAlertsPanel();
    let deleted = 0;
    for (let guard = 0; guard < 50; guard++) {
      const item = Array.from(document.querySelectorAll('[class*="itemBody"]')).find((el) =>
        el.textContent.includes('[PHARM]')
      );
      if (!item) break;
      let row = item;
      for (let up = 0; up < 6 && row; up++) {
        if (row.querySelector('[data-name="alert-delete-button"]')) break;
        row = row.parentElement;
      }
      const del = row && row.querySelector('[data-name="alert-delete-button"]');
      if (!del) break;
      fire(del, CLICK);
      for (let i = 0; i < 20 && !findConfirm(); i++) await sleep(100);
      const dlg = findConfirm();
      if (dlg) {
        const yes = Array.from(dlg.querySelectorAll('button')).find((b) => b.getAttribute('name') === 'yes');
        if (yes) fire(yes, CLICK);
        await sleep(400);
        deleted++;
      } else {
        break; // no confirmation appeared — stop rather than loop blindly
      }
    }
    return { deleted };
  };

  // ---- Public: create ONE alert. Message first, price last + Enter (see header note).
  window.__pharmMakeAlert = async ({ price, message }) => {
    if (!findDlg()) {
      const btn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(
        (b) => (b.getAttribute('aria-label') || '') === 'Create alert' && b.getBoundingClientRect().width > 50
      );
      if (!btn) return { err: 'no Create alert button' };
      fire(btn, CLICK);
      for (let i = 0; i < 25 && !findDlg(); i++) await sleep(150);
    }
    let dlg = findDlg();
    if (!dlg) return { err: 'alert dialog did not open (is replay mode off?)' };

    // message first
    const msgBtn = dlg.querySelector('[data-qa-id="alert-message-button"]');
    if (!msgBtn) return { err: 'no message button' };
    fire(msgBtn, CLICK);
    for (let i = 0; i < 25 && !findMsgPanel(); i++) await sleep(150);
    const panel = findMsgPanel();
    if (!panel) return { err: 'message panel did not open' };
    const ta = panel.querySelector('textarea');
    if (!ta) return { err: 'no message textarea' };
    setNative(ta, message, window.HTMLTextAreaElement.prototype);
    await sleep(150);
    const apply = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Apply');
    if (!apply) return { err: 'no Apply button' };
    fire(apply, CLICK);
    for (let i = 0; i < 25 && findMsgPanel(); i++) await sleep(150);
    await sleep(300);

    // price last — Enter commits the typed price AND submits at that value
    dlg = findDlg();
    if (!dlg) return { err: 'main dialog gone before price step' };
    const inp = dlg.querySelector('input[type="text"]');
    setNative(inp, String(price), window.HTMLInputElement.prototype);
    inp.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13, which: 13 }));
    inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', keyCode: 13, which: 13 }));
    await sleep(500);
    // fallback: if Enter did not submit, click Create explicitly
    if (findDlg()) {
      const shown = findDlg().querySelector('input[type="text"]').value;
      if (numOf(shown) !== numOf(price)) return { err: 'price did not hold', wanted: price, got: shown };
      const create = Array.from(findDlg().querySelectorAll('button')).find((b) => b.textContent.trim() === 'Create');
      if (create) {
        fire(create, CLICK);
        for (let i = 0; i < 25 && findDlg(); i++) await sleep(150);
      }
    }
    return { ok: true, dialogClosed: !findDlg() };
  };

  // ---- Public: full idempotent refresh. Deletes prior [PHARM] alerts, then creates one
  // per setup at its first-reached edge. Poll window.__pharmSyncResult for the outcome.
  window.__pharmSync = async (setupsObj, lastPrice) => {
    window.__pharmSyncResult = 'running';
    try {
      const del = await window.__pharmDeletePharm();
      const risk = setupsObj.risk || {};
      const made = [];
      for (const s of setupsObj.setups) {
        const price = window.__pharmEdge(s.zone, lastPrice);
        const message = window.__pharmMsg(s, risk);
        const res = await window.__pharmMakeAlert({ price, message });
        made.push({ id: s.id, price, ok: !!res.ok, err: res.err || null });
        await sleep(400);
      }
      window.__pharmSyncResult = { deleted: del.deleted, created: made };
    } catch (e) {
      window.__pharmSyncResult = { err: String(e) };
    }
    return 'started';
  };

  return 'pharm-alert-sync helpers defined';
})();
