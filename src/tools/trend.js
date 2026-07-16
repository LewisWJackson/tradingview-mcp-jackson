import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/trend.js';

export function registerTrendTools(server) {
  server.tool('data_get_trend_summary', 'Compute trend direction, strength, and swing structure for the current chart symbol/timeframe from raw price data — no indicators need to be on the chart. Combines EMA20/50 slope, ADX/DMI (trend strength, <20 = choppy/ranging), and HH/HL vs LH/LL swing structure into one verdict.', {
    count: z.coerce.number().optional().describe('Number of bars to analyze (default 150, min 60)'),
  }, async ({ count }) => {
    try { return jsonResult(await core.getTrendSummary({ count })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_multi_timeframe_trend', 'Check whether trend direction agrees across several timeframes for a symbol (default 15m/1H/4H/D). Switches the live chart through each timeframe, runs the same EMA/ADX/structure trend read on each, then restores the original chart symbol/timeframe. Use this to confirm a bias before entering, or to spot conflicting timeframes.', {
    symbol: z.string().optional().describe('Symbol to check (blank = current chart symbol)'),
    timeframes: z.array(z.string()).optional().describe('Timeframes to check, e.g. ["15","60","240","D"] (default: 15,60,240,D)'),
    count: z.coerce.number().optional().describe('Bars to analyze per timeframe (default 150, min 60)'),
  }, async ({ symbol, timeframes, count }) => {
    try { return jsonResult(await core.getMultiTimeframeTrend({ symbol, timeframes, count })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
