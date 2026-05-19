import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/brief.js';

export function registerBriefTools(server) {
  server.tool('trader_brief',
    'Orchestrated trader briefing for a symbol: tape + indicators (RSI/MACD/BB/ATR/MAs) + distilled read + Pine-drawn levels + last-24h news + macro context (SPY/QQQ/IWM/VIX/DXY/US10Y quotes). Restores original chart after. Use as a daily pre-market read.',
    {
      symbol: z.string().optional().describe('Target symbol (e.g., "NASDAQ:COIN"). Defaults to currently active chart.'),
      news_count: z.number().optional().describe('Number of headlines (default 5, max 20).'),
      include_macro: z.boolean().optional().describe('Pull SPY/QQQ/IWM/VIX/DXY/US10Y quotes (adds ~10-15s). Default true.'),
      include_pine_levels: z.boolean().optional().describe('Read Pine-drawn lines/labels (publisher-protected scripts return empty). Default true.'),
      restore_after: z.boolean().optional().describe('Switch chart back to original symbol after. Default true.'),
      watchlist: z.string().optional().describe('Optional watchlist name. If set, also runs RSI<35 (oversold) + RSI>70 (overextended) scans on the list — adds ~5min for a 45-symbol list. TV must be visible for indicator freshness.'),
      watchlist_max: z.number().optional().describe('Cap symbols scanned (default 50).'),
      oversold_threshold: z.number().optional().describe('RSI threshold for oversold scan (default 35).'),
      overextended_threshold: z.number().optional().describe('RSI threshold for overextended scan (default 70).'),
    },
    async (args) => {
      try { return jsonResult(await core.traderBrief(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
