/**
 * Pharm Setup Monitor
 * --------------------
 * Watches the live MNQ/NQ chart for the LBAF/LAAF triggers defined in
 * pharm-setups.json, scores indicator confluence at the moment of trigger,
 * fires a macOS notification, then tracks each triggered setup forward to a
 * win (first target) or loss (invalidation) and records the R-multiple.
 * Confirmed triggers only (fires on the bar that actually reclaims the zone).
 *
 *   node pharm-monitor.js            # live loop (default 15s poll)
 *   node pharm-monitor.js --once     # single evaluation tick, then exit (test)
 *   node pharm-monitor.js --interval 30   # custom poll seconds
 *
 * Trade lifecycle is written to pharm-monitor-log.json (read by pharm-journal.js).
 * Requires TradingView Desktop running with CDP (port 9222) — same as the MCP.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { data } from "./src/core/index.js";
import { disconnect } from "./src/connection.js";

const SETUPS_FILE = new URL("./pharm-setups.json", import.meta.url);
const STATE_FILE = new URL("./pharm-monitor-state.json", import.meta.url);
const LOG_FILE = new URL("./pharm-monitor-log.json", import.meta.url);

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const intervalArg = args.indexOf("--interval");
const INTERVAL_MS =
  (intervalArg >= 0 ? parseInt(args[intervalArg + 1]) || 15 : 15) * 1000;
const BARS = 150; // ~5h of 2-min bars — enough to resolve intraday setups

// ── Indicator math (ported from scalper-run.js) ─────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}
function calcVWAP(bars) {
  let tpv = 0,
    vol = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    tpv += tp * (b.volume || 0);
    vol += b.volume || 0;
  }
  return vol === 0 ? bars[bars.length - 1].close : tpv / vol;
}

// ── State machine: replay closed bars, return phase + trigger bar times ──
// dir "long"  = LBAF: wick BELOW zone low, then close back above (fail).
// dir "short" = LAAF: wick ABOVE zone high, then close back below (fail).
function replay(setup, closed) {
  const [lo, hi] = setup.zone;
  const inv = setup.invalidation;
  const long = setup.dir === "long";
  let phase = "watch";
  const triggers = [];

  for (const b of closed) {
    if ((long && b.close < inv) || (!long && b.close > inv)) {
      if ((long && b.close > hi) || (!long && b.close < lo)) phase = "watch";
      else {
        phase = "dead";
        continue;
      }
    }
    if (phase === "dead") {
      if ((long && b.close > hi) || (!long && b.close < lo)) phase = "watch";
      else continue;
    }
    const excursion = long ? b.low < lo : b.high > hi;
    const reclaim = long ? b.close > lo : b.close < hi;
    if (phase === "watch" || phase === "post") {
      if (excursion && reclaim) {
        triggers.push(b.time);
        phase = "post";
      } else if (excursion) phase = "excursion";
    } else if (phase === "excursion") {
      if (reclaim) {
        triggers.push(b.time);
        phase = "post";
      }
    }
  }
  return { phase, triggers };
}

// ── Confluence scoring at the moment of trigger ─────────────────
function scoreConfluence(setup, price, ind) {
  const long = setup.dir === "long";
  const hits = [];
  if (ind.vwap != null && (long ? price > ind.vwap : price < ind.vwap))
    hits.push("VWAP");
  if (
    ind.ema9 != null &&
    ind.ema20 != null &&
    (long ? ind.ema9 > ind.ema20 : ind.ema9 < ind.ema20)
  )
    hits.push("EMA");
  if (
    ind.rsi != null &&
    (long ? ind.rsi >= 50 && ind.rsi < 72 : ind.rsi <= 50 && ind.rsi > 28)
  )
    hits.push("RSI");
  if (ind.dynTrend != null && (long ? price > ind.dynTrend : price < ind.dynTrend))
    hits.push("TREND");
  const max = [ind.vwap, ind.ema9, ind.rsi, ind.dynTrend].filter(
    (x) => x != null,
  ).length;
  const score = hits.length;
  const tier = score >= 3 ? "🔥 HIGH" : score >= 2 ? "⚡ MED" : "💤 LOW";
  return { score, max, hits, tier };
}

function parseNum(s) {
  if (typeof s === "number") return s;
  const n = parseFloat(String(s).replace(/[, ]/g, ""));
  return isNaN(n) ? null : n;
}

function notify(title, message, loud) {
  try {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}${loud ? ' sound name "Glass"' : ""}`;
    execFileSync("osascript", ["-e", script]);
  } catch (e) {
    console.error("  (notification failed:", e.message + ")");
  }
}

function loadJSON(url, fallback) {
  try {
    return existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(url, obj) {
  writeFileSync(url, JSON.stringify(obj, null, 2));
}

// ── Resolve open trades to target (win) or invalidation (loss) ──
function resolveOpen(state, bars) {
  const log = loadJSON(LOG_FILE, []);
  const stillOpen = [];
  for (const pos of state.open || []) {
    const after = bars.filter((b) => b.time > pos.barTime);
    const long = pos.dir === "long";
    const t1 = pos.targets[0];
    let outcome = null,
      exitPrice = null,
      exitTime = null;
    for (const b of after) {
      const hitStop = long ? b.low <= pos.invalidation : b.high >= pos.invalidation;
      const hitTgt = long ? b.high >= t1 : b.low <= t1;
      // same-bar ambiguity → assume stop (conservative)
      if (hitStop) {
        outcome = "stop";
        exitPrice = pos.invalidation;
        exitTime = b.time;
        break;
      }
      if (hitTgt) {
        outcome = "target";
        exitPrice = t1;
        exitTime = b.time;
        break;
      }
    }
    if (!outcome) {
      stillOpen.push(pos);
      continue;
    }
    const risk = Math.abs(pos.entry - pos.invalidation) || 1;
    const R = ((long ? exitPrice - pos.entry : pos.entry - exitPrice) / risk);
    const rec = log.find((r) => r.id === pos.id && r.barTime === pos.barTime);
    if (rec) {
      rec.status = "resolved";
      rec.outcome = outcome;
      rec.exitPrice = exitPrice;
      rec.exitTime = exitTime;
      rec.R = Math.round(R * 100) / 100;
    }
    console.log(
      `  ${outcome === "target" ? "✓ WIN " : "✗ LOSS"} ${pos.id} → ${exitPrice} (${rec ? rec.R : "?"}R)`,
    );
    notify(
      `${outcome === "target" ? "✓" : "✗"} NQ ${pos.rating} ${pos.type} ${outcome}`,
      `${pos.zone[0]}-${pos.zone[1]} exit ${exitPrice} (${rec ? rec.R : "?"}R)`,
      false,
    );
  }
  state.open = stillOpen;
  saveJSON(LOG_FILE, log);
}

// ── One evaluation tick ─────────────────────────────────────────
async function tick(config, state) {
  const ohlcv = await data.getOhlcv({ count: BARS });
  const bars = ohlcv.bars;
  if (!bars || bars.length < 25) throw new Error("not enough bars yet");
  const closed = bars.slice(0, -1);
  const lastClosed = closed[closed.length - 1];
  const closes = closed.map((b) => b.close);
  const price = bars[bars.length - 1].close;

  const ind = {
    vwap: calcVWAP(closed),
    ema9: calcEMA(closes, 9),
    ema20: calcEMA(closes, 20),
    rsi: calcRSI(closes, 14),
    dynTrend: null,
  };
  try {
    const sv = await data.getStudyValues();
    const ts = (sv.studies || []).find((s) => /trend speed/i.test(s.name));
    if (ts) ind.dynTrend = parseNum(ts.values["Dynamic Trend"]);
  } catch {}

  // Resolve any open trades first
  state.open = state.open || [];
  state.fired = state.fired || {};
  resolveOpen(state, bars);

  const now = new Date().toISOString().slice(11, 19);
  console.log(
    `[${now}] px ${price}  vwap ${ind.vwap.toFixed(0)}  ema9 ${ind.ema9.toFixed(0)}  ema20 ${ind.ema20.toFixed(0)}  rsi ${ind.rsi.toFixed(0)}  open ${state.open.length}`,
  );

  for (const setup of config.setups) {
    const { phase, triggers } = replay(setup, closed);
    const fresh = triggers[triggers.length - 1];
    const inZone = price >= setup.zone[0] && price <= setup.zone[1];
    console.log(
      `   ${setup.id.padEnd(20)} ${phase.padEnd(10)} z${setup.zone[0]}-${setup.zone[1]} ${setup.rating}${inZone ? " ◄ IN ZONE" : ""}`,
    );

    if (fresh && fresh === lastClosed.time && state.fired[setup.id] !== fresh) {
      state.fired[setup.id] = fresh;
      // entry = the reclaim bar's close (the actual trigger level), NOT the
      // live forming price, which can be far away on higher timeframes.
      const entry = lastClosed.close;
      const long = setup.dir === "long";
      // Sanity guard: if the reclaim already blew past the first target (no room
      // left) or is already beyond the invalidation, the move happened without
      // us — don't fire a trade we couldn't actually take.
      const noRoom = long
        ? entry >= setup.targets[0]
        : entry <= setup.targets[0];
      const pastStop = long
        ? entry <= setup.invalidation
        : entry >= setup.invalidation;
      if (noRoom || pastStop) {
        console.log(
          `   (skip ${setup.id} — reclaim @${entry} left no room: tgt ${setup.targets[0]}, stop ${setup.invalidation})`,
        );
        continue;
      }
      const c = scoreConfluence(setup, entry, ind);
      const dirWord = setup.dir === "long" ? "Long" : "Short";
      // Risk discipline shown at the moment of temptation: total risk budget for
      // the whole idea, max scale-ins, and the actual stop distance for sizing.
      // Per-setup values override the file-level `risk` defaults.
      const maxRiskR =
        setup.max_risk_R ?? config.risk?.max_risk_R ?? 1;
      const maxAdds = setup.max_adds ?? config.risk?.max_adds ?? 2;
      const stopPts = Math.round(Math.abs(entry - setup.invalidation) * 100) / 100;
      const risk = { max_risk_R: maxRiskR, max_adds: maxAdds, stop_pts: stopPts };
      const title = `${c.tier.split(" ")[0]} NQ ${setup.rating} ${setup.type}`;
      const message = `${dirWord} ${setup.zone[0]}-${setup.zone[1]} reclaimed @${entry} | conf ${c.score}/${c.max} (${c.hits.join(" ") || "none"}) | tgts ${setup.targets.slice(0, 2).join(", ")} | RISK ${maxRiskR}R max, ≤${maxAdds} adds, stop ${setup.invalidation} (${stopPts}pt) — no adds underwater`;
      console.log(`\n  ★ TRIGGER ${title} — ${message}\n`);
      notify(title, message, c.score >= 3);

      const log = loadJSON(LOG_FILE, []);
      log.push({
        ts: new Date().toISOString(),
        id: setup.id,
        type: setup.type,
        dir: setup.dir,
        rating: setup.rating,
        zone: setup.zone,
        entry,
        barTime: fresh,
        confluence: c,
        risk,
        targets: setup.targets,
        invalidation: setup.invalidation,
        indicators: ind,
        status: "open",
      });
      saveJSON(LOG_FILE, log);
      state.open.push({
        id: setup.id,
        dir: setup.dir,
        type: setup.type,
        rating: setup.rating,
        zone: setup.zone,
        entry,
        barTime: fresh,
        targets: setup.targets,
        invalidation: setup.invalidation,
      });
    }
  }
  return state;
}

async function main() {
  const config = loadJSON(SETUPS_FILE, null);
  if (!config) {
    console.error("Missing pharm-setups.json");
    process.exit(1);
  }
  let state = loadJSON(STATE_FILE, { fired: {}, open: [] });
  console.log(
    `🐶 Pharm monitor — ${config.instrument} — ${config.setups.length} setups — ${ONCE ? "single tick" : `poll ${INTERVAL_MS / 1000}s`}\n`,
  );

  const run = async () => {
    try {
      state = await tick(config, state);
      saveJSON(STATE_FILE, state);
    } catch (e) {
      console.error(`  ⚠ ${e.message}`);
    }
  };

  await run();
  if (ONCE) {
    await disconnect().catch(() => {});
    return;
  }
  setInterval(run, INTERVAL_MS);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
