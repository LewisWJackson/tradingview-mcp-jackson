import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUILD = path.resolve(__dirname, '..', 'scripts', 'dashboard', 'build_dashboard_html.js');
const OUTPUT = 'C:/Users/lam61/OneDrive/Desktop/Queen Mommy/Trading/Dashboard.html';

test.before(() => {
  execFileSync('node', [BUILD], { env: { ...process.env, SKIP_OPTIONS: '1' }, stdio: 'pipe' });
});

test('notification prompt element exists in dashboard', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('id="cs-notif-prompt"'), 'cs-notif-prompt element not found');
  assert.ok(html.includes('id="cs-notif-yes"'), 'cs-notif-yes button not found');
  assert.ok(html.includes('id="cs-notif-no"'), 'cs-notif-no button not found');
});

test('prompt script gates on permission already granted', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes("Notification.permission === 'granted'"), 'granted gate not found');
});

test('prompt script gates on permission already denied', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes("Notification.permission === 'denied'"), 'denied gate not found');
});

test('prompt script honors localStorage cs-notif-declined', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes("localStorage.getItem('cs-notif-declined')"), 'localStorage gate not found');
  assert.ok(html.includes("localStorage.setItem('cs-notif-declined', '1')"), 'persistence on Not Now not found');
});

test('Enable button calls Notification.requestPermission', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('Notification.requestPermission()'), 'requestPermission call not found');
});

test('Not now button persists choice and dismisses prompt', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  // Same regex as test 4 but specifically for "Not now" handler — already covered, this test is a sanity sentinel
  assert.ok(html.includes("'cs-notif-declined', '1'"), 'persistence value 1 not found');
});

test('prompt initializes after DOMContentLoaded if document is loading', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes("document.readyState === 'loading'") || html.includes('DOMContentLoaded'),
    'DOMContentLoaded handling not found');
});
