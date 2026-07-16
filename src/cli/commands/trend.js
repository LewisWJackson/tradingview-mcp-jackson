import { register } from '../router.js';
import * as core from '../../core/trend.js';

register('trend', {
  description: 'Compute trend direction/strength/structure from price data (EMA slope + ADX/DMI + swing structure) — no indicators required on chart',
  options: {
    count: { type: 'string', short: 'n', description: 'Number of bars to analyze (default 150, min 60)' },
  },
  handler: (opts) => core.getTrendSummary({ count: opts.count ? Number(opts.count) : undefined }),
});

register('trend-mtf', {
  description: 'Check trend alignment across multiple timeframes (default 15,60,240,D). Switches the live chart through each and restores it after.',
  options: {
    symbol: { type: 'string', short: 's', description: 'Symbol to check (blank = current chart symbol)' },
    timeframes: { type: 'string', short: 't', description: 'Comma-separated timeframes, e.g. "15,60,240,D" (default: 15,60,240,D)' },
    count: { type: 'string', short: 'n', description: 'Bars to analyze per timeframe (default 150, min 60)' },
  },
  handler: (opts, positionals) => core.getMultiTimeframeTrend({
    symbol: opts.symbol || positionals[0],
    timeframes: opts.timeframes ? opts.timeframes.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    count: opts.count ? Number(opts.count) : undefined,
  }),
});
