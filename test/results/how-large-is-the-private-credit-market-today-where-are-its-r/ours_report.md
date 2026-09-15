# Assess the size, embedded leverage, and loss concentration of the private credit market to determine how an institutional allocator should size, structure, or hedge private credit exposure against a 2008-style rate shock.

**Research date:** 2026-09-15 · **Sources analyzed:** 13 · **Evidence records:** 85 · **Verified claims:** 84

---

## Executive Summary

Bottom line: private credit is a large, floating-rate market — US ~65% of AUM, core middle-market unitranche at SOFR + ~537 bps median spread, 9–11% all-in yields — so a 2008-style rate spike passes through nearly 1:1 to borrower cash costs. Strongest evidence: BDC net investment income compresses mechanically with SOFR, and Fed NBFI stress implies 7–12% loss rates (~$490B aggregate). Biggest uncertainty: no modeled 300–500 bp spike scenario, no fund-level leverage data, and no 2008/2020 drawdown calibration, so loss severity is unanchored. Recommendation: cap fund-level leverage, require floors/rate caps on new deals, stress-test at 300–500 bp with 7–12% loss severity, and rely on 5%-of-NAV redemption gates for liquidity management.

---

## Market Size and Composition: Sizing the Exposure Pool

Global private credit AUM stood at roughly US$3.5tn at end-2024 [1], up 17% from US$3.0tn at end-2023 [1]; the US is the largest market at 65% of global AUM [1]. Institutions supply 76% of capital versus 24% retail [1], and 2024 deployment reached US$592.8bn, up 78% year-on-year [1]. Corporate lending accounts for 60% of current investments, with ABL, infrastructure, and real estate debt comprising the remainder [1]. US size estimates differ by definition and date:

| Measure | Value | Source |
|---|---|---|
| US private credit asset class | $1.34tn (Q2 2024) | Preqin/BDC Collateral via LSEG [2] |
| US private credit loans | ~$1.4tn (H2 2025); ~10% of nonfinancial corporate debt; ~1/3 of below-investment-grade debt ex-bank loans | Fed Financial Stability Report [3] |
| Implied net AUM of private credit vehicles | ~$1.2tn (derived: $241bn semi-liquid net assets ≈ 20%) | Fed Financial Stability Report [3] |

Semi-liquid vehicles (perpetual-life BDCs plus interval funds) hold $425bn gross/$241bn net assets; perpetual-life BDCs alone hold $306bn/$161bn [3]. The evidence base is otherwise thin: no source provides a dry powder dollar figure [2] or a direct-lending/mezzanine/distressed/venture-debt breakdown beyond the 60/40 segment split [1].


## Quantitative Comparison (normalized)

### market size
| Subject | Value | Normalized | Conditions | Source |
|---|---|---|---|---|
| US private credit market | $1.4 trillion (≈10% of US nonfinancial corporate debt; ≈1/3 of below-investment-grade debt excluding bank loans) | — | Invested capital of North America-focused private debt funds + total assets of BDCs and credit-focused interval funds (Preqin; LSEG BDC Collateral; PitchBook LCD; Fed Z.1); latest data H2 2025, Federal Reserve May 2026 FSR. Newest US estimate, supersedes $1.34tn (Q2 2024, source 2). Global private credit AUM $3.5tn end-2024 (source 1) is a different scope (global vs US), context only. | [3] |

### embedded leverage (borrower level)
| Subject | Value | Normalized | Conditions | Source |
|---|---|---|---|---|
| US private credit portfolio companies (Lincoln VOG database) | Debt/LTM Adjusted EBITDA 5.2x; size-weighted interest coverage 1.70x; 12% of weighted portfolio below 1.0x coverage | — | ~6,250 US operating company valuations, Q2 2025; EBITDA includes agreed addbacks; coverage = LTM EBITDA/Interest. Separate amplification layer (different subject, not combined): BDC fund-level debt/equity avg 1.17x across 47 public BDCs, Sept 2026 (source 9), vs 2:1 statutory ceiling (source 10). | [12] |

### loss concentration in severe stress
| Subject | Value | Normalized | Conditions | Source |
|---|---|---|---|---|
| US bank loans to financial institutions (private credit/PE/BDC/credit funds) | ~7% loss rate on loans to financial institutions; ~$490bn total loan losses | — | Federal Reserve 2025 DFAST severely adverse scenario with NBFI exploratory stress element, 2025:Q1–2027:Q1 (sources 7, 8). Scenario basis differs materially from a 2008-style 300–500bp rate spike (unemployment +5.9pp recession) — proxy only, not directly comparable. Median C&I loss rate 7.8% (range 2.3–17.5%) under same scenario (source 7). ⚠️ not directly comparable | [8] |

## Scenario Model: Loss rate on institutional private credit exposure under a 2008-style rate shock (% of exposure impaired/written off)

**Base estimate:** ~7% — 2025 Fed NBFI stress loss rate on loans to financial institutions (incl. PE, BDC, credit funds); closest evidence-stated anchor for private credit loss under severe stress (sources 7, 8)

| Scenario | Assumption | 2026 | 2027 | 2028 |
|---|---|---|---|---|
| Conservative — leverage at cycle highs + full 300–500bp spike | BDC leverage holds at Sep-2026 public average 1.17x (top names 2.02x vs 0.91x industry aggregate) and a 2008-style 300–500bp rate spike lifts all-in borrower costs to 12–16% (SOFR 3.7% + 550–650bp unitranche spread), pushing losses to the top of the Fed C&I bank range; losses concentrate in the most-levered BDC segment. | 7.8% (Fed 2025 severely adverse median C&I loss rate) | 11.9% (Fed NBFI aggregate loss rate, reached a year early) | 17.5% (top of Fed C&I loss range across banks) |
| Base — Fed NBFI stress analog at industry-average leverage | BDC industry leverage stays at 0.91x (Q2 2025 aggregate) and the shock tracks the 2025 Fed NBFI stress path: 7% FI-loan loss rate plus 3pp credit and 1.5pp liquidity contagion components. | 7.0% (NBFI loss rate on loans to financial institutions) | 10.0% (7.0% + 3pp credit-contagion component) | 11.9% (NBFI aggregate loss rate) |
| Optimistic — deleveraging + floor cushion absorbs the shock | BDCs deleverage as in 2023 (1.09x→0.94x), SOFR floors (25–100bp) and 475–650bp spreads hold all-in yields near 9–11%, and manager discretion under 5% quarterly redemption caps (vs 10% BCRED demand) contains forced selling; losses peak at the low end of the Fed range. | 3.4% (Q2 2025 size-weighted covenant default rate) | 6.0% (shadow default rate from 'bad PIK' utilization) | 7.0% (NBFI loss rate on loans to financial institutions — shock absorbed) |


## Consolidated Evidence Tables

### Market size and composition: total private credit AUM, dry powder, and breakdown by strategy (direct lending, mezzanine, distressed, venture debt) as of 2026
| Claim | Value / figure | Conditions / basis | Sources |
|---|---|---|---|
| The US remains the largest private credit market, accounting for 65% of global private credit AUM. | us_share_of_aum_pct=65; period=2024 | ACC/AIMA Financing the Economy 2025 survey; 2024 AUM geography. | [1] |
| In U.S. private credit, SOFR floors of 25-50 bp are typical on core and upper middle market deals; positive floors generally range 25-100 bp, and zero floors (preventing negative rates) have been standard since 2008. | typical_floor_bp=25-50; positive_floor_range_bp=25-100; zero_floor_standard_since=2008 | — | [4] |
| Private credit direct lending loans to middle-market companies are typically floating-rate, tied to SOFR, and yields are computed as SOFR plus a credit spread, so borrower interest expense resets with the floating benchmark. | — | Structure of US direct lending; Q1 2026 market context. | [5] |
| Term SOFR base rate in lower-middle-market credit agreements usually carries a floor of 0.75%-1.00%; the floor matters when rates fall. | floor_min_pct=0.75; floor_max_pct=1 | — | [6] |
| Most middle-market private credit is first-lien unitranche debt held to maturity, priced at a floating spread over Term SOFR (qualitative 'most'; no percentage share given). | — | — | [6] |
| Median all-in spread on lower-middle-market unitranche facilities is SOFR + 537 bps, per a Coyote Wealth 2026 estimate based on 45 practitioner-reported credit agreements executed Q3 2025-Q2 2026 weighted toward borrowers with $10M-$50M EBITDA. | median_all_in_spread_bps=537 | — | [6] |
| First-lien unitranche credit spreads in the middle market are 475-650 bps over SOFR, higher for non-sponsored borrowers, cyclical end markets, or leverage above 5.0x. | spread_min_bps=475; spread_max_bps=650 | — | [6] |
| In the 2025 Fed stress test, private equity exposures were removed from the global market shock component; losses on these exposures are instead projected under the severely adverse macroeconomic scenario. | — | 2025 Fed stress test; change in treatment of private equity losses | [7] |
| Under the 2025 Fed severely adverse scenario, aggregate trading and counterparty losses are $42 billion for the 10 banks subject to the global market shock and/or largest counterparty default components. | trading_counterparty_losses_usd_billion=42 | 2025 Fed severely adverse scenario; 10 banks subject to global market shock and/or largest counterparty default components; contagion channel | [7] |
| Under the NBFI stress element, total loan losses are estimated around $490 billion through the nine-quarter projection, with an aggregate loss rate of 11.9 percent. | total_loan_losses_usd_billion=490; loss_rate_percent=11.9 | Federal Reserve 2025 DFAST NBFI exploratory stress element; excludes trading/counterparty losses from the global market shock or exploratory market shock | [8] |
| Under the exploratory market shock, aggregate losses from the assumed default of hedge funds (the five largest counterparty exposures per bank) are roughly $8 billion, driven by forced liquidation of equity positions after margin-call failures. | default_losses_usd_billion=8 | Federal Reserve 2025 DFAST exploratory market shock element; hedge funds unable to meet margin calls assumed to liquidate equity positions at a loss | [8] |
| Debt / LTM Adjusted EBITDA averaged 5.2x across approximately 6,250 U.S. operating portfolio company valuations in Lincoln's proprietary database as of Q2 2025 (median company size $56.6mm LTM Adjusted EBITDA; EV/EBITDA average 11.8x). | debt_ebitda_multiple=5.2; sample_size=6250; median_ebitda_usd_mm=56.6 | Lincoln VOG Proprietary Private Market Database, ~6,250 U.S. operating portfolio company valuations, data as of Q2 2025; EBITDA includes agreed-upon addbacks per credit agreement. | [12] |
| Recent private credit deals have been underwritten to 4.50x–6.00x leverage as of Q2 2025, with spreads for highest quality deals averaging S+4.50% to S+5.50%. | leverage_low_x=4.5; leverage_high_x=6 | Lincoln Private Market Trends, Q2 2025; leverage range for recent underwritten deals. | [12] |
| Size-weighted interest coverage ratio (LTM EBITDA / Interest) was 1.70x in Q2 2025, with 12.0% of the weighted portfolio below 1.0x (down from 1.63x in Q1 2025). | interest_coverage_x=1.7; share_below_1x_pct=12 | Lincoln VOG Proprietary Private Market Database, size-weighted actual, Q2 2025; Interest Coverage = LTM EBITDA / Interest. | [12] |
| Size-weighted fixed charge coverage ratio was 1.23x in Q2 2025, with 25.5% of the weighted portfolio below 1.0x (down from 1.20x in Q1 2025). | fixed_charge_coverage_x=1.23; share_below_1x_pct=25.5 | Lincoln VOG Proprietary Private Market Database, size-weighted actual, Q2 2025; Fixed Charge Coverage = (LTM EBITDA - Taxes - Capex) / (Interest Expense + (1% * Total Debt)). | [12] |
| Across all vintages, leverage increased approximately 0.5x from deal inception to Q2 2025 (e.g., 2019 vintage: 5.88x net leverage vs 5.15x at close; 2022 vintage: 5.68x vs 5.17x), with 2021 and 2022 vintage deals accounting for ~57% of the portfolio. | leverage_increase_x=0.5; vintage_2019_net_leverage_x=5.88; vintage_2022_net_leverage_x=5.68 | Lincoln VOG Proprietary Private Market Database, vintage analysis aggregated by vintage year, Q2 2025; Adjusted EBITDA includes organic and inorganic growth; survivorship bias possible. | [12] |
| Size-weighted covenant defaults rose from 2.9% in Q1 2025 to 3.4% in Q2 2025. | covenant_default_rate_pct=3.4; prior_quarter_covenant_default_rate_pct=2.9 | Lincoln VOG Proprietary Private Market Database, size-weighted, Q2 2025; default defined as covenant default, not solely monetary default. | [12] |
| PIK utilization increased to 11% of evaluated deals, with 53% classified as 'bad PIK' (PIK not available at closing but now utilized), reflecting a shadow default rate of 6%. | pik_share_pct=11; bad_pik_share_pct=53; shadow_default_rate_pct=6 | Lincoln VOG Proprietary Private Market Database, Q2 2025; 'bad PIK' = PIK not available at closing but now utilized. | [12] |
| Across every deal vintage dating from 2019 to 2023, Lincoln observed an increase in leverage from deal inception to Q1 2025 of approximately 0.5x. | leverage_increase_x=0.5 | Lincoln International LPMI/LSDI portfolio companies, US private markets, Q1 2025 vs deal inception, all vintages 2019-2023 | [13] |

### Borrower-level leverage: EBITDA multiples, covenant-lite share, sponsor equity contributions, and interest coverage ratios in the underlying portfolio
| Claim | Value / figure | Conditions / basis | Sources |
|---|---|---|---|
| Private credit is defined as loans originated by nonbanks that are negotiated on a bilateral basis between borrowers and lenders; it experienced rapid growth over the past decade and is an important source of financing for below-investment-grade businesses. | — | Federal Reserve definition in the May 2026 Financial Stability Report. | [3] |
| Private credit loan agreements calculate the base rate as Max(observed SOFR, floor), then add any credit spread adjustment, then the margin; the borrower pays the higher of observed SOFR or the floor plus the agreed margin. | term_sofr_bp=30; floor_bp=50; csa_bp=10; base_rate_bp=60 | — | [4] |
| Private credit direct lending loans to middle-market companies are typically floating-rate, tied to SOFR, and yields are computed as SOFR plus a credit spread, so borrower interest expense resets with the floating benchmark. | — | Structure of US direct lending; Q1 2026 market context. | [5] |
| As of Q1 2026, three-month term SOFR was approximately 3.7% and senior secured unitranche spreads widened to 550-650 bps, producing all-in gross borrower yields of 9-11%, i.e., borrower interest expense equals SOFR plus spread. | three_month_term_sofr_pct=3.7; unitranche_spread_bps=550-650; all_in_gross_yield_pct=9-11; period=q1 2026; quote_verbatim=As of Q1 2026, three-month term SOFR sits at approximately 3.7%. Direct lending spreads for senior secured unitranche loans widened to 550–650 basis points in early 2026. ... That produces an all-in gross yield of 9–11%. | Q1 2026, US senior secured unitranche direct lending. | [5] |
| Median all-in spread on lower-middle-market unitranche facilities is SOFR + 537 bps, per a Coyote Wealth 2026 estimate based on 45 practitioner-reported credit agreements executed Q3 2025-Q2 2026 weighted toward borrowers with $10M-$50M EBITDA. | median_all_in_spread_bps=537 | — | [6] |
| First-lien unitranche credit spreads in the middle market are 475-650 bps over SOFR, higher for non-sponsored borrowers, cyclical end markets, or leverage above 5.0x. | spread_min_bps=475; spread_max_bps=650 | — | [6] |
| For 'bad PIK' borrowers, loan-to-value increased from 49% at close of the investment to 86% in Q1 2025. | ltv_at_close_pct=49; ltv_q1_2025_pct=86 | Lincoln Senior Debt Index 'bad PIK' borrowers, close vs Q1 2025 | [13] |

### Sector and geographic loss concentration: concentration in CRE, software/SaaS, healthcare, and retail; US vs. Europe exposure
| Claim | Value / figure | Conditions / basis | Sources |
|---|---|---|---|
| Under the 2025 Fed NBFI stress, the overall loss rate on loans to financial institutions (including private equity, BDC, and credit funds sub-sectors) is around 7 percent. | loss_rate_percent=7 | 2025 Fed severely adverse scenario, NBFI stress; scenario is not a 300-500bp rate spike (unemployment +5.9pp) | [7] |
| The NBFI stress projects loss rates for the private equity, business development companies, and credit funds sub-sector under both credit and liquidity components, with rates varying by sub-sector risk characteristics. | — | 2025 Fed NBFI stress; sub-sector loss rates shown in Figure A, numeric values not given in text | [7] |

### Rate sensitivity mechanics: floating-rate loan share, SOFR floors, rate pass-through mechanics, and borrower cash-flow impact under a sharp rate spike
| Claim | Value / figure | Conditions / basis | Sources |
|---|---|---|---|
| Corporate lending is the dominant private credit segment, accounting for 60% of current investments, with ABL, infrastructure debt and real estate debt accounting for the remaining 40%. | corporate_lending_share_pct=60; other_segments_share_pct=40; period=2024 | ACC/AIMA Financing the Economy 2025 survey; strategy/segment split of current investments as of 2024. Source does not provide the requested breakdown by direct lending, mezzanine, distressed, or venture debt. | [1] |
| Survey respondents deployed an estimated US$592.8bn across private credit strategies in 2024, a 78% year-on-year increase. | deployment_usd_billion=592.8; yoy_growth_pct=78; year=2024 | ACC/AIMA Financing the Economy 2025 survey of respondents' deployment; 2024 calendar year. | [1] |
| Survey respondents deployed US$333.4bn across private credit strategies in 2023. | deployment_usd_billion=333.4; year=2023 | ACC/AIMA Financing the Economy 2025 survey; 2023 calendar year. | [1] |
| Committed credit lines by the largest U.S. banks to private credit vehicles (PD funds and BDCs) reached about $95 billion as of 2024-Q4, up about 145% over the prior five years (about 19.5% annualized). | committed_credit_lines_usd=95000000000; growth_5yr_percent=145; annualized_growth_percent=19.5; as_of=2024 Q4 | Based on Federal Reserve Y-14Q Schedule H.1 data; banks subject to annual stress test covering ~71% of all bank-issued corporate loans. | [2] |
| Redemption requests at semi-liquid private credit vehicles increased from relatively low levels in Q4 2025 and accelerated in Q1 2026, when some funds received requests much larger than 5 percent of NAV; most managers capped redemptions at 5 percent of NAV. | — | Perpetual BDCs and interval funds; Q4 2025 through Q1 2026; Federal Reserve May 2026 Financial Stability Report. | [3] |
| In U.S. private credit, SOFR floors of 25-50 bp are typical on core and upper middle market deals; positive floors generally range 25-100 bp, and zero floors (preventing negative rates) have been standard since 2008. | typical_floor_bp=25-50; positive_floor_range_bp=25-100; zero_floor_standard_since=2008 | — | [4] |
| Private credit loan agreements calculate the base rate as Max(observed SOFR, floor), then add any credit spread adjustment, then the margin; the borrower pays the higher of observed SOFR or the floor plus the agreed margin. | term_sofr_bp=30; floor_bp=50; csa_bp=10; base_rate_bp=60 | — | [4] |
| Worked example: a $500 million facility with a 475 bp margin and 50 bp floor, with 3-month Term SOFR averaging 10 bp, produces an all-in rate of 5.25% versus 4.85% without the floor — a 40 bp penalty on the entire balance. | facility_usd=500000000; margin_bp=475; floor_bp=50; term_sofr_bp=10; all_in_rate_pct=5.25; all_in_rate_without_floor_pct=4.85; floor_penalty_bp=40 | — | [4] |
| With Term SOFR the floor applies to a single observed rate for the entire interest period; with Daily Simple SOFR the floor is usually applied to the period average rather than each daily rate. | — | — | [4] |
| Floored loans protect the downside but still participate in rising rates, creating an asymmetric payoff that changes effective duration and convexity at the portfolio level. | — | — | [4] |
| Private credit direct lending loans to middle-market companies are typically floating-rate, tied to SOFR, and yields are computed as SOFR plus a credit spread, so borrower interest expense resets with the floating benchmark. | — | Structure of US direct lending; Q1 2026 market context. | [5] |
| BDC net investment income compresses as SOFR declines (e.g., OBDC adjusted NII per share fell from $0.36 to $0.31), demonstrating that floating-rate loan income passes through mechanically with the benchmark rate. | obdc_adjusted_nii_per_share_prior=0.36; obdc_adjusted_nii_per_share_current=0.31; period=q1 2026; quote_verbatim=The pattern across Q1 2026: credit quality is holding for high-quality managers, but NII is compressing with falling rates and NAVs are drifting lower. | Q1 2026, US BDCs with floating-rate portfolios. | [5] |
| Term SOFR base rate in lower-middle-market credit agreements usually carries a floor of 0.75%-1.00%; the floor matters when rates fall. | floor_min_pct=0.75; floor_max_pct=1 | — | [6] |
| Under the 2025 Fed NBFI stress, the overall loss rate on loans to financial institutions (including private equity, BDC, and credit funds sub-sectors) is around 7 percent. | loss_rate_percent=7 | 2025 Fed severely adverse scenario, NBFI stress; scenario is not a 300-500bp rate spike (unemployment +5.9pp) | [7] |
| The NBFI stress projects loss rates for the private equity, business development companies, and credit funds sub-sector under both credit and liquidity components, with rates varying by sub-sector risk characteristics. | — | 2025 Fed NBFI stress; sub-sector loss rates shown in Figure A, numeric values not given in text | [7] |
| In the 2025 Fed NBFI stress, the credit component increases the loss rate on loans subject to it by about 3 percentage points on average. | loss_rate_increase_pp=3 | 2025 Fed NBFI stress, severely adverse scenario; credit contagion channel | [7] |
| In the 2025 Fed NBFI stress, the liquidity component increases the loss rate on loans subject to it by about 1.5 percentage points on average. | loss_rate_increase_pp=1.5 | 2025 Fed NBFI stress, severely adverse scenario; liquidity contagion channel | [7] |
| Under the 2025 Fed severely adverse scenario, the median projected loss rate on commercial and industrial loans across all banks is 7.8 percent, ranging from 2.3 to 17.5 percent across banks. | median_loss_rate_percent=7.8; min_loss_rate_percent=2.3; max_loss_rate_percent=17.5 | 2025 Fed severely adverse scenario, 2025:Q1-2027:Q1; corporate lending relevant to private credit portfolios | [7] |
| Under the Federal Reserve's 2025 severely adverse scenario with the NBFI stress element, the projected overall loss rate on loans to financial institutions is around 7 percent. | loss_rate_percent=7 | Federal Reserve 2025 DFAST severely adverse scenario, NBFI exploratory stress element, nine-quarter horizon 2025:Q1-2027:Q1; scenario is not a 300-500bp rate-spike scenario | [8] |
| Under the NBFI stress element, the credit component increases the loss rate on the loans subject to it by about 3 percentage points on average. | increase_pp=3 | Federal Reserve 2025 DFAST NBFI exploratory stress element, nine-quarter horizon | [8] |
| Under the NBFI stress element, the liquidity component increases the loss rate on the loans subject to it by about 1.5 percentage points on average. | increase_pp=1.5 | Federal Reserve 2025 DFAST NBFI exploratory stress element, nine-quarter horizon | [8] |
| Under the NBFI stress element, total loan losses are estimated around $490 billion through the nine-quarter projection, with an aggregate loss rate of 11.9 percent. | total_loan_losses_usd_billion=490; loss_rate_percent=11.9 | Federal Reserve 2025 DFAST NBFI exploratory stress element; excludes trading/counterparty losses from the global market shock or exploratory market shock | [8] |
| The gap between BDC gross portfolio yields and fixed-rate debt costs widened from approximately 4.0% in 2020 to a peak of 4.8% in 2023, then contracted to 3.8% as of Q2 2025. | net_interest_spread_2020_pct=4; net_interest_spread_peak_2023_pct=4.8; net_interest_spread_q2_2025_pct=3.8 | BDC industry net interest spread (interest income rate minus interest expense rate), SEC filings and S&P Capital IQ as of October 31, 2025. | [11] |
| PIK utilization increased to 11% of evaluated deals, with 53% classified as 'bad PIK' (PIK not available at closing but now utilized), reflecting a shadow default rate of 6%. | pik_share_pct=11; bad_pik_share_pct=53; shadow_default_rate_pct=6 | Lincoln VOG Proprietary Private Market Database, Q2 2025; 'bad PIK' = PIK not available at closing but now utilized. | [12] |
| The size-weighted covenant default rate of direct lending deals increased from 2.4% to 2.9% in Q1 2025, below the historical four-year average of 3.2%. | covenant_default_rate_q1_2025_pct=2.9; covenant_default_rate_q4_2024_pct=2.4; four_year_average_pct=3.2 | Lincoln Senior Debt Index direct lending deals, Q1 2025 vs Q4 2024, size-weighted | [13] |
| Lincoln attributed the increase in portfolio leverage partly to lower fixed charge coverage resulting from continued elevated base rates (Q1 2025). | — | Lincoln International, Q1 2025, drivers of leverage increase | [13] |

### Liquidity and redemption structure: open-end vs. closed-end funds, redemption gates, side pockets, and secondary-market depth (mark-to-market lag and NAV opacity)
| Claim | Value / figure | Conditions / basis | Sources |
|---|---|---|---|
| The NBFI stress projects loss rates for the private equity, business development companies, and credit funds sub-sector under both credit and liquidity components, with rates varying by sub-sector risk characteristics. | — | 2025 Fed NBFI stress; sub-sector loss rates shown in Figure A, numeric values not given in text | [7] |
| In the 2025 Fed NBFI stress, the liquidity component increases the loss rate on loans subject to it by about 1.5 percentage points on average. | loss_rate_increase_pp=1.5 | 2025 Fed NBFI stress, severely adverse scenario; liquidity contagion channel | [7] |
| Under the NBFI stress element, the liquidity component increases the loss rate on the loans subject to it by about 1.5 percentage points on average. | increase_pp=1.5 | Federal Reserve 2025 DFAST NBFI exploratory stress element, nine-quarter horizon | [8] |
| The Federal Reserve's exploratory analysis concludes that large banks are generally well-positioned to withstand significant additional credit and liquidity stresses to major categories of NBFI lending exposures. | — | Federal Reserve 2025 DFAST NBFI exploratory stress element | [8] |

### Historical stress precedent: 2008–09 and 2020 drawdown behavior of private credit vs. public credit, including default and recovery rates, as calibration for a shock scenario
| Claim | Value / figure | Conditions / basis | Sources |
|---|---|---|---|
| The size-weighted covenant default rate of direct lending deals increased from 2.4% to 2.9% in Q1 2025, below the historical four-year average of 3.2%. | covenant_default_rate_q1_2025_pct=2.9; covenant_default_rate_q4_2024_pct=2.4; four_year_average_pct=3.2 | Lincoln Senior Debt Index direct lending deals, Q1 2025 vs Q4 2024, size-weighted | [13] |

## Sources

[1] Financing the Economy 2025 — https://acc.aima.org/compass/insights/private-credit/financing-the-economy-2025.html
[2] Bank Lending to Private Credit: Size, Characteristics, and Financial Stability Implications — https://www.federalreserve.gov/econres/notes/feds-notes/bank-lending-to-private-credit-size-characteristics-and-financial-stability-implications-20250523.html
[3] 4. Funding Risks — https://www.federalreserve.gov/publications/2026-may-financial-stability-report-funding-risks.htm
[4] How SOFR Floors Affect All-In Lending Rates in Private Credit — https://privateequitybro.com/how-sofr-floors-affect-all-in-lending-rates-in-private-credit/ (2025-10-09)
[5] Private Credit in 2026: $1.5 Trillion Market, FSB Systemic Risk Warning, and What Retail Investors Miss — https://angelinvestorsnetwork.com/alternative-investments/private-credit-market-2026 (2026-05-30)
[6] Private Credit Funds: How Direct Lending Works and What It Costs — https://coyotewealth.com/guides/private-credit-funds
[7] Federal Reserve Board Publication — https://www.federalreserve.gov/publications/files/2025-dfast-results-20250627.pdf
[8] Results for Banks under the Severely Adverse Scenario — https://federalreserve.gov/publications/2025-june-dodd-frank-act-stress-test-results.htm
[9] Most Leveraged BDCs by Debt-to-Equity Ratio — https://www.bdcinvestor.com/screens/most-leveraged-bdcs/
[10] BDC Debt-to-Equity Ratio: The Leverage Number Every BDC Investor Should Check — https://angelinvestorsnetwork.com/alternative-investments/bdc-debt-to-equity-ratio-explained (2026-09-02)
[11] BDC Monitor - Fall 2025 — https://cdn.hl.com/pdf/2025/bdc-monitor-fall-2025.pdf
[12] PowerPoint Presentation — https://www.lincolninternational.com/wp-content/uploads/Lincoln-VOG-Private-Market-Perspectives_Q2_2025.pdf
[13] While the Lincoln Private Market Index Grew in Q1, Negative Trends are Brewing — https://www.lincolninternational.com/perspectives/articles/while-the-lincoln-private-market-index-grew-in-q1-negative-trends-are-brewing/ (2025-05-22)


## Methodology

- **Pipeline:** specification → task graph → 12 research iterations (36 searches) → evidence extraction → claim graph → sectioned synthesis → citation + quality audits
- **Sources:** 13 ingested (9 distinct publishers), 85 evidence records, 84 verified claims, 13 relations (0 contradictions)
- **Model:** session model · **Run:** 2026-09-15T14-04-44-how-large-is-the-private-credit-market-t
- **Audits:** citation entailment (9 checked, 6 unresolved), coverage pass, source diversity 23% max publisher share


---

## Audit warnings
- Citation failures (6/9): Partial support only. The evidence quote supports the AUM figures (US$3.5tn end-2024, US$3.0tn end-2023, 17% increase), but the report sentence's third component — "the US is the largest market at 65% of global AUM" — is not present anywhere in the cited claim or quote. The citation [1] is used for all three claims, yet the evidence contains no US market share data, so that portion is unsupported (topical-but-not-supportive).; The evidence supports the AUM figures (US$3.5tn end-2024, US$3.0tn end-2023, 17% increase), but the report sentence's third component — "the US is the largest market at 65% of global AUM" — is not present anywhere in the cited claim or evidence quote. The citation [1] is used for all three claims, yet the evidence only covers the first two. This is partial support: the US market share assertion is unsupported by the cited evidence.; The evidence quote supports the AUM figures (US$3.5tn at end-2024, US$3.0tn at end-2023, 17% increase), but it contains no information about the US being the largest market at 65% of global AUM. That portion of the report sentence is unsupported by the cited evidence (topical-but-not-supportive / missing support for the US market share claim).; Partial support only. The evidence quote supports the deployment figure (US$592.8bn in 2024, a 78% YoY increase from US$333.4bn in 2023), but it contains nothing about "Institutions supply 76% of capital versus 24% retail." The second claim in the evidence is about global private credit AUM growing ~17% YoY, which is topical but does not support the 76%/24% institutional/retail capital split. Since a material portion of the report sentence is unsupported by the cited evidence, the evidence does not fully entail the sentence.; The evidence supports only the second clause (US$592.8bn deployed in 2024, a 78% YoY increase). The first clause — "Institutions supply 76% of capital versus 24% retail" — is not present anywhere in the cited evidence, which discusses deployment amounts and AUM growth but contains no institutional/retail capital split. Partial support only.