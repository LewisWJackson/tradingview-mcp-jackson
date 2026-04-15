import { register } from '../router.js';
import * as core from '../../core/health.js';

register('status', {
  description: 'Check CDP connection to TradingView',
  handler: () => core.healthCheck(),
});

register('launch', {
  description: 'Launch TradingView Desktop app with CDP enabled',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    'no-kill': { type: 'boolean', description: 'Do not kill existing instances' },
  },
  handler: (opts) => core.launch({
    port: opts.port ? Number(opts.port) : undefined,
    kill_existing: !opts['no-kill'],
  }),
});

register('launch-browser', {
  description: 'Launch Chrome or Edge and open TradingView website with CDP enabled',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    browser: { type: 'string', short: 'b', description: 'Browser: chrome (default) or edge' },
    profile: { type: 'string', description: 'Custom user-data-dir path for browser profile' },
  },
  handler: (opts) => core.launchBrowser({
    port: opts.port ? Number(opts.port) : undefined,
    browser: opts.browser,
    profile: opts.profile,
  }),
});
