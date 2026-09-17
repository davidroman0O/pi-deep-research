# Recalibration Execution Audit: Deep Research Review of Review #6

## Executive assessment

Review #6 is **directionally strong and mostly correctly sequenced**, but I would not execute it verbatim. The external evidence supports three of its central intuitions: evidence quality and verdict quality are separable evaluation objects; numerical/financial claims behave differently enough to justify explicit stratification and typed verification; and repeated adaptive use of a held-out set creates genuine overfitting risk. AVeriTeC itself evaluates evidence separately while also conditionally scoring downstream veracity/justification, FinQA documents the distinctive numerical and heterogeneous-representation burden of finance, and adaptive-data-analysis work shows that repeatedly consulting a holdout can overfit it. citeturn18view0turn17view2turn20view0turn20view2

The two material weaknesses are in the **measurement protocol**, not the overall direction.

First, the proposed `disagreement_handling` metric is gameable if its denominator consists only of contradiction/qualification edges that the system itself chose to put in the graph. A weaker system can improve that ratio by discovering fewer disagreements. The polarity split therefore needs either a third diagnostic for **disagreement discovery** or an independently defined reference denominator.

Second, the sealed-pool recommendation is not strict enough. A “double dev+shadow pass” can be a useful operational stability check, but it is not statistical protection against adaptive overfitting. More importantly, “open sealed once per gate decision” becomes unsafe if several later gate decisions are informed by earlier sealed results. Once its outcome affects development, that sealed set is no longer truly sealed. This is exactly the kind of adaptive reuse that holdout-overfitting theory warns about. citeturn20view0turn20view2

My revised verdict is:

| Review area | Audit verdict | Main correction |
|---|---|---|
| Evidence polarity | **Accept with material amendment** | Separate discovery from handling, or use an independently adjudicated denominator |
| Pool assignment | **Accept stratification; revise gate protocol** | Keep finance balanced, but retire sealed data after disclosure and do not treat two passes as statistical validation |
| First optimization | **Accept typing first** | Instrument the extraction cap immediately after typing, before spending much of the run budget on query A/Bs |
| Typed fact matching | **Accept normalization; strengthen semantics** | Canonicalize structured quantities rather than globally rewriting strings such as `$ → USD` or `M → million` |

A scope limitation matters: no repository, run log, pool manifest, or fixture file was supplied. I therefore cannot independently verify that `corroboratedClaims`, `test/lib/metrics.ts`, `extract maxItems 8`, the claimed 50/50 corpus composition, the ±0.15 run noise, or the 53-run budget exist exactly as described. Those are **local premises supplied by Review #6**, not externally verified facts.

## Evidence polarity should be split, but the proposed denominator must change

The basic distinction in Review #6 is sound. “Did the system obtain independent corroboration?” and “Did the final synthesis faithfully represent contradictory or qualifying evidence?” measure different behaviors. A fact-checking system can be excellent at obtaining multiple sources but poor at expressing conflicts, or it can carefully hedge the conflicts it notices while failing to discover important contrary evidence.

That distinction is consistent with AVeriTeC's evaluation philosophy. In the original benchmark, evidence retrieval is measured separately, while veracity and justification scores are also reported **conditioned on reaching evidence-quality thresholds**. In other words, mature fact-verification evaluation has precedent for both component measurement and gating. citeturn18view0 AVeriTeC's later shared-task analysis also found that conflicting-evidence/cherry-picking cases remained particularly difficult: no participating system exceeded 0.1 on the reported score for those cases. citeturn19view0turn19view1

That creates an important nuance for Review #6. Its operational recommendation—**do not introduce a new polarity gate during recalibration**—is sensible. Its stronger implication that disagreement should inherently remain additive rather than gated is not established. Gating can be principled once the underlying measures are validated; AVeriTeC is a direct precedent. citeturn18view0 During the present calibration phase, however, changing a new metric, the composite definition, and system behavior simultaneously would make regression attribution harder. So keeping the composite frozen is the right staging choice.

### The self-referential denominator is the real defect

The proposed definition is approximately:

\[
\text{disagreement\_handling}
=
\frac{\#\{\text{graph contradict/qualify edges represented in synthesis}\}}
{\#\{\text{graph contradict/qualify edges}\}}
\]

That measures **conditional handling given discovery**, not disagreement handling end to end.

Consider two runs against ten true disagreement opportunities:

| Run | True tensions discovered | Discovered tensions surfaced | Proposed score |
|---|---:|---:|---:|
| A | 10 | 8 | 0.80 |
| B | 2 | 2 | **1.00** |

Run B is clearly worse at representing the evidence landscape, yet the proposed metric prefers it. This is the same perverse incentive Review #6 says it wants to avoid by refusing to gate contradiction scoring; moving the quantity outside the gate does **not** remove the incentive. The problem lies in the denominator.

The clean decomposition is:

\[
\text{independent\_support}
=
\frac{\text{eligible claims satisfying corroboration predicate}}
{\text{eligible claims}}
\]

\[
\text{disagreement\_discovery}
=
\frac{|T_{\text{reference}}\cap T_{\text{graph}}|}
{|T_{\text{reference}}|}
\]

\[
\text{disagreement\_surface}
=
\frac{|T_{\text{reference}}\cap T_{\text{graph}}\cap T_{\text{synthesis}}|}
{|T_{\text{reference}}\cap T_{\text{graph}}|}
\]

and, most importantly,

\[
\text{disagreement\_end\_to\_end}
=
\frac{|T_{\text{reference}}\cap T_{\text{graph}}\cap T_{\text{synthesis}}|}
{|T_{\text{reference}}|}
\]

where \(T_{\text{reference}}\) is an independently adjudicated set of contradiction/qualification opportunities rather than the current system's own graph.

If only **two headline numbers** are affordable, I would expose `independent_support` and `disagreement_end_to_end`, while logging discovery and conditional surface as diagnostic counts. That retains the desired polarity split without rewarding disagreement suppression.

There is a second measurement issue: “referenced in synthesis text” should not ideally mean literal string co-occurrence. AVeriTeC's human-evaluation analysis explicitly notes that valid evidence can use different information, arguments, or sources from the reference, and that automatic textual evidence metrics can diverge from human judgment. citeturn18view1turn19view1 A synthesis can faithfully paraphrase a tension without repeating the graph wording.

The more robust architecture is therefore to pass stable claim/edge identifiers or provenance references through synthesis generation and score those structured links. If that is too invasive for the recalibration window, normalized text matching can be used as a temporary instrument, but it should be manually audited on a calibration sample for paraphrase false negatives and accidental lexical matches.

### What should be emitted during the baseline period

For every run, emit the ratios **and their raw denominators**:

`independent_support = 17/23`, not merely `0.739`;  
`disagreement_discovery = 4/6`;  
`disagreement_surface = 3/4`;  
`disagreement_end_to_end = 3/6`.

Zero-denominator cases need an explicit `N/A`, not an invented perfect or zero score. Otherwise a topic with no reference disagreements can distort averages.

Review #6's “report separately for 5–10 runs” is reasonable as an engineering smoke test, but **5–10 runs has no general statistical guarantee**. Whether that is enough depends on topic reuse, run stochasticity, correlation across topics, and the actual observed spread. Treat 5–10 as a minimum instrumentation phase, not an acceptance threshold.

**Audited decision:** split now, do not integrate into the frozen composite yet, but change the disagreement denominator before collecting the baseline. This is the highest-priority correction to Review #6.

## Pool stratification is right; sealed-set governance needs to be stricter

Treating finance as an explicit stratum is well supported. FinQA describes financial QA as involving complex numerical reasoning and heterogeneous representations relative to general-domain tasks, and reports a substantial gap between then-current pretrained systems and expert human performance on the task. citeturn17view2 In the more recent AVeriTeC shared task, all submitted systems performed substantially worse on numerical claims than on the other claim types under that evaluation. citeturn19view0turn19view1

Those findings support **stratification**, but they do not establish Review #6's stronger local statement that “finance topics have systematically higher variance.” Variance is a property that should be measured on your own regression corpus. The literature establishes distinct difficulty and representation demands, not the specific variance of your 20-topic suite.

Assuming the supplied premise that the corpus is exactly 50% finance and 50% general, the proposed split is internally coherent:

| Pool | Finance | General | Total |
|---|---:|---:|---:|
| dev | 4 | 4 | 8 |
| shadow | 3 | 3 | 6 |
| sealed | 3 | 3 | 6 |

The more important constraint is that **topic clusters must not cross pool boundaries**. If near-duplicate topics, companies, events, or reference-fact templates occur on both sides of a split, the apparent independence of the pools is overstated. Stratify first, but assign complete correlated clusters as units.

Reporting finance/general medians inside each pool is useful diagnostically, but with only three or four observations per stratum, those medians are extremely coarse. For three observations, the median is literally one item; for four, it is the midpoint of the two central items. A single topic can therefore move the “stratum median” substantially. The stratum readout should accompany the overall gate, not become a powerful independent gate unless the sample is enlarged.

### The “twice consecutively” rule does less than Review #6 claims

Two consecutive dev+shadow passes can detect some run-to-run instability **only if the execution is stochastic and the repetitions are meaningfully independent**, for example with predeclared different seeds. If the pipeline is deterministic, two identical evaluations contribute no new evidence. If it is stochastic, two runs are still a very small sample of the run distribution.

More importantly, repeated passes do not solve adaptive overfitting to dev+shadow. Dwork and colleagues show that repeatedly and adaptively reusing a holdout can cause overfitting to the holdout itself; Blum and Hardt make the same point in the sequential leaderboard setting. citeturn20view0turn20view2 Thus “two passes” is best understood as a **stability rule**, not an unbiasedness rule.

The stated “one pass after a calibration change is within noise of ±0.15” should also not be promoted to a design constant unless the ±0.15 was empirically estimated from your own replicated baseline. Nothing in the external evidence justifies that particular magnitude.

A stronger pre-sealed protocol is:

1. Freeze pool membership, topic clusters, finance/general labels, seeds, metric definitions, and pass/fail thresholds before the final experiment.
2. Compare candidate vs frozen baseline **pairwise on the same topics and execution conditions**. Raw medians alone discard useful pairing information.
3. Report overall result, finance/general slices, and individual-topic deltas so that one extreme topic cannot hide behind an aggregate.
4. Use dev for active iteration and shadow for less-frequent confirmation. Repeatedly exposing both after every tweak effectively turns both into development data.
5. Open sealed only when the candidate is already frozen.

That last point leads to a stricter rule than Review #6's “once per gate decision”:

> **A disclosed sealed pool should be retired from its role as an unbiased final holdout for subsequent adaptations influenced by its result.**

Suppose candidate A sees sealed and fails. If you then change the system in response and candidate B is evaluated on the same sealed six topics, candidate B has indirectly trained on those topics. That is adaptive holdout reuse, even if each candidate saw sealed “only once.” The theoretical concern is precisely repeated feedback-driven reuse, not merely multiple accesses within one run. citeturn20view0turn20view2

So the preferred policy is **one sealed disclosure per release family, followed by retirement/rotation**, or else a larger untouched reserve from which a fresh sealed subset can be drawn.

### Six sealed items cannot provide a precise population estimate

The tiny sealed pool is best treated as a **regression tripwire**, not a high-precision estimate of general capability. To illustrate the scale of the uncertainty, suppose—for simplicity—that each sealed item yields a binary pass/fail outcome and all six pass. The exact two-sided 95% Clopper–Pearson lower bound on the underlying pass probability is only about **0.541**. Even eight successes out of eight raise that lower bound only to about **0.631**.

That does not make a six-item sealed pool useless. It means the interpretation should be “no detected regression on this protected panel,” not “the true success rate is established with narrow uncertainty.” Continuous composite scores and clustered topics require an analysis tailored to their structure, but the binary illustration makes the sample-size limitation clear.

**Audited decision:** keep the 4/4, 3/3, 3/3 stratification if those local corpus premises are true; keep topic clusters intact; treat the two-pass rule as stability screening; and make sealed disclosure one-use followed by retirement, not reusable once per successive gate decision.

## Verify-target typing should land first, with extraction saturation audited immediately afterward

Review #6's strongest sequencing recommendation is to stabilize **what counts as a matching fact** before changing how evidence is searched.

This is supported by the behavior of claim-verification benchmarks. AVeriTeC explicitly distinguishes numerical, event/property, quote, causal, and position-statement claim types, and its 2025 shared-task analysis reports materially different performance by type, with numerical claims especially weak. citeturn19view0turn19view2 FinQA likewise demonstrates that financial numerical reasoning depends on structured operations and heterogeneous representations rather than generic semantic similarity alone. citeturn17view2

An untyped verifier can therefore create exactly the attribution ambiguity Review #6 describes. Suppose an entity-slot query finds a page containing the correct company and the right-looking number but the wrong metric, denominator, currency, or period. If the matching layer does not encode those distinctions, retrieval improvements and verification errors become entangled. Conversely, an over-strict matcher can reject semantically equivalent quantities and make a genuine retrieval improvement look like recall loss.

The sequencing should be:

**typed target semantics → extraction-cap telemetry → entity-slot retrieval A/B**

rather than simply typing → entity-slot A/B → cap audit.

The difference is subtle but important. Auditing the cap is instrumentation, not a high-blast-radius optimization. It can reveal a bottleneck before a limited experiment budget is spent trying to improve upstream retrieval.

### Recommended verify-target schema

For factual/numerical claims, a useful target is more structured than a single `claim_type` enum. At minimum, preserve:

```text
claim_id
claim_type
entity
property_or_metric
value
quantity_kind
unit
currency
scale
time_period
qualifier_or_comparator
```

Not every field applies to every claim. The purpose is to make equality criteria explicit. For example:

```text
entity: ExampleCo
property_or_metric: capital_expenditure
value: 4_000_000_000
currency: USD
time_period: FY2025
```

is structurally different from:

```text
entity: ExampleCo
property_or_metric: generation_cost
value: 4_000
currency: USD
unit_denominator: kW
```

despite both potentially containing the strings “$4,000” somewhere in the evidence.

This structure also makes later entity-slot query work cleaner. Query generation can consume typed slots without changing the definition of verification success at the same time.

The claim in Review #6 that this is “nearly free” cannot be verified without the codebase. Schema changes can be cheap when the graph already carries all relevant fields; they can be expensive when extraction, serialization, caching, fixtures, and downstream comparators assume a flat shape. The correct engineering label is therefore **low conceptual blast radius, unknown implementation cost** until the repository is inspected.

### Move the `maxItems 8` audit forward

Assuming `extract maxItems 8` really is a current hard cap, the review is right that it could become a binding constraint, especially on documents containing many numerical facts. Financial QA is demonstrably characterized by dense numerical reasoning and heterogeneous financial representations, which makes this a credible risk worth measuring rather than assuming away. citeturn17view2 Recent financial-QA work also frames retrieval over long, multi-document financial contexts as a major challenge, reinforcing the need to distinguish search failure from downstream context/extraction loss. citeturn17view3

Do **not** simply increase 8 to 12 or 16 and declare success. First run a saturation audit with four measurements:

| Instrument | What it tells you |
|---|---|
| `cap_hit_rate` | How often extraction returns exactly eight items |
| `cap_hit_rate_by_stratum` | Whether finance reaches the ceiling disproportionately |
| sampled 8/12/16/high-cap reruns | Whether additional capacity produces genuinely useful claims |
| reference-claim recall vs cap | Whether facts needed for verification are among the truncated claims |

A cap-hit rate alone is not proof of truncation harm; an extractor can return eight items even when the first eight contain everything required. The binding-constraint signal is an improvement in **reference fact coverage or downstream verification** when the cap increases.

Also inspect rank position. If the missing finance claims tend to be ninth or tenth, capacity is implicated. If they never appear even at a high cap,
the problem is extractorthe problem is extractor recall/ranking, not the ceiling.

Only after target typing and cap diagnosis should entity-slot queries receive a substantial A/B budget. Keep topics, seeds, retrieval limits, extract limits, and matcher semantics fixed during that A/B. Otherwise a search-side change is being evaluated while the downstream ruler is moving.

**Audited decision:** Review #6 is right that verify-target typing comes first. Promote extraction-cap instrumentation to an immediate second step, then conduct the entity-slot query experiment.

## Typed fact matching needs semantic quantity canonicalization, not a loose synonym table

Review #6 correctly identifies a classic recall failure:

```text
$4,000 per kilowatt
$4,000/kW
```

A literal unit-string matcher can reject those even though the quantity representations can express the same rate.

The external standards evidence strongly supports canonicalization rather than literal comparison. UCUM was explicitly designed for unambiguous machine communication of quantities and units; its specification notes that different unit expressions may have the same semantics and that fully conformant systems compare semantic equivalence rather than just literal strings. It also defines multiplication, division, exponents, prefixes, and dimensional relationships as part of the unit semantics. citeturn17view6

So the broad prescription is correct, but the proposed lookup table is **too permissive in two places**.

### Do not globally normalize `$` to `USD`

The dollar sign alone does not encode which dollar-denominated currency is intended. ISO 4217 exists specifically to assign unambiguous alphabetic currency identifiers; ISO uses examples such as `USD` for the US dollar, and SIX is the official maintenance agency for ISO 4217 currency codes. citeturn21search0turn21search1

Therefore:

```text
"US$4,000"      -> USD 4000
"USD 4,000"     -> USD 4000
"4,000 US dollars" -> USD 4000
```

can safely converge.

But:

```text
"$4,000"
```

should become `currency = ambiguous_dollar` unless the document or fixture context establishes the currency. Automatically rewriting every `$` to `USD` risks false positives on Canadian, Australian, Singaporean, and other dollar currencies.

### Do not globally normalize `M` to `million`

Context-sensitive financial shorthand such as `$4,000M` may legitimately mean `$4 billion`, but `M` is not a universally safe textual synonym for “million.” Unit systems are case- and expression-sensitive, and UCUM explicitly treats lexical representation and semantic unit expressions carefully. citeturn17view6

Financial scaling should therefore be parsed under a **financial amount grammar**, not as an unrestricted string substitution:

```text
USD 4M  -> value = 4,000,000; currency = USD
USD 4B  -> value = 4,000,000,000; currency = USD
```

This has a useful consequence: `USD 4B` and `USD 4,000M` can compare equal after exact scaling, without introducing fuzzy numerical matching.

### Canonicalize into a structured quantity

A robust normalized representation is approximately:

```text
numeric_value
currency_code?
unit_numerator?
unit_denominator?
scale
dimension_or_quantity_kind
```

with entity, metric, and time period carried separately at the fact level.

Examples:

| Surface form | Canonical interpretation | Match? |
|---|---|---|
| `$4,000/kW` vs `USD 4,000 per kilowatt`, with US-dollar context | USD 4000 / kW vs USD 4000 / kW | Yes |
| `4,000` vs `4.0e3` | 4000 vs 4000 | Yes |
| `$4B` vs `$4,000M`, same currency context | 4,000,000,000 vs 4,000,000,000 | Yes |
| `$4,000/kW` vs `$4,000/kWh` | power-denominated rate vs energy-denominated rate | **No** |
| `USD 4,000` vs `CAD 4,000` | different currencies | **No** |
| `4,000` vs `4,100` | unequal values | **No** |
| `FY2025 revenue = USD 4B` vs `FY2024 revenue = USD 4B` | same amount, different period | **No** |
| `$4,000` vs `USD 4,000` with no currency context | ambiguous vs USD | **Abstain/no match** |

The `kW`/`kWh` case is exactly why matching “full unit token, not prefix” is right, but a parser is preferable to a hand-built prefix rule. UCUM's semantics are based on complete unit expressions and dimensional composition, which is the right conceptual model. citeturn17view6

### Keep numeric equality strict, but distinguish formatting from approximation

Review #6 is right to normalize representation without silently changing factual tolerances:

\[
4000 = 4{,}000 = 4.0\times10^3
\]

but

\[
4000 \ne 4100.
\]

That is exact arithmetic after parsing, not fuzzy matching.

There is one necessary extension: some reference claims are explicitly approximate. A phrase such as “about $4 billion” should not force the matcher to pretend exact equality. The solution is **not** embedding similarity or an implicit percentage tolerance. Encode approximation semantics in the reference target itself, for example:

```text
comparison: approximately_equal
reference_value: 4_000_000_000
tolerance: explicitly_defined_by_fixture
```

That keeps tolerance visible and auditable.

### Expand the adversarial fixture beyond two pairs

The two tests in Review #6 are necessary but insufficient. The minimum calibration matrix should cover both false-negative and false-positive pressure:

| Fixture class | Expected result |
|---|---|
| same value, synonymous unit spelling | match |
| same value, slash vs “per” representation | match |
| exact scale equivalence: `4B` vs `4,000M` | match |
| same number, different denominator: `kW` vs `kWh` | reject |
| same number, different currency | reject |
| same entity/value, different metric | reject |
| same entity/metric/value, different period | reject |
| ambiguous `$` against explicit `USD` without context | reject/abstain |
| near value: `4,000` vs `4,100` | reject |
| superficially similar unit prefix | reject |

The review's claim that roughly “20 entries covers 95% of finance-regression cases” should not be accepted without evidence from the actual regression-error corpus. The right procedure is to derive the alias table from observed failures, track coverage, and expand it only with reviewed canonical mappings.

**Audited decision:** retain the strict typed matcher, but make normalization a structured, semantics-preserving preprocessing layer. Do not use fuzzy unit similarity; do not globally rewrite `$` or `M`; and make ambiguity an explicit state rather than guessing.

## Revised execution order and acceptance criteria

The strongest version of Review #6 is not a wholesale rewrite. It is a handful of surgical corrections that make the recalibration much harder to game and much easier to interpret.

| Priority | Action | Acceptance criterion |
|---|---|---|
| **Highest** | Replace self-referential disagreement scoring | A system cannot raise its headline disagreement score merely by emitting fewer contradiction/qualification edges |
| **High** | Add structured quantity/currency/unit canonicalization | Positive representation-equivalence fixtures match; adversarial currency/unit/period/metric fixtures remain rejected |
| **High** | Freeze stratified, cluster-separated pool manifests | 4/4, 3/3, 3/3 balance is preserved where applicable; correlated topic families do not cross pools |
| **High** | Land verify-target typing | Matcher can distinguish at least entity, metric/type, numeric value, unit/currency, and period where applicable |
| **High** | Instrument extraction saturation | Cap-hit rates and reference-recall-at-cap are available by finance/general before retrieval A/Bs |
| **Next** | Run entity-slot query A/B | Same topics, seeds, budgets, extraction settings, and typed matcher on baseline and treatment |
| **Later** | Consider polarity/composite integration | Only after the new metrics show stable behavior, adequate denominators, and agreement with manual adjudication |

The concrete polarity instrumentation I would freeze is:

```text
independent_support
independent_support_numerator
independent_support_denominator

disagreement_reference_count
disagreement_discovered_count
disagreement_surfaced_count

disagreement_discovery
disagreement_surface_given_discovery
disagreement_end_to_end
```

The final synthesis score should remain unchanged during the calibration window. That preserves comparability with the frozen baseline while the new instruments are being validated. Once the instrumentation has a stable baseline, gating can be reconsidered; fact-verification benchmarks demonstrate that evidence-conditioned downstream scoring is a legitimate design, so it should be evaluated empirically rather than ruled out categorically. citeturn18view0

For the pool protocol, the operational rule should be:

> **Dev is iterative; shadow is confirmatory; sealed is final and consumable.**

The candidate should be frozen before sealed evaluation. A sealed failure can invalidate that candidate, but once the failure has informed the next implementation, the exposed sealed set should not continue to be described as an unbiased holdout. Adaptive holdout research gives a formal reason for that stricter interpretation. citeturn20view0turn20view2

For the optimization sequence, use:

```text
typed verifier
    ↓
unit/currency/value canonicalization + adversarial fixtures
    ↓
extraction-cap saturation audit
    ↓
entity-slot retrieval A/B
    ↓
dev stability check
    ↓
shadow confirmation
    ↓
freeze candidate
    ↓
one-use sealed evaluation
```

The resulting “do not” list is slightly different from Review #6's:

Do not integrate the new disagreement metric into the composite until its denominator is independently anchored. Do not interpret two consecutive pool passes as evidence that adaptive overfitting has been solved. Do not reuse an exposed sealed set for later implementation decisions while continuing to call it sealed. Do not globally map `$` to `USD` or `M` to `million`. Do not loosen numerical equality merely to recover formatting variants. Do not begin expensive entity-slot experimentation while the verifier's quantity semantics or a potentially binding extraction cap are still moving.

The overall judgment, therefore, is **approve Review #6 with amendments rather than approve as written**. Its architectural direction is good: preserve the frozen composite, stratify finance, type verify targets before modifying retrieval, normalize units explicitly, and protect the sealed pool. But the recalibration will be materially stronger if it fixes the disagreement denominator, treats the sealed pool as consumable rather than repeatedly reusable, replaces string-level unit aliases with structured quantity semantics, and measures extraction saturation before spending the retrieval experiment budget. These changes preserve nearly all of Review #6's intended low-cost execution plan while removing its two biggest sources of measurement bias.

