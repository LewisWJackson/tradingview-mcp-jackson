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
