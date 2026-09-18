import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/mt5.js';

const ORDER_TYPES = ['buy', 'sell', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'];

export function registerMt5Tools(server) {
  server.tool(
    'mt5_ensure_running',
    'Ensure the MT5 bridge (Wine Python + MetaTrader5 package) is running and connected. Launches it if not already up. Call this first if other mt5_* tools fail with a connection error.',
    {},
    async () => {
      try {
        return jsonResult(await core.ensureBridgeRunning());
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_health_check',
    'Check MT5 bridge connection and return terminal + account state',
    {},
    async () => {
      try {
        return jsonResult(await core.health());
      } catch (err) {
        return jsonResult(
          { success: false, error: err.message, hint: 'Bridge may not be running. Try mt5_ensure_running.' },
          true
        );
      }
    }
  );

  server.tool('mt5_get_account', 'Get MT5 account info: balance, equity, margin, leverage, currency', {}, async () => {
    try {
      return jsonResult(await core.getAccount());
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool(
    'mt5_get_positions',
    'Get open positions, optionally filtered by symbol',
    { symbol: z.string().optional().describe('e.g. XAUUSD') },
    async ({ symbol }) => {
      try {
        return jsonResult(await core.getPositions(symbol));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_get_orders',
    'Get pending (working) orders, optionally filtered by symbol',
    { symbol: z.string().optional().describe('e.g. XAUUSD') },
    async ({ symbol }) => {
      try {
        return jsonResult(await core.getOrders(symbol));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_get_quote',
    'Get current bid/ask tick for a symbol',
    { symbol: z.string().describe('e.g. XAUUSD') },
    async ({ symbol }) => {
      try {
        return jsonResult(await core.getQuote(symbol));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_get_symbol_info',
    'Get symbol specs: pip/point size, volume min/max/step, spread, contract size, leverage-relevant fields',
    { symbol: z.string().describe('e.g. XAUUSD') },
    async ({ symbol }) => {
      try {
        return jsonResult(await core.getSymbolInfo(symbol));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_get_ohlcv',
    'Get OHLCV bars for a symbol/timeframe',
    {
      symbol: z.string().describe('e.g. XAUUSD'),
      timeframe: z.enum(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1']).optional().describe('default M15'),
      count: z.coerce.number().optional().describe('number of bars, default 100, max 5000'),
    },
    async ({ symbol, timeframe, count }) => {
      try {
        return jsonResult(await core.getOhlcv({ symbol, timeframe, count }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_get_history_deals',
    'Get executed deals (closed trade legs) from trade history over the last N days',
    { days: z.coerce.number().optional().describe('default 7') },
    async ({ days }) => {
      try {
        return jsonResult(await core.getHistoryDeals(days));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_get_history_orders',
    'Get historical orders (filled, cancelled, expired) over the last N days',
    { days: z.coerce.number().optional().describe('default 7') },
    async ({ days }) => {
      try {
        return jsonResult(await core.getHistoryOrders(days));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_place_order',
    'Place an order. "buy"/"sell" execute at market immediately. "buy_limit"/"sell_limit"/"buy_stop"/"sell_stop" are pending orders and require price. Pass dry_run=true to see the exact request MT5 would receive without sending it — use this to double check before a real submission.',
    {
      symbol: z.string().describe('e.g. XAUUSD'),
      type: z.enum(ORDER_TYPES),
      volume: z.coerce.number().describe('lot size, e.g. 0.10'),
      price: z.coerce.number().optional().describe('required for pending order types; ignored for market buy/sell'),
      sl: z.coerce.number().optional().describe('stop loss price'),
      tp: z.coerce.number().optional().describe('take profit price'),
      comment: z.string().optional(),
      dry_run: z.coerce.boolean().optional().describe('if true, return the constructed request without sending it'),
    },
    async (params) => {
      try {
        return jsonResult(await core.placeOrder(params));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_close_position',
    'Close an open position by ticket, in full or partially',
    {
      ticket: z.coerce.number().describe('position ticket, from mt5_get_positions'),
      volume: z.coerce.number().optional().describe('partial close volume; omit to close the full position'),
    },
    async ({ ticket, volume }) => {
      try {
        return jsonResult(await core.closePosition({ ticket, volume }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_modify_position',
    "Modify an open position's stop loss / take profit",
    {
      ticket: z.coerce.number().describe('position ticket, from mt5_get_positions'),
      sl: z.coerce.number().optional().describe('new stop loss; omit to leave unchanged'),
      tp: z.coerce.number().optional().describe('new take profit; omit to leave unchanged'),
    },
    async ({ ticket, sl, tp }) => {
      try {
        return jsonResult(await core.modifyPosition({ ticket, sl, tp }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_cancel_order',
    'Cancel a pending order by ticket',
    { ticket: z.coerce.number().describe('order ticket, from mt5_get_orders') },
    async ({ ticket }) => {
      try {
        return jsonResult(await core.cancelOrder({ ticket }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'mt5_modify_order',
    "Modify a pending order's price / stop loss / take profit",
    {
      ticket: z.coerce.number().describe('order ticket, from mt5_get_orders'),
      price: z.coerce.number().optional().describe('new entry price; omit to leave unchanged'),
      sl: z.coerce.number().optional().describe('new stop loss; omit to leave unchanged'),
      tp: z.coerce.number().optional().describe('new take profit; omit to leave unchanged'),
    },
    async ({ ticket, price, sl, tp }) => {
      try {
        return jsonResult(await core.modifyPendingOrder({ ticket, price, sl, tp }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
