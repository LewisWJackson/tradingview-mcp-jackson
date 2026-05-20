import { z } from "zod";
import { jsonResult } from "./_format.js";
import * as core from "../core/morning.js";

export function registerMorningTools(server) {
  server.tool(
    "morning_brief",
    "Scan your watchlist across D1, H1 and M15 timeframes. Returns BB values, SMA order, bb_width (volatility filter) and strategy_candidates per ticker. Claude applies the 7-step premarket checklist to generate the session brief.",
    {
      rules_path: z
        .string()
        .optional()
        .describe(
          "Optional path to rules.json. Defaults to rules.json in the project root.",
        ),
    },
    async ({ rules_path } = {}) => {
      try {
        return jsonResult(await core.runBrief({ rules_path }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "premarket_save",
    "Save the full premarket checklist report as a markdown file in docs/sessions/premarket-YYYY-MM-DD.md inside the project repo.",
    {
      content: z
        .string()
        .describe("Full markdown content of the premarket checklist report."),
      date: z
        .string()
        .optional()
        .describe("Date string YYYY-MM-DD. Defaults to today."),
    },
    async ({ content, date } = {}) => {
      try {
        return jsonResult(core.savePremarketReport({ content, date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "session_save",
    "Save today's morning brief to ~/.tradingview-mcp/sessions/YYYY-MM-DD.json for future reference.",
    {
      brief: z
        .string()
        .describe(
          "The brief text to save (output from morning_brief after Claude applies the rules).",
        ),
      date: z
        .string()
        .optional()
        .describe("Date string YYYY-MM-DD. Defaults to today."),
    },
    async ({ brief, date } = {}) => {
      try {
        return jsonResult(core.saveSession({ brief, date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "session_get",
    "Retrieve a saved session brief. Returns today's if available, otherwise yesterday's.",
    {
      date: z
        .string()
        .optional()
        .describe("Date string YYYY-MM-DD. Defaults to today."),
    },
    async ({ date } = {}) => {
      try {
        return jsonResult(core.getSession({ date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}
