/**
 * journal-log.js unit tests — no TradingView connection needed.
 * Tests: stdout passthrough fidelity, BUY/SELL-only journaling, dedupe,
 * --dry-run writes nothing.
 *
 * Run: node --test tests/journal-log.test.js
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'journal-log.js');

const tmpRoot = mkdtempSync(join(tmpdir(), 'journal-log-test-'));
after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

let counter = 0;
function paths() {
  counter += 1;
  return {
    journal: join(tmpRoot, `journal-${counter}.jsonl`),
    state: join(tmpRoot, `state-${counter}.json`),
  };
}

function run(lines, { journal, state }, extraArgs = []) {
  const input = lines.join('\n') + '\n';
  try {
    const stdout = execFileSync(
      'node',
      [SCRIPT, '--journal', journal, '--state', state, ...extraArgs],
      { input, encoding: 'utf-8', timeout: 15000 },
    );
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

const buySignal = JSON.stringify({
  symbol: 'NSE:RELIANCE1!', side: 'BUY', entry: 1316.6, stop: 1308.4, target: 1333.0,
  rr: 2.0, rr_text: '1:2.0', bar_time: 1788434100, scan_time: '14:35 IST',
  reasons: ['5m trend BULL', '3m confirm OK'],
});
const sellSignal = JSON.stringify({
  symbol: 'MCX:GOLD1!', side: 'SELL', entry: 71000, stop: 71200, target: 70600,
  rr: 2.0, rr_text: '1:2.0', bar_time: 1788434400, scan_time: '19:10 IST',
  reasons: ['5m trend BEAR', '3m confirm OK'],
});
const waitSignal = JSON.stringify({ symbol: 'NSE:NIFTY', side: 'WAIT', reasons: ['no gate passed'] });
const invalidBuy = JSON.stringify({ symbol: 'NSE:SBIN1!', side: 'BUY' }); // missing required fields
const malformedLine = '{not valid json';
const commentLine = '# a comment';
const blankLine = '';

describe('journal-log — stdout passthrough', () => {
  it('reproduces stdin on stdout unchanged, line for line', () => {
    const lines = [buySignal, waitSignal, sellSignal, invalidBuy, malformedLine, commentLine, blankLine, 'trailing'];
    const p = paths();
    const { stdout, exitCode } = run(lines, p);
    assert.equal(exitCode, 0);
    assert.equal(stdout, lines.join('\n') + '\n');
  });
});

describe('journal-log — journaling', () => {
  it('journals valid BUY and SELL signals only', () => {
    const p = paths();
    run([buySignal, sellSignal, waitSignal, invalidBuy, malformedLine], p);
    assert.ok(existsSync(p.journal));
    const recorded = readFileSync(p.journal, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].symbol, 'NSE:RELIANCE1!');
    assert.equal(recorded[0].side, 'BUY');
    assert.equal(recorded[0].entry, 1316.6);
    assert.equal(recorded[0].stop, 1308.4);
    assert.equal(recorded[0].target, 1333.0);
    assert.ok(Array.isArray(recorded[0].reasons) && recorded[0].reasons.length > 0);
    assert.ok(typeof recorded[0].logged_at === 'string' && recorded[0].logged_at.length > 0);
    assert.equal(recorded[1].symbol, 'MCX:GOLD1!');
    assert.equal(recorded[1].side, 'SELL');
  });

  it('does not journal WAIT or invalid signals', () => {
    const p = paths();
    run([waitSignal, invalidBuy, malformedLine, commentLine, blankLine], p);
    assert.equal(existsSync(p.journal), false);
  });

  it('dedupes on symbol + side + bar_time across separate runs', () => {
    const p = paths();
    run([buySignal], p);
    const afterFirst = readFileSync(p.journal, 'utf-8').trim().split('\n');
    assert.equal(afterFirst.length, 1);

    run([buySignal], p); // same symbol/side/bar_time again
    const afterSecond = readFileSync(p.journal, 'utf-8').trim().split('\n');
    assert.equal(afterSecond.length, 1, 'repeated signal for the same bar must not be journaled twice');
  });

  it('journals a new bar_time for the same symbol/side as a separate entry', () => {
    const p = paths();
    const buyBarTwo = JSON.stringify({ ...JSON.parse(buySignal), bar_time: 1788434700 });
    run([buySignal], p);
    run([buyBarTwo], p);
    const lines = readFileSync(p.journal, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
  });
});

describe('journal-log — --dry-run', () => {
  it('writes neither the journal nor the state file', () => {
    const p = paths();
    const { exitCode } = run([buySignal, sellSignal], p, ['--dry-run']);
    assert.equal(exitCode, 0);
    assert.equal(existsSync(p.journal), false);
    assert.equal(existsSync(p.state), false);
  });
});
