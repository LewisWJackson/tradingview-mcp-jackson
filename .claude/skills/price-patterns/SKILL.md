---
name: price-patterns
description: Reference catalog of chart formations, trend structure, and price-action patterns — market structure (swing highs/lows, HH/HL, Dow accumulation/markup/distribution/markdown phases), support/resistance mechanics, Fibonacci retracements and extensions (golden pocket, 38.2/50/61.8/78.6%, 127.2/161.8% projections, Elliott Wave note), continuation formations (flags, pennants, triangles, wedges, rectangles, cup & handle), reversal formations (double/triple tops & bottoms, head & shoulders, rounding, diamond), candlestick patterns (doji, hammer, engulfing, stars, soldiers/crows), time/sequence analysis (candle counting, TD Sequential 9/13, cycles, time-based stops), and market cycle models (Benner cycle, psychology-of-a-market-cycle, Dow phases, land/halving cycles) with a 123-year backtest showing predictive cycle-timing loses to buy-and-hold while reactive regime timing wins — each with its structure, what it implies, measured-move target, volume behavior, and honest reliability. Consult this whenever describing or annotating a chart formation, reading trend structure, drawing Fibonacci levels, counting candles/bars from a pivot, placing stops/targets at structure, discussing "is this a breakout / reversal / continuation," or turning a visual pattern into a testable rule. Complements trading-fundamentals (strategy-design altitude) and chart-analysis (TradingView workflow). Read the reliability section before treating any pattern as a signal.
---

# Price Patterns — Formations, Trends & Market Structure

A working vocabulary for describing what price is doing, so chart analysis is
consistent and so a "pattern" can be turned into something testable rather than
something seen in hindsight.

## How to use this (read first)

Patterns are **hypotheses and context, not signals.** A formation tells you what
*might* happen and, more usefully, *where you're wrong* — which is where a stop goes.
Three rules keep pattern-talk honest:

1. **A pattern is only real once it resolves.** A "head and shoulders" that hasn't
   broken its neckline is just three bumps. Describe forming patterns as *potential*.
2. **The measured move is a target, not a promise.** Every projection below is a rule
   of thumb with a wide error bar.
3. **Volume and higher-timeframe context confirm; price alone deceives.** A breakout on
   falling volume, against the higher-timeframe trend, is the classic false-breakout
   setup.

See the **Reliability reality check** at the end before you let any of this drive an
entry. In this project's own out-of-sample testing, pattern/timing signals did **not**
beat buy-and-hold; the durable edge was regime context and risk control. Use patterns
for **structure (where to place stops/targets) and regime read**, not as standalone
buy/sell triggers.

---

## 1. Market structure — the foundation everything else sits on

Before naming any formation, read the structure. Structure is defined by **swing
points**: a swing high is a bar whose high is above the bars on either side; a swing
low, the mirror. Connecting them gives the trend's skeleton.

- **Uptrend** = a sequence of **higher highs (HH) and higher lows (HL)**. Each pullback
  bottoms above the last — buyers keep stepping in earlier.
- **Downtrend** = **lower highs (LH) and lower lows (LL)**.
- **Range / consolidation** = highs and lows oscillating between roughly horizontal
  bounds; no directional structure.
- **Structure break** = the first HL that fails (price closes below the prior HL in an
  uptrend) is the earliest objective sign the trend may be turning. This is the single
  most useful structural event — it's what a trend/regime filter is really detecting.

```
 Uptrend (HH/HL)          Downtrend (LH/LL)        Range
        HH                 LH                    ___________
       /  \      HH        /\                   |  .  .  .  |
   HL /    \    /         /  \    LH            |.  .  .  . |
     /      \  /         /    \   /\            |  .  .  .  |
    /        \/         /      \ /  \           |___________|
 (higher lows)         /        v    \ LL
```

**Dow-theory phases** (the macro version of the same idea): *accumulation* (smart money
builds while price is flat and hated) → *markup* (the visible uptrend) → *distribution*
(flat, euphoric, smart money exits) → *markdown* (the decline). Most "cycle" talk (the
BTC 4-year cycle, the land cycle) is this pattern at a longer wavelength.

**Always read the higher timeframe first.** A bullish flag on the 15-minute chart inside
a daily downtrend is a lower-probability trade than the same flag inside a daily uptrend.
Trend alignment across timeframes is the cheapest edge in this whole document.

---

## 2. Support & resistance — where structure lives

- **Support** = a level where buying has repeatedly halted declines. **Resistance** =
  where selling has halted advances.
- **Why they work:** memory and self-fulfilment. Traders remember where price turned and
  place orders there, which makes it turn again — until it doesn't.
- **Role reversal (flip):** broken resistance often becomes support and vice-versa. A
  clean retest of a broken level that holds is one of the more reliable continuation cues.
- **Strength factors:** more touches, higher volume at the level, and confluence (a level
  that is also a round number, a moving average, or a prior swing) make it more significant.
- **Practical use here:** structural S/R is where stops and targets *belong* — put the
  stop just beyond the level that invalidates the idea, not at an arbitrary ATR distance.

---

## 3. Trend structures — channels, lines, measured moves

- **Trendline:** a line along the swing lows (uptrend) or swing highs (downtrend). Needs
  ≥2 touches to draw, a 3rd to confirm. Steeper = less sustainable.
- **Channel:** price bounded by two parallel lines. Trades within the channel (buy lower
  line / sell upper) work only while the channel holds; the *break* of a channel is often
  the more tradeable event.
- **Measured move:** trends often travel in roughly equal legs separated by a pullback
  (an "ABC" or "1-2-3"). The projected leg ≈ the length of the first leg added to the
  pullback low. A target, not a guarantee.

---

## 4. Fibonacci retracements & extensions

Fibonacci levels come from the ratios between numbers in the Fibonacci sequence
(0.618, 0.382, …). Traders use them to anticipate *how far a pullback goes*
(retracement) and *how far the next leg runs* (extension). Pre-marked reaction zones —
not magic numbers.

**Retracement** — measure a completed swing (low → high in an uptrend) and mark the
pullback levels:
- **23.6%** — shallow; strong trends often only dip this far.
- **38.2%** — common in a healthy trend.
- **50%** — not a true Fibonacci ratio but universally watched (the halfway-back level).
- **61.8%** — the "golden ratio"; roughly the deepest a pullback usually goes while the
  trend is still intact. The **38.2–61.8% band is the "golden pocket"** most traders
  watch for a continuation entry.
- **78.6%** — deep; beyond it, the move is more likely a full reversal than a pullback.

**Extension / projection** — for targets *beyond* the prior swing: **127.2%, 161.8%,
261.8%**. Used to project where a trend leg might end (pairs naturally with the
measured-move idea in §3).

```
 Uptrend retracement (draw low -> high; pullback lands in the zone)
   high ___________________ 0%
       |                    23.6%
       |     pullback       38.2%  } "golden
       |     often stalls   50%    }  pocket"
       |     in here        61.8%  }
       |                    78.6%
   low |___________________ 100%
```

**How to use it (honestly):**
- **Confluence is everything.** A Fib level alone is weak. A 61.8% retracement that
  *also* sits on prior support, a moving average, or a round number is a real reaction
  zone. Fib is a confluence/filter tool, not a trigger.
- **Risk placement.** React in the golden pocket, put the stop just beyond the 78.6% (if
  that breaks, the pullback thesis is wrong), and target the prior high or a 127.2/161.8%
  extension. Concrete and testable.
- **Elliott Wave** builds whole trend/counter-trend structures on Fib ratios; internally
  elegant but *highly subjective* — the wave count is usually only clear in hindsight.
  Context, not a tradeable count you can't backtest.
- **Fibonacci fans, arcs, and time zones** exist but are more esoteric and even less
  evidenced; the horizontal retracement/extension levels are what most traders actually use.

**Reliability:** the same caveats as §11 — partly self-fulfilling (enough traders watch
50%/61.8% that orders cluster there), no robust standalone edge, and the levels are only
as good as the swing you chose to draw them from (garbage swing → garbage levels). Use
them to *pre-mark* reaction zones and define invalidation, then codify and backtest
before trusting.

## 5. Continuation formations — the trend pauses, then resumes

These form *inside* a trend and typically resolve in the trend's direction. A breakout
strategy is a bet that one of these is forming and about to break the right way.

- **Flag** — a small counter-trend rectangle after a sharp move ("flagpole"). Bull flag
  slopes gently down; bear flag gently up. *Target:* project the flagpole length from the
  breakout. *Volume:* high on the pole, drying up in the flag, surging on the break.
- **Pennant** — like a flag but the consolidation is a small symmetrical triangle. Same
  logic and target as a flag.
- **Triangles:**
  - *Symmetrical* — lower highs + higher lows converging; coiling energy, direction
    ambiguous until it breaks (slight bias to the prevailing trend).
  - *Ascending* — flat top, rising lows; buyers getting more aggressive → bullish bias.
  - *Descending* — flat bottom, falling highs; bearish bias.
  - *Target:* the triangle's height projected from the breakout point.
- **Rectangle** — a clean horizontal range between support and resistance; trade the
  range edges, or the breakout with the range height as the target.
- **Wedge (continuation)** — both lines slope the *same* way but converge; a rising wedge
  in a downtrend / falling wedge in an uptrend usually resolves with the trend. (Note: a
  wedge *against* the trend is often a *reversal* — see §6.)
- **Cup & handle** — a rounded bottom ("cup") then a small pullback ("handle"); bullish
  continuation, target = cup depth projected from the breakout.

```
 Bull flag        Ascending triangle     Symmetrical triangle
    |                ____________            \        /
    |  ___           .  .  .  .  |            \      /
    | /   \  ...     .  .  .  .  |             \    /   -> breaks
    |/     \___      / / / /                    \  /
   (pole) (flag)   (rising lows)              (coil)
```

---

## 6. Reversal formations — the trend exhausts and turns

These form at the *end* of a trend. A mean-reversion strategy is implicitly betting a
(minor) reversal is near.

- **Double top / bottom** — two failed attempts at the same extreme ("M" top / "W"
  bottom). Confirmed only when price breaks the intervening swing (the "neckline").
  *Target:* pattern height projected from the neckline break.
- **Triple top / bottom** — three tests; rarer, often stronger once it breaks.
- **Head & shoulders** — three peaks, the middle (head) highest, shoulders lower and
  roughly level; neckline along the two troughs. *Inverse H&S* is the bottoming mirror.
  Confirmed on the neckline break; *target:* head-to-neckline distance projected down
  (or up for inverse). One of the more-studied and better-regarded reversal shapes.
- **Rounding top / bottom (saucer)** — a slow, gradual curl of direction; no sharp
  trigger, reflects a gradual shift in control.
- **Rising/falling wedge (reversal)** — a converging wedge *against* the trend that runs
  out of steam and reverses (rising wedge → bearish; falling wedge → bullish).
- **V-reversal / spike** — a violent turn with no consolidation; hard to trade, common
  after capitulation or a news shock.
- **Diamond** — a broadening then narrowing top; a rare, unstable distribution shape.

```
 Head & shoulders                 Double bottom (W)
        H                          \      /\      /
   S   / \   S                      \    /  \    /
  / \ /   \ / \   <- neckline        \  /    \  /
 /   v     v   \                      \/      \/  -> break neckline = confirm
        (break down = confirm)      (two lows at ~same level)
```

---

## 7. Candlestick formations — single- to few-bar signals

Candlesticks read the *fight within a bar or two*: body = open-to-close, wicks = the
rejected extremes. Most reliable at a structural level (support/resistance) and with
volume; in the middle of noise they mean little.

**Single-bar:**
- *Doji* — open ≈ close; indecision. Meaningful at an extreme after a strong move.
- *Hammer / hanging man* — small body, long lower wick; buyers rejected the lows.
  Bullish at support (hammer), a warning at a top (hanging man).
- *Shooting star / inverted hammer* — long upper wick; sellers rejected the highs.
- *Marubozu* — full body, no wicks; one side dominated completely.

**Two-bar:**
- *Bullish/bearish engulfing* — a body that fully engulfs the prior opposite body; a
  clear shift in control. Among the more useful two-bar cues at structure.
- *Harami* — a small body inside the prior large body; momentum stalling.
- *Tweezers* — two bars with matching highs (top) or lows (bottom); a rejection level.

**Three-bar:**
- *Morning / evening star* — down bar, small indecision bar, strong up bar (morning =
  bullish bottom); the evening star is the bearish mirror.
- *Three white soldiers / three black crows* — three strong same-direction bars; a
  decisive momentum thrust.

---

## 8. Volume & confirmation

Volume is the lie-detector for price patterns:

- **Valid breakout** — expands on the break, especially out of a continuation pattern.
- **Suspect breakout** — occurs on *shrinking* volume → higher odds of a false break /
  fade back into the range.
- **Trend health** — rising volume with the trend, falling volume on counter-trend
  pullbacks, is healthy. Volume climaxing at a new extreme (a "blow-off") often precedes
  exhaustion.
- **Divergence** — price makes a new high but momentum/volume doesn't; a caution flag,
  not a trigger.

---

## 9. Time & sequence — candle counting and cycles

Most of this document is about price *shapes*. Candle counting adds the *time* axis:
counting consecutive bars, or bars from a pivot, to gauge how *mature* a move is and
anticipate exhaustion. The intuition is sound — trends tire with age — even where the
specific numbers are folklore.

- **The general heuristic** — after **3–4 consecutive candles** in one direction the
  odds of at least a pause/pullback rise (the move is short-term stretched). Better as a
  "don't chase" filter than a reversal trigger.
- **Counts from a pivot** — some traders watch specific bar counts from a major swing
  (the 7th, 13th, 21st candle, etc.) for turns. Treat these as folklore unless codified
  and backtested — there is no robust evidence a particular integer is special (see §11).
- **TD Sequential (Tom DeMark)** — the *rigorous, widely-implemented* version of candle
  counting, and the one worth knowing by name. A **Setup** completes on 9 consecutive
  closes higher (or lower) than the close 4 bars earlier; a **Countdown** to 13 refines
  the exhaustion read. It's fully mechanical (hence backtestable) and built into most
  platforms. Published results are mixed, but it's a defined method, not vibes.
- **Time-based stops / trade duration** — the longer a trend has run in *bars*, the more
  holding it bets against mean reversion in time. A count is a clean way to cap trade
  duration ("exit after N bars if the target hasn't hit").
- **Cycles** — recurring rhythms (the "3–5 day" swing cycle, or long wavelengths like the
  BTC 4-year halving cycle) are the same idea at different scales: markets alternate
  thrust and rest.
- **Confluence** — counting earns its keep only alongside other evidence. A bar count
  that completes *at* structural support/resistance, a Fibonacci level (§4), or a **Fair
  Value Gap** (FVG — an unfilled price imbalance left by a fast move) is far more
  actionable than a count in open space.

**Reliability:** the honest read (per §11) is sharpest here — "near holy grail" claims
about magic candle numbers are a red flag, and specific counts are the most
hindsight-prone thing in this document (it's trivial to find, after the fact, the count
that "worked"). The durable kernel is real but modest: **moves exhaust in time as well as
price, so extension raises reversal odds** — which is exactly what a mean-reversion rule
or a time-stop already encodes. TD Sequential is the version you can actually test; test
it (and any count) out-of-sample against buy-and-hold before trusting it.

## 10. Market cycle models & sentiment — and what 123 years of data say

Markets breathe in cycles at every scale, and several popular models try to *name* or
*time* them. They are useful as **context and posture, dangerous as timing signals** —
and unlike most of this document, that claim has been *tested* here on 123 years of data.

**The models:**
- **Dow / Wyckoff phases** — accumulation → markup → distribution → markdown (see §1). The
  structural backbone of all the others.
- **"Psychology of a market cycle"** (the Wall St. Cheat Sheet chart) — disbelief → hope
  → optimism → belief → thrill → **euphoria (peak / max risk)** → complacency → anxiety →
  denial → panic → **capitulation (bottom / max opportunity)** → depression. Behaviorally
  *true* — sentiment does peak at tops and trough at bottoms — but only labellable in
  hindsight, so useless as real-time timing.
- **Benner cycle (1875)** — a fixed calendar of "panic / high-sell / low-buy" years
  (panics 1927, 1945, 1965, 1981, 1999, 2019, 2035…). Numerology with no mechanism.
- **Long cycles** — the ~18-year land cycle (Harrison/Anderson) and the BTC 4-year halving
  cycle. Real rhythms at longer wavelengths, but tiny samples (n≈3–8) → narrative, not signal.

**The test** (S&P 500 total return, 1900–2023, cash earns the 10-yr yield when out):

| Strategy | CAGR | Max DD | Sharpe | $1 → |
|---|---|---|---|---|
| **Reactive regime (10-mo SMA)** | **11.9%** | **−41%** | **1.20** | **$1,096,353** |
| Buy & hold | 9.8% | −82% | 0.71 | $105,579 |
| CAPE / sentiment timing (buy cheap, sell dear) | 7.7% | −63% | 0.72 | $9,477 |
| Benner calendar | 6.9% | −70% | 0.79 | $3,795 |

**What it proves:**
- **Predictive cycle timing loses badly.** Benner (a calendar) ended with ~4% of
  buy-and-hold's wealth; CAPE/sentiment timing (the measurable "buy fear / sell greed")
  ~9%. Both sit out of the market too long and miss the compounding — the drawdown they
  save is dwarfed by the opportunity cost.
- **Benner's "panic years" are ~chance-level** as crash predictors: a few hits (1873, 1907,
  2019) but it missed 1987 and 2008 entirely, and its 1927 "1929 call" was two years early
  (outside a 24-month window). Baseline forward-24m drawdown from *any* month is ~−10%.
- **Reactive regime timing wins on every metric** — it beat buy-and-hold's *return* while
  halving the drawdown, because it stays invested through uptrends and only steps aside
  *after* price breaks its trend (dodging the deep of 1929–32, 1937, 1973–74, 2000–02, 2008).

**The lesson — react, don't predict.** You cannot profitably *forecast* the cycle (by
calendar or by valuation/sentiment); you *can* improve outcomes by *reacting* to the trend
breaking. Use cycle models for **posture** (risk-on vs defensive bias) and **humility**
(when *you* feel euphoric or despairing, distrust the feeling) — never as a standalone
entry trigger. The mechanical regime rule is the response that captures the benefit without
needing a forecast; it is what the `regime_beta` strategy in this repo implements.

## 11. Reliability reality check (do not skip)

Be honest about what this catalog is worth as a *signal source*:

- **Academic evidence for classical chart patterns is mixed-to-weak.** Some (head &
  shoulders, breakouts with volume) have modest documented edge; many are within noise
  once you account for transaction costs and data-mining. Treat "high win rate" claims
  about patterns with deep suspicion.
- **Hindsight & subjectivity are the core traps.** Patterns are obvious *after* they
  resolve. Two analysts draw the same chart differently. If a rule can't be coded and
  backtested, it can't be trusted — it can only be *believed*.
- **False breakouts are the norm, not the exception**, especially intraday and in
  ranging regimes. Most naive breakout entries lose to costs.
- **This project's own finding:** across an out-of-sample scan of trend, momentum,
  breakout, and mean-reversion signals on SPY/QQQ/BTC, *none* beat buy-and-hold
  risk-adjusted. The durable edge was **regime context** (own beta above the trend,
  cash below) and **risk control** — not pattern-timing.

**So how to actually use patterns here:**
1. **As a regime read** — is structure trending (HH/HL) or ranging? That decides whether
   a trend-following or mean-reversion *frame* even applies. This is their highest-value use.
2. **For risk placement** — put stops just beyond the structural level that invalidates
   the idea (a swing low, a neckline), and set targets at the next S/R or the measured
   move. This is concrete and testable.
3. **As a hypothesis to *codify and backtest*** — if you believe "ascending triangle
   breakouts on daily SPY with volume expansion have an edge," write it as an explicit
   rule, backtest it out-of-sample with costs, and check it against buy-and-hold before
   trusting it. Never trade a pattern you haven't measured.
4. **Never as a standalone discretionary trigger** on real capital without the above.

The value of this document is a **shared, precise vocabulary** and a discipline for
turning "I see a pattern" into "here is a testable rule with a defined invalidation
level" — not a promise that shapes on a chart print money.

---

## Related skills

- **trading-fundamentals** — indicator families, regime fit, risk-management and
  backtest-metric fundamentals (the *why* behind strategy design).
- **chart-analysis** — the TradingView workflow to set symbol/timeframe, add indicators,
  annotate structure, and screenshot (the *how* of marking these patterns up on a chart).
- **strategy-report** — turning an analyzed setup into a documented, testable strategy.
