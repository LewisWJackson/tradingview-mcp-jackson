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

// Build once for all tests in this file (Task 13 pattern)
test.before(() => {
  execFileSync('node', [BUILD], { env: { ...process.env, SKIP_OPTIONS: '1' }, stdio: 'pipe' });
});

test('fire banner element exists in dashboard', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('id="cs-fire-banner"'), 'fire banner element not found');
  assert.ok(html.includes('id="cs-fire-banner-text"'), 'fire banner text span not found');
});

test('window.__onDashboardFire handler is wired', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('window.__onDashboardFire = function'), 'fire handler not assigned');
});

test('showFireBanner function defined', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('function showFireBanner'), 'showFireBanner not defined');
});

test('dispatchFireToast function defined', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('function dispatchFireToast'), 'dispatchFireToast not defined');
});

test('toast dispatcher gates on Notification.permission === granted', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes("Notification.permission !== 'granted'") || html.includes('Notification.permission !== "granted"'),
    'permission gate not found in toast dispatcher');
});

test('toast dispatcher only fires for Level 2 and Level 3', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('f.fireStrength === 2 || f.fireStrength === 3') ||
            html.includes('fireStrength === 2 || fireStrength === 3'),
    'Level 2/3 gate on toast dispatcher not found');
});

test('banner shows degraded-source warning when tradePlan.planReason indicates degraded', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('degraded_source_no_plan'), 'degraded source case not handled');
  assert.ok(html.includes('verify before acting'), 'degraded warning text not found');
});

test('banner shows trade-plan placeholder for Level 2/3 with planGenerated=false', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('Trade plan: pending implementation'), 'trade plan placeholder not found');
});

test('risk chips render for build-time candidates', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('class="cs-risk-chips"') || html.includes('cs-risk-chip'),
    'risk chip elements not found');
});
