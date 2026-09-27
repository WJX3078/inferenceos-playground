// Engine microbenchmark — measures the JAVASCRIPT SIMULATOR's execution
// speed (ticks/second of the simulation loop). It says nothing whatsoever
// about LLM serving or hardware performance; the numbers describe this
// TypeScript code only.
//
//   node scripts/bench.ts [requests] [ticks]

import { SimulationEngine } from '../src/simulation/engine.ts';

function bench(requests: number, ticks: number) {
  const e = new SimulationEngine({ gpuCount: 2, numBlocks: 128, maxBatchSize: 8 }, 2024);
  e.burst(requests, { promptTokens: 256, outputTokens: 64, prefix: 'chat' });
  // Warm up JIT with a short burst, then measure.
  e.step(200);
  const t0 = process.hrtime.bigint();
  e.step(Math.min(ticks, 2000));
  const t1 = process.hrtime.bigint();
  const measured = Math.min(ticks, 2000);
  const ticksPerSec = measured / (Number(t1 - t0) / 1e9);
  // Continue the full run without measuring to exercise steady-state memory.
  const remaining = Math.max(0, ticks - 200 - measured);
  for (let done = 0; done < remaining; done += 5000) e.step(Math.min(5000, remaining - done));
  const assertT0 = process.hrtime.bigint();
  e.assertInvariants();
  const assertT1 = process.hrtime.bigint();
  return {
    requests, ticks,
    ticksPerSec: Math.round(ticksPerSec),
    simSeconds: (e.now / 1000).toFixed(1),
    invariantCheckMs: Number(assertT1 - assertT0) / 1e6,
    completed: e.metrics.completed,
    liveRequests: e.requests.length,
  };
}

const requests = Number(process.argv[2] ?? 2000);
const ticks = Number(process.argv[3] ?? 100000);

console.log('InferenceOS engine microbenchmark (JS simulator speed — NOT an LLM/hardware benchmark)');
const r = bench(requests, ticks);
console.log(`  requests=${r.requests} ticks=${r.ticks} (${r.simSeconds}s simulated)`);
console.log(`  measured: ${r.ticksPerSec.toLocaleString()} ticks/s (main loop, 20 ms simulated per tick)`);
console.log(`  invariant check: ${r.invariantCheckMs.toFixed(2)} ms (single pass at end of run)`);
console.log(`  completed=${r.completed} live-requests-tracked=${r.liveRequests}`);
console.log('  Reminder: this measures simulation throughput in JavaScript, nothing else.');
