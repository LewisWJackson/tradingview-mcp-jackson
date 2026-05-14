/**
 * REST helpers for TradingView's symbols_list API.
 *
 * The REST API is auth'd via TV's HttpOnly session cookies, so all calls are
 * proxied through the TV renderer via CDP `evaluateAsync` (which awaits the
 * Promise natively).
 *
 * Endpoints (all under `https://www.tradingview.com/api/v1/symbols_list/custom/`):
 *   GET  /             → array of all watchlists with id/name/symbols/active/modified
 *   GET  /{id}/         → full list state
 *   POST /{id}/append/  → body raw [symbols], appends
 *   POST /{id}/remove/  → body raw [symbols], removes (exact match incl. ###HEADERS)
 *   POST /{id}/replace/ → body raw [symbols], reorders only (server rejects add/remove)
 *
 * Discovered live 2026-05-13. Note: POST body must be a raw JSON array, not
 * `{symbols: [...]}` — server returns 422 ListOfSymbols serializer error otherwise.
 */
import { evaluateAsync } from '../connection.js';

const BASE = 'https://www.tradingview.com/api/v1/symbols_list/custom';

function fetchJson(expr) {
  // Wrap a fetch() expression so CDP awaits the promise and returns parsed JSON
  // (or text body on non-2xx, with status for caller to branch on).
  return evaluateAsync(`
    (async () => {
      try {
        const r = await ${expr};
        const ct = r.headers.get('content-type') || '';
        const body = ct.includes('json') ? await r.json() : await r.text();
        return { status: r.status, ok: r.ok, body };
      } catch (e) { return { status: 0, ok: false, body: String(e) }; }
    })()
  `);
}

export async function listAll() {
  const res = await fetchJson(`fetch('${BASE}/', { credentials: 'include' })`);
  if (!res.ok) throw new Error(`listAll: HTTP ${res.status} ${typeof res.body === 'string' ? res.body.slice(0,200) : ''}`);
  return res.body;
}

export async function getList(id) {
  const res = await fetchJson(`fetch('${BASE}/${id}/', { credentials: 'include' })`);
  if (!res.ok) throw new Error(`getList(${id}): HTTP ${res.status}`);
  return res.body;
}

async function postJson(subpath, id, payload) {
  const bodyJson = JSON.stringify(payload).replace(/'/g, "\\'");
  const expr = `fetch('${BASE}/${id}/${subpath}/', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '${bodyJson}'
  })`;
  return fetchJson(expr);
}

export async function append(id, symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('append: symbols must be a non-empty array');
  }
  const res = await postJson('append', id, symbols);
  if (!res.ok) throw new Error(`append(${id}): HTTP ${res.status} ${typeof res.body === 'string' ? res.body.slice(0,200) : JSON.stringify(res.body).slice(0,200)}`);
  return res.body;
}

export async function removeSymbols(id, symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('removeSymbols: symbols must be a non-empty array');
  }
  const res = await postJson('remove', id, symbols);
  if (!res.ok) throw new Error(`remove(${id}): HTTP ${res.status}`);
  return res.body;
}

export async function replaceOrder(id, symbols) {
  // Server enforces that the set of symbols matches the existing list (reorder only).
  // Sends back 422 with "You can't remove symbols during safe replace" if set differs.
  const res = await postJson('replace', id, symbols);
  if (!res.ok) throw new Error(`replace(${id}): HTTP ${res.status} ${typeof res.body === 'string' ? res.body.slice(0,300) : JSON.stringify(res.body).slice(0,300)}`);
  return res.body;
}

export async function activeListId() {
  const all = await listAll();
  const active = all.find(l => l.active);
  if (!active) throw new Error('No active watchlist found');
  return active.id;
}

export async function findByName(name) {
  const all = await listAll();
  return all.find(l => l.name === name) || null;
}

export async function findById(id) {
  const all = await listAll();
  return all.find(l => l.id === Number(id)) || null;
}

/** Delete a watchlist by id. Endpoint discovered 2026-05-14:
 *  DELETE /api/v1/symbols_list/custom/{id}/ → 204 No Content. */
export async function deleteList(id) {
  const expr = `fetch('${BASE}/${id}/', { method: 'DELETE', credentials: 'include' })`;
  const res = await fetchJson(expr);
  if (!res.ok) throw new Error(`deleteList(${id}): HTTP ${res.status}`);
  return res.body;
}

/** Set the active watchlist by id. Endpoint discovered via fetch interceptor 2026-05-13:
 *  POST /api/v1/symbols_list/active/{id}/ (no body required). */
export async function setActive(id) {
  const expr = `fetch('https://www.tradingview.com/api/v1/symbols_list/active/${id}/', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }
  })`;
  const res = await fetchJson(expr);
  if (!res.ok) throw new Error(`setActive(${id}): HTTP ${res.status}`);
  return res.body;
}

/** Create a TradingView price alert. Endpoint discovered 2026-05-14 via fetch hook.
 *  POST https://pricealerts.tradingview.com/create_alert
 *
 *  symbol must be a full "EXCHANGE:TICKER" — wrapped server-side as
 *  '={"adjustment":"splits","currency-id":"USD","symbol":"<sym>"}'.
 *
 *  conditionType: "cross" | "greater_than" | "less_than" etc.
 *  threshold: numeric price to trigger at.
 */
export async function createAlert({ symbol, message, threshold, resolution = '1', conditionType = 'cross', notification = {} }) {
  if (!symbol) throw new Error('createAlert: symbol required');
  if (typeof threshold !== 'number') throw new Error('createAlert: numeric threshold required');
  if (!message) throw new Error('createAlert: message required');
  // Build the serialized symbol field exactly as TV's UI does
  const symPayload = `={"adjustment":"splits","currency-id":"USD","symbol":"${symbol}"}`;
  const payload = {
    symbol: symPayload,
    resolution,
    message,
    sound_file: 'alert/fired',
    sound_duration: 0,
    popup: notification.popup !== false,
    expiration: null,
    auto_deactivate: true,
    email: !!notification.email,
    sms_over_email: false,
    mobile_push: notification.mobile_push !== false,
    // CRITICAL: pricealerts API rejects empty string ("") here — must be null
    // if not using a webhook. Discovered 2026-05-14: web_hook:"" returns
    // invalid_request, web_hook:null returns ok.
    web_hook: notification.web_hook || null,
    name: null,
    conditions: [{
      type: conditionType,
      frequency: 'on_first_fire',
      series: [
        { type: 'barset' },
        { type: 'value', value: threshold },
      ],
      resolution,
    }],
    active: true,
    ignore_warnings: true,
  };
  // Stash body on window then read it back in the fetch — avoids string
  // escape hell and matches TV's UI which fires without Content-Type header
  // (default text/plain body avoids CORS preflight; pricealerts parses JSON anyway).
  const bodyStr = JSON.stringify({ payload });
  await evaluateAsync(`(window.__bulkAlertBody = ${JSON.stringify(bodyStr)}, true)`);
  const expr = `fetch('https://pricealerts.tradingview.com/create_alert', {
    method: 'POST',
    credentials: 'include',
    body: window.__bulkAlertBody
  })`;
  const res = await fetchJson(expr);
  if (!res.ok) throw new Error(`createAlert(${symbol}): HTTP ${res.status} ${typeof res.body === 'string' ? res.body.slice(0,200) : JSON.stringify(res.body).slice(0,200)}`);
  return res.body;
}

/** Delete one or more TradingView price alerts. Endpoint discovered via fetch
 *  hook 2026-05-14: POST /delete_alerts with body {payload:{alert_ids:[...]}}.
 *  Note: endpoint is PLURAL — `/delete_alert` and `/remove_alert` both 404. */
export async function deleteAlerts(alertIds) {
  const ids = Array.isArray(alertIds) ? alertIds : [alertIds];
  if (ids.length === 0) throw new Error('deleteAlerts: at least one alert_id required');
  const body = JSON.stringify({ payload: { alert_ids: ids } });
  await evaluateAsync(`(window.__delAlertBody = ${JSON.stringify(body)}, true)`);
  const expr = `fetch('https://pricealerts.tradingview.com/delete_alerts', {
    method: 'POST', credentials: 'include',
    body: window.__delAlertBody
  })`;
  const res = await fetchJson(expr);
  if (!res.ok) throw new Error(`deleteAlerts(${ids.join(',')}): HTTP ${res.status}`);
  return res.body;
}

// Legacy single-alert alias for backwards compat
export const deleteAlert = (id) => deleteAlerts([id]);

/** Resolve a symbol via TV's search API; returns canonical "EXCHANGE:SYMBOL" or null. */
export async function resolveSymbol(query) {
  if (!query || typeof query !== 'string') return null;
  if (query.includes(':')) return query; // already fully qualified
  const expr = `fetch('https://symbol-search.tradingview.com/symbol_search/?text=' + encodeURIComponent('${query}') + '&hl=1&exchange=&lang=en&type=&domain=production', { credentials: 'include' })`;
  const res = await fetchJson(expr);
  if (!res.ok || !Array.isArray(res.body) || res.body.length === 0) return null;
  const first = res.body[0];
  return `${first.exchange}:${first.symbol}`;
}
