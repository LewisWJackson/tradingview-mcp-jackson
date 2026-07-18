// Push today's NIFTY OI snapshot straight into the "NIFTY REVANCHE" indicator
// inputs on the active TradingView chart (via the tv CLI / CDP bridge):
//   in_43 = PCR, in_45 = Max Pain, in_46 = Call Wall, in_47 = Put Floor
// NOTE: these are POSITIONAL input ids — they shift whenever inputs are added
// before the OI group. Updated for v3.0 (TK-alignment gate added 3 inputs in
// the Score group, shifting OI from in_40/42/43/44). If REVANCHE inputs change
// again, re-verify against `chart_get_state` + the indicator's input order.
//
// Usage: npm run fyers:oi:push
// Requires: fresh Fyers token (npm run fyers:auth) + TradingView Desktop open
// on a chart that has the REVANCHE indicator loaded.

import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { computeOiSnapshot } from "./fyers-oi.js";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "src/cli/index.js");
const tv = async (...args) => {
  const { stdout } = await run("node", [CLI, ...args]);
  return JSON.parse(stdout);
};

const s = await computeOiSnapshot();
console.log(
  `OI (expiry ${s.expiry}): spot ${s.spot} · PCR ${s.pcr} · MaxPain ${s.maxPain} · CallWall ${s.callWall} · PutFloor ${s.putFloor}`,
);

const state = await tv("state");
if (!state.success) {
  console.error("TradingView not reachable — is it running with CDP? (tv launch)");
  process.exit(1);
}
const rev = (state.studies || []).find((st) => /REVANCHE/i.test(st.name));
if (!rev) {
  console.error(
    `No REVANCHE study on the active chart (symbol: ${state.symbol}). ` +
      `Open your NIFTY layout with the indicator loaded, then rerun.`,
  );
  process.exit(1);
}

const res = await tv(
  "indicator", "set", rev.id,
  "--inputs", JSON.stringify({ in_43: s.pcr, in_45: s.maxPain, in_46: s.callWall, in_47: s.putFloor }),
);
if (!res.success) {
  console.error("Input update failed:", JSON.stringify(res).slice(0, 300));
  process.exit(1);
}

// read back to confirm what the chart now holds
const check = await tv("indicator", "get", rev.id);
const got = Object.fromEntries(
  (check.inputs || [])
    .filter((i) => ["in_43", "in_45", "in_46", "in_47"].includes(i.id))
    .map((i) => [i.id, i.value]),
);
console.log(`✓ "${rev.name}" updated:`, JSON.stringify(got));
