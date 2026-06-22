# Test Plan #2 — Flow / Rebalance Front-Running

**Date:** 2026-06-21
**Rank:** #2 (calendar-driven → low overfit; strongest *new* edge candidate)
**Status:** authorized by board conclusion; not yet run

---

## Plain-English summary

Big pools of money are *forced* to buy and sell certain TASI stocks on *known dates*, for reasons
that have nothing to do with whether the stock is cheap. Examples:

- **Index rebalances** — when MSCI / FTSE / the Saudi index add, drop, or re-weight a stock, every
  fund that tracks that index must trade it, on the effective date, in size.
- **IPO free-float additions** — a newly listed stock gets added to indices on a schedule after
  listing; trackers must buy.
- **PIF / government stake changes** — when the sovereign fund's holding changes, the float that
  indices count changes, forcing tracker trades.

These flows are *predictable* (announced in advance, fixed effective dates) and *price-insensitive*
(the funds must trade regardless of price). The hypothesis: a nimble retail account can position
ahead of that forced flow and exit into it. This is the board's strongest *new* idea because the
signal is a **calendar**, not a fitted pattern — which makes it hard to overfit. You either traded
around the real event dates or you did not.

This is a genuinely new edge (unlike Plan #1, which re-sizes the edge we have), so the bar for proof
is higher and the hygiene around event dates is everything.

---

## Hypothesis (precise)

> TASI stocks experiencing a predictable, price-insensitive demand shock (index inclusion /
> re-weight up / IPO float add / PIF-driven float increase) earn **abnormal positive returns** in
> the window *before* the effective date, and a **reversal** after — large enough that buying at
> announcement and selling into the effective-date flow beats the market, net of Derayah cost and
> net of the spread/slippage these often-thinner names carry.

Mirror case (optional second leg): forced *selling* events (deletions, re-weight down, float cuts)
produce abnormal *negative* returns into the date — tradeable only as "avoid / do not hold," since
shorting is not part of the Halal retail mandate.

---

## What "win" means

**Primary metric:** average abnormal return (return *minus* the market's return over the same
window) of the announce→effective-date trade, net of cost and an explicit slippage assumption.
**Statistical bar:** the average must be positive with a t-stat > 2 (Newey-West, to handle
overlapping event windows), across a reasonable number of distinct events.
**Practical bar:** the per-event edge must clear realistic costs for the *liquidity these names
actually have* — inclusion candidates can be thin; a paper edge that vanishes under a real spread
is not an edge.

---

## Data needed (this plan lives or dies on event data)

- **Event calendar (the core asset):** historical list of TASI index inclusions, deletions,
  re-weightings, with **announcement date** and **effective date** for each. Sources to confirm:
  MSCI / FTSE Russell rebalance announcements, Tadawul/Argaam notices, index methodology docs.
- **IPO schedule:** listing dates + the scheduled index-add dates (fast-entry rules differ by
  index).
- **PIF / major stake changes:** disclosed holding changes that altered index float (Tadawul
  disclosures).
- **Prices:** daily total-return prices for each event name around its window (±60 trading days),
  plus the TASI index return for the same window (to compute *abnormal* = name minus market).
- **Liquidity/spread:** average daily volume and a spread estimate per event name at event time —
  to set an honest slippage assumption and to confirm the trade was actually executable at retail
  size.

**Hygiene gate (blocking):** events must be timestamped by when the info was *public* (announcement
date), never by hindsight. Using the effective date as if it were knowable earlier = look-ahead =
fiction. Same point-in-time rule as Plan #1.

---

## Method (event study, then tradeability check)

1. **Build the event table** — every qualifying event with announce date, effective date, type
   (add / up-weight / IPO-add / float-up). Start with the cleanest, highest-flow category (major
   index additions) before widening to noisier ones.
2. **Event study** — for each event, compute the cumulative *abnormal* return (name minus TASI)
   across the window: pre-announcement, announce→effective (the trade), and post-effective (the
   reversal). Average across events; t-stat with Newey-West for overlap.
3. **Define the tradeable rule** from the *shape* the study reveals (e.g. "enter T+1 after
   announcement, exit on effective date −1"). Fix the rule; do not re-tune it per event.
4. **Cost + slippage** — charge 0.11% RT *plus* a per-name slippage from its actual spread/volume.
   Thin names get a bigger haircut. Net edge is the only number that matters.
5. **Capacity check** — at retail size, could the position be entered/exited inside the name's daily
   volume without moving it? Flag events where the answer is no (paper-only edge).
6. **Out-of-sample split** — events are dated, so split by time: derive the rule on the earlier
   events, test it untouched on the later events.

---

## Out-of-sample (OOS) gate — must pass ALL

- OOS average trade abnormal return positive, **net of cost + slippage**, t > 2.
- Holds in the **later** event period (rule built on earlier events, judged on unseen later ones).
- Edge survives the **honest** slippage haircut for the actual liquidity of the names (not a
  zero-spread fantasy).
- Edge is **not** driven by 1–2 outlier events — trim the top/bottom event and it still stands.
- Capacity-feasible at retail size for a usable fraction of events.

---

## Kill criteria (fast)

- Abnormal return is real *before* cost but **gone after** realistic spread/slippage → kill (most
  likely failure mode for thin inclusion names).
- Edge exists on early events, **absent** on later events → it decayed or was overfit → kill.
- Whole result rides on one mega-event (e.g. a single huge index entry) → kill / treat as anecdote.
- Event dates cannot be reliably sourced point-in-time → cannot proceed; halt and reassess data.
- Capacity check says retail can't enter/exit without moving the name → shelve as untradeable.

---

## Why this is #2, not #1

- Higher payoff potential than re-sizing, but it is a **new prediction**, so more ways to be wrong.
- Lower overfit risk than pattern-mined signals because the trigger is a **published calendar** —
  but it imports a new dependency (clean event data) and a new enemy (slippage in thin names).
- Run **after** Plan #1 ships, because Plan #1 needs no new data and compounds whatever edges exist —
  including this one, later. Sizing first, new edge second.

---

## Relationship to the existing system

- New edge → enters as a **candidate** under the existing state machine ([[shipped-state]]):
  net>0 AND t>2 AND stable-across-both-halves AND ≥24 events before any live promotion.
- Surfaces in Lab as a separate signal, never auto-promoted, downgrade-only — same governance as
  the momentum edge. Red-team rule from the board ([[advisory-board]]): guilty until proven OOS.
