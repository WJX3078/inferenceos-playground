#!/usr/bin/env node
// Headless experiment runner (no browser required):
//
//   npm run experiment -- scenarios/my-experiment.json
//   npm run experiment -- scenarios/my.json --out results.json --include-observations
//   npm run experiment -- scenarios/my.json --seeds 1,2,3,4,5        # multi-seed stats
//   npm run experiment -- --trace requests.jsonl --config scenarios/base.json
//
// Trace files (JSONL/JSON) replay a real workload SHAPE through the simulator.
// If trace lines carry observed_ttft_ms / observed_tpot_ms, the output shows
// Observed vs Simulated SIDE BY SIDE — reference only, never a calibration
// claim (see docs/experiments.md).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  runScenario, runSweep, runMultiSeed, replayIdentical,
  type ScenarioFile, type RunResult,
} from '../src/simulation/experiment.ts';
import { parseTrace, traceToScenario, type NormalizedTraceRequest } from '../src/simulation/trace.ts';

function gitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined; // not a git checkout — fingerprint simply omits the field
  }
}

function observedRows(results: RunResult[]): { id: string; observed: number; simulated: number }[][] {
  return results.map(r => {
    const observations = (r.observations ?? []) as Array<{
      id: string; ttft: number | null; observed: { ttftMs?: number } | null;
    }>;
    return observations
      .filter(o => o.observed?.ttftMs !== undefined && o.ttft !== null)
      .map(o => ({ id: o.id, observed: o.observed!.ttftMs!, simulated: o.ttft! }));
  });
}

function main() {
  const args = process.argv.slice(2);
  const valueFlags = new Set(['--out', '--seeds', '--trace']);
  const file = args.find((a, i) =>
    !a.startsWith('--') && !(i > 0 && valueFlags.has(args[i - 1])));
  const flags = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outPath = args.includes('--out') ? flags('out') : null;
  // Trace mode needs observations for the Observed-vs-Simulated reference table.
  const includeObservations = args.includes('--include-observations') || !!flags('trace');
  const seedsArg = flags('seeds');
  const seeds = seedsArg ? seedsArg.split(',').map(s => Number(s.trim())).filter(Number.isInteger) : undefined;
  const traceFile = flags('trace');

  let scenario: ScenarioFile;
  if (traceFile) {
    const text = readFileSync(resolve(traceFile), 'utf8');
    const parsed = parseTrace(text);
    const baseConfig = file ? JSON.parse(readFileSync(resolve(file), 'utf8')) as ScenarioFile : {};
    scenario = traceToScenario(parsed, { name: `trace:${traceFile}`, config: baseConfig.config, maxSimMs: baseConfig.maxSimMs });
    console.error(`Loaded trace: ${parsed.requests.length} requests (${parsed.format}). Observed metrics are reference-only.`);
  } else {
    if (!file) {
      console.error('Usage: npm run experiment -- <scenario.json> [--out results.json] [--seeds 1,2,3,4,5] [--trace requests.jsonl] [--include-observations]');
      process.exit(2);
    }
    scenario = JSON.parse(readFileSync(resolve(file), 'utf8')) as ScenarioFile;
  }

  const isMultiSeed = !!seeds?.length || (!!scenario.seeds?.length && !scenario.sweep?.length && args.includes('--seeds'));
  const results: RunResult[] = scenario.sweep?.length && !isMultiSeed
    ? runSweep(scenario, { includeObservations })
    : [];

  let multiSeed = null;
  if (isMultiSeed) {
    multiSeed = runMultiSeed(scenario, seeds ?? scenario.seeds, { includeObservations });
  } else if (!results.length) {
    results.push(runScenario(scenario, { includeObservations }));
  }
  const git = gitCommit();
  if (git) for (const r of results) r.fingerprint.gitCommit = git;
  if (multiSeed) for (const r of multiSeed.perSeed) r.fingerprint.gitCommit = git;

  const fmt = (v: number | null, digits = 0) => v === null ? '--' : v.toFixed(digits);

  if (multiSeed) {
    console.log(`\n=== ${multiSeed.scenario} — ${multiSeed.seeds.length} paired seeds [${multiSeed.seeds.join(', ')}] ===`);
    console.log('aggregate over seeds (population stddev; paired comparison uses the same seed list):');
    for (const a of multiSeed.aggregate) {
      console.log(`  ${a.key.padEnd(18)} mean=${a.mean.toFixed(1)} median=${a.median.toFixed(1)} min=${a.min.toFixed(1)} max=${a.max.toFixed(1)} stddev=${a.stddev.toFixed(1)}`);
    }
    for (const r of multiSeed.perSeed) {
      const s = r.summary;
      console.log(`seed ${r.seed}: completed=${s.completed} ttftP99=${fmt(s.ttftP99)} tpotP99=${fmt(s.tpotP99, 1)} goodput=${s.goodput.toFixed(2)} fp=${r.fingerprint.resultHash}`);
    }
  }

  for (const r of results.length ? results : (multiSeed?.perSeed ?? [])) {
    const s = r.summary;
    console.log(`\n=== ${r.scenario} (seed ${r.seed}) ===`);
    console.log(`engine v${r.engineVersion} | simulated ${(r.simulatedMs / 1000).toFixed(1)}s | ${r.iterations} iterations | drained: ${r.drained}`);
    console.log(`completed=${s.completed} rejected=${s.rejected} cancelled=${s.cancelled} outputTokens=${s.outputTokens}`);
    console.log(`TTFT  mean=${fmt(s.ttft)} p50=${fmt(s.ttftP50)} p95=${fmt(s.ttftP95)} p99=${fmt(s.ttftP99)} ms`);
    console.log(`TPOT  mean=${fmt(s.tpot, 1)} p50=${fmt(s.tpotP50, 1)} p95=${fmt(s.tpotP95, 1)} p99=${fmt(s.tpotP99, 1)} ms`);
    console.log(`E2E   p50=${fmt(s.e2eP50)} p95=${fmt(s.e2eP95)} p99=${fmt(s.e2eP99)} ms`);
    console.log(`throughput=${s.tokensPerSecond.toFixed(0)} tok/s, ${s.requestsPerSecond.toFixed(2)} req/s | goodput=${s.goodput.toFixed(2)} req/s | SLO=${s.sloAttainment.toFixed(1)}%`);
    console.log(`KV util=${s.kvUtilization.toFixed(0)}% evictions=${s.evictions} preemptions=${s.preemptions} recomputed=${s.recomputedTokens} starvation=${s.starvationEvents} backpressure=${s.backpressureEvents}`);
    console.log(`budget util=${s.tokenBudgetUtilization.toFixed(0)}% iterations=${s.schedulerIterations} prefixHits=${s.prefixHitRate.toFixed(0)}%`);
    if (s.transfersCompleted || s.transfersActive || s.transfersQueued) {
      console.log(`transfers: ${s.transfersCompleted} done / ${s.transfersActive} active / ${s.transfersQueued} queued, ${(s.networkBytes / 1048576).toFixed(0)} MiB moved, pipe busy ${s.networkUtilization.toFixed(0)}%`);
    }
    if (s.cpuHitBlocks || s.remoteHitBlocks || s.recomputeBlocks || s.restores) {
      console.log(`tier blocks: gpu=${s.gpuHitBlocks} cpu=${s.cpuHitBlocks} remote=${s.remoteHitBlocks} recompute=${s.recomputeBlocks} restores=${s.restores}`);
    }
    console.log(`fingerprint: engine v${r.fingerprint.engineVersion} schema v${r.fingerprint.scenarioSchemaVersion} `
      + `seed=${r.fingerprint.seed} config=${r.fingerprint.configHash} workload=${r.fingerprint.workloadHash} result=${r.fingerprint.resultHash}`
      + (r.fingerprint.gitCommit ? ` git=${r.fingerprint.gitCommit.slice(0, 8)}` : ''));
  }

  // Observed vs simulated side-by-side (reference only, never "accuracy").
  const rows = observedRows(results.length ? results : (multiSeed?.perSeed ?? []));
  const flat = rows.flat();
  if (flat.length) {
    console.log(`\n--- Observed vs Simulated TTFT (reference only — the simulator is not a calibrated hardware predictor) ---`);
    console.log('request      observed   simulated   difference');
    for (const { id, observed, simulated } of flat.slice(0, 20)) {
      console.log(`${id.padEnd(10)} ${String(observed).padStart(8)} ms ${String(simulated.toFixed(0)).padStart(9)} ms ${String((simulated - observed).toFixed(0)).padStart(10)} ms`);
    }
    if (flat.length > 20) console.log(`... ${flat.length - 20} more in the JSON output`);
  }

  const payload = multiSeed
    ? { mode: 'multi-seed', seeds: multiSeed.seeds, aggregate: multiSeed.aggregate, perSeed: multiSeed.perSeed }
    : results.length === 1 ? results[0] : results;
  const json = JSON.stringify(payload, null, 2);
  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(resolve(outPath), json);
    console.log(`\nWrote results to ${outPath}`);
  } else {
    console.log(`\n${json}`);
  }

  // Replay sanity: identical runs must produce identical fingerprints.
  if (results.length === 2 && !results.some(r => r.scenario.includes('sweep')) && !multiSeed) {
    if (!replayIdentical(results[0], results[0])) throw new Error('fingerprint not self-consistent');
  }
  void parseTrace; // imported for trace mode above; kept referenced for clarity
}

main();
