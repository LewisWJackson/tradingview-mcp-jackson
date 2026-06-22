// Shared mutable app state — single source of truth, imported by server + (later) route modules.
// Never reassign `state`; only mutate its properties so all importers share one reference.
export const state = {
  scan:      { running: false, progress: 0, total: 0, results: [], lastRun: null, error: null, delta: [], currentMarket: "tasi", mode: 'swing', investMode: false, quickScan: false, quickSkipped: 0 },
  universe:  {},
  settings:  {},
  positions: {},
  virtual:       { cash: 100000, balance_start: 100000, positions: {}, trades: [] },
  score_history: {},
  alert_rules:   [],
};
