#!/usr/bin/env node
/**
 * bench-mutex.mjs — validate F2 write-tool mutex against live Chrome+TV.
 *
 * Spawns the MCP server (this fork) as a child process via stdio,
 * connects as an MCP client, and runs three scenarios:
 *
 *   B1 — baseline read latency (10× chart_get_state, sequential)
 *   B2 — reads do not block on a slow write (1× chart_set_symbol on same
 *        symbol + 5 parallel quote_get started 50ms later)
 *   B3 — concurrent writes serialize in arrival order (5 parallel
 *        scrollToDate calls — chosen because it mutates only the visible
 *        viewport, no underlying chart data state changes; safe to run
 *        against the live LENS-polled chart)
 *
 * Reports per-call latency, p50/p95, total wall time vs theoretical-
 * serial, and order observation.
 *
 * Pre-requisites:
 *   - Chrome with TradingView open, CDP listening on :9222
 *   - `npm install` already run (async-mutex dep present)
 *
 * Usage:
 *   node scripts/bench-mutex.mjs                       # default: XAUUSD
 *   SYMBOL=BTCUSDT node scripts/bench-mutex.mjs        # benchmark target
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "src", "server.js");
const SYMBOL = process.env.SYMBOL || "XAUUSD";

function fmt(ms) {
  return `${ms.toFixed(1)}ms`;
}
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function callTool(client, name, args = {}) {
  const t0 = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const dt = performance.now() - t0;
  return { result, dt };
}

async function main() {
  console.log(`F2 write-mutex benchmark — symbol=${SYMBOL}\n`);

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
  });
  const client = new Client(
    { name: "bench-mutex", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  try {
    // ----- B1 — sequential read baseline -----
    console.log("## B1 — baseline read latency");
    const b1_durations = [];
    for (let i = 0; i < 10; i++) {
      const { dt } = await callTool(client, "chart_get_state", {});
      b1_durations.push(dt);
    }
    const b1_mean = b1_durations.reduce((a, b) => a + b, 0) / b1_durations.length;
    const b1_p50 = percentile(b1_durations, 0.5);
    const b1_p95 = percentile(b1_durations, 0.95);
    console.log(
      `  10× chart_get_state — mean ${fmt(b1_mean)}, p50 ${fmt(b1_p50)}, p95 ${fmt(b1_p95)}`,
    );
    console.log(
      `  individual: ${b1_durations.map((d) => fmt(d)).join(", ")}\n`,
    );

    // ----- B2 — reads do not block on a slow write -----
    console.log("## B2 — reads do not block on a slow write");
    const b2_t0 = performance.now();
    const writePromise = (async () => {
      const t0 = performance.now();
      await callTool(client, "chart_set_symbol", { symbol: SYMBOL });
      return { who: "write_set_symbol", dt: performance.now() - t0, started_at: t0 - b2_t0 };
    })();

    // Wait 50ms then fire 5 parallel reads
    await new Promise((r) => setTimeout(r, 50));
    const readPromises = Array.from({ length: 5 }, async (_, i) => {
      const t0 = performance.now();
      await callTool(client, "quote_get", {});
      return { who: `read_${i + 1}`, dt: performance.now() - t0, started_at: t0 - b2_t0 };
    });

    const results = await Promise.all([writePromise, ...readPromises]);
    const sortByCompletion = (a, b) => a.started_at + a.dt - (b.started_at + b.dt);
    results.sort(sortByCompletion);
    const writeResult = results.find((r) => r.who === "write_set_symbol");
    console.log(`  write completion order events (start→end relative ms):`);
    for (const r of results) {
      console.log(
        `    ${r.who.padEnd(20)} start=${fmt(r.started_at)} dur=${fmt(r.dt)} end=${fmt(r.started_at + r.dt)}`,
      );
    }
    const readsCompletedBeforeWrite = results.filter(
      (r) => r.who.startsWith("read_") && r.started_at + r.dt < writeResult.started_at + writeResult.dt,
    );
    console.log(
      `  → ${readsCompletedBeforeWrite.length}/5 reads completed BEFORE the write finished` +
        ` (expected 5/5 if read path is mutex-free)\n`,
    );

    // ----- B3 — concurrent writes serialize in arrival order -----
    console.log("## B3 — concurrent writes serialize");
    // scrollToDate dates picked relative-to-now; small range so all
    // requests are valid for the current symbol's bar history.
    const now = Math.floor(Date.now() / 1000);
    const dates = [
      now - 86400 * 1, // yesterday
      now - 86400 * 2,
      now - 86400 * 3,
      now - 86400 * 4,
      now - 86400 * 5,
    ];
    const b3_t0 = performance.now();
    const writes = dates.map((d, i) => async () => {
      const t0 = performance.now();
      await callTool(client, "chart_scroll_to_date", { date: String(d) });
      return { i, dt: performance.now() - t0, started_at: t0 - b3_t0, ended_at: performance.now() - b3_t0 };
    });
    const writeResults = await Promise.all(writes.map((w) => w()));
    const b3_total = performance.now() - b3_t0;
    const b3_sum = writeResults.reduce((s, r) => s + r.dt, 0);

    console.log(`  5× chart_scroll_to_date — wall clock total ${fmt(b3_total)}`);
    console.log(`  per-call timeline (start→end relative ms):`);
    for (const r of writeResults) {
      console.log(
        `    write_${r.i} start=${fmt(r.started_at)} dur=${fmt(r.dt)} end=${fmt(r.ended_at)}`,
      );
    }

    // Order check — serialization shows up in END times, NOT start times.
    // Promise.all fires every async function's entry simultaneously, so all
    // start_at values cluster at ~0ms. The mutex queues their critical
    // sections; the CDP work runs one after another. If the mutex works,
    // consecutive end times should be spaced by ~one-call-of-work apart.
    // If writes ran in parallel without mutex, all end times would cluster
    // close together (every write would finish at roughly the same moment).
    const byEnd = [...writeResults].sort((a, b) => a.ended_at - b.ended_at);
    const gaps = [];
    for (let i = 1; i < byEnd.length; i++) {
      gaps.push(byEnd[i].ended_at - byEnd[i - 1].ended_at);
    }
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const minGap = Math.min(...gaps);
    const maxGap = Math.max(...gaps);
    const meanDur = writeResults.reduce((s, r) => s + r.dt, 0) / writeResults.length;
    const expectedSerialPerCall = writeResults[0].dt; // first call had no wait
    console.log(
      `  inter-end gaps: min ${fmt(minGap)}, mean ${fmt(meanGap)}, max ${fmt(maxGap)}`,
    );
    console.log(
      `  first-call duration (no queue wait): ${fmt(expectedSerialPerCall)} — gaps should match this if serialized`,
    );
    const serialEvidence =
      meanGap >= expectedSerialPerCall * 0.7 && meanGap <= expectedSerialPerCall * 1.3;
    console.log(
      `  → ${serialEvidence ? "✓" : "✗"} writes serialized: mean inter-end gap (${fmt(meanGap)}) ≈ per-call work (${fmt(expectedSerialPerCall)})`,
    );
    if (!serialEvidence) {
      console.log(
        `    parallel hypothesis: gaps would be <50ms each (all ending together); observed mean ${fmt(meanGap)}`,
      );
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("Benchmark error:", e);
  process.exit(1);
});
