import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'setup_autostart.ps1');

test('setup_autostart.ps1 exists', () => {
  assert.ok(fs.existsSync(SCRIPT), 'setup_autostart.ps1 must exist');
});

test('script declares a Remove parameter', () => {
  const ps = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(/\[switch\]\$Remove/i.test(ps), '-Remove switch parameter not declared');
  assert.ok(/if\s*\(\s*\$Remove\s*\)/i.test(ps), 'Remove branch not implemented');
});

test('script registers a scheduled task at logon', () => {
  const ps = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(ps.includes('New-ScheduledTaskTrigger -AtLogOn'), 'AtLogOn trigger not found');
  assert.ok(ps.includes('Register-ScheduledTask'), 'Register-ScheduledTask call not found');
});

test('script unregisters before re-registering (idempotent)', () => {
  const ps = fs.readFileSync(SCRIPT, 'utf8');
  // Should call Unregister-ScheduledTask in the install path (before Register-ScheduledTask)
  const installSection = ps.split('Register-ScheduledTask')[0];
  assert.ok(installSection.includes('Unregister-ScheduledTask'),
    'install path must Unregister-ScheduledTask first for idempotency');
});

test('script runs the live_server.js entry point via cmd.exe with minimized window', () => {
  const ps = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(ps.includes('live_server.js'), 'live_server.js path not referenced');
  assert.ok(ps.includes('cmd.exe'), 'cmd.exe wrapper not used');
  assert.ok(ps.includes('/min'), '/min flag for minimized window not found');
});

test('script writes logs to data/live_server.log', () => {
  const ps = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(ps.includes('live_server.log'), 'log file path not referenced');
  assert.ok(ps.includes('1>>') || ps.includes('1>>'), 'stdout redirection not found');
});

test('script validates Node is on PATH and errors out if missing', () => {
  const ps = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(ps.includes('Get-Command node'), 'node lookup not present');
  assert.ok(/node not found/i.test(ps), 'helpful error message for missing node not present');
});

test('operations doc covers autostart workflow concretely', () => {
  const docPath = path.resolve(__dirname, '..', 'docs', 'live-feed-operations.md');
  const md = fs.readFileSync(docPath, 'utf8');
  assert.ok(md.includes('./scripts/setup_autostart.ps1'), 'doc must reference the autostart script');
  assert.ok(md.includes('-Remove'), 'doc must explain -Remove option');
  assert.ok(md.includes('Get-ScheduledTask'), 'doc must explain how to verify');
});
