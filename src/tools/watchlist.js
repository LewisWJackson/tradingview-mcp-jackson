import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
  server.tool('watchlist_get', 'Get all symbols from the current TradingView watchlist with last price, change, and change%', {}, async () => {
    try { return jsonResult(await core.get()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add', 'Add a symbol to the TradingView watchlist', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.add({ symbol })); }
    catch (err) {
      // Try to close any open search/input on error
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch (_) {}
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('watchlist_clear', 'Remove every symbol from the current TradingView watchlist', {}, async () => {
    try { return jsonResult(await core.clear()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_sync_from_rules',
    'Diff the TradingView watchlist against the watchlist[] array in rules.json and apply add/remove ops so they match.',
    {
      rulesPath: z.string().optional().describe('Optional absolute path to rules.json. Defaults to the repo-bundled rules.json.'),
    },
    async ({ rulesPath }) => {
      try { return jsonResult(await core.syncFromRules({ rulesPath })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_merge',
    'Union of symbols across multiple watchlists (deduplicated). Read-only — returns symbol array. Use watchlist_upload to materialize as a new list.',
    {
      lists: z.array(z.union([z.string(), z.number()])).min(1).describe('Array of watchlist names (strings) or ids (numbers).'),
      strip_exchange: z.boolean().optional().describe('Strip exchange prefix (NASDAQ:AAPL → AAPL) for cross-source dedup. Default false.'),
    },
    async ({ lists, strip_exchange }) => {
      try { return jsonResult(await core.setOp({ op: 'merge', lists, strip_exchange })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_intersect',
    'Symbols present in ALL given watchlists. Useful for finding overlaps across thematic lists.',
    {
      lists: z.array(z.union([z.string(), z.number()])).min(2).describe('Array of watchlist names or ids (minimum 2).'),
      strip_exchange: z.boolean().optional().describe('Strip exchange prefix for matching across sources.'),
    },
    async ({ lists, strip_exchange }) => {
      try { return jsonResult(await core.setOp({ op: 'intersect', lists, strip_exchange })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_subtract',
    'Symbols in list A but not in list B. Useful for finding gaps ("what\'s in Bybit perps I\'m not watching on TV?").',
    {
      lists: z.array(z.union([z.string(), z.number()])).length(2).describe('Exactly 2 watchlists: [A, B]. Returns A - B.'),
      strip_exchange: z.boolean().optional().describe('Strip exchange prefix for matching across sources.'),
    },
    async ({ lists, strip_exchange }) => {
      try { return jsonResult(await core.setOp({ op: 'subtract', lists, strip_exchange })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_section_add',
    'Add a section header to an existing watchlist. Inserts before a specified symbol or at the end.',
    {
      name: z.string().optional().describe('Watchlist name.'),
      list_id: z.number().optional().describe('Watchlist id (takes precedence).'),
      section_name: z.string().describe('Section title (e.g., "MINERS"). The ### prefix is added automatically.'),
      before_symbol: z.string().optional().describe('Insert before this symbol. Defaults to end if omitted.'),
      at_end: z.boolean().optional().describe('Force append at end (overrides before_symbol).'),
    },
    async ({ name, list_id, section_name, before_symbol, at_end }) => {
      try { return jsonResult(await core.sectionAdd({ name, listId: list_id, sectionName: section_name, beforeSymbol: before_symbol, atEnd: at_end })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_section_remove',
    'Remove a section header from a watchlist (keeps the symbols underneath).',
    {
      name: z.string().optional(),
      list_id: z.number().optional(),
      section_name: z.string().describe('Section name to remove (without ### prefix).'),
    },
    async ({ name, list_id, section_name }) => {
      try { return jsonResult(await core.sectionRemove({ name, listId: list_id, sectionName: section_name })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_section_rename',
    'Rename a section header in a watchlist, preserving its position.',
    {
      name: z.string().optional(),
      list_id: z.number().optional(),
      from_name: z.string().describe('Current section name (without ### prefix).'),
      to_name: z.string().describe('New section name.'),
    },
    async ({ name, list_id, from_name, to_name }) => {
      try { return jsonResult(await core.sectionRename({ name, listId: list_id, fromName: from_name, toName: to_name })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_export_all',
    'Dump every named TradingView watchlist to .txt files in one directory + write an index.md. Defaults to ~/virtuoso-vault/04-Trading/Watchlists/<YYYY-MM-DD>/. Use for disaster-recovery backup + audit trail.',
    {
      out_dir: z.string().optional().describe('Explicit output directory (otherwise vault default).'),
    },
    async ({ out_dir }) => {
      try { return jsonResult(await core.exportAll({ outDir: out_dir })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_export',
    'Export a named TradingView watchlist to a .txt file in TV upload format (one symbol per line, ###SECTION headers). Defaults to ~/Downloads/watchlists/{slug}-{date}.txt.',
    {
      name: z.string().optional().describe('Watchlist name (case-sensitive).'),
      list_id: z.number().optional().describe('Numeric watchlist id (takes precedence over name).'),
      out_path: z.string().optional().describe('Explicit output path (otherwise default Downloads/watchlists/ used).'),
    },
    async ({ name, list_id, out_path }) => {
      try { return jsonResult(await core.exportList({ name, listId: list_id, outPath: out_path })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_upload',
    'Create a new TradingView watchlist from a local .txt file. Preserves ###SECTION headers. File format: one symbol or section header per line.',
    {
      file_path: z.string().describe('Absolute path to the .txt file.'),
      new_name: z.string().optional().describe('Name for the new watchlist (defaults to file basename).'),
    },
    async ({ file_path, new_name }) => {
      try { return jsonResult(await core.uploadList({ filePath: file_path, newName: new_name })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_diff',
    'Preview the diff between a local .txt file and a TradingView watchlist without applying changes. Shows to_add, to_remove, and reorder_needed.',
    {
      file_path: z.string().describe('Absolute path to the local .txt file.'),
      name: z.string().optional().describe('Watchlist name (case-sensitive).'),
      list_id: z.number().optional().describe('Numeric watchlist id (takes precedence over name).'),
    },
    async ({ file_path, name, list_id }) => {
      try { return jsonResult(await core.diffList({ filePath: file_path, name, listId: list_id })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_sync',
    'Idempotently sync a local .txt file into an existing TradingView watchlist. Applies append → remove → reorder. Safe to re-run.',
    {
      file_path: z.string().describe('Absolute path to the local .txt file.'),
      name: z.string().optional().describe('Watchlist name (case-sensitive).'),
      list_id: z.number().optional().describe('Numeric watchlist id (takes precedence over name).'),
    },
    async ({ file_path, name, list_id }) => {
      try { return jsonResult(await core.syncList({ filePath: file_path, name, listId: list_id })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_list_all',
    'Enumerate every named watchlist in the user\'s TradingView account with id, name, symbol count, section count, active flag, and modified date.',
    {},
    async () => {
      try { return jsonResult(await core.listAll()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('alerts_delete_batch',
    'Batch-delete one or more TradingView price alerts by alert_id. POST /delete_alerts. Replaces the legacy DOM-based alert_delete for known-id deletion.',
    {
      alert_ids: z.array(z.number()).min(1).describe('Array of numeric alert_ids (returned from watchlist_bulk_alert or alert_list).'),
    },
    async (args) => {
      try { return jsonResult(await core.deleteAlertsBatch(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_bulk_alert',
    'Create price-cross alerts for every symbol in a watchlist via TV pricealerts REST. Two threshold modes: absolute (same price for all) or delta_pct (per-symbol % from current). Use dry_run=true to preview without creating.',
    {
      name: z.string().optional().describe('Watchlist name.'),
      list_id: z.number().optional().describe('Watchlist id (takes precedence).'),
      threshold: z.number().optional().describe('Absolute price threshold (same for all symbols). Mutually exclusive with delta_pct.'),
      delta_pct: z.number().optional().describe('Per-symbol % delta from current price (e.g., -10 for "drops 10%"). Triggers a quote fetch per symbol.'),
      condition_type: z.enum(['cross', 'greater_than', 'less_than']).optional().describe('Alert condition. Default cross.'),
      resolution: z.string().optional().describe('Bar resolution for evaluation (default "1" = 1 minute).'),
      message_template: z.string().optional().describe('Message template with {symbol}, {condition}, {threshold} placeholders.'),
      max_alerts: z.number().optional().describe('Cap on alerts created (default 50). TV has plan-tier alert quotas.'),
      dry_run: z.boolean().optional().describe('Preview without creating. Returns computed thresholds + messages.'),
    },
    async (args) => {
      try { return jsonResult(await core.bulkAlert(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_screen',
    'Filter a TradingView watchlist by indicator condition. Switches chart to each symbol, reads study values, returns matches. Works with custom Pine indicators (TV native screener can\'t). Slow: ~5-10s per symbol. Restores original chart state after.',
    {
      name: z.string().optional().describe('Watchlist name (case-sensitive).'),
      list_id: z.number().optional().describe('Numeric watchlist id (takes precedence).'),
      study: z.string().describe('Study name or partial match (e.g., "Relative Strength Index", "MACD", "Bollinger").'),
      field: z.string().describe('Field within the study (e.g., "RSI", "MACD", "Upper", "Histogram"). Case-sensitive.'),
      op: z.enum(['<', '<=', '>', '>=', '==', '!=', 'between']).describe('Comparison operator.'),
      value: z.union([z.number(), z.array(z.number()).length(2)]).describe('Threshold (number) or [low, high] for "between".'),
      timeframe: z.string().optional().describe('Timeframe override (e.g., "1H", "4H", "D"). Defaults to current chart.'),
      max_symbols: z.number().optional().describe('Cap symbols scanned (default 50; warning: 500-symbol lists take 40+ min).'),
      per_symbol_timeout_ms: z.number().optional().describe('Per-symbol timeout in ms (default 5000).'),
      force_when_hidden: z.boolean().optional().describe('Override visibility-hidden refusal. WARNING: results will be stale because Chrome throttles hidden tabs. Default false.'),
    },
    async (args) => {
      try { return jsonResult(await core.screen(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_delete',
    'Delete a TradingView watchlist by name or id. **Destructive** — must pass confirm=true. DELETE /api/v1/symbols_list/custom/{id}/ → 204.',
    {
      name: z.string().optional().describe('Watchlist name (case-sensitive).'),
      list_id: z.number().optional().describe('Numeric watchlist id (takes precedence over name).'),
      confirm: z.boolean().describe('Must be true. Safety gate against accidental destruction.'),
    },
    async ({ name, list_id, confirm }) => {
      try { return jsonResult(await core.deleteList({ name, listId: list_id, confirm })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_switch',
    'Switch the active TradingView watchlist by name (or list id). Uses TV REST API (no UI automation).',
    {
      name: z.string().optional().describe('Name of the watchlist to activate (case-sensitive). Either name or list_id required.'),
      list_id: z.number().optional().describe('Numeric watchlist id (from watchlist_list_all). Takes precedence over name.'),
    },
    async ({ name, list_id }) => {
      try { return jsonResult(await core.switchTo({ name, listId: list_id })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('watchlist_create',
    'Create a new named watchlist in TradingView Desktop. Opens the watchlists dropdown, clicks "Create new list", types the name, and presses Enter. Optionally seeds it with an initial symbol array.',
    {
      name: z.string().min(1).describe('Name of the new watchlist (e.g., "AI 2026", "Mag 7")'),
      symbols: z.array(z.string()).optional().describe('Optional list of symbols to add after creation (e.g., ["AAPL", "MSFT", "NVDA"])'),
    },
    async ({ name, symbols }) => {
      try { return jsonResult(await core.createList({ name, symbols })); }
      catch (err) {
        try {
          const { getClient } = await import('../connection.js');
          const c = await getClient();
          await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        } catch (_) {}
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool('watchlist_remove', 'Remove a symbol from the TradingView watchlist (right-click row → Remove)', {
    symbol: z.string().describe('Symbol to remove. Accepts bare ticker (AAPL) or full form (NASDAQ:AAPL).'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.remove({ symbol })); }
    catch (err) {
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch (_) {}
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
