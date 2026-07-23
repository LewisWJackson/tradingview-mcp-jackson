import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultTradingViewCandidates,
  discoverTradingViewBinary,
  discoverWindowsMsixTradingView,
} from '../src/core/tradingview-binary.js';

test('Windows candidates include traditional install locations', () => {
  const candidates = defaultTradingViewCandidates('win32', {
    LOCALAPPDATA: 'C:\\Local',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  });

  assert.deepEqual(candidates, [
    'C:\\Local\\TradingView\\TradingView.exe',
    'C:\\Program Files\\TradingView\\TradingView.exe',
    'C:\\Program Files (x86)\\TradingView\\TradingView.exe',
  ]);
});

test('MSIX discovery returns executable emitted by PowerShell', () => {
  const expected = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_1\\TradingView.exe';
  const found = discoverWindowsMsixTradingView({
    exists: (path) => path === expected,
    execFile: () => expected,
  });
  assert.equal(found, expected);
});

test('MSIX discovery returns null when PowerShell fails', () => {
  const found = discoverWindowsMsixTradingView({
    exists: () => true,
    execFile: () => { throw new Error('PowerShell unavailable'); },
  });
  assert.equal(found, null);
});

test('binary discovery falls back to MSIX on Windows', () => {
  const expected = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_1\\TradingView.exe';
  const result = discoverTradingViewBinary({
    platform: 'win32',
    env: {
      LOCALAPPDATA: 'C:\\Missing',
      PROGRAMFILES: 'C:\\Missing',
      'PROGRAMFILES(X86)': 'C:\\Missing',
    },
    exists: (path) => path === expected,
    exec: () => { throw new Error('where failed'); },
    execFile: () => expected,
  });

  assert.equal(result.path, expected);
  assert.equal(result.source, 'windows-msix');
});
