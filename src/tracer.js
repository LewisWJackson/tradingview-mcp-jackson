/**
 * src/tracer.js — optional NDJSON packet tracer for MCP tool dispatch.
 *
 * Disabled by default. Activates when MCP_TRACE_FILE is set.
 *
 * Captures every evaluate() and evaluateWrite() call with timing and
 * (when tool-name attribution is wired through registerTool wrappers
 * in src/server.js) the originating MCP tool name. Each event is one
 * NDJSON line; the file can be tailed live or parsed offline with jq.
 *
 * Design choices:
 *   - Lazy-init on first call. Zero cost when MCP_TRACE_FILE is unset.
 *   - Async fire-and-forget appendFile. Buffered: events accumulate in
 *     memory and flush every MCP_TRACE_BUFFER_MS (default 50ms) or when
 *     buffer hits 64KB, whichever comes first. Flush on process.beforeExit.
 *   - Multi-process safe: POSIX write() under PIPE_BUF (4KB on most
 *     systems) is atomic, and our NDJSON lines stay well under that
 *     (typical line is 150-300 bytes). Concurrent appends from multiple
 *     MCP subprocesses interleave at line granularity without tearing.
 *   - Size-based rotation: when the file exceeds MCP_TRACE_MAX_MB
 *     (default 50MB), it's renamed to "<path>.1" (replacing any prior
 *     .1) and a fresh empty file is started. Single-level rotation —
 *     intentionally minimal complexity. Operators wanting long-term
 *     retention should pipe through logrotate or similar.
 *   - Probabilistic sampling: MCP_TRACE_SAMPLE (0.0-1.0, default 1.0)
 *     drops events. Sampling decision is per-span at start; if a span
 *     is sampled in, all of its lifecycle events emit (so partial
 *     spans never appear). Use sample=0.1 in heavy production to cap
 *     volume.
 *   - Tool-name attribution via AsyncLocalStorage. server.js wraps each
 *     registerTool callback in toolContext.run(name, fn) so any
 *     evaluate/evaluateWrite called inside the handler sees the tool
 *     name via traceCurrentTool().
 *
 * Output schema (NDJSON):
 *   { ts, pid, seq, kind, id, tool?, excerpt?, dur_ms?, wait_ms?,
 *     work_ms?, error? }
 *
 *   kind ∈ {
 *     "evaluate.start", "evaluate.end", "evaluate.error",
 *     "evaluateWrite.queued", "evaluateWrite.acquired",
 *     "evaluateWrite.released", "evaluateWrite.error"
 *   }
 *
 * Sample analysis (jq):
 *   # mutex acquire-time distribution
 *   jq -r 'select(.kind=="evaluateWrite.acquired") | .wait_ms' trace.log
 *   # outliers
 *   jq 'select(.kind=="evaluate.end" and .dur_ms > 50)' trace.log
 *   # call rate per tool
 *   jq -r 'select(.kind=="evaluate.start") | .tool // "unattributed"' \
 *     trace.log | sort | uniq -c
 */
import { AsyncLocalStorage } from "async_hooks";
import { appendFile, stat, rename } from "fs/promises";

// ─── Configuration (env-driven, read once on first activation) ────────
let _config = null;
function config() {
  if (_config) return _config;
  const file = process.env.MCP_TRACE_FILE || null;
  if (!file) {
    _config = { enabled: false };
    return _config;
  }
  const maxMB = parseFloat(process.env.MCP_TRACE_MAX_MB);
  const bufferMsRaw = process.env.MCP_TRACE_BUFFER_MS;
  const bufferMs = bufferMsRaw === undefined ? 0 : parseInt(bufferMsRaw, 10);
  const sample = parseFloat(process.env.MCP_TRACE_SAMPLE);
  _config = {
    enabled: true,
    file,
    maxBytes: (isNaN(maxMB) || maxMB <= 0 ? 50 : maxMB) * 1024 * 1024,
    // bufferMs default is 0 = immediate fire-and-forget append per event.
    // This is the right default for spawn-per-call architectures (LENS,
    // AURUM) where each MCP subprocess gets SIGKILLed after returning
    // its response — a buffered flush timer rarely fires in time. Set
    // MCP_TRACE_BUFFER_MS=50 (or higher) to opt in to buffering in
    // long-running deployments (e.g. F3 Streamable HTTP daemon).
    bufferMs: isNaN(bufferMs) || bufferMs < 0 ? 0 : bufferMs,
    sample: isNaN(sample) || sample < 0 || sample > 1 ? 1.0 : sample,
  };
  return _config;
}

// ─── Tool-name attribution context ────────────────────────────────────
const toolContext = new AsyncLocalStorage();

/**
 * Wrap a tool handler so any evaluate/evaluateWrite call inside its
 * async stack picks up the tool name via traceCurrentTool().
 * Called from src/server.js when registering each tool.
 *
 * @param {string} toolName
 * @param {Function} handler - the original tool callback
 * @returns {Function} wrapped handler
 */
export function withToolName(toolName, handler) {
  if (!config().enabled) return handler;
  return async (...args) => toolContext.run(toolName, () => handler(...args));
}

/** Returns the current tool name in scope, or undefined. */
export function traceCurrentTool() {
  return toolContext.getStore();
}

// ─── Buffer + flush loop ──────────────────────────────────────────────
let _seq = 0;
let _buffer = [];
let _bufferBytes = 0;
let _flushTimer = null;
let _flushing = false;
let _exitHooked = false;

const BUFFER_BYTES_MAX = 64 * 1024;

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(flush, config().bufferMs);
  // Don't keep the event loop alive solely for this timer.
  if (_flushTimer.unref) _flushTimer.unref();
}

async function flush() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (_buffer.length === 0 || _flushing) return;
  _flushing = true;
  const chunk = _buffer.join("");
  _buffer = [];
  _bufferBytes = 0;
  try {
    await appendFile(config().file, chunk);
    await maybeRotate();
  } catch (e) {
    // Tracer must never break the MCP server. Print to stderr so the
    // operator notices but don't throw.
    if (process.env.MCP_TRACE_DEBUG)
      console.error("[tracer] flush error:", e.message || e);
  } finally {
    _flushing = false;
    if (_buffer.length > 0) scheduleFlush();
  }
}

async function maybeRotate() {
  const cfg = config();
  if (!cfg.enabled) return;
  try {
    const s = await stat(cfg.file);
    if (s.size <= cfg.maxBytes) return;
  } catch {
    return; // file disappeared — nothing to do
  }
  try {
    await rename(cfg.file, `${cfg.file}.1`);
  } catch (e) {
    if (process.env.MCP_TRACE_DEBUG)
      console.error("[tracer] rotate error:", e.message || e);
  }
}

// Serialised write queue — used when bufferMs=0 (immediate mode) to
// preserve emission order while doing fire-and-forget async appends.
let _writeQueue = Promise.resolve();

function emit(line) {
  if (config().bufferMs === 0) {
    // Immediate mode: chain this append onto the write queue. Order
    // within one process is preserved. Each appendFile call is a single
    // write() syscall — the data hits the kernel page cache before the
    // promise settles, so SIGKILL after the chain link resolves is safe
    // (the kernel flushes its page cache asynchronously regardless of
    // whether our process is alive).
    _writeQueue = _writeQueue.then(() =>
      appendFile(config().file, line).catch((e) => {
        if (process.env.MCP_TRACE_DEBUG)
          console.error("[tracer] write error:", e.message || e);
      }),
    );
    // Rotation check piggybacks on the queue so it doesn't race with
    // writes.
    _writeQueue = _writeQueue.then(() => maybeRotate());
    hookExit();
    return;
  }
  // Buffered mode (operator opted in via MCP_TRACE_BUFFER_MS > 0).
  _buffer.push(line);
  _bufferBytes += line.length;
  if (_bufferBytes >= BUFFER_BYTES_MAX) {
    flush();
  } else {
    scheduleFlush();
  }
  hookExit();
}

function hookExit() {
  if (_exitHooked) return;
  _exitHooked = true;
  // beforeExit fires when the loop is about to empty; we get a chance
  // to drain pending writes / flush the buffer before the process
  // exits cleanly. SIGTERM that triggers a clean exit also fires this.
  // SIGKILL (= kill -9) and OOM-killer don't — accept the loss for
  // those rare cases.
  process.on("beforeExit", async () => {
    if (_buffer.length > 0) await flush();
    await _writeQueue.catch(() => {});
  });
}

// ─── Truncate JS expression for the excerpt field ─────────────────────
const EXCERPT_MAX = 80;
function excerptOf(expression) {
  return String(expression).replace(/\s+/g, " ").slice(0, EXCERPT_MAX);
}

function nextSeq() {
  return ++_seq;
}

function nowMs() {
  return performance.now();
}

function shouldSample() {
  const cfg = config();
  if (cfg.sample >= 1.0) return true;
  if (cfg.sample <= 0.0) return false;
  return Math.random() < cfg.sample;
}

// ─── Public trace API used by connection.js ───────────────────────────
//
// trace.start(kind, expression) — begin a non-locked (read) span.
//   Returns a span handle: { end(), error(msg) }
//
// trace.startWrite(expression) — begin a write span (covers
//   evaluateWrite). Returns { acquired(), released(), error(msg) }.
//
// trace itself is exported as a callable for back-compat: trace(kind, info)
//   logs a single one-shot event. Mostly used internally for tests.

function logOne(kind, info) {
  if (!config().enabled) return;
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      seq: nextSeq(),
      kind,
      ...info,
    }) + "\n";
  emit(line);
}

export const trace = Object.assign(logOne, {
  /**
   * Begin a read-span around a CDP evaluate() call.
   * No-op (returns a stub) when tracer is disabled or sample drops.
   */
  start(kind, expression) {
    if (!config().enabled || !shouldSample()) return SPAN_NOOP;
    const id = nextSeq() + 1; // use the seq of our first emitted event
    const tool = traceCurrentTool();
    const t0 = nowMs();
    logOne(`${kind}.start`, {
      id,
      tool,
      excerpt: excerptOf(expression),
    });
    return {
      end() {
        logOne(`${kind}.end`, {
          id,
          tool,
          dur_ms: +(nowMs() - t0).toFixed(2),
        });
      },
      error(msg) {
        logOne(`${kind}.error`, {
          id,
          tool,
          dur_ms: +(nowMs() - t0).toFixed(2),
          error: String(msg).slice(0, 200),
        });
      },
    };
  },

  /**
   * Begin a multi-step write-section around a withWriteLock() block.
   * Same lifecycle as startWrite (queued/acquired/released) but emits
   * kind=writeLock.* instead of evaluateWrite.* — keeps the trace
   * unambiguous about which path took the mutex (single-evaluate
   * write vs multi-step block).
   */
  startSection() {
    if (!config().enabled || !shouldSample()) return WRITE_SPAN_NOOP;
    const id = nextSeq() + 1;
    const tool = traceCurrentTool();
    const tQueued = nowMs();
    let tAcquired = 0;
    logOne("writeLock.queued", { id, tool });
    return {
      acquired() {
        tAcquired = nowMs();
        logOne("writeLock.acquired", {
          id,
          tool,
          wait_ms: +(tAcquired - tQueued).toFixed(2),
        });
      },
      released() {
        logOne("writeLock.released", {
          id,
          tool,
          work_ms: +(nowMs() - tAcquired).toFixed(2),
        });
      },
      error(msg) {
        logOne("writeLock.error", {
          id,
          tool,
          error: String(msg).slice(0, 200),
        });
      },
    };
  },

  /**
   * Begin a write-span around an evaluateWrite() call. Captures three
   * lifecycle events: queued (call entered the wrapper), acquired
   * (mutex grant) with wait_ms, released (CDP completed) with work_ms.
   */
  startWrite(expression) {
    if (!config().enabled || !shouldSample()) return WRITE_SPAN_NOOP;
    const id = nextSeq() + 1;
    const tool = traceCurrentTool();
    const tQueued = nowMs();
    let tAcquired = 0;
    logOne("evaluateWrite.queued", {
      id,
      tool,
      excerpt: excerptOf(expression),
    });
    return {
      acquired() {
        tAcquired = nowMs();
        logOne("evaluateWrite.acquired", {
          id,
          tool,
          wait_ms: +(tAcquired - tQueued).toFixed(2),
        });
      },
      released() {
        logOne("evaluateWrite.released", {
          id,
          tool,
          work_ms: +(nowMs() - tAcquired).toFixed(2),
        });
      },
      error(msg) {
        logOne("evaluateWrite.error", {
          id,
          tool,
          error: String(msg).slice(0, 200),
        });
      },
    };
  },

  /** Internal: force-flush pending buffer (used by tests). */
  async _flush() {
    await flush();
  },

  /** Internal: returns current config snapshot (used by tests). */
  _config() {
    return { ...config() };
  },

  /** Internal: reset state (used by tests). */
  _reset() {
    _config = null;
    _seq = 0;
    _buffer = [];
    _bufferBytes = 0;
    if (_flushTimer) {
      clearTimeout(_flushTimer);
      _flushTimer = null;
    }
    _flushing = false;
  },
});

// No-op spans returned when tracing is disabled or sample drops.
const SPAN_NOOP = Object.freeze({ end() {}, error() {} });
const WRITE_SPAN_NOOP = Object.freeze({ acquired() {}, released() {}, error() {} });
