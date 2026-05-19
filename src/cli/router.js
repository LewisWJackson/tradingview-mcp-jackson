/**
 * CLI command router using node:util parseArgs.
 * Zero dependencies — uses only Node.js built-ins.
 */
import { parseArgs } from 'node:util';

/** @type {Map<string, { description: string, options?: object, handler: Function, subcommands?: Map<string, object> }>} */
const commands = new Map();

export function register(name, config) {
  commands.set(name, config);
}

// Exposed for `tv lint` and CI tests. Walks the registry and reports any
// `register()` block whose sibling subcommands read different sets of CLI
// flags from `opts`. This catches the class of bug fixed in
// fix(brief): the `brief active` handler silently dropped --no-macro etc.
// that its sibling `brief for` handler honored.
export function lintSiblingFlagParity() {
  const findings = [];
  for (const [name, config] of commands) {
    if (!config.subcommands || config.subcommands.size < 2) continue;

    const profiled = [];
    for (const [subName, subConf] of config.subcommands) {
      if (subConf.allowAsymmetric === true) continue;
      if (typeof subConf.handler !== 'function') continue;
      const src = subConf.handler.toString();
      if (src.includes('lint:allow-asymmetric')) continue;
      const backends = extractBackendCalls(src);
      if (backends.size === 0) continue;
      const sig = [...backends].sort().join(',');
      profiled.push({ name: subName, sig, keys: extractOptKeys(src) });
    }
    if (profiled.length < 2) continue;

    const groups = new Map();
    for (const p of profiled) {
      if (!groups.has(p.sig)) groups.set(p.sig, []);
      groups.get(p.sig).push(p);
    }

    for (const [sig, group] of groups) {
      if (group.length < 2) continue;
      const union = new Set();
      for (const s of group) for (const k of s.keys) union.add(k);
      const asymmetric = [];
      for (const s of group) {
        const missing = [...union].filter(k => !s.keys.has(k));
        if (missing.length > 0) asymmetric.push({ subcommand: s.name, missing });
      }
      if (asymmetric.length > 0) {
        findings.push({ command: name, sharedBackend: sig, asymmetric });
      }
    }
  }
  return findings;
}

// Heuristic: extract every `opts['<k>']`, `opts["<k>"]`, and `opts.<k>` reference
// from a handler's source text. Filters parseArgs-reserved keys ('help', 'h', '_').
function extractOptKeys(src) {
  const keys = new Set();
  const re = /opts(?:\[\s*(?:'([^']+)'|"([^"]+)")\s*\]|\.([A-Za-z_][\w-]*))/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[1] || m[2] || m[3];
    if (key && key !== 'help' && key !== 'h' && key !== '_') keys.add(key);
  }
  return keys;
}

// Heuristic: extract every `core.<name>` reference from a handler's source.
// Two sibling subcommands sharing the same set of core.X calls share a
// backend and must forward the same flag set.
function extractBackendCalls(src) {
  const calls = new Set();
  const re = /\bcore\.([A-Za-z_][\w]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) calls.add(m[1]);
  return calls;
}

function printHelp() {
  console.log('Usage: tv <command> [options]\n');
  console.log('Commands:');
  const maxLen = Math.max(...[...commands.keys()].map(k => k.length));
  for (const [name, cmd] of commands) {
    if (cmd.subcommands) {
      const subs = [...cmd.subcommands.keys()].join(', ');
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}  [${subs}]`);
    } else {
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}`);
    }
  }
  console.log('\nRun "tv <command> --help" for command-specific options.');
  console.log('\nDISCLAIMER');
  console.log('  Not affiliated with TradingView Inc. or Anthropic, PBC.');
  console.log('  Use subject to TradingView\'s Terms of Use: tradingview.com/policies');
}

function printCommandHelp(name, cmd) {
  if (cmd.subcommands) {
    console.log(`Usage: tv ${name} <subcommand> [options]\n`);
    console.log('Subcommands:');
    for (const [sub, subConf] of cmd.subcommands) {
      console.log(`  ${sub.padEnd(12)}${subConf.description}`);
    }
  } else {
    console.log(`Usage: tv ${name} [options]\n`);
    console.log(cmd.description);
  }
  const opts = cmd.options || {};
  if (Object.keys(opts).length > 0) {
    console.log('\nOptions:');
    for (const [k, v] of Object.entries(opts)) {
      const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
      console.log(`  ${flag.padEnd(20)}${v.description || ''}`);
    }
  }
}

export async function run(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const cmdName = args[0];
  const cmd = commands.get(cmdName);

  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    console.error('Run "tv --help" for a list of commands.');
    process.exit(1);
  }

  // Handle subcommands (e.g., tv pine get)
  let handler, options;
  if (cmd.subcommands) {
    const subName = args[1];
    if (!subName || subName === '--help' || subName === '-h') {
      printCommandHelp(cmdName, cmd);
      process.exit(0);
    }
    const sub = cmd.subcommands.get(subName);
    if (!sub) {
      console.error(`Unknown subcommand: ${cmdName} ${subName}`);
      printCommandHelp(cmdName, cmd);
      process.exit(1);
    }
    handler = sub.handler;
    options = sub.options || {};
    // Parse remaining args after command + subcommand
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        console.log(`Usage: tv ${cmdName} ${subName} [options]\n`);
        console.log(sub.description);
        if (Object.keys(options).length > 0) {
          console.log('\nOptions:');
          for (const [k, v] of Object.entries(options)) {
            const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
            console.log(`  ${flag.padEnd(20)}${v.description || ''}`);
          }
        }
        process.exit(0);
      }
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  } else {
    handler = cmd.handler;
    options = cmd.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        printCommandHelp(cmdName, cmd);
        process.exit(0);
      }
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  }
}

async function execute(handler, values, positionals) {
  try {
    const result = await handler(values, positionals);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}

function handleError(err) {
  const message = err.message || String(err);
  // Connection failures get exit code 2
  if (/CDP|connection|ECONNREFUSED|not running/i.test(message)) {
    console.error(JSON.stringify({ success: false, error: message }, null, 2));
    process.exit(2);
  }
  console.error(JSON.stringify({ success: false, error: message }, null, 2));
  process.exit(1);
}
