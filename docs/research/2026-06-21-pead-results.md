# PEAD — Results (2026-06-21)

Cross-sectional, reaction-as-surprise, single 6-month window (Dec-2025→Jun-2026). Survivorship ≈ nil.
Board's above-modest layer #3 (retail-behavioral). 480 matured earnings events used (174 skipped:
unmatured / missing bars). Benchmark `^TASI.SR`; spread cancels it.

## Raw output
```
PEAD cross-sectional study — earnings events 654, used 480, skipped 174
reaction [0,+1] vs ^TASI; drift [+2,+22]; cost 0.11% RT + slip 0.15%/side

QUINTILE (by earnings-day reaction)  reactionMean  driftMean   n
  Q1    -5.66%         0.88%   96
  Q2    -1.41%        -0.64%   100
  Q3    -0.40%        -1.95%   92
  Q4     0.62%        -0.06%   96
  Q5     3.72%         1.19%   96

Q5 long-only drift net of cost+slip: 0.78% (n=96)  NW-t 0.99

PSEUDO-OOS by season (Q5−Q1 spread):
  annual: n=339  Q5−Q1 spread 0.82%
  q1: n=141  Q5−Q1 spread -1.07%

VERDICT (PEAD): NO SIGNAL — spread 0.31% NW-t 0.20, monotonic false, Q5 long-only net 0.78%
```

## Verdict

**NO SIGNAL.** Fails on every gate: the spread Q5−Q1 is 0.31% with NW-t 0.20 (≈ zero), drift is
**not monotonic** across quintiles, and the season pseudo-OOS **flips sign** (annual +0.82%, Q1
−1.07%). The tradeable Q5 long-only drift is +0.78% net but NW-t 0.99 — not significant.

## Plain-English read

Classic PEAD says: stocks that react strongly *up* to earnings keep drifting up; strong-*down*
keep drifting down — so the drift should rise smoothly from the worst-reaction group to the best.
**TASI does not do that.** The shape is a **U**, not a ramp: *both* extremes drift up. The
most-negative-reaction group (Q1, −5.7% on the day) **bounces back +0.88%** — a reversal of
overreaction, the opposite of drift — while the most-positive group (Q5, +3.7%) **continues +1.19%**.
The middle drifts down. There's no single direction to trade.

So the one PEAD-consistent piece — strong *positive* surprises continuing (Q5 +1.19%, long-only
+0.78% net) — is **not statistically real here** (t≈1) and **does not hold out-of-sample** (it works
in the March annual-results cohort, reverses in the May Q1 cohort). The negative side is reversal,
not drift, so a long-short PEAD is incoherent on this data — and shorting isn't available anyway.

## Honest caveats

- **Single 6-month window** (no across-year OOS); the season split is the only OOS and it fails.
- 480 events is a healthy cross-section, so this isn't an underpowered "maybe" — the *structure*
  (U-shape, sign-flip across seasons) says there's no clean drift to harvest, not just noise.
- Reaction proxy (no consensus estimates); a true SUE measure could sharpen the sort, but the
  reaction-sorted version showing a U rather than a ramp argues against a strong hidden PEAD.

## Conclusion

**Third above-modest layer tested, third negative result.** Sizing (#1), flow front-running (#2),
and now earnings drift (#3) all came back NO SIGNAL on honest, OOS-aware tests. The momentum
equal-weight engine remains the only validated edge on TASI. The pattern is now strong enough to
take seriously: plausible upside layers keep dissolving on contact with out-of-sample discipline.
See `[[edge-validation-findings]]`, `[[advisory-board]]`.
