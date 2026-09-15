import { register } from "../router.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { generateSignals, formatBrief } from "../../core/signals.js";

register("analyze", {
  description:
    "Analyze a saved morning-brief JSON offline (no TradingView needed). Prints interpreted SET signals.",
  options: {
    json: {
      type: "boolean",
      default: false,
      description: "Output raw signals JSON instead of formatted text",
    },
    compact: {
      type: "boolean",
      default: false,
      description: "Compact one-line format (ignored with --json)",
    },
  },
  handler: async (values, positionals) => {
    const filePath = resolve(positionals[0] || values.path || "brief-output.json");
    if (!existsSync(filePath)) {
      throw new Error(`Brief output not found: ${filePath}`);
    }

    let briefOutput;
    try {
      const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      briefOutput = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to parse ${filePath}: ${e.message}`);
    }

    if (!briefOutput.symbols_scanned) {
      throw new Error(
        `${filePath} does not look like a morning brief output (missing symbols_scanned)`,
      );
    }

    if (values.json) {
      return generateSignals(briefOutput);
    }

    return formatBrief(briefOutput, { compact: values.compact });
  },
});
