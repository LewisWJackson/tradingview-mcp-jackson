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
    },
    async (args) => {
      try { return jsonResult(await core.traderBrief(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
