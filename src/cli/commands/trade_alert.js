import { register } from "../router.js";
import * as core from "../../core/trade_alert.js";
import * as tab from "../../core/tab.js";

register("trade-alert", {
  description:
    "Check the watchlist for a high-conviction trade setup and notify you (Pushover) if found",
  subcommands: new Map([
    [
      "check",
      {
        description:
          "Run one check cycle now: scan watchlist, ask Claude for a confidence read, notify on high confidence",
        options: {
          rules: {
            type: "string",
            short: "r",
            description: "Path to rules.json (default: ./rules.json)",
          },
          "dry-run": {
            type: "boolean",
            description:
              "Evaluate and print what would be sent, without sending a notification or updating cooldown state",
          },
        },
        handler: async ({ rules, "dry-run": dryRun }) =>
          core.checkForSignals({ rules_path: rules, dry_run: !!dryRun }),
      },
    ],
    [
      "set-scanner-tab",
      {
        description:
          "Pin an open chart tab (index from 'tv tab list') as the dedicated background scan tab, so checks stop flickering your active chart",
        handler: (opts, positionals) => {
          if (positionals[0] === undefined)
            throw new Error(
              "Index required. Run 'tv tab new' to open a tab to dedicate, 'tv tab list' to find its index, then 'tv trade-alert set-scanner-tab <index>'.",
            );
          return tab.setScannerTab({ index: positionals[0] });
        },
      },
    ],
    [
      "scanner-tab-status",
      {
        description: "Show whether a background scanner tab is configured and still open",
        handler: () => tab.getScannerTab(),
      },
    ],
    [
      "clear-scanner-tab",
      {
        description:
          "Unpin the scanner tab — checks fall back to scanning on the active tab (will flicker) until a new one is set",
        handler: () => tab.clearScannerTabPin(),
      },
    ],
  ]),
});
