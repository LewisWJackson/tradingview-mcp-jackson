import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUILD = path.resolve(__dirname, '..', 'scripts', 'dashboard', 'build_dashboard_html.js');
// Use a per-test output path so we don't race against other dashboard_*.test.js
// files that read the shared Dashboard.html.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-shadow-'));
const OUTPUT_ON = path.join(TMP_DIR, 'Dashboard-shadow-on.html');
const OUTPUT_OFF = path.join(TMP_DIR, 'Dashboard-shadow-off.html');
const INPUT = 'C:/Users/lam61/OneDrive/Desktop/ETrade Activity_4.11.26.xlsx';

test('build with SHADOW_MODE=1 emits shadow banner', () => {
  execFileSync('node', [BUILD, INPUT, OUTPUT_ON], { env: { ...process.env, SHADOW_MODE: '1', SKIP_OPTIONS: '1' }, stdio: 'pipe' });
  const html = fs.readFileSync(OUTPUT_ON, 'utf8');
  assert.ok(html.includes('id="cs-shadow-banner"'), 'cs-shadow-banner not found');
  assert.ok(html.includes('SHADOW MODE'), 'SHADOW MODE label not found');
  assert.ok(html.includes('window.__shadowMode = true'), '__shadowMode flag not set true');
});

test('build without SHADOW_MODE omits shadow banner', () => {
  // Explicitly delete SHADOW_MODE from env to avoid any inherited value
  const env = { ...process.env, SKIP_OPTIONS: '1' };
  delete env.SHADOW_MODE;
  execFileSync('node', [BUILD, INPUT, OUTPUT_OFF], { env, stdio: 'pipe' });
  const html = fs.readFileSync(OUTPUT_OFF, 'utf8');
  assert.ok(!html.includes('id="cs-shadow-banner"'), 'cs-shadow-banner should not be present');
  assert.ok(html.includes('window.__shadowMode = false'), '__shadowMode flag should be false');
});

test('toast dispatcher suppresses notifications in shadow mode', () => {
  // Assert against the SHADOW_MODE-on build so we verify BOTH that the dispatcher's
  // early-return guard exists AND that __shadowMode is true at runtime in this build.
  // Asserting against the OFF build would pass vacuously since the guard is static JS
  // source present in every build regardless of SHADOW_MODE.
  if (!fs.existsSync(OUTPUT_ON)) {
    execFileSync('node', [BUILD, INPUT, OUTPUT_ON], { env: { ...process.env, SHADOW_MODE: '1', SKIP_OPTIONS: '1' }, stdio: 'pipe' });
  }
  const html = fs.readFileSync(OUTPUT_ON, 'utf8');
  // (1) Early-return guard exists in the dispatcher source
  assert.ok(html.includes('window.__shadowMode === true'), 'toast dispatcher must check window.__shadowMode');
  // (2) This build sets the flag true — together with (1), the runtime path skips Notification dispatch
  assert.ok(html.includes('window.__shadowMode = true'), 'shadow-on build must set __shadowMode = true');
  assert.ok(html.includes('function dispatchFireToast'), 'dispatchFireToast function not found');
});

test('operations doc exists and covers required topics', () => {
  const docPath = path.resolve(__dirname, '..', 'docs', 'live-feed-operations.md');
  assert.ok(fs.existsSync(docPath), 'docs/live-feed-operations.md must exist');
  const md = fs.readFileSync(docPath, 'utf8');
  // Required topics
  for (const topic of ['Start the live server', 'Shadow mode', 'Files produced', 'Polling cadence', 'Market-hours behavior', 'Autostart', 'Common issues']) {
    assert.ok(md.includes(topic), `operations doc missing topic: ${topic}`);
  }
  assert.ok(md.includes('SHADOW_MODE=1'), 'doc must show how to enable shadow mode');
});
