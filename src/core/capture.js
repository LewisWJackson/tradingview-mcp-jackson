/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection } from "../connection.js";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), "screenshots");

function sanitiseFilename(name) {
  // Strip path separators, parent-dir refs, and any control chars.
  // Allow only [A-Za-z0-9._-]; collapse everything else to '_'.
  const cleaned = String(name).replace(/[^A-Za-z0-9._-]/g, "_");
  // Reject anything that's empty after sanitisation or starts with a dot.
  if (!cleaned || cleaned.startsWith(".")) {
    throw new Error(`Invalid filename: ${name}`);
  }
  return cleaned;
}

export async function captureScreenshot({ region, filename, method } = {}) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fname = filename ? sanitiseFilename(filename) : `tv_${region}_${ts}`;
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  if (method === "api") {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true,
        method: "api",
        note: "takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI",
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClient();
  let clip = undefined;

  if (region === "chart") {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds)
      clip = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        scale: 1,
      };
  } else if (region === "strategy_tester") {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds)
      clip = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        scale: 1,
      };
  }

  // Validate/clamp the clip: a zero-size, fractional, or out-of-viewport clip
  // can make CDP Page.captureScreenshot stall indefinitely (observed
  // 2026-07-18: region "chart" hung for 30 minutes after the window was
  // resized). Degenerate clips fall back to a full capture instead.
  if (clip) {
    const viewport = await evaluate(
      `({ w: window.innerWidth, h: window.innerHeight })`
    );
    clip.x = Math.max(0, Math.round(clip.x));
    clip.y = Math.max(0, Math.round(clip.y));
    clip.width = Math.round(Math.min(clip.width, (viewport?.w || 0) - clip.x));
    clip.height = Math.round(Math.min(clip.height, (viewport?.h || 0) - clip.y));
    if (!(clip.width >= 1 && clip.height >= 1)) clip = undefined;
  }

  const captureWithTimeout = (params, ms) =>
    Promise.race([
      client.Page.captureScreenshot(params),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Page.captureScreenshot timed out after ${ms / 1000}s`)),
          ms
        )
      ),
    ]);

  const params = { format: "png" };
  if (clip) params.clip = clip;

  let data;
  let clipped_fallback = false;
  try {
    ({ data } = await captureWithTimeout(params, 15000));
  } catch (err) {
    if (!params.clip) throw err;
    // Clipped capture failed/hung — retry once unclipped rather than dying.
    ({ data } = await captureWithTimeout({ format: "png" }, 15000));
    clipped_fallback = true;
  }
  writeFileSync(filePath, Buffer.from(data, "base64"));

  return {
    success: true,
    method: "cdp",
    file_path: filePath,
    region: clipped_fallback ? "full" : region,
    requested_region: region,
    clipped_fallback,
    size_bytes: Buffer.from(data, "base64").length,
  };
}
