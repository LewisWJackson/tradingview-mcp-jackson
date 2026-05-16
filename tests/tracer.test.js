/**
 * tests/tracer.test.js — exercises the optional NDJSON tracer in src/tracer.js.
 *
 * The tracer is disabled when MCP_TRACE_FILE is unset. These tests set
 * the env var before importing the module (after each test, _reset()
 * clears state and the next test reads env afresh).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir;
let tracer;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "tracer-test-"));
});

after(async () => {
  // Best-effort cleanup; not critical if it fails.
  try {
    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
  } catch {}
});

async function freshTracer(envOverrides = {}) {
  // Reset cached config and re-import so env changes take effect.
  delete process.env.MCP_TRACE_FILE;
  delete process.env.MCP_TRACE_MAX_MB;
  delete process.env.MCP_TRACE_BUFFER_MS;
  delete process.env.MCP_TRACE_SAMPLE;
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  // Bust the module cache so a fresh _config() read happens.
  const mod = await import(`../src/tracer.js?t=${Date.now()}`);
  mod.trace._reset();
  return mod;
}

test("tracer disabled when MCP_TRACE_FILE is unset — no file written", async () => {
  const mod = await freshTracer({});
  const span = mod.trace.start("evaluate", "1 + 1");
  span.end();
  await mod.trace._flush();
  assert.equal(mod.trace._config().enabled, false);
});

test("tracer writes one NDJSON line per emit", async () => {
  const file = join(tmpDir, "single.log");
  const mod = await freshTracer({
    MCP_TRACE_FILE: file,
    MCP_TRACE_BUFFER_MS: "10",
  });
  // Direct one-shot call.
  mod.trace("custom.event", { foo: "bar", n: 42 });
  await mod.trace._flush();
  const contents = await readFile(file, "utf8");
  const lines = contents.trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.kind, "custom.event");
  assert.equal(parsed.foo, "bar");
  assert.equal(parsed.n, 42);
  assert.equal(typeof parsed.ts, "string");
  assert.equal(typeof parsed.pid, "number");
  assert.equal(typeof parsed.seq, "number");
});

test("tracer captures evaluate span — start + end with dur_ms", async () => {
  const file = join(tmpDir, "evaluate.log");
  const mod = await freshTracer({
    MCP_TRACE_FILE: file,
    MCP_TRACE_BUFFER_MS: "10",
  });
  const span = mod.trace.start("evaluate", "(function() { return 42; })()");
  await new Promise((r) => setTimeout(r, 5));
  span.end();
  await mod.trace._flush();
  const lines = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "evaluate.start");
  assert.equal(lines[1].kind, "evaluate.end");
  assert.equal(lines[0].id, lines[1].id);
  assert.equal(
    typeof lines[1].dur_ms,
    "number",
    "end event must record dur_ms",
  );
  assert.ok(lines[1].dur_ms >= 4, "dur_ms reflects the sleep");
  assert.ok(
    lines[0].excerpt.startsWith("(function() { return 42; })()"),
    "excerpt captures the expression",
  );
});

test("tracer captures evaluateWrite span — queued + acquired + released", async () => {
  const file = join(tmpDir, "evaluateWrite.log");
  const mod = await freshTracer({
    MCP_TRACE_FILE: file,
    MCP_TRACE_BUFFER_MS: "10",
  });
  const span = mod.trace.startWrite("/* setSymbol */");
  await new Promise((r) => setTimeout(r, 3)); // queue wait
  span.acquired();
  await new Promise((r) => setTimeout(r, 5)); // mutex work
  span.released();
  await mod.trace._flush();
  const lines = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].kind, "evaluateWrite.queued");
  assert.equal(lines[1].kind, "evaluateWrite.acquired");
  assert.equal(lines[2].kind, "evaluateWrite.released");
  // All three share the same id (lifecycle of one span)
  assert.equal(lines[0].id, lines[1].id);
  assert.equal(lines[1].id, lines[2].id);
  assert.ok(lines[1].wait_ms >= 2, "wait_ms reflects queue time");
  assert.ok(lines[2].work_ms >= 4, "work_ms reflects critical-section time");
});

test("tracer attributes tool name via withToolName context", async () => {
  const file = join(tmpDir, "tool-name.log");
  const mod = await freshTracer({
    MCP_TRACE_FILE: file,
    MCP_TRACE_BUFFER_MS: "10",
  });
  const wrapped = mod.withToolName("chart_set_symbol", async () => {
    const span = mod.trace.start("evaluate", "test");
    span.end();
  });
  await wrapped();
  await mod.trace._flush();
  const lines = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tool, "chart_set_symbol");
  assert.equal(lines[1].tool, "chart_set_symbol");
});

test("tracer omits tool field when no context is active", async () => {
  const file = join(tmpDir, "no-tool.log");
  const mod = await freshTracer({
    MCP_TRACE_FILE: file,
    MCP_TRACE_BUFFER_MS: "10",
  });
  // Called outside any withToolName wrapper.
  const span = mod.trace.start("evaluate", "x");
  span.end();
  await mod.trace._flush();
  const lines = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  // tool field is omitted (undefined when traceCurrentTool() returns nothing,
  // which JSON.stringify drops). So no "tool" key.
  assert.ok(!("tool" in lines[0]), `unexpected tool field: ${lines[0].tool}`);
});

test("withToolName is a no-op when tracer is disabled", async () => {
  const mod = await freshTracer({});
  const inner = async () => "result";
  const wrapped = mod.withToolName("any_tool", inner);
  // When disabled, withToolName returns the original handler unchanged.
  assert.equal(wrapped, inner);
});

test("ordering preserved within a single process — seq is monotonic", async () => {
  const file = join(tmpDir, "ordering.log");
  const mod = await freshTracer({
    MCP_TRACE_FILE: file,
    MCP_TRACE_BUFFER_MS: "10",
  });
  for (let i = 0; i < 20; i++) {
    mod.trace("burst", { i });
  }
  await mod.trace._flush();
  const lines = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 20);
  for (let i = 1; i < lines.length; i++) {
    assert.ok(
      lines[i].seq > lines[i - 1].seq,
      `seq must be monotonic (line ${i} seq=${lines[i].seq} not > ${lines[i - 1].seq})`,
    );
  }
});

test("size-based rotation: file exceeding MCP_TRACE_MAX_MB is renamed to .1", async () => {
  const file = join(tmpDir, "rotate.log");
  // Pre-fill the file so the very next flush triggers rotation.
  // 0.001 MB = 1024 bytes; we'll write more than that.
  await writeFile(file, "x".repeat(2000));
  const mod = await freshTracer({
    MCP_TRACE_FILE: file,
    MCP_TRACE_MAX_MB: "0.001",
    MCP_TRACE_BUFFER_MS: "10",
  });
  // Emit one event — flush will check size and rotate.
  mod.trace("trigger", {});
  await mod.trace._flush();
  const s1 = await stat(file).catch(() => null);
  const sRotated = await stat(`${file}.1`).catch(() => null);
  assert.ok(sRotated !== null, "rotated file .1 must exist");
  // After rotation the active file should be either small (just the
  // post-rotation events) or absent if no further writes happened.
  if (s1 !== null) {
    assert.ok(
      s1.size < 2000,
      "post-rotation file should be smaller than the pre-rotation size",
    );
  }
});

test("sampling=0 emits nothing", async () => {
  const file = join(tmpDir, "no-sample.log");
  const mod = await freshTracer({
    MCP_TRACE_FILE: file,
    MCP_TRACE_BUFFER_MS: "10",
    MCP_TRACE_SAMPLE: "0",
  });
  for (let i = 0; i < 10; i++) {
    const span = mod.trace.start("evaluate", "x");
    span.end();
    const wspan = mod.trace.startWrite("y");
    wspan.acquired();
    wspan.released();
  }
  await mod.trace._flush();
  const contents = await readFile(file, "utf8").catch(() => "");
  // sample=0 means span starts return SPAN_NOOP — zero lines emitted.
  assert.equal(contents, "");
});
