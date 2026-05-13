import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/health.js';

export function registerHealthTools(server) {
  server.tool('tv_health_check', 'Check CDP connection to TradingView and return current chart state', {}, async () => {
    try { return jsonResult(await core.healthCheck()); }
    catch (err) {
      // On failure, probe local state (is TV running? is the port open?) so the user sees the
      // actual reason instead of a generic "fetch failed" / "no target" message.
      let diagnostic = null;
      let hint = 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.';
      try {
        diagnostic = await core.diagnoseLocalTv();
        hint = core.hintForDiagnostic(diagnostic);
      } catch { /* diagnostic is best-effort */ }
      return jsonResult({ success: false, error: err.message, diagnostic, hint }, true);
    }
  });

  server.tool('tv_discover', 'Report which known TradingView API paths are available and their methods', {}, async () => {
    try { return jsonResult(await core.discover()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {}, async () => {
    try { return jsonResult(await core.uiState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_launch', 'Launch TradingView Desktop with Chrome DevTools Protocol (remote debugging) enabled. Auto-detects install location on Mac, Windows, and Linux. If TradingView is already running with CDP, returns success without restarting (pass force:true to override).', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
    kill_existing: z.coerce.boolean().optional().describe('Kill existing TradingView instances first (default true)'),
    force: z.coerce.boolean().optional().describe('Force relaunch even if TradingView is already running with CDP (default false). WARNING: kills the running app — save your layout first.'),
  }, async ({ port, kill_existing, force }) => {
    try { return jsonResult(await core.launch({ port, kill_existing, force })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
