# SLO and goodput

Throughput says how much the system processes. **Goodput says how much of it is actually usable.** The gap between the two is the single most important serving-systems lesson this simulator teaches.

## Definitions

- **SLO targets**: global `sloTTFTms` and `sloTPOTms` (configurable live), with optional per-request overrides (`RequestInput.sloTTFTms / sloTPOTms`). A request's resolved SLO is fixed at enqueue time.
- A completed request **meets SLO** iff:
  - `ttft ≤ sloTTFT` (TTFT includes queueing), and
  - `tpot ≤ sloTPOT` (a single-token request has no TPOT and cannot violate it).
- **Throughput** = completed requests (or emitted tokens) per second — every completion counts.
- **Goodput** = completions meeting both SLO targets per second (trailing 1 s window).
- **SLO attainment** = goodput candidates / completions, lifetime, reported for TTFT, TPOT, and both combined.

Cancelled requests produce observations but no SLO verdicts (`null`) — they never inflate attainment.

## Why throughput ≠ quality

Push arrival rate past capacity and throughput keeps climbing while every request queues: p99 TTFT explodes, attainment collapses, and *goodput goes down even as throughput goes up*. The `slo-overload` scenario (3 req/s against a 400 ms TTFT target) shows the crossover directly. The SLO-aware scheduler exists for the other half of the lesson: when overload is unavoidable, an explainable urgency order decides *which* requests get saved — and the observations export lets you check who actually met their target.

## What to observe

1. Run any scenario with a generous SLO (e.g. 60000 ms): attainment 100%, goodput ≈ requests/s.
2. Tighten TTFT SLO to 100–200 ms: attainment drops; the GOODPUT tile diverges from REQUESTS/SEC.
3. Compare FCFS vs SLO-aware under the same overload: same throughput, different attainment distribution (who gets saved changes).
4. Long-prefill interference: TPOT p99 may violate while p50 passes — mean-based SLO accounting hides exactly this; that's why the tail percentiles sit next to the SLO numbers.

## Honest accounting notes

- SLO verdicts are evaluated **per completed request at completion time** using its recorded latencies — no partial credit.
- Changing the global SLO live does **not** retroactively change already-recorded verdicts.
- The simulator's absolute millisecond values come from illustrative cost models; the *ratios* (attainment, goodput/throughput gap, percentile spreads) are the meaningful output, not the absolute numbers.
