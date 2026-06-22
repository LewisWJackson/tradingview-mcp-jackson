/**
 * risk_sim.mjs — honest risk picture for a 100K SAR account over 2 years.
 * Monte Carlo (geometric Brownian) of realistic strategy profiles. Shows the
 * distribution of outcomes AND the drawdowns you must survive — not just the
 * happy-path average.
 *
 * Run: node scripts/risk_sim.mjs
 */
const START = 100000, YEARS = 2, DAYS = 252 * YEARS, N = 50000;

// profiles: annualized expected return (mu) and volatility (sigma)
const PROFILES = [
  { name: 'Market-like (no edge)',          mu: 0.08, sigma: 0.20 },
  { name: 'Target 25%/yr (skilled, real)',  mu: 0.25, sigma: 0.28 },
  { name: 'Aggressive 40%/yr (concentrated)',mu: 0.40, sigma: 0.45 },
  { name: 'Swing-for-10x (lever/concentr.)', mu: 0.40, sigma: 0.80 },
];

function randn() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function simulate({ mu, sigma }) {
  const dt = 1 / 252, drift = (mu - 0.5 * sigma * sigma) * dt, vol = sigma * Math.sqrt(dt);
  const ends = [], maxDD = [];
  for (let i = 0; i < N; i++) {
    let x = START, peak = START, dd = 0;
    for (let d = 0; d < DAYS; d++) {
      x *= Math.exp(drift + vol * randn());
      if (x > peak) peak = x;
      dd = Math.max(dd, 1 - x / peak);
    }
    ends.push(x); maxDD.push(dd);
  }
  ends.sort((a, b) => a - b); maxDD.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
  const frac = (arr, f) => arr.filter(f).length / arr.length;
  return {
    p10: q(ends, 0.10), median: q(ends, 0.5), p90: q(ends, 0.90),
    pLoss: frac(ends, x => x < START),
    p1_5x: frac(ends, x => x >= 1.5 * START),
    p2x: frac(ends, x => x >= 2 * START),
    p10x: frac(ends, x => x >= 10 * START),
    pRuin: frac(ends, x => x < 0.5 * START),     // ended down >50%
    ddMedian: q(maxDD, 0.5), ddP90: q(maxDD, 0.90), // worst drawdown along the path
  };
}

const k = (x) => (x / 1000).toFixed(0) + 'K';
const pc = (x) => (x * 100).toFixed(0) + '%';
console.log(`\n=== 100K SAR over ${YEARS} years — ${N.toLocaleString()} simulated paths ===\n`);
console.log('profile'.padEnd(34) + 'p10    median  p90     | P(loss) P(1.5x) P(2x) P(10x) P(ruin<50%) | worst-DD med/p90');
for (const p of PROFILES) {
  const r = simulate(p);
  console.log(
    p.name.padEnd(34) +
    `${k(r.p10).padStart(5)} ${k(r.median).padStart(6)} ${k(r.p90).padStart(6)}  |  ` +
    `${pc(r.pLoss).padStart(4)}  ${pc(r.p1_5x).padStart(4)}  ${pc(r.p2x).padStart(4)} ${pc(r.p10x).padStart(4)}   ${pc(r.pRuin).padStart(4)}     | ` +
    `${pc(r.ddMedian)}/${pc(r.ddP90)}`
  );
}
console.log('\n  worst-DD = the deepest peak-to-trough loss you must SURVIVE mid-path (most people sell here).');
console.log('  Note: assumes a REAL edge for the >market profiles. We found none on the screener — so');
console.log('  the realistic baseline without skill+luck is the "Market-like" row.');
