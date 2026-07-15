import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/journal.js';

export function registerJournalTools(server) {
  server.tool('journal_get', 'Get recent trades from the replay-backtest trade journal (auto-captured by replay_trade), optionally filtered by tag or symbol', {
    tag: z.string().optional().describe('Only return trades logged with this tag'),
    symbol: z.string().optional().describe('Only return trades for this symbol'),
    limit: z.coerce.number().optional().describe('Max trades to return (most recent first). Default: all'),
  }, async ({ tag, symbol, limit }) => {
    try { return jsonResult(core.getTrades({ tag, symbol, limit })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('journal_stats', 'Get win-rate stats from the replay-backtest trade journal, grouped by tag (setup/bias-criterion) unless a specific tag is given', {
    tag: z.string().optional().describe('Only compute stats for this tag'),
    symbol: z.string().optional().describe('Only compute stats for this symbol'),
  }, async ({ tag, symbol }) => {
    try { return jsonResult(core.getStats({ tag, symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('journal_clear', 'Wipe the replay-backtest trade journal (destructive — use to start a fresh backtest run)', {}, async () => {
    try { return jsonResult(core.clear()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
