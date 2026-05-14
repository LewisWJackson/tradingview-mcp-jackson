import { register } from '../router.js';
import * as core from '../../core/chart.js';

register('view', {
  description: 'Save/restore chart views (symbol + TF + type + study list)',
  subcommands: new Map([
    ['save', {
      description: 'Save current chart state as a named view',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Name required. Usage: tv view save mySetup');
        return core.saveView({ name: positionals[0] });
      },
    }],
    ['restore', {
      description: 'Restore a named view (sets symbol/TF/type; returns studies to re-add)',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Name required. Usage: tv view restore mySetup');
        return core.restoreView({ name: positionals[0] });
      },
    }],
    ['list', {
      description: 'List all saved views',
      handler: () => core.listViews(),
    }],
  ]),
});
