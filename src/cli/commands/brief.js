import { register } from '../router.js';
import * as core from '../../core/brief.js';

register('brief', {
  description: 'Generate a trader briefing (tape, indicators, levels, news, macro)',
  subcommands: new Map([
    ['for', {
      description: 'Brief for a symbol. Usage: tv brief for "NASDAQ:COIN" [--news=5] [--no-macro=true] [--watchlist="Crypto Stocks"] [--oversold=30] [--overextended=75]',
      handler: (opts, positionals) => core.traderBrief({
        symbol: positionals[0],
        news_count: opts.news ? Number(opts.news) : undefined,
        include_macro: opts['no-macro'] !== 'true',
        include_pine_levels: opts['no-pine'] !== 'true',
        restore_after: opts['no-restore'] !== 'true',
        watchlist: opts.watchlist,
        watchlist_max: opts['watchlist-max'] ? Number(opts['watchlist-max']) : undefined,
        oversold_threshold: opts.oversold !== undefined ? Number(opts.oversold) : undefined,
        overextended_threshold: opts.overextended !== undefined ? Number(opts.overextended) : undefined,
      }),
    }],
    ['active', {
      description: 'Brief for currently active chart symbol. Optional --watchlist=NAME for scan.',
      handler: (opts) => core.traderBrief({
        restore_after: false,
        watchlist: opts.watchlist,
        watchlist_max: opts['watchlist-max'] ? Number(opts['watchlist-max']) : undefined,
      }),
    }],
  ]),
});
