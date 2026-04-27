/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync } from '../connection.js';

const CONDITION_TYPE = {
  crossing: 'cross',
  greater_than: 'greater',
  less_than: 'less',
};

export async function create({ condition, price, message }) {
  const ctype = CONDITION_TYPE[condition] || 'cross';
  if (!Number.isFinite(price)) {
    return { success: false, error: `Invalid price: ${price}`, source: 'pricealerts_api' };
  }

  // Resolve current chart symbol and the logged-in username (both required for the API)
  const ctx = await evaluate(`
    (function() {
      var wv = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value();
      var sym = wv && typeof wv.symbol === 'function' ? wv.symbol() : null;
      var username = (window.user && window.user.username) || null;
      return { symbol: sym, username: username };
    })()
  `);
  if (!ctx?.symbol) {
    return { success: false, error: 'Could not resolve chart symbol', source: 'pricealerts_api' };
  }
  if (!ctx?.username) {
    return { success: false, error: 'Could not resolve TradingView username', source: 'pricealerts_api' };
  }

  const expiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const defaultMessage = `${ctx.symbol.split(':').pop()} ${ctype === 'cross' ? 'Crossing' : ctype} ${price}`;
  const payload = {
    payload: {
      symbol: `=${JSON.stringify({ adjustment: 'splits', 'currency-id': 'USD', symbol: ctx.symbol })}`,
      resolution: '1',
      message: message || defaultMessage,
      sound_file: null,
      sound_duration: 0,
      popup: true,
      expiration,
      auto_deactivate: false,
      email: false,
      sms_over_email: false,
      mobile_push: true,
      web_hook: null,
      name: null,
      conditions: [{
        type: ctype,
        frequency: 'on_first_fire',
        series: [
          { type: 'barset' },
          { type: 'value', value: price },
        ],
        resolution: '1',
      }],
      active: true,
      ignore_warnings: true,
    },
  };

  const url = `https://pricealerts.tradingview.com/create_alert?log_username=${encodeURIComponent(ctx.username)}`;
  const result = await evaluateAsync(`
    fetch(${JSON.stringify(url)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: ${JSON.stringify(JSON.stringify(payload))}
    })
    .then(function(r){ return r.json().then(function(d){ return { status: r.status, data: d }; }); })
    .catch(function(e){ return { error: e.message }; })
  `);

  if (result?.error) {
    return { success: false, error: result.error, source: 'pricealerts_api' };
  }
  if (result?.data?.s !== 'ok' || !result.data.r?.alert_id) {
    return { success: false, error: result?.data?.errmsg || 'Unknown API error', response: result?.data, source: 'pricealerts_api' };
  }

  const a = result.data.r;
  return {
    success: true,
    source: 'pricealerts_api',
    alert_id: a.alert_id,
    symbol: ctx.symbol,
    price,
    condition: ctype,
    message: a.message,
    active: a.active,
    expiration: a.expiration,
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
