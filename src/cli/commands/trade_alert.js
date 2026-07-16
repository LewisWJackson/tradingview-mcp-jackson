import { register } from "../router.js";
import * as core from "../../core/trade_alert.js";

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
  ]),
});
