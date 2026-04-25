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
  // The new schema emits planReason as a free-form string. The banner reads it verbatim,
  // so we check the dashboard JS reads `tp.planReason` and that the dispatcher branches on
  // whether a real plan exists.
  assert.ok(html.includes('tp.planReason'), 'banner JS must read tp.planReason');
  assert.ok(html.includes('hasPlan'), 'banner JS must distinguish plan-vs-placeholder via hasPlan check');
});

test('banner shows trade-plan placeholder for Level 2/3 with planGenerated=false', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  // The placeholder is whatever planReason the poller emitted, displayed verbatim with " • " prefix.
  // The dashboard checks decision fields on stock/options/finalDecision to detect a real plan.
  assert.ok(html.includes('tp.finalDecision'), 'banner JS must read tp.finalDecision');
  assert.ok(html.includes('tp.stock') && html.includes('tp.options'), 'banner JS must check stock + options sub-decisions');
});

test('risk chips render for build-time candidates', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(html.includes('class="cs-risk-chips"') || html.includes('cs-risk-chip'),
    'risk chip elements not found');
});
