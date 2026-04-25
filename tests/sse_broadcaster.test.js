import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { createSseBroadcaster } from '../src/lib/sse_broadcaster.js';

function mockRes() {
  const writes = [];
  const headers = {};
  let statusCode = null;
  return {
    writeHead(code, h) { statusCode = code; Object.assign(headers, h); },
    write(chunk) { writes.push(chunk); return true; },
    writes, headers, getStatusCode: () => statusCode,
  };
}

function mockReq() {
  const ee = new EventEmitter();
  ee.on = ee.on.bind(ee);
  return ee;
}

test('handleClient sets correct SSE headers and sends initial comment', () => {
  const b = createSseBroadcaster();
  const req = mockReq();
  const res = mockRes();
  b.handleClient(req, res);
  assert.strictEqual(res.getStatusCode(), 200);
  assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
  assert.strictEqual(res.headers['Cache-Control'], 'no-cache');
  assert.strictEqual(res.headers['Connection'], 'keep-alive');
  assert.strictEqual(res.writes[0], ': connected\n\n');
});

test('broadcast sends properly formatted event to all clients', () => {
  const b = createSseBroadcaster();
  const req1 = mockReq(), res1 = mockRes();
  const req2 = mockReq(), res2 = mockRes();
  b.handleClient(req1, res1);
  b.handleClient(req2, res2);
  b.broadcast('fire', { ticker: 'APH', price: 152.85 });
  assert.strictEqual(res1.writes.length, 2, 'initial : connected + event');
  assert.strictEqual(res2.writes.length, 2);
  const expected = 'event: fire\ndata: {"ticker":"APH","price":152.85}\n\n';
  assert.strictEqual(res1.writes[1], expected);
  assert.strictEqual(res2.writes[1], expected);
});

test('clientCount reflects active subscribers', () => {
  const b = createSseBroadcaster();
  assert.strictEqual(b.clientCount(), 0);
  const req1 = mockReq(), res1 = mockRes();
  b.handleClient(req1, res1);
  assert.strictEqual(b.clientCount(), 1);
  const req2 = mockReq(), res2 = mockRes();
  b.handleClient(req2, res2);
  assert.strictEqual(b.clientCount(), 2);
});

test('client is removed from set when req emits close', () => {
  const b = createSseBroadcaster();
  const req = mockReq();
  const res = mockRes();
  b.handleClient(req, res);
  assert.strictEqual(b.clientCount(), 1);
  req.emit('close');
  assert.strictEqual(b.clientCount(), 0);
});

test('broadcast gracefully removes clients that throw on write', () => {
  const b = createSseBroadcaster();
  const goodReq = mockReq(), goodRes = mockRes();
  const badReq = mockReq(), badRes = {
    writeHead() {}, write(chunk) { throw new Error('EPIPE'); },
  };
  b.handleClient(goodReq, goodRes);
  b.handleClient(badReq, badRes);
  assert.strictEqual(b.clientCount(), 2);
  b.broadcast('tick', { symbol: 'X' });
  // bad client should be pruned after write error
  assert.strictEqual(b.clientCount(), 1);
  // good client still received the event
  assert.ok(goodRes.writes.some(w => w.includes('event: tick')));
});

test('broadcast serializes nested objects (trade plan contract propagates)', () => {
  const b = createSseBroadcaster();
  const req = mockReq();
  const res = mockRes();
  b.handleClient(req, res);
  const event = {
    ticker: 'X',
    fireStrength: 2,
    tradePlan: { planGenerated: false, planReason: 'not_yet_implemented', stock: null, options: null, finalRecommendation: null },
  };
  b.broadcast('fire', event);
  const payload = res.writes[1];
  assert.ok(payload.includes('"tradePlan"'));
  assert.ok(payload.includes('"planGenerated":false'));
  assert.ok(payload.includes('"planReason":"not_yet_implemented"'));
});
