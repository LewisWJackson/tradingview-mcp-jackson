/**
 * contract_flow.mjs — pure helpers for the contract-award drift study. No I/O, no bars.
 * Unit-tested in tests/moneypath.test.js. Spec: docs/superpowers/specs/2026-06-21-contract-flow-design.md
 */

// Government / SOE / Vision-2030 counterparty terms. Match = the award comes from a public-sector
// or megaproject buyer (the retail-under-reaction hypothesis). Lowercase, substring match.
const GOVT_TERMS = [
  'aramco', 'ministry', 'municipalit', 'saudi electricity', 'national water', 'water company',
  'neom', 'public investment fund', ' pif', 'royal commission', 'national guard', 'authority',
  'university', 'government', 'tatweer', 'red sea', 'roshn', 'diriyah', 'qiddiya', 'sabic',
  'saudi railway', 'sar ', 'general organization', 'ministry of', 'governorate', 'public transport',
];

/** 'govt' if the headline names a government/SOE/Vision-2030 counterparty, else 'private'. */
export function classifyCounterparty(headline) {
  const h = (headline || '').toLowerCase();
  return GOVT_TERMS.some(t => h.includes(t)) ? 'govt' : 'private';
}

// Anti-leakage: the upstream 'contract' classifier is leaky (some rows are financial-results /
// capital-increase). Keep only headlines that actually denote an award.
const AWARD_RE = /contract|project award|project sign|awarded|award with|purchase order|sign off|signing of a|tender/i;

/** true if the headline denotes an actual contract/award (not a misfiled financial/capital row). */
export function isContractHeadline(headline) {
  return AWARD_RE.test(headline || '');
}
