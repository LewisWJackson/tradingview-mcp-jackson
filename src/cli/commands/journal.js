import { register } from '../router.js';
import * as core from '../../core/journal.js';

register('journal', {
  description: 'Replay-backtest trade journal (auto-captured by `tv replay trade`)',
  subcommands: new Map([
    ['list', {
      description: 'List recent journaled trades',
      options: {
        tag: { type: 'string', description: 'Only show trades with this tag' },
        symbol: { type: 'string', description: 'Only show trades for this symbol' },
        limit: { type: 'string', short: 'n', description: 'Max trades to return (most recent first)' },
      },
      handler: (opts) => core.getTrades({
        tag: opts.tag,
        symbol: opts.symbol,
        limit: opts.limit ? Number(opts.limit) : undefined,
      }),
    }],
    ['stats', {
      description: 'Win-rate stats, grouped by tag unless one is given',
      options: {
        tag: { type: 'string', description: 'Only compute stats for this tag' },
        symbol: { type: 'string', description: 'Only compute stats for this symbol' },
      },
      handler: (opts) => core.getStats({ tag: opts.tag, symbol: opts.symbol }),
    }],
    ['clear', {
      description: 'Wipe the journal (destructive)',
      handler: () => core.clear(),
    }],
  ]),
});
