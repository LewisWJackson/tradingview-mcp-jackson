import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/news.js';

export function registerNewsTools(server) {
  server.tool('news_get',
    'Fetch recent news headlines for a symbol via the local Yahoo Finance bridge (~/bin/yf news). Returns title, publisher, URL, published timestamp.',
    {
      symbol: z.string().describe('Symbol to fetch news for (e.g., MELI, AAPL, BTC-USD)'),
      n: z.coerce.number().optional().describe('Number of headlines (1-20, default 5)'),
    },
    async ({ symbol, n }) => {
      try { return jsonResult(await core.getNews({ symbol, n })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
