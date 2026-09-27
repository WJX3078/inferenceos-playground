#!/usr/bin/env node
// Headless experiment runner (no browser required):
//
//   npm run experiment -- scenarios/my-experiment.json
//   npm run experiment -- scenarios/my-experiment.json --out results.json --include-observations
//
// The scenario file format is documented in docs/experiments.md. Output is a
// JSON result (or result array for sweeps) with config, summary metrics,
// percentiles, SLO/goodput, resource utilization and event counters.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runScenario, runSweep, type ScenarioFile, type RunResult } from '../src/simulation/experiment.ts';

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: npm run experiment -- <scenario.json> [--out results.json] [--include-observations]');
    process.exit(2);
  }
  const wantOut = args.includes('--out');
  const outPath = wantOut ? args[args.indexOf('--out') + 1] : null;
  const includeObservations = args.includes('--include-observations');

  const scenario = JSON.parse(readFileSync(resolve(file), 'utf8')) as ScenarioFile;
  const results: RunResult[] = scenario.sweep?.length ? runSweep(scenario, { includeObservations }) : [runScenario(scenario, { includeObservations })];

  // Human-readable summary on stdout.
  for (const r of results) {
    const s = r.summary;
    const fmt = (v: number | null, digits = 0) => v === null ? '--' : v.toFixed(digits);
    console.log(`\n=== ${r.scenario} (seed ${r.seed}) ===`);
    console.log(`engine v${r.engineVersion} | simulated ${(r.simulatedMs / 1000).toFixed(1)}s | ${r.iterations} iterations | drained: ${r.drained}`);
    console.log(`completed=${s.completed} rejected=${s.rejected} cancelled=${s.cancelled} outputTokens=${s.outputTokens}`);
    console.log(`TTFT  mean=${fmt(s.ttft)} p50=${fmt(s.ttftP50)} p95=${fmt(s.ttftP95)} p99=${fmt(s.ttftP99)} ms`);
    console.log(`TPOT  mean=${fmt(s.tpot, 1)} p50=${fmt(s.tpotP50, 1)} p95=${fmt(s.tpotP95, 1)} p99=${fmt(s.tpotP99, 1)} ms`);
    console.log(`E2E   p50=${fmt(s.e2eP50)} p95=${fmt(s.e2eP95)} p99=${fmt(s.e2eP99)} ms`);
    console.log(`throughput=${s.tokensPerSecond.toFixed(0)} tok/s, ${s.requestsPerSecond.toFixed(2)} req/s | goodput=${s.goodput.toFixed(2)} req/s | SLO=${s.sloAttainment.toFixed(1)}%`);
    console.log(`KV util=${s.kvUtilization.toFixed(0)}% evictions=${s.evictions} preemptions=${s.preemptions} recomputed=${s.recomputedTokens}`);
    console.log(`budget util=${s.tokenBudgetUtilization.toFixed(0)}% iterations=${s.schedulerIterations} prefixHits=${s.prefixHitRate.toFixed(0)}%`);
    if (s.transfersCompleted || s.transfersActive || s.transfersQueued) {
      console.log(`transfers: ${s.transfersCompleted} done / ${s.transfersActive} active / ${s.transfersQueued} queued, ${(s.networkBytes / 1048576).toFixed(0)} MiB moved`);
    }
    if (s.tierHitsCpu || s.tierHitsRemote || s.tierRecomputes || s.restores) {
      console.log(`tiers: gpu=${s.tierHitsGpu} cpu=${s.tierHitsCpu} remote=${s.tierHitsRemote} recompute=${s.tierRecomputes} restores=${s.restores}`);
    }
  }

  const json = JSON.stringify(results.length === 1 ? results[0] : results, null, 2);
  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(resolve(outPath), json);
    console.log(`\nWrote ${results.length} result(s) to ${outPath}`);
  } else {
    console.log(`\n${json}`);
  }
}

main();
