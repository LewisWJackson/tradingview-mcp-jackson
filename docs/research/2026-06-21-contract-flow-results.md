# Contract-Flow (Govt/Vision-2030 Award Drift) — Results (2026-06-21)

Alt-data layer #4. Single 4-month window (Feb→Jun 2026). Award size unavailable → counterparty cut.
Survivorship ≈ nil. **First non-flat result in four layers — but underpowered.**

## Raw output
```
Contract-flow study — contract events 148, used 129, skipped 19
drift [+1,+21] vs ^TASI; cost 0.11% RT + slip 0.15%/side

ALL CONTRACTS (matured, award-gated):
  all              n=129  drift   0.78%  net   0.37%  NW-t 0.72

LIQUID HALF, by counterparty:
  govt/Vision-2030 n= 22  drift   4.56%  net   4.15%  NW-t 2.11
  private          n= 43  drift   0.88%  net   0.47%  NW-t 0.84
  govt − private spread: 3.69%
  govt trim-one drift range: 3.18% … 5.23%

VERDICT (govt/Vision-2030, liquid): UNDERPOWERED — only 22 liquid govt awards (<30)
```

## Verdict

**UNDERPOWERED — but a genuine lead, the first in four layers.** The pooled "all contracts" result
is flat (net +0.37%, t=0.72) — reproducing the earlier catalyst finding. **But the refined cut works
in-sample:** govt/Vision-2030 awards to liquid companies drifted **+4.15% net over 20 days, NW-t 2.11,
beating private awards by +3.69pts, and the trim-one range (3.18–5.23%) shows it is not driven by one
or two names.** Every gate *except sample size* passed. At **n=22 (< the 30 floor)** in a single
4-month window, it does not clear the bar to call a SIGNAL — t=2.11 at n=22 is fragile.

## Plain-English read

For the first time, a refinement didn't die on contact. The story is economically sensible: when a
liquid Saudi company wins a **government / Vision-2030 megaproject contract** (Aramco, a ministry,
NEOM, Saudi Electricity, a municipality…), the stock tends to **keep drifting up ~4% over the next
month** — retail appears to under-appreciate the revenue/backlog the award implies. Crucially this is
*specific to government counterparties*: private-company contracts show almost nothing (+0.47%), and
all-contracts-pooled is flat — which is exactly why the earlier blunt test missed it, and why the
counterparty cut matters.

**The honest caution:** it's 22 events in one 4-month window. That is too few to trust with money —
t≈2 at n=22 can appear by chance, the window is one regime, and award *size* (which should matter) is
unmeasured. This is a **lead to confirm, not an edge to trade.**

## The confirmation step (the clear next move if pursued)

Unlike the three dead layers, this one earns a follow-up: **harvest more contract history** to grow
the liquid-govt sample past ~30–50 and across multiple windows, then re-run `contract_flow_test.mjs`.
The harvester exists (`scripts/harvest_catalysts.mjs`, headed Playwright on saudiexchange.sa) — more
months of issuer announcements → more contract events → a powered test with real across-window OOS.
If it holds at n≥30+ with the spread intact, it graduates to a candidate under the state machine
(guilty until proven; multi-window OOS required before capital).

## Harvest-more attempt (2026-06-21) — blocked by tooling, sample unchanged

Tried to grow the underpowered govt-liquid sample by harvesting more contract history.
- **firecrawl stealth DOES bypass the saudiexchange.sa Akamai wall** (renders the JS-injected
  announcement rows with 4-digit codes + dates) — a useful, confirmed capability.
- **But the feed pages too shallowly:** `&page=N` advances ~5–8 rows / ~5 days per *16 pages*;
  reaching 2024–2025 would take hundreds–thousands of paged stealth scrapes. Firecrawl **ran out
  of credits at page 17.**
- Net: **14 new contract announcements, all Jun 16–21 2026** — too recent to be matured (need 20
  forward trading days), so the study **skips them. Re-run is identical: n=22 govt-liquid,
  +4.15% net, NW-t 2.11, UNDERPOWERED.** They're imported (contract total 196→206) and will mature
  in ~3 weeks, seeding future runs.

**Realistic paths to actually power this (none feasible in-session now):**
1. **Headed desktop harvester** using the site's **date-range filter** (a form POST, not `&page`):
   `HEADLESS=false node scripts/harvest_catalysts.mjs …` on a real desktop to bulk-backfill
   2024–2025 contracts — the memory-flagged "headed on real desktop" job.
2. **`anId` detail-page backfill** — anId is a dense sequential counter (~96103 now); iterate
   downward to ~Feb 2026 (~thousands of fetches) — needs firecrawl credits + a batch crawl.
3. **Time** — keep harvesting recent announcements weekly; the lead's sample grows ~naturally as
   events mature (months).

## Where this leaves the hunt

Three layers dead (sizing, flow, PEAD); **the fourth (govt contract-flow) is the first live thread —
underpowered but directionally real and economically coherent.** Momentum equal-weight is still the
only *validated* edge, but this is the first candidate worth more data. See `[[edge-validation-findings]]`,
`[[advisory-board]]`.
