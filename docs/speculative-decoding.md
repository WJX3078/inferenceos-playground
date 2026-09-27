# Speculative decoding

Speculative decoding trades extra compute for fewer sequential decode steps: a cheap draft model proposes several tokens, the target model verifies them in one pass, the matching prefix is accepted, the rest is discarded, and a correction (or bonus) token is committed. The simulator models this as a per-step mechanism with configurable economics.

## Model

Per decode emission for a sequence (with speculative decoding enabled):

1. `drafted = min(draftLength, outputTokens − generated)` — never draft beyond the requested output.
2. Each draft token is accepted **independently** with the profile probability (drawn from the engine's seeded RNG — deterministic): low = 0.25, medium = 0.70, high = 0.92. Acceptance stops at the first rejection.
3. Committed tokens = `accepted + 1` (the correction), capped at the remaining output. The accepted prefix is committed verbatim, the rejected suffix is discarded — exactly the draft/verify contract.
4. The step's **duration** (time cost) is `specCost ×` the ordinary decode duration; the step's **budget** consumption stays 1 token slot (documented simplification — draft tokens cost compute, not scheduling slots).

All knobs are configuration: `specDraftLength` (1–16), `specAcceptance` (low/medium/high), `specCost` (1.0–4.0×, default 1.65). The v0.1 hard-coded draft-4/0.76/1.65 model is gone.

## The economics — and the negative case

Expected tokens per step ≈ `1 + Σ P(first k drafts accepted)` (geometric, capped at the draft length). Expected *speedup* ≈ that divided by `specCost`:

| Profile | Draft | E[tokens/step] | Cost 1.65× | Cost 2.0× |
| --- | --- | --- | --- | --- |
| low (25%) | 8 | ≈ 1.33 | 0.81× **loss** | 0.67× loss |
| medium (70%) | 8 | ≈ 3.1 | 1.9× gain | 1.6× gain |
| high (92%) | 8 | ≈ 7.5 | 4.6× gain | 3.8× gain |

**Speculation is not always a win.** Low acceptance (a weak draft model, or a coding task the draft can't track) or a costly verify makes it slower than plain decoding — the `speculative-low-acceptance` scenario exists to demonstrate exactly this, and the Compare tab makes the loss visible against `speculative-high-acceptance`.

## What to observe

- Trace `verify` events: `3/8 draft tokens accepted; 4 committed` — the inspector renders the accept/reject pattern per verify for the selected request.
- Counters: `drafted`, `accepted`, rejected suffix, acceptance rate (metrics strip + telemetry).
- Throughput & TPOT p50/p99 with speculation on vs off at the same seed and workload (use Compare).
- Output conservation: the total generated always equals the requested output exactly (invariant-tested); speculation never overshoots.

## Not modeled

Draft-model weights and memory, the draft model's own forward pass beyond the aggregated step cost, tree/chain draft structures, and verification KV bookkeeping. The verify pass here is a cost multiplier, not a second model.
