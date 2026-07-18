/**
 * Core alert logic.
 *
 * create/delete/list all use TradingView's internal pricealerts REST API — the
 * same endpoints the official UI calls. The previous DOM-dialog automation for
 * create() never worked (it clicked the alerts panel tab, not a create button)
 * and was replaced 2026-07-18 after the REST path was verified live.
 *
 * Endpoint gotchas (all verified against a live session):
 * - Send the JSON body WITHOUT a Content-Type header. An explicit
 *   application/json header triggers a CORS preflight the endpoint rejects,
 *   surfacing as "TypeError: Failed to fetch".
 * - expiration must be a fixed ISO-8601 date string. null (never expire)
 *   fails with no_infinity_expiration_permissions on non-premium plans, and
 *   unix-seconds timestamps fail with invalid_request.
 * - create_alert returns the new alert with active:false; a follow-up
 *   restart_alerts call is required to arm it.
 */
import { evaluate, evaluateAsync } from '../connection.js';

const PRICEALERTS_BASE = 'https://pricealerts.tradingview.com';

// Map the tool's documented condition names onto the API's types, while
// passing through any native API type ("cross_up" etc.) unchanged.
const CONDITION_MAP = {
  crossing: 'cross',
  greater_than: 'greater',
  less_than: 'less',
};

function restCall(path, payloadObj) {
  // Body is embedded as a JS string literal; no Content-Type header on purpose.
  return evaluateAsync(`
    fetch('${PRICEALERTS_BASE}/${path}', { method: 'POST', credentials: 'include', body: ${JSON.stringify(JSON.stringify(payloadObj))} })
      .then(function(r) { return r.json(); })
      .catch(function(e) { return { s: 'error', err: { code: String(e) } }; })
  `);
}

export async function create({ condition, price, message, expiration_days }) {
  const condType = CONDITION_MAP[condition] || condition;
  const symbol = await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().symbol()`);
  const resolution = await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().resolution()`);
  const days = Number(expiration_days) > 0 ? Number(expiration_days) : 14;

  const payload = {
    symbol: `={"adjustment":"splits","symbol":"${symbol}"}`,
    resolution: String(resolution || '15'),
    condition: {
      type: condType,
      frequency: 'on_first_fire',
      series: [
        { type: 'barset', special_symbol: 'main_symbol' },
        { type: 'value', value: Number(price) },
      ],
    },
    expiration: new Date(Date.now() + days * 86400 * 1000).toISOString(),
    message: message || '',
    name: '',
    active: true,
    email: false,
    mobile_push: true,
    popup: true,
    sound_file: null,
    sound_duration: 0,
    auto_deactivate: false,
    ignore_warnings: true,
  };

  const created = await restCall('create_alert', { payload });
  if (created?.s !== 'ok' || !created?.r?.alert_id) {
    return {
      success: false,
      price: Number(price),
      condition: condType,
      error: created?.err?.code || created?.errmsg || 'create_alert failed',
      source: 'pricealerts_rest',
    };
  }

  const alertId = created.r.alert_id;
  // Newly created alerts start inactive — restart_alerts arms them.
  const restarted = await restCall('restart_alerts', { payload: { alert_ids: [alertId] } });

  return {
    success: true,
    alert_id: alertId,
    symbol,
    price: Number(price),
    condition: condType,
    message: message || '(none)',
    expiration: payload.expiration,
    active: restarted?.s === 'ok',
    source: 'pricealerts_rest',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('${PRICEALERTS_BASE}/list_alerts', { credentials: 'include' })
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

export async function deleteAlerts({ delete_all, alert_ids }) {
  let ids = Array.isArray(alert_ids) ? alert_ids.map(Number).filter(Boolean) : [];
  if (delete_all) {
    const current = await list();
    ids = (current.alerts || []).map(a => a.alert_id);
  }
  if (!ids.length) {
    return {
      success: true,
      deleted: 0,
      note: delete_all ? 'No alerts to delete.' : 'Pass alert_ids: [id, ...] or delete_all: true.',
      source: 'pricealerts_rest',
    };
  }

  const res = await restCall('delete_alerts', { payload: { alert_ids: ids } });
  if (res?.s !== 'ok') {
    return {
      success: false,
      error: res?.err?.code || res?.errmsg || 'delete_alerts failed',
      alert_ids: ids,
      source: 'pricealerts_rest',
    };
  }
  return { success: true, deleted: ids.length, alert_ids: ids, source: 'pricealerts_rest' };
}
