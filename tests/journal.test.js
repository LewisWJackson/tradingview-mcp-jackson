/**
 * Unit tests for the replay-backtest trade journal (src/core/journal.js).
 * Offline — uses a temp journal_path, never touches ~/.tradingview-mcp/journal.json.
 *
 * Run: node --test tests/journal.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as journal from '../src/core/journal.js';

let dir, journal_path;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tv-journal-test-'));
  journal_path = join(dir, 'journal.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('journal core', () => {
  it('records a winning trade', () => {
    journal.recordOpen({ symbol: 'OANDA:GBPUSD', timeframe: '240', side: 'buy', currentDate: '2026-01-01', cumulativePnl: 100, tag: 'fvg-retest', journal_path });
    const { recorded, trade } = journal.recordClose({ currentDate: '2026-01-02', cumulativePnl: 150, journal_path });

    assert.equal(recorded, true);
    assert.equal(trade.outcome, 'win');
    assert.equal(trade.pnl_delta, 50);
    assert.equal(trade.tag, 'fvg-retest');
    assert.equal(trade.symbol, 'OANDA:GBPUSD');
  });

  it('records a losing trade', () => {
    journal.recordOpen({ symbol: 'OANDA:GBPUSD', timeframe: '240', side: 'sell', currentDate: '2026-01-01', cumulativePnl: 100, journal_path });
    const { trade } = journal.recordClose({ currentDate: '2026-01-02', cumulativePnl: 80, journal_path });

    assert.equal(trade.outcome, 'loss');
    assert.equal(trade.pnl_delta, -20);
  });

  it('records a breakeven trade', () => {
    journal.recordOpen({ symbol: 'BTCUSD', timeframe: '60', side: 'buy', currentDate: '2026-01-01', cumulativePnl: 0, journal_path });
    const { trade } = journal.recordClose({ currentDate: '2026-01-02', cumulativePnl: 0, journal_path });

    assert.equal(trade.outcome, 'breakeven');
    assert.equal(trade.pnl_delta, 0);
  });

  it('close with nothing pending is a no-op', () => {
    const result = journal.recordClose({ currentDate: '2026-01-02', cumulativePnl: 50, journal_path });
    assert.equal(result.recorded, false);
    assert.equal(journal.getTrades({ journal_path }).trades.length, 0);
  });

  it('a second open overwrites pending without journaling the first leg (flip case)', () => {
    journal.recordOpen({ symbol: 'BTCUSD', timeframe: '60', side: 'buy', currentDate: '2026-01-01', cumulativePnl: 0, journal_path });
    journal.recordOpen({ symbol: 'BTCUSD', timeframe: '60', side: 'sell', currentDate: '2026-01-02', cumulativePnl: 10, journal_path });
    journal.recordClose({ currentDate: '2026-01-03', cumulativePnl: 30, journal_path });

    const { trades } = journal.getTrades({ journal_path });
    assert.equal(trades.length, 1);
    assert.equal(trades[0].side, 'sell');
    assert.equal(trades[0].pnl_delta, 20);
  });

  it('getTrades filters by tag and symbol, most-recent-first, respects limit', () => {
    journal.recordOpen({ symbol: 'BTCUSD', side: 'buy', currentDate: 'd1', cumulativePnl: 0, tag: 'a', journal_path });
    journal.recordClose({ currentDate: 'd1', cumulativePnl: 10, journal_path });
    journal.recordOpen({ symbol: 'ETHUSD', side: 'buy', currentDate: 'd2', cumulativePnl: 10, tag: 'b', journal_path });
    journal.recordClose({ currentDate: 'd2', cumulativePnl: 5, journal_path });
    journal.recordOpen({ symbol: 'BTCUSD', side: 'sell', currentDate: 'd3', cumulativePnl: 5, tag: 'a', journal_path });
    journal.recordClose({ currentDate: 'd3', cumulativePnl: 25, journal_path });

    const all = journal.getTrades({ journal_path }).trades;
    assert.equal(all.length, 3);
    assert.equal(all[0].opened_date, 'd3'); // most recent first

    const tagA = journal.getTrades({ tag: 'a', journal_path }).trades;
    assert.equal(tagA.length, 2);

    const btc = journal.getTrades({ symbol: 'BTCUSD', journal_path }).trades;
    assert.equal(btc.length, 2);

    const limited = journal.getTrades({ limit: 1, journal_path }).trades;
    assert.equal(limited.length, 1);
  });

  it('getStats groups by tag with win rate and total pnl', () => {
    journal.recordOpen({ symbol: 'BTCUSD', side: 'buy', currentDate: 'd1', cumulativePnl: 0, tag: 'fvg', journal_path });
    journal.recordClose({ currentDate: 'd1', cumulativePnl: 10, journal_path }); // win
    journal.recordOpen({ symbol: 'BTCUSD', side: 'buy', currentDate: 'd2', cumulativePnl: 10, tag: 'fvg', journal_path });
    journal.recordClose({ currentDate: 'd2', cumulativePnl: 0, journal_path }); // loss (-10)
    journal.recordOpen({ symbol: 'BTCUSD', side: 'sell', currentDate: 'd3', cumulativePnl: 0, tag: 'sweep', journal_path });
    journal.recordClose({ currentDate: 'd3', cumulativePnl: 20, journal_path }); // win

    const stats = journal.getStats({ journal_path });
    assert.equal(stats.overall.count, 3);
    assert.equal(stats.overall.wins, 2);
    assert.equal(stats.overall.losses, 1);
    assert.equal(stats.by_tag.fvg.count, 2);
    assert.equal(stats.by_tag.fvg.win_rate, 0.5);
    assert.equal(stats.by_tag.sweep.win_rate, 1);

    const fvgOnly = journal.getStats({ tag: 'fvg', journal_path });
    assert.equal(fvgOnly.count, 2);
    assert.equal(fvgOnly.total_pnl, 0);
  });

  it('clear wipes all trades and pending', () => {
    journal.recordOpen({ symbol: 'BTCUSD', side: 'buy', currentDate: 'd1', cumulativePnl: 0, journal_path });
    journal.recordClose({ currentDate: 'd2', cumulativePnl: 10, journal_path });
    journal.clear({ journal_path });

    const { trades, pending } = journal.getTrades({ journal_path });
    assert.equal(trades.length, 0);
    assert.equal(pending, null);
  });
});
