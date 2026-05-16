# MCP Packet Tracing

Optional NDJSON trace of every CDP `evaluate()` and `evaluateWrite()` call inside the MCP server. Disabled by default; turn it on by setting one environment variable. Useful for:

- **Troubleshooting** — see exactly which tool a slow/failing CDP call belongs to, what JS it evaluated, and how long it took.
- **Latency profiling** — measure tool-call distributions over time without bolting on an APM.
- **Mutex visibility** — when the write-tool mutex queues calls, the trace exposes `wait_ms` (queue latency) and `work_ms` (critical-section duration) per call.
- **Operational forensics** — after an incident, replay exactly which Chrome calls fired and in what order.

The tracer is implemented in [`src/tracer.js`](../src/tracer.js). It is **off by default and zero-cost when off** — `evaluate()` / `evaluateWrite()` skip the trace branch in a single `if`. Tests live at [`tests/tracer.test.js`](../tests/tracer.test.js).

## Activate

```bash
# Minimal — write events to /tmp/mcp-trace.log
MCP_TRACE_FILE=/tmp/mcp-trace.log node src/server.js

# Tune the buffer + rotation
MCP_TRACE_FILE=/tmp/mcp-trace.log \
MCP_TRACE_BUFFER_MS=50 \
MCP_TRACE_MAX_MB=50 \
node src/server.js
```

When deployed as a launchd / systemd service, add to the service's environment block.

## Env vars

| Variable | Default | Meaning |
|---|---|---|
| `MCP_TRACE_FILE` | unset → **disabled** | NDJSON output path. Created if missing; appended otherwise. |
| `MCP_TRACE_MAX_MB` | `50` | Rotation threshold. When the file exceeds this, it's renamed to `<path>.1` (replacing any prior `.1`) and a fresh file is started. Single-level rotation only. |
| `MCP_TRACE_BUFFER_MS` | `50` | Internal flush interval (ms). Events are buffered in memory and flushed on this timer or when the buffer hits 64KB, whichever comes first. Plus a final flush on `process.beforeExit`. |
| `MCP_TRACE_SAMPLE` | `1.0` | Probabilistic sampling fraction `[0, 1]`. Set to `0.1` in high-volume production to cap trace volume. Sampling decision is per-span at start, so partial spans never appear. |
| `MCP_TRACE_DEBUG` | unset | When set, trace internal errors (disk full, rotation failure) print to stderr instead of being swallowed silently. |

## Output schema (NDJSON)

Each line is one JSON object terminated by `\n`. Multi-process safe: POSIX `write()` calls under PIPE_BUF (4KB) are atomic, and lines stay well under that. Multiple MCP subprocesses appending to the same file interleave cleanly at line granularity.

Fields:

| Field | Type | Always present? | Meaning |
|---|---|---|---|
| `ts` | string (ISO 8601) | yes | Event timestamp |
| `pid` | number | yes | Emitting process PID — useful to separate concurrent MCP subprocesses |
| `seq` | number | yes | Per-process monotonic sequence (starts at 1, increments per emitted line) |
| `kind` | string | yes | Event kind (see table below) |
| `id` | number | for span events | Span identifier — `start`/`end` of one logical call share the same `id` |
| `tool` | string | when attribution is active | MCP tool name (`chart_set_symbol`, `quote_get`, etc.) — attributed via the `withToolName` wrapper applied in `src/server.js` to every registered tool handler |
| `excerpt` | string | on `*.start` and `*.queued` events | First 80 chars of the JS expression (whitespace collapsed). Lets you tell at a glance which code path fired. |
| `dur_ms` | number | on `evaluate.end` and `evaluate.error` | Wall-clock duration of the underlying CDP call |
| `wait_ms` | number | on `evaluateWrite.acquired` | Time spent waiting in the mutex queue before this writer was granted the lock |
| `work_ms` | number | on `evaluateWrite.released` | Critical-section duration — how long the CDP work itself took inside the lock |
| `error` | string | on `*.error` | Truncated error message (200 char cap) |

Event kinds:

| Kind | Emitted by | What it means |
|---|---|---|
| `evaluate.start` | `evaluate()` | A read-class CDP call began |
| `evaluate.end` | `evaluate()` | Read completed normally |
| `evaluate.error` | `evaluate()` | Read threw — `error` field has the message |
| `evaluateWrite.queued` | `evaluateWrite()` | Single-evaluate write call entered the wrapper and is now queued behind the mutex |
| `evaluateWrite.acquired` | `evaluateWrite()` | Mutex granted to this writer; `wait_ms` shows the queue latency |
| `evaluateWrite.released` | `evaluateWrite()` | Inner CDP call returned and the mutex was released; `work_ms` shows critical-section time |
| `evaluateWrite.error` | `evaluateWrite()` | Inner CDP call threw — `error` field has the message |
| `writeLock.queued` | `withWriteLock(fn)` | Multi-step write SECTION entered the wrapper; queued behind the mutex |
| `writeLock.acquired` | `withWriteLock(fn)` | Mutex granted to this section; `wait_ms` = queue latency. The inner `fn` may now issue multiple `evaluate` calls (recorded as `evaluate.*` events) atomically under the lock. |
| `writeLock.released` | `withWriteLock(fn)` | Section finished; `work_ms` = total time the lock was held (covers all inner evaluate calls + sleeps + JS work) |
| `writeLock.error` | `withWriteLock(fn)` | Inner section threw |

## Sample analysis (jq)

```bash
TRACE=/tmp/mcp-trace.log

# 1) Distribution of mutex acquire times.
#    A healthy single-MCP run should see most values <1ms.
jq -r 'select(.kind=="evaluateWrite.acquired") | .wait_ms' "$TRACE" \
  | sort -n \
  | awk '{a[NR]=$1} END {
      print "count:", NR;
      print "p50:  ", a[int(NR*0.5)];
      print "p95:  ", a[int(NR*0.95)];
      print "p99:  ", a[int(NR*0.99)];
      print "max:  ", a[NR];
    }'

# 2) Calls per tool (requires tool attribution).
jq -r 'select(.kind=="evaluate.start" or .kind=="evaluateWrite.queued")
       | .tool // "unattributed"' "$TRACE" \
  | sort | uniq -c | sort -rn

# 3) Outliers — reads taking longer than 50ms.
jq 'select(.kind=="evaluate.end" and .dur_ms > 50)' "$TRACE"

# 4) Time-series of mutex contention.
#    Each line: timestamp, wait_ms. Plot in your tool of choice.
jq -r 'select(.kind=="evaluateWrite.acquired")
       | [.ts, .wait_ms] | @tsv' "$TRACE"

# 5) Errors.
jq 'select(.kind | endswith(".error"))' "$TRACE"

# 6) Find concurrent writer races across processes —
#    pairs of evaluateWrite.queued events that overlap in wall time.
#    Within one PID the mutex serializes, but across PIDs (legacy
#    stdio-per-consumer pattern) they can race in Chrome.
jq -s 'map(select(.kind=="evaluateWrite.queued"))
       | group_by(.pid)
       | length as $n
       | if $n > 1 then "multiple PIDs writing: \($n)" else "single PID" end' "$TRACE"

# 7) Live tail with friendly formatting.
tail -F "$TRACE" \
  | jq -r 'select(.kind | startswith("evaluateWrite"))
           | [.ts[11:19], .pid, .kind, .tool // "-",
              (.wait_ms // .work_ms // "" | tostring)] | @tsv'
```

## Multi-process notes

Each MCP subprocess writes to the same file. Lines interleave by completion order. To analyse a single process in isolation, filter by `pid`:

```bash
jq 'select(.pid == 16220)' "$TRACE"
```

The `seq` field is **per-process**, not global — two different PIDs can both have `seq: 5`. Use the `ts` for global ordering.

## Performance

The tracer is asynchronous and buffered. Concretely:

- Each call adds one JSON line to an in-memory array.
- The flush timer (default 50ms) writes the accumulated batch as one `fs.appendFile` call.
- The buffer also flushes synchronously when it hits 64KB.

When `MCP_TRACE_FILE` is unset (default), the trace code paths in `src/connection.js` short-circuit to a no-op stub before any string formatting or memory allocation. The cost is one `if (!config().enabled)` check per call — effectively free.

When the tracer is active, the per-call cost is dominated by `JSON.stringify` of the event object — typically a few microseconds. Disk write is amortised across the buffer interval.

## Rotation

When the trace file exceeds `MCP_TRACE_MAX_MB`, it's renamed to `<path>.1` (overwriting any prior `.1`) and a fresh empty file starts. **Single-level rotation, no compression.** This is intentionally minimal — for long-term retention pipe through logrotate, or run a sidecar that rotates by date.

## When to enable

| Scenario | Recommended setting |
|---|---|
| Local debugging — see what tools an agent called | `MCP_TRACE_FILE=/tmp/mcp-trace.log` |
| Production with periodic forensics | `MCP_TRACE_FILE=/var/log/mcp/trace.log` + `MCP_TRACE_MAX_MB=200` |
| High-volume production — keep volume cap | Add `MCP_TRACE_SAMPLE=0.1` to retain 10% of spans |
| Investigating a specific incident | Enable just before reproducing, disable after — no service restart needed if you can set env on the next subprocess spawn |

## Disabling

Unset the env var. Restart the server (or, for spawn-per-call patterns where each subprocess reads env at start, the next subprocess spawn picks up the absence and is tracer-free).

## Limitations

- Tracer state (buffer, counter) is per-OS-process. Long-running daemons keep their buffer in memory; short-lived spawn-per-query subprocesses flush + exit cleanly via `beforeExit`.
- `SIGKILL` (kill -9) and OOM kills lose any unflushed events. `SIGTERM` flushes via the `beforeExit` hook (Node's default lifecycle handles this).
- Rotation is not atomic relative to concurrent writers in other processes — if two MCPs both check size at the same moment, one might write to the (just-rotated) `.1`. This is rare and acceptable for diagnostics use.
- Sampling drops at the SPAN level (not per-event), so write-span lifecycle events (`queued`/`acquired`/`released`) all emit or none emit for a given call.
