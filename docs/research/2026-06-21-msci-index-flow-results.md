# MSCI Index-Flow — Results (2026-06-21)

Test Plan #2, first clean slice: front-running MSCI Saudi index **adds/deletes**. Can a retail
account buy at the announcement and sell into the forced index-fund flow on the effective date?

**Data:** 6 MSCI Saudi reviews, May-2022 → Nov-2024 (Argaam English review articles, cross-checked).
34 events (23 adds, 11 deletes), 33 symbols, **0 skipped** (Yahoo bars available for all).
Name→code resolved via TwelveData's full Saudi reference list. Survivorship ≈ nil (index large-caps).

## Raw output
```
MSCI Saudi index-flow event study — events 34, used 34, skipped 0
cost 0.11% RT + slippage 0.15%/side

ADD (n=23)
  pre      mean 0.98%
  trade    mean -0.69% net  NW-t -1.16  win 35%
  reversal mean 0.29%
  trim-one trade mean range -1.17% … -0.28%
DELETE (n=11)
  pre      mean -0.08%
  trade    mean 0.97% net  NW-t 0.50  win 55%
  reversal mean -4.02%
  trim-one trade mean range 0.08% … 1.83%

ADD OOS split — early(11) mean 0.52%  late(12) mean -1.79%

VERDICT (adds): NO SIGNAL — trade mean -0.69% net, NW-t -1.16
```

## Verdict

**NO SIGNAL — the front-run trade does not exist on this sample.** Buying an index ADD at the
public announcement and selling into the effective-date flow **lost** money: −0.69% abnormal return
net of cost+slippage, NW-t −1.16 (wrong sign, not significant), win rate 35%. It does not survive
trim-one (every trimmed mean stays negative) and is unstable OOS (early +0.52% → late −1.79%).

## Plain-English read

The idea was: index funds are *forced* to buy added names on a known date, so step in front and sell
into them. On MSCI Saudi 2022–2024, **that edge is already gone by the time you can legally act.**

The tell is the **pre-announcement window: +0.98%.** The run-up happens *before* MSCI publicly
announces — the additions are anticipated (large, liquid, obvious candidates; the methodology is
public), so the price moves on the *expectation*. By the public announcement date — the only point a
retail trader can act without inside information — the gain is spent, and the stock drifts **down**
into the effective date as the "news" is sold. This is textbook *buy-the-rumor-sell-the-news*: the
flow is too well-known to front-run on public info.

**This kills the cleanest version of the flow edge.** It does not prove every flow idea is dead, but
it removes the strongest, lowest-overfit candidate the board ranked #2.

## Honest caveats

- **Sample is modest:** 6 reviews, n=23 adds (just over the 20 underpowered floor). 2022–2024 only,
  not the full 2019→now; adds skew to recent IPOs (the post-2021 listing wave).
- **Anticipation is the mechanism, not noise:** the negative trade + positive pre-window is
  internally consistent and repeats across reviews (trim-one robust) — it is a real "no edge for the
  public trader," not just thin data.
- **Deletes:** n=11, NW-t 0.50 — noise; the −4% post-effective reversal on deletes is suggestive but
  untradeable long-only and underpowered.

## What would change the verdict (not pursued unless requested)

1. **Pre-announcement positioning** — the move lives *before* the announcement, which needs
   *predicting* additions (rule-based: free-float/size thresholds from MSCI methodology). That is a
   real but harder, prediction-based edge — and exactly the overfit surface the board warned about.
2. **Reweights / FII steps + FTSE inclusions** (spec non-goals) — more, possibly less-anticipated
   flows; would widen n. Only worth it if there's reason to expect a *less-anticipated* flow.
3. **IPO fast-entry index-adds** — additions on a fixed post-IPO schedule, less "obvious" than
   regular-review adds; the next-cleanest flow candidate.

## Conclusion

The momentum equal-weight engine remains the only validated edge. Both above-modest layers tested so
far — compounding-geometry sizing (`2026-06-21-compounding-geometry-results.md`) and now flow
front-running — came back negative on honest, out-of-sample-aware tests. The pipeline
(`index_events` table + study) is reusable for the harder flow variants above if pursued.
See `[[edge-validation-findings]]`, `[[advisory-board]]`.
