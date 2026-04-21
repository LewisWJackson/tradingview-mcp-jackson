---
name: company-evaluation
description: Evaluate a company's financial health using key metrics — liquidity, profitability, valuation, debt, growth, and free cash flow. Use when the user wants to analyze a stock, assess financial metrics, screen a company for investment, or interpret ratios like P/E, ROE, D/E, FCF margin, or earnings growth.
---

# Company Financial Evaluation

Assess companies across 6 categories. Adjust thresholds for industry and growth stage.

## 1. Liquidity

| Metric | Good | Warning |
|--------|------|---------|
| Current Ratio (Current Assets ÷ Current Liabilities) | 1.5–3 | <1 (liquidity risk), >3 (idle assets) |
| Quick Ratio (excl. inventory) | 1–2 | <1 |

## 2. Profitability

| Metric | Good | Warning |
|--------|------|---------|
| Net Profit Margin | 10%+ (mature), 15%+ (tech/growth) | <5% |
| Return on Equity (ROE) | 15%+ | Low or negative |
| Gross Margin | 40%+ | Low = pricing pressure or rising costs |

## 3. Valuation

| Metric | Good | Warning |
|--------|------|---------|
| P/E Ratio | 10–20 (mature); higher OK for growth | >30 = overvaluation risk, <10 = low growth/distrust |
| P/S Ratio | 1–3 | >10 = high expectations, potential overvaluation |
| P/B Ratio | <3 (esp. financials/asset-heavy) | <1 = possible undervaluation *or* underlying issues |

## 4. Debt Management

| Metric | Good | Warning |
|--------|------|---------|
| Debt-to-Equity | <1 (most industries) | >2 = financial strain risk |
| Interest Coverage (EBIT ÷ Interest Expense) | 3+ | <1.5 = trouble meeting debt payments |

## 5. Growth

| Metric | Good | Warning |
|--------|------|---------|
| Earnings Growth (YoY / CAGR) | 10–20% (stable), 20%+ (high-growth) | >40% sustained = likely unsustainable |
| Revenue Growth (YoY) | 5–10%+ (mature), higher for growth | Flat or declining in growth company |

## 6. Free Cash Flow

| Metric | Good | Note |
|--------|------|------|
| FCF Margin (FCF ÷ Revenue) | 5–10%+ | Negative FCF OK for startups if growth justifies it |

## Industry Adjustments

- **Tech**: Higher P/E and P/S are normal — growth expectations are priced in
- **Utilities / Consumer Staples**: Lower growth; focus on stable ROE, margins, dividends
- **Financials**: Emphasize P/B, loan loss provisions, capital adequacy over P/E

## Evaluation Workflow

```
1. Get symbol data: quote_get → current price and market cap context
2. Pull financials from the chart or user-provided data
3. Score each category: Good / Caution / Warning
4. Apply industry adjustment — re-evaluate flagged metrics in context
5. Summarize: overall health rating, key strengths, key risks
```

## Output Format

For each evaluated company, produce:

**[TICKER] — Financial Health Summary**
- Liquidity: [Good/Caution/Warning] — [key ratio + value]
- Profitability: [Good/Caution/Warning] — [key metric + value]
- Valuation: [Good/Caution/Warning] — [P/E, P/S, P/B]
- Debt: [Good/Caution/Warning] — [D/E, Interest Coverage]
- Growth: [Good/Caution/Warning] — [earnings/revenue growth]
- FCF: [Good/Caution/Warning] — [FCF margin]
- **Overall**: Strong / Adequate / Concerning
- **Key Risk**: [1-sentence summary]
- **Key Strength**: [1-sentence summary]
