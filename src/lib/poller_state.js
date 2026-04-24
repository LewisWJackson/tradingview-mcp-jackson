import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

export function createStateStore({ filePath, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  function read() {
    if (!fs.existsSync(filePath)) {
      return emptyState();
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return emptyState();
    }
  }

  function write(state) {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  function isFresh(now = new Date()) {
    if (!fs.existsSync(filePath)) return false;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return false;
    }
    if (!parsed.asOf) return false;
    const ageMs = now - new Date(parsed.asOf);
    return ageMs >= 0 && ageMs <= maxAgeMs;
  }

  return { read, write, isFresh };
}

function emptyState() {
  return {
    asOf: null,
    tickers: {},
    circuitBreaker: { status: 'closed', consecutiveFailures: 0, openedAt: null },
  };
}
