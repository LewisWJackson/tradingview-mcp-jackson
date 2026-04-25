import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUILD = path.resolve(__dirname, '..', 'scripts', 'dashboard', 'build_dashboard_html.js');
const OUTPUT = 'C:/Users/lam61/OneDrive/Desktop/Queen Mommy/Trading/Dashboard.html';

test('build_dashboard_html.js runs to completion and emits HTML', { timeout: 120_000 }, () => {
  // Run the builder with options skipped for speed.
  // It writes Dashboard.html to the user's vault path.
  execFileSync('node', [BUILD], { env: { ...process.env, SKIP_OPTIONS: '1' }, stdio: 'pipe' });
  assert.ok(fs.existsSync(OUTPUT), 'Dashboard.html should exist after build');
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.length > 1000, 'Dashboard.html is non-trivial');
});

test('generated dashboard contains SSE client script', { timeout: 120_000 }, () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes("new EventSource('/events')"), 'SSE EventSource not found');
  assert.ok(html.includes("addEventListener('tick'"), 'tick listener not found');
  assert.ok(html.includes("addEventListener('fire'"), 'fire listener not found');
  assert.ok(html.includes("addEventListener('source_status'"), 'source_status listener not found');
});

test('generated dashboard contains live-price + delta + fire-badge spans', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('class="cs-live-price"'), 'cs-live-price class not found');
  assert.ok(html.includes('class="cs-delta-to-trigger"'), 'cs-delta-to-trigger class not found');
  assert.ok(html.includes('class="cs-fire-badge"'), 'cs-fire-badge class not found');
  assert.ok(html.includes('data-cs-row='), 'data-cs-row attribute not found');
});

test('generated dashboard contains source-status banner element', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('id="cs-source-banner"'), 'cs-source-banner not found');
});

test('generated dashboard hydrates window.__todaysFires from fire log', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('window.__todaysFires ='), '__todaysFires hydration script not found');
});

test('CSS rules for new elements present', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('.cs-fired-today'), 'CSS .cs-fired-today not found');
  assert.ok(html.includes('.cs-fire-badge'), 'CSS .cs-fire-badge not found');
  assert.ok(html.includes('.cs-live-price'), 'CSS .cs-live-price not found');
});
