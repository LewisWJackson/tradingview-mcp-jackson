import { register, lintSiblingFlagParity } from '../router.js';

register('lint', {
  description: 'Static checks on the CLI surface (sibling-handler flag parity)',
  handler: () => {
    const findings = lintSiblingFlagParity();
    if (findings.length === 0) {
      return { success: true, findings: [], message: 'All sibling subcommands forward identical flag sets.' };
    }
    // Print human-readable detail to stderr; structured findings to stdout
    process.stderr.write(`\nFlag-parity issues in ${findings.length} command group(s):\n`);
    for (const f of findings) {
      process.stderr.write(`\n  ${f.command}  (shared backend: core.${f.sharedBackend})\n`);
      for (const a of f.asymmetric) {
        process.stderr.write(`    ${f.command} ${a.subcommand}: missing [${a.missing.join(', ')}]\n`);
      }
    }
    process.stderr.write(
      `\nTo silence intentional asymmetry, add 'allowAsymmetric: true' to the subcommand config,\n` +
      `or include the comment 'lint:allow-asymmetric' in the handler body.\n\n`
    );
    // Exit code 1 to make CI fail
    process.exitCode = 1;
    return { success: false, findings };
  },
});
