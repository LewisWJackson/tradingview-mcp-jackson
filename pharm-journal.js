/**
 * Pharm Journal — analytics over the monitor's trade log.
 * --------------------------------------------------------
 * Reads pharm-monitor-log.json (written by pharm-monitor.js) and reports
 * win-rate / expectancy broken down by rating, setup type, direction, and
 * confluence score — so you can see which Pharm setups actually pay for YOU,
 * and whether the confluence gate predicts wins.
 *
 *   node pharm-journal.js          # print report
 *   node pharm-journal.js --html   # also write pharm-journal.html
 */
import { existsSync, readFileSync, writeFileSync } from "fs";

const LOG_FILE = new URL("./pharm-monitor-log.json", import.meta.url);
const HTML_FILE = new URL("./pharm-journal.html", import.meta.url);
const HTML = process.argv.includes("--html");

const log = existsSync(LOG_FILE)
  ? JSON.parse(readFileSync(LOG_FILE, "utf8"))
  : [];

const resolved = log.filter((r) => r.status === "resolved");
const open = log.filter((r) => r.status === "open");

// ── stats for a group of resolved trades ────────────────────────
function stats(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.outcome === "target").length;
  const losses = rows.filter((r) => r.outcome === "stop").length;
  const totalR = rows.reduce((s, r) => s + (r.R || 0), 0);
  return {
    n,
    wins,
    losses,
    winRate: n ? Math.round((wins / n) * 100) : 0,
    avgR: n ? Math.round((totalR / n) * 100) / 100 : 0,
    totalR: Math.round(totalR * 100) / 100,
  };
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()]
    .map(([k, rows]) => ({ key: k, ...stats(rows) }))
    .sort((a, b) => b.n - a.n);
}

// ── text report ─────────────────────────────────────────────────
function bar(pct) {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function printGroup(title, groups) {
  console.log(`\n${title}`);
  console.log("  " + "key".padEnd(16) + "n   win%  avgR  totR");
  for (const g of groups) {
    console.log(
      "  " +
        String(g.key).padEnd(16) +
        String(g.n).padEnd(4) +
        (g.winRate + "%").padEnd(6) +
        String(g.avgR).padEnd(6) +
        g.totalR,
    );
  }
}

const all = stats(resolved);
console.log("\n🐶 PHARM SETUP JOURNAL");
console.log("─".repeat(48));
console.log(
  `Triggers logged: ${log.length}   resolved: ${resolved.length}   open: ${open.length}`,
);
if (resolved.length === 0) {
  console.log(
    "\nNo resolved trades yet. Run the monitor during RTH to collect data:\n  node pharm-monitor.js\n",
  );
} else {
  console.log(
    `\nOverall: ${all.wins}W / ${all.losses}L  ${bar(all.winRate)} ${all.winRate}%  | avg ${all.avgR}R | net ${all.totalR}R`,
  );
  printGroup("By rating:", groupBy(resolved, (r) => r.rating));
  printGroup("By setup type:", groupBy(resolved, (r) => r.type));
  printGroup("By direction:", groupBy(resolved, (r) => r.dir));
  printGroup(
    "By confluence score:",
    groupBy(resolved, (r) => `${r.confluence?.score ?? "?"}/4`),
  );
  printGroup("By setup id:", groupBy(resolved, (r) => r.id));
}

if (open.length) {
  console.log("\nOpen (unresolved):");
  for (const r of open)
    console.log(
      `  ${r.id}  entry ${r.entry}  conf ${r.confluence?.score}/4  tgt ${r.targets?.[0]}  stop ${r.invalidation}`,
    );
}
console.log("");

// ── optional HTML dashboard ─────────────────────────────────────
if (HTML) {
  const section = (title, groups) => `
    <h2>${title}</h2>
    <table>
      <tr><th>${title.replace("By ", "").replace(":", "")}</th><th>n</th><th>Win%</th><th>Avg R</th><th>Net R</th></tr>
      ${groups
        .map(
          (g) =>
            `<tr><td>${g.key}</td><td>${g.n}</td><td>${g.winRate}%</td><td>${g.avgR}</td><td class="${g.totalR >= 0 ? "pos" : "neg"}">${g.totalR}</td></tr>`,
        )
        .join("")}
    </table>`;
  const html = `<!doctype html><meta charset="utf8"><title>Pharm Journal</title>
  <style>
    body{font:14px -apple-system,system-ui,sans-serif;background:#0e0e12;color:#e8e8ea;padding:28px;max-width:760px;margin:auto}
    h1{font-size:20px} h2{font-size:15px;color:#9aa;margin-top:26px}
    .hero{font-size:15px;background:#1a1a22;padding:16px 18px;border-radius:10px;margin:14px 0}
    table{border-collapse:collapse;width:100%;margin-top:6px}
    th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #23232c}
    th{color:#778;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
    .pos{color:#3ad29f} .neg{color:#ff6b6b}
  </style>
  <h1>🐶 Pharm Setup Journal</h1>
  <div class="hero">${
    resolved.length
      ? `<b>${all.wins}W / ${all.losses}L</b> &nbsp; ${all.winRate}% win &nbsp;|&nbsp; avg <b>${all.avgR}R</b> &nbsp;|&nbsp; net <b class="${all.totalR >= 0 ? "pos" : "neg"}">${all.totalR}R</b> &nbsp; <span style="color:#778">(${resolved.length} resolved, ${open.length} open)</span>`
      : "No resolved trades yet — run the monitor during RTH."
  }</div>
  ${
    resolved.length
      ? section("By rating:", groupBy(resolved, (r) => r.rating)) +
        section("By setup type:", groupBy(resolved, (r) => r.type)) +
        section("By direction:", groupBy(resolved, (r) => r.dir)) +
        section(
          "By confluence score:",
          groupBy(resolved, (r) => `${r.confluence?.score ?? "?"}/4`),
        ) +
        section("By setup id:", groupBy(resolved, (r) => r.id))
      : ""
  }`;
  writeFileSync(HTML_FILE, html);
  console.log(`Wrote ${HTML_FILE.pathname}\n`);
}
