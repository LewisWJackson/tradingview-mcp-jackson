/**
 * Server-Sent Events broadcaster.
 *
 * Pure factory — manages a Set of active client response objects and sends
 * formatted SSE payloads to all of them.
 *
 * Usage:
 *   const b = createSseBroadcaster();
 *   // In your HTTP handler:
 *   b.handleClient(req, res);           // adds the client, registers cleanup
 *   // From anywhere with a reference to `b`:
 *   b.broadcast('fire', { ticker: 'APH', ... });
 *   b.clientCount();                    // → number of active subscribers
 */

export function createSseBroadcaster() {
  const clients = new Set();

  function handleClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    try { res.write(': connected\n\n'); } catch (e) { /* client already gone */ }
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function broadcast(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); }
      catch (e) { clients.delete(res); }
    }
  }

  function clientCount() { return clients.size; }

  return { handleClient, broadcast, clientCount };
}
