import { register } from '../router.js';
import * as core from '../../core/brief.js';

register('brief', {
  description: 'Generate a trader briefing (tape, indicators, levels, news, macro)',
  subcommands: new Map([
    ['for', {
      description: 'Brief for a symbol. Usage: tv brief for "NASDAQ:COIN" [--news=5] [--no-macro=true] [--no-restore=true]',
      handler: (opts, positionals) => core.traderBrief({
        symbol: positionals[0],
        news_count: opts.news ? Number(opts.news) : undefined,
        include_macro: opts['no-macro'] !== 'true',
        include_pine_levels: opts['no-pine'] !== 'true',
        restore_after: opts['no-restore'] !== 'true',
      }),
    }],
    ['active', {
      description: 'Brief for currently active chart symbol',
      handler: () => core.traderBrief({ restore_after: false }),
    }],
  ]),
});
