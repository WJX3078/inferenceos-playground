# Testing strategy

What each test layer is for, and — more usefully — **which bug classes each one catches**. The mutation-style spot checks at the bottom were performed during v1.0 hardening: we deliberately broke the code and confirmed the right test went red.

## Layers

| Layer | Files | Purpose |
| --- | --- | --- |
| Unit / invariant | `engine.test.ts`, `scheduler.test.ts` | request lifecycle, batching semantics, TP topology, replay, hardware matrix |
| Scheduler policies | `scheduler.test.ts` | ordering rules, SLO urgency, preemption rules |
| Memory & caching | `kv.test.ts` | content-hash identity, watermark, multi-tier restore/recompute |
| Disaggregation | `disagg.test.ts` | P/D topology, transfer-before-decode, lifecycle walk, backpressure effects |
| Metrics | `metrics.test.ts` | nearest-rank percentiles, SLO/goodput accounting, observation completeness |
| State machine | `lifecycle.test.ts` | transition table legality, engine-wide graph crawl |
| Hardening features | `hardening.test.ts` | aging, cost-aware preemption, transfer policies, backpressure |
| Property-based | `property.test.ts` | cross-run invariants (monotonicity, conservation, no black holes) |
| Randomized stress | `stress.test.ts` | adversarial configs, tens of thousands of ticks, invariants every ~25 ticks |
| Experiment framework | `experiment.test.ts`, `trace.test.ts` | scenario validation, fingerprints, multi-seed stats, trace parsing, replay identity |
| Browser E2E | `e2e/*.spec.ts` | real-UI workflows, viewport matrix, import/export, no console errors |
| Docs consistency | `scripts/docs-check.ts` | README ↔ code drift, link rot, benchmark-sounding claims |

## Bug class → catching test

| Bug class | Caught by |
| --- | --- |
| KV overcommit / reservation drift | `assertInvariants` ("Overcommitted KV") inside stress + dedicated pressure tests |
| Leaked block ownership after release/transfer/cancel | invariant "Leaked owner" + cancel tests |
| Mutable shared pages | invariant "Mutable shared page" |
| Token budget overrun | budget invariant + `lastBudget` assertions per tick |
| Decode before KV transfer completes | disagg regression 4 + invariant |
| Speculative output overflow | regression 8 (exact output lengths) |
| Non-deterministic scheduling | replay tests (engine-level and fingerprint-level) |
| Preemption livelock (victim/candidate swap) | `cost-aware-preemption` scenario drain + `hardening.test.ts` |
| Preemption storm | cooldown test (`preemptions ≤ bound`) |
| Starvation under SJF/priority | aging tests + `starvation-aging` scenario |
| Prefix cache false sharing (name-based identity) | `kv.test.ts` hash/collision tests |
| Tier restore jumping a content hole | block-granular reuse-plan tests |
| Percentile non-monotonicity or wrong rank | `metrics.test.ts` |
| SLO/goodput mis-accounting | `metrics.test.ts` SLO tests |
| Trace schema drift / silent fallback | `trace.test.ts` problem-collection + scenario validation errors |
| Queue black holes (requests stuck forever) | property "no black holes" |
| Output counter drift | property "outputTokensGenerated never decreases" |
| UI regressions (overflow, clipped buttons, console errors) | E2E viewport matrix + error collectors |
| README claim drift / rot | `npm run docs:check` |

## Mutation spot checks (performed manually in v1.0)

1. **Relaxed the token-budget comparison** (`decode + prefill > total` → `>=`): the budget invariant and the "never schedules more than the budget" test failed immediately.
2. **Skipped owner cleanup in `release()`** (drop the `owners.filter`): the cancel test ("without leaking references") and the invariant "Leaked owner" both failed.
3. **Off-by-one in nearest-rank percentile** (`ceil → floor`): the percentile unit test failed on the p95 rank.
4. **Removed the preemption victim-exclusion set** (reintroduced the livelock): the `cost-aware-preemption` scenario drain test hung and failed — the regression that motivated the fix.

Every mutation was reverted; none required relaxing an assertion.
