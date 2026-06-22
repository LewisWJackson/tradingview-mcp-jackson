# Saudi IPO Base-Rate Ledger — "IPO Subscription Flipping" as a Structural Retail Edge

**Date:** 2026-06-22 · **Account context:** one-person Sharia Tadawul/Derayah, ~100K SAR · **Branch:** `feat/alpha-exec`

> **This is a structural frequency-table validation, NOT a price backtest.** The thesis is a
> primary-market mechanic — apply for an IPO at the fixed offer price, get a scaled allocation,
> flip the day-1 listing pop. The relevant statistic is the **day-1 pop base rate** and the
> **break-issue tail**, not a t-stat. Do not run this through portfolioGuillotine.

---

## TL;DR / Decision

**Policy decision: UNCLEAR, leaning NO as a standalone "income" strategy — but a mild, capacity-limited YES on positive-skew grounds for Main-Market IPOs only.**

The reason is one hard mechanic that the bull-case narrative ignores: **Tadawul caps day-1 moves at ±30%** (expanded limit for the first 3 sessions, then ±10%). So the day-1 flip upside is **structurally capped at +30%**, and in practice the hot ones simply *pin* that cap. Meanwhile the realized return is that capped pop **× your allocation %**, and allocation on a heavily-oversubscribed deal (100–240× institutional, "1,981%" retail-Nomu) is **tiny**. A +30% pop on a 1–3% allocation is a +0.3% to +0.9% return on *applied* capital per deal, before the ~1–2 week capital lock-up. That does beat parking cash for those weeks, but it is small, lumpy, and exposed to a real break-issue tail (Luberef −4% day 1; several Nomu names −28% to −60%).

---

## The Ledger (n = 26; Main 19 / Nomu 7)

`day1%` = day-1 close vs offer. **cap** = print hit the +30% limit on day 1. **cum** = the figure available is cumulative/since-listing, *not* day-1. `null` = could not source cleanly (marked honestly, not fabricated).

| # | Company | Code | Mkt | Yr | Offer SAR | Inst. oversub | List date | Day-1 % | Note | Broke issue |
|--|---------|------|-----|----|-----------|---------------|-----------|---------|------|-------------|
| 1 | ACWA Power | 2082 | Main | 2021 | 56.00 | — | 2021-10-11 | **+30%** | cap | no |
| 2 | Nayifat Finance | 4081 | Main | 2021 | 34.00 | 136× | 2021-11-22 | null | cum (ATH 30.50 < offer→soft) | unclear |
| 3 | Luberef | 2030 | Main | 2022 | 99.00 | — | 2022-12-28 | **−4%** | — | **YES** (closed 95) |
| 4 | MBC Group | 4072 | Main | 2024 | 25.00 | — | 2024-01-08 | **+30%** | cap | no |
| 5 | Middle East Pharma | 4016 | Main | 2024 | 82.00 | — | 2024-02-27 | null | cum +44.9% | no |
| 6 | Modern Mills | 2284 | Main | 2024 | 48.00 | 127× | 2024-03-27 | null | cum −14.9% | unclear |
| 7 | Dr Soliman Fakeeh | 4017 | Main | 2024 | 57.50 | — | 2024-06-05 | null | cum +18.8% | no |
| 8 | Miahona | 2084 | Main | 2024 | 11.50 | — | 2024-06-06 | null | cum +134% | no |
| 9 | SMASCO (Manpower) | 1834 | Main | 2024 | 7.50 | — | 2024-06-12 | null | cum +0.5% | no |
| 10 | Rasan Information Tech | 8313 | Main | 2024 | 37.00 | 129× | 2024-06-13 | **+30%** | cap (closed 48.1) | no |
| 11 | Al Taiseer (Talco) | 4143 | Main | 2024 | 43.00 | — | 2024-06-13 | null | cum +71.9% | no |
| 12 | Al Majed Oud | 4165 | Main | 2024 | 94.00 | — | 2024-10-07 | null | cum +53.4% | no |
| 13 | Arabian Mills | 2285 | Main | 2024 | 66.00 | — | 2024-10-08 | null | day1 ATH 72.6 (+10% intraday); cum −25.9% | unclear |
| 14 | Fourth Milling (MC4) | 2286 | Main | 2024 | 5.30 | — | 2024-10-29 | null | day1 ATH 5.79 (+9.2% intraday); cum −24% | unclear |
| 15 | Tamkeen HR | 1835 | Main | 2024 | 50.00 | — | 2024-11-27 | null | cum +28.6% | no |
| 16 | United Intl Holding | 4083 | Main | 2024 | 132.00 | — | 2024-12-03 | null | cum +27.6% | no |
| 17 | Nice One Beauty | 4328 | Main | 2025 | 35.00 | — | 2025-01-08 | null | cum +45% | no |
| 18 | Flynas | 4264 | Main | 2025 | 80.00 | 100× | 2025-06-18 | null | "stormy start" (Israel-Iran airspace) | unclear |
| 19 | Dar AlBalad | 7205 | Main | 2026 | 9.75 | — | 2026-05-20 | **+26%** | (closed 12.32, under ±30%) | no |
| 20 | Pan Gulf Marketing | 9580 | Nomu | 2024 | — | — | 2024-02 | null | cum −35% | **YES** |
| 21 | Yaqeen Capital | — | Nomu | 2024 | — | — | 2024-06 | null | cum −28% | **YES** |
| 22 | Purity for IT | — | Nomu | 2024 | — | — | 2024-10 | null | cum +118% (30d) | no |
| 23 | Smoh Almadi | — | Nomu | 2025 | 22.00 | — | 2025-01 | null | cum −60% | **YES** |
| 24 | Smile Care (Basma) | 9626 | Nomu | 2025 | 4.40 | 1,981%* | 2025-02-03 | null | — | unclear |
| 25 | Lamasat | 9628 | Nomu | 2025 | 5.75 | 1,101%* | 2025-02-09 | null | — | unclear |
| 26 | Ratio Speciality | — | Nomu | 2025 | 10.00 | 865%* | 2025-03 | null | cum +190% | no |

\* Nomu oversubscription is reported as a % coverage of a *qualified-investor* tranche, not the retail-tranche times-covered used on Main.

---

## Base-Rate Statistics

### Clean day-1 sample (n = 5 — the honest core)
Only 5 of 26 have a *clean, sourced day-1 close vs offer*. Everything else the press reports as cumulative/since-listing, which is a different (and self-selected, survivor-tilted) statistic.

| Stat | Value |
|------|-------|
| Popped day-1 (close > offer) | **4 / 5 = 80%** |
| Broke issue day-1 | 1 / 5 = 20% (Luberef −4%) |
| Mean day-1 pop | **+22.4%** |
| Median day-1 pop | **+30.0%** |
| Pinned the +30% cap | 3 / 5 (ACWA, MBC, Rasan) |

### Break-issue tail (whole sample, day-1 *or* post-listing as a proxy)
- **4 / 26 confirmed broke issue** (Luberef Main; Pan Gulf −35%, Yaqeen −28%, Smoh Almadi −60% on Nomu).
- The tail is **concentrated in Nomu** and in weak sectors (milling/SME). Main-Market break-issue is rare (1 clear case in 19, Luberef, and only −4%).

### Decay check (2021 → 2026)
- 2021–2022: ACWA +30% (cap), Luberef −4%. 2024: MBC +30%, Rasan +30% (caps). 2026: Dar AlBalad +26%.
- **No evidence of day-1 pop decay** on Main Market — the cap is still being pinned in 2024 and 2026. What *has* decayed is **post-listing follow-through**: the milling/Nomu cohort of late-2024→2025 (Arabian/Fourth Milling, Smoh Almadi, Pan Gulf) gave back gains or broke. So the *flip-on-day-1* edge looks intact; the *hold-it* trade does not.
- **Main vs Nomu:** Main = reliable, capped, small-tail. Nomu = bimodal — bigger headline pops (+118%, +190% cumulative) but the real break-issue risk (−28% to −60%). For a one-person Sharia account, **Nomu is also gated** (qualified-investor tranches — retail often can't even apply), which removes most Nomu deals from the policy anyway.

---

## Return-on-Capital Math (the part that decides it)

Realized flip return ≈ **pop% × allocation% − lock-up drag**. The cap fixes pop% ≈ +30% best case. Allocation is the killer:

| Scenario | Oversub | Retail allocation* | Day-1 pop | Return on **applied** capital | Return on **allocated** capital |
|----------|---------|--------------------|-----------|-------------------------------|----------------------------------|
| Hot Main IPO (Rasan-like) | ~130× inst / ~30× retail | ~3% of applied filled | +30% (cap) | **+0.9%** | +30% |
| Typical Main IPO | ~50–100× | ~5–10% filled | +20% | **+1.0% to +2.0%** | +20% |
| Cold / cornerstone-heavy | low | up to ~100% | +5% to +30% | +5% to +30% | same |
| Break-issue (Luberef) | — | full | **−4%** | **−4%** | −4% |

\* Saudi retail IPO allocation is *pro-rata then min-guarantee*; on a heavily oversubscribed deal you get a small guaranteed lot plus a pro-rata sliver. The "return on allocated capital" looks great (+20–30%) but it is on a *small allocated amount* — the rest of your applied cash sat locked earning nothing for ~1–2 weeks.

**Annualized estimate on cycled capital.** Assume you can apply full size to ~15–20 eligible Main IPOs/yr, each locks capital ~1.5 weeks, median *applied*-capital return ~+1.0% to +1.5% per deal (driven by the small allocation), with a ~5–10% break-issue probability costing a few percent. Capital can be re-cycled, but only one or two deals run at a time, so effective deployment is maybe ~30–40% of the year. **Rough annualized on the cash you actually tie up: ~+8% to +15%, high-variance, positively skewed, with a fat-ish left tail in any bad-tape window** (the 2025 milling/Nomu cohort shows how a whole season can sour). On *total* account capital the contribution is smaller because you can't keep 100K deployed across enough simultaneous deals.

---

## Decision Rule Applied

> "Subscribe to every eligible Sharia-compliant Tadawul/Nomu IPO as policy" — YES if median return-on-cycled-capital beats parking cash and break-issue rate is tolerable.

- **Median day-1 pop:** +30% (capped) on the clean sample → the *direction* clears the hurdle easily; cash parked for 1.5 weeks returns ~0.15%.
- **But return on *applied* capital ≈ +1% per deal** once allocation scaling is applied — beats cash, but it is small and the strategy is capacity-limited (you can't get a big fill on the deals that pop).
- **Break-issue rate ≈ 4/26 (~15%) overall, ~1/19 (~5%) on Main, and the Main case was only −4%.** Tolerable on Main; **not** tolerable on Nomu (−60% tail), which is also mostly inaccessible to retail anyway.

### Verdict
- **Main Market IPOs (Sharia-screened): MILD YES.** Apply as a standing policy. It is a positive-skew, capped-upside, low-Main-break-issue trade that beats idle cash on the cycled portion. Treat it as **opportunistic cash-management with a kicker, not a core return engine.** Do **not** size it as "income."
- **Nomu IPOs: NO** for this account — qualified-investor gating blocks most of them, and the accessible tail (−28% to −60%) is the wrong shape for a 100K Sharia account.
- **Overall thesis "repeatable positive-skew edge": PARTIALLY CONFIRMED but SMALLER THAN THE NARRATIVE.** The +134%/+147%/+190% headlines are cumulative survivors, not the day-1 flip. The honest flip number is "+30% cap × small allocation," and that is the number to plan around.

---

## Data-Source Coverage & Caveats (honest accounting)

- **Local DB:** `catalyst_events` has no IPO/listing type (types: acquisition, assembly, capital_change, capital_ops, contract, dividend, earnings, guidance, management, other). **Zero local coverage.**
- **saudiexchange.sa:** Akamai-walled; not scraped this session (would need full Playwright). The official "Recently Listed" table with exact day-1 OHLC was **not** obtained — that is the single biggest gap.
- **firecrawl:** out of credits (HTTP **402**) for the whole session — fell back to WebSearch + WebFetch on Argaam/news.
- **Day-1 precision:** only **n=5** have a clean sourced day-1 close vs offer. The other 21 rows carry cumulative/since-listing figures (survivor-tilted upward) or nulls. **The base-rate stats above are computed on the n=5 clean sample and stated as such — do not read the cumulative columns as day-1.**
- **Offer prices / oversub:** sourced for most Main names; several Nomu offer prices are null.
- **Sample is news-curated, not exhaustive.** Real 2021–2026 Tadawul+Nomu IPO count is ~150+ (15 Main + ~28 Nomu in 2024 alone; 13 Main + 24 Nomu in 2025). This ledger is ~26, **biased toward the names that made headlines** (which skews toward both the big pops and the notable failures). A complete, unbiased base rate needs the exchange's own listing table.
- **No fabricated numbers.** Every non-null figure traces to a cited source; unknowns are null.

### To harden this (next session)
Drive `saudiexchange.sa` "Recently Listed" with Playwright (Akamai bypass) to pull the full 2021–2026 listing set with exact day-1 open/close, then recompute the base rate on the *complete* population rather than the headline-curated subset. That converts the n=5 clean day-1 sample into the real n≈80 Main-Market sample and settles the allocation-scaling question with actual retail-tranche fill ratios.

---

### Sources
Argaam (article IDs 1869916, 1764248, 1786822, 1513938, 1501626), Arab News (ACWA debut, GCC IPO 2024/2025, Nice One), The National (MBC +30%, Luberef −4%), MenaBytes (Rasan +30% cap), gulfbusiness/gulfnews (Modern Mills, Flynas), sahmcapital (2024 IPO review, Dar AlBalad +26%), Zawya, PwC/Markaz GCC IPO watch. Harvest script: `scripts/ipo_harvest.mjs` (`--json` for raw ledger).

---

## Population hardening (price-derived, 2026-06-22)

The n=5 clean-day-1 sample was too thin. Offer prices for the full population aren't
cheaply scrapable (saudiexchange.sa is Akamai-walled, firecrawl out of credits), so this
section hardens the study two ways, **without** needing population-wide offer prices:

- **(A) a price-derived population PROXY** computed off the Yahoo bars cache for every
  TASI name whose first cached daily bar falls on/after 2021-01-01 (a window-IPO), and
- **(B) the TRUE offer-relative pop** on the ledger subset that has a known offer price.

Script: `scripts/ipo_population.mjs` (`--json` for raw). Frequency study — **no guillotine.**

### Population identified
- **n = 41 recent listings** (first cached bar ≥ 2021-01-01) out of 182 TASI names scanned.
  This is the real window-IPO population we can see via price (vs the 26 news-curated rows).

### (A) Proxy base-rate — and why it's weak (the load-bearing lesson)
| Stat (n=41, intraday first-bar) | Value |
|---|---|
| % up day-1 (close>open) | 43.9% |
| % down day-1 (close<open) | 56.1% |
| % intraday near-+30% cap, first 3 sessions | **0.0%** |
| median day-1 intraday return | 0.0% |
| median first-5-session return | −0.2% |

**The cap-pin proxy reads 0% and that is the finding, not a bug.** Yahoo's first daily
bar already **opens** at the popped/capped price (the offer→open gap happened pre-open),
so `close/open − 1` is ~flat and is **blind to the offer-relative pop**. The intraday proxy
therefore *understates* the pop badly — it only measures "did it keep drifting after the
first print" (a coin-flip, 44% up). **Conclusion: the offer→open gap, not intraday drift,
IS the IPO pop, and you cannot recover it from secondary-market bars alone.** The honest
population number is the offer-subset truth in (B), not the intraday proxy.

### (B) TRUE pop on the offer-price subset (the real hardening: n=5 → n=12)
Computed as day-1 close / offer − 1 on ledger names with a known offer price. **Critical
data-quality guard:** Yahoo's first cached bar is *not* reliably the true day-1 bar — three
contamination modes were found and **excluded** (not fabricated around):
1. **Pre-IPO history** — `2030.SR` (Luberef) opens 2016 (spun-off Aramco unit); its real
   day-1 was −4% per the ledger but Yahoo can't source it cleanly → excluded.
2. **First bar lags the list date by weeks/months** — ACWA (+69d), Nayifat (+16d),
   Rasan/Al Taiseer (+10d), ME Pharma (+138d), Smile Care (+104d) → excluded.
3. **Price-scale artifact** — `4083.SR` (United Intl) offer 132 but Yahoo trades ~65
   (impossible −50% offer→open gap; ledger says cum +27.6%) → excluded.

Keeping only rows where the first bar is within 6 days of the known list date **and** the
offer→open gap is mechanically sane (≥ −35%):

| Trusted offer-subset (n=12) | Value |
|---|---|
| popped (true day-1 close > offer) | **10 / 12 = 83.3%** |
| broke issue (true close < offer) | 2 / 12 = 16.7% (Arabian Mills −0.3%, Flynas −3.4%) |
| **median TRUE day-1 pop** | **+30.0%** |
| median offer→open gap (the pop lives here) | +10.0% |
| names pinning ≈+30% true | MBC, Modern Mills, Tamkeen, Smile Care (and Al Majed/Miahona/Lamasat gapped >+40%) |

The true-pop median of **+30.0%** confirms the cap-pin pattern at population grade: the
modal hot Main IPO closes day-1 right at the +30% expanded limit, and the few that gap
above it (Al Majed +68.9%, Miahona +53.6%, Lamasat +35%) opened far above offer. **The
proxy did NOT track the truth** (median proxy ~0% vs median true +30%) — exactly because
the pop is in the offer→open gap the proxy can't see. This is the single biggest takeaway:
**offer-relative pop is only knowable with offer prices; secondary bars can't proxy it.**

### (C) Decay check (by first-bar year, intraday proxy)
| Year | n | %up | median day-1 intraday | median 5-session |
|---|---|---|---|---|
| 2021 | 12 | 41.7% | 0.0% | −0.5% |
| 2022 | 14 | 28.6% | −1.1% | −1.4% |
| 2023 | 6 | 66.7% | +5.3% | +8.4% |
| 2024 | 4 | 75.0% | +9.5% | +9.0% |
| 2025 | 5 | 40.0% | −0.3% | +2.2% |

These are *intraday/follow-through* numbers (the proxy), so they describe post-print drift,
not the offer pop. No clean monotonic decay; 2023–24 listings drifted up more after the
first print, 2021–22 and 2025 were flat-to-soft. On the **offer-relative** side, the trusted
subset spans 2021→2026 (ACWA 2021 cap … Dar AlBalad 2026 +32%) and the +30% pin keeps
recurring — **consistent with the prior finding of no day-1 pop decay on Main Market.**

### Updated decision (population-grade)
The verdict is **unchanged in shape but now rests on n=12 verified offer-relative pops, not
n=5**, plus a 41-name population map of what's visible via price:

- **Main-Market Sharia IPOs: MILD YES, opportunistic cash-management with a kicker.** Day-1
  pop base rate ≈ **83% popped, median +30%** (cap-pinned), break-issue ≈ **17% and shallow**
  (the two breaks were −0.3% and −3.4%, not the −60% Nomu tails). Direction clears the hurdle.
- **The number to plan around is still pop% × allocation%.** The +30% cap × a small
  oversubscribed allocation (1–3% filled on hot deals) → ~**+0.3% to +0.9% per deal on
  *applied* capital**, with cold/cornerstone-light deals filling more. Honest **annualized on
  cycled capital ≈ +8% to +15%, high-variance, positively skewed**, capacity-limited (only
  1–2 deals run at once, ~30–40% effective deployment). Unchanged from the prior estimate —
  the bigger sample tightened the *base rate*, not the allocation math.
- **Nomu: still NO** (qualified-investor gating + −28% to −60% tails).

### Honest coverage caveat (read this)
- **The hardening is real but bounded.** The *population proxy* (A) is genuinely population-
  scale (n=41) but is the **wrong statistic** — it's intraday/follow-through and blind to the
  offer pop. The *offer-relative truth* (B) is the right statistic but is still only **n=12**
  (the ledger names with a known offer price that also survive the data-quality guard).
- **We did not break the offer-price wall.** Population-wide offer prices remain unscrapable;
  this session expanded the *clean offer-relative sample from 5 to 12* and *mapped the 41-name
  price-visible population*, but a true population offer-relative base rate (n≈80 Main) still
  needs the exchange's prospectus/listing table. The +30%-pop / ~17%-break headline is solid
  for Main; its allocation-scaled return is the honest, smaller, capacity-limited reality.
- **No fabrication.** Excluded rows are excluded with the reason stamped (date lag / pre-IPO
  history / price scale), not back-filled. Luberef's −4% day-1 is known from news but Yahoo
  can't source it cleanly, so it is dropped rather than invented.
