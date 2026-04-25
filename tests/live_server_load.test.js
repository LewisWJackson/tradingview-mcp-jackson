import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.resolve(__dirname, '..', 'scripts', 'dashboard', 'live_server.js');

test('live_server.js parses and starts up without crashing', { timeout: 5000 }, async () => {
  // Spawn the server with a short timeout. We want to confirm it boots far enough
  // to print the SSE-endpoint banner line, then we kill it.
  const child = spawn('node', [SERVER], {
    env: { ...process.env, PORT: '0', SHADOW_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const seenBanner = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    child.stdout.on('data', () => {
      if (stdout.includes('SSE:') && stdout.includes('Poller:')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    child.on('exit', () => { clearTimeout(timer); resolve(false); });
  });

  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));

  if (!seenBanner) {
    console.error('STDOUT:', stdout);
    console.error('STDERR:', stderr);
  }
  assert.ok(seenBanner, 'server should print SSE + Poller banner lines within 3s');
  // Server must NOT have crashed with an uncaught exception
  assert.ok(!stderr.includes('throw'), `server crashed: ${stderr}`);
  assert.ok(!stderr.includes('Error:'), `server emitted errors: ${stderr}`);
});
