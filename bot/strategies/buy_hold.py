"""Static buy-and-hold anchor — the non-trend sleeve primitive.

Unlike every other strategy here, this one does NOT time anything: it enters long
once and never exits. It exists so the bot can carry a genuine *non-trend* return
source alongside the regime-beta trend book — an always-on risk-premium harvest:

  - a BOND-CARRY sleeve (e.g. IEF): harvests the term premium; historically
    negatively correlated to equities, so it cushions deflationary busts (2008); and
  - a BETA-ANCHOR sleeve (e.g. SPY): recaptures the bull upside the regime filter
    gives up to whipsaw.

CRITICAL — this is HELD, not trend-traded. The earlier "naive diversifier" test
failed only because it ran a bond ETF through the trend strategy (PF 0.12 in a
trendless bond market). A carry sleeve must be bought and held; that is what this is.

Sizing is fixed-fractional; there is no meaningful stop (set stop_atr_mult very wide
in config — an anchor is not stopped out). See docs/NON_TREND_SLEEVE.md for the full
backtest and the honest verdict: the bond-carry edge is REGIME-DEPENDENT (a strong
diversifier in the 2007-2016 bond bull, a drag in the 2017-2026 rate-rising / 2022
regime), so this sleeve ships OFF by default and small — insurance, not alpha.
"""


def generate_signal(df, position, params):
    if position is None:
        return "long"
    # Held forever: the anchor never times an exit.
    return None


def warmup_bars(params):
    """A static anchor needs no history of its own."""
    return 1
