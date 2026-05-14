import { register } from '../router.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, remove, clear, sync)',
  subcommands: new Map([
    ['get', {
      description: 'Get watchlist symbols (defaults to active list; --list-id=N for specific)',
      handler: (opts) => core.get({ listId: opts['list-id'] ? Number(opts['list-id']) : undefined }),
    }],
    ['export', {
      description: 'Dump a named list to .txt. Usage: tv watchlist export "Crypto Stocks" [--out=path]',
      handler: (opts, positionals) => {
        if (!positionals[0] && !opts['list-id']) throw new Error('Name or --list-id required');
        return core.exportList({ name: positionals[0], listId: opts['list-id'] ? Number(opts['list-id']) : undefined, outPath: opts.out });
      },
    }],
    ['upload', {
      description: 'Create a new list from a .txt file. Usage: tv watchlist upload <file> [--name="My List"]',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('File path required');
        return core.uploadList({ filePath: positionals[0], newName: opts.name });
      },
    }],
    ['diff', {
      description: 'Preview file vs remote diff. Usage: tv watchlist diff <file> "<list name>" [--list-id=N]',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('File path required');
        return core.diffList({ filePath: positionals[0], name: positionals[1], listId: opts['list-id'] ? Number(opts['list-id']) : undefined });
      },
    }],
    ['sync', {
      description: 'Sync local .txt into existing list (idempotent). Usage: tv watchlist sync <file> "<list name>" [--list-id=N]',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('File path required');
        return core.syncList({ filePath: positionals[0], name: positionals[1], listId: opts['list-id'] ? Number(opts['list-id']) : undefined });
      },
    }],
    ['merge', {
      description: 'Union of N watchlists. Usage: tv watchlist merge "List A" "List B" "List C"',
      handler: (opts, positionals) => {
        if (positionals.length < 1) throw new Error('At least one list required');
        return core.setOp({ op: 'merge', lists: positionals, strip_exchange: opts['strip-exchange'] === 'true' });
      },
    }],
    ['intersect', {
      description: 'Intersection of 2+ watchlists. Usage: tv watchlist intersect "List A" "List B"',
      handler: (opts, positionals) => {
        if (positionals.length < 2) throw new Error('At least 2 lists required');
        return core.setOp({ op: 'intersect', lists: positionals, strip_exchange: opts['strip-exchange'] === 'true' });
      },
    }],
    ['subtract', {
      description: 'A - B. Usage: tv watchlist subtract "List A" "List B"',
      handler: (opts, positionals) => {
        if (positionals.length !== 2) throw new Error('Exactly 2 lists required');
        return core.setOp({ op: 'subtract', lists: positionals, strip_exchange: opts['strip-exchange'] === 'true' });
      },
    }],
    ['section-add', {
      description: 'Add section header. Usage: tv watchlist section-add "List Name" "Section Name" [--before=SYMBOL]',
      handler: (opts, positionals) => {
        if (!positionals[0] || !positionals[1]) throw new Error('list name + section name required');
        return core.sectionAdd({ name: positionals[0], sectionName: positionals[1], beforeSymbol: opts.before, atEnd: opts['at-end'] === 'true' });
      },
    }],
    ['section-remove', {
      description: 'Remove section header (keeps symbols). Usage: tv watchlist section-remove "List Name" "Section Name"',
      handler: (opts, positionals) => {
        if (!positionals[0] || !positionals[1]) throw new Error('list name + section name required');
        return core.sectionRemove({ name: positionals[0], sectionName: positionals[1] });
      },
    }],
    ['section-rename', {
      description: 'Rename a section. Usage: tv watchlist section-rename "List Name" "Old Name" "New Name"',
      handler: (opts, positionals) => {
        if (!positionals[0] || !positionals[1] || !positionals[2]) throw new Error('list + from + to required');
        return core.sectionRename({ name: positionals[0], fromName: positionals[1], toName: positionals[2] });
      },
    }],
    ['list-all', {
      description: 'Enumerate every watchlist in the account',
      handler: () => core.listAll(),
    }],
    ['switch', {
      description: 'Switch the active watchlist by name. Usage: tv watchlist switch "Crypto Stocks"',
      handler: (opts, positionals) => {
        if (!positionals[0] && !opts['list-id']) throw new Error('Name or --list-id required');
        return core.switchTo({ name: positionals[0], listId: opts['list-id'] ? Number(opts['list-id']) : undefined });
      },
    }],
    ['add', {
      description: 'Add a symbol to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist add AAPL');
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['remove', {
      description: 'Remove a symbol from the watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist remove AAPL');
        return core.remove({ symbol: positionals[0] });
      },
    }],
    ['clear', {
      description: 'Remove all symbols from the watchlist',
      handler: () => core.clear(),
    }],
    ['create', {
      description: 'Create a new named watchlist. Optional --symbols=AAPL,MSFT,NVDA seeds it.',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Name required. Usage: tv watchlist create "AI 2026" [--symbols=AAPL,MSFT]');
        const symbols = opts.symbols ? String(opts.symbols).split(',').map(s => s.trim()).filter(Boolean) : undefined;
        return core.createList({ name: positionals[0], symbols });
      },
    }],
    ['sync-rules', {
      description: '[Legacy] Sync TV watchlist to match rules.json:watchlist[] (use `sync` for .txt files)',
      handler: (opts) => core.syncFromRules({ rulesPath: opts.rules }),
    }],
  ]),
});
