# Contributing

## Setup

```bash
npm ci
npm run dev -- --port 5178
npm test          # deterministic unit / invariant / stress tests
npm run check     # tests + type check + build + Playwright E2E
```

## Ground rules

1. **Correctness over features.** The simulation core is the product. If a
   change alters simulation behavior, update the tests and docs in the same
   PR and bump `ENGINE_VERSION` (src/simulation/version.ts) when old exported
   runs become incomparable.
2. **Determinism is non-negotiable.** No `Math.random()`, no `Date.now()`,
   no wall-clock time in `src/simulation/`. Use the seeded RNG and stable
   tie-breaks.
3. **Claims discipline.** Every simulated number is an illustrative model
   output. Never describe simulator results as hardware benchmarks or as
   vLLM behavior. Mark new cost-model parameters as illustrative in docs.
4. **No skipped tests.** A failing test is either a real bug or a documented
   behavior change — never silence it.
5. **Honest limitations.** If a feature has a boundary (modeling or
   engineering), document it in docs/limitations.md rather than hiding it.

## PR checklist

- [ ] `npm run check` passes locally
- [ ] New behavior has tests (invariant, regression, or property)
- [ ] README/docs updated; `npm run docs:check` passes
- [ ] No benchmark-sounding claims without a reproducible in-repo experiment
- [ ] Known limitations updated if the change adds or removes one
