import { delta } from './comparison';
import type { Comparison, ComparisonMetrics, Experiment } from './comparison';
import { fingerprint } from './workload';

export const ASSUMPTIONS = [
  'SIMULATED: all time, throughput, GPU occupancy and communication values are synthetic; not a hardware benchmark.',
  'A single deterministic seed is descriptive evidence, not statistical significance or proof of isolated causality.',
  'Fixed 20 ms clock; batch service is rounded up to a clock boundary. No CUDA, model weights, networking or backend.',
  'Conservative full-context KV reservations; RECOMPUTE at batch boundaries, no swap; waiting-time aging every 2 s.',
  'Illustrative 32-layer, width-4096 FP16 communication model; two ring AllReduces per layer, no communication overlap.',
  'TP scaling compares one replica with 1/2/4/8 GPUs and identical KV capacity, not an equal hardware budget.',
  'Speculative acceptance is seeded at 0.76 per draft position; verification compute scales from 1x at one position to 1.65x at five.',
  'Summary throughput uses each strategy’s own elapsed time; time series use the trailing 1 s and shared clock.',
  'TTFT includes queue time; TPOT is token-weighted spacing and includes recompute delays after first output.',
  'GPU utilization is synthetic phase/batch occupancy; KV utilization includes retained cache; higher is not always better.',
  'Prefix labels synthesize token identity; only full matching chained blocks reuse KV. Cache is local to a replica.',
];
const f = (n: number) => n.toFixed(1);
export function explainMetric(run: Experiment, baseline: Experiment, metric: keyof ComparisonMetrics): string[] {
  const m = run.metrics, b = baseline.metrics, c = run.engine.collector, tp = run.engine.tpStats;
  const change = delta(m[metric], b[metric]);
  return [
    `${run.strategy.name} vs ${baseline.strategy.name}: ${metric} ${change === null ? 'has no defined percentage baseline' : `changed ${change >= 0 ? '+' : ''}${f(change)}%`}. These are observed simulation differences, not isolated causal estimates.`,
    `Initial plus preemption queue delay averaged ${f(m.queueTime)} ms (${f(m.queueTime - b.queueTime)} ms vs baseline), across ${c.admissions} admitted requests.`,
    `${m.cachedTokens} prompt tokens reused; ${c.hits}/${c.lookups} cache lookups hit. Reuse removes that many prefill positions from the scheduled work.`,
    `${run.engine.schedulerStats.mixedIterations} iterations mixed prefill and decode; ${run.engine.schedulerStats.prefillTokens} prefill positions and ${run.engine.schedulerStats.decodeTokens} decode/verification positions scheduled.`,
    `${m.accepted}/${m.drafted} draft positions accepted; rejected draft work still costs budget. ${run.engine.preemptionStats.count} preemptions rebuilt ${run.engine.preemptionStats.recomputedTokens} tokens.`,
    `Replica service: ${f(tp.computeMs)} ms compute + ${f(tp.communicationMs)} ms communication. Completed ${m.completed}/${run.trace.length}; rejected ${m.rejected}.`,
  ];
}
export function experimentReport(lab: Comparison, baselineId: string) {
  const baseline = lab.experiments.find(e => e.strategy.id === baselineId) ?? lab.experiments[0];
  lab.assertInvariants();
  return {
    schemaVersion: 2, version: '0.2.0', simulated: true, seed: lab.seed,
    status: lab.timedOut ? 'time-limit' : lab.done ? 'complete' : 'partial',
    baseline: baseline.strategy.id, workloadFingerprint: fingerprint(lab.trace),
    workload: lab.trace, assumptions: ASSUMPTIONS,
    config: lab.experiments.map(e => ({ id: e.strategy.id, ...e.engine.config })),
    experiments: lab.experiments.map(e => ({
      id: e.strategy.id, name: e.strategy.name, config: { ...e.engine.config }, metrics: e.metrics,
      delta: Object.fromEntries((Object.keys(e.metrics) as (keyof ComparisonMetrics)[]).map(key => [key, delta(e.metrics[key], baseline.metrics[key])])),
      finishedAt: e.finishedAt, received: structuredClone(e.received), samples: structuredClone(e.samples),
      schedulerStats: { ...e.engine.schedulerStats }, preemptionStats: { ...e.engine.preemptionStats },
      cacheStats: { lookups: e.engine.collector.lookups, hits: e.engine.collector.hits, reusedTokens: e.metrics.cachedTokens, evictions: e.metrics.evictions },
      tpStats: { ...e.engine.tpStats }, recentIterations: structuredClone(e.engine.iterations),
    })),
  };
}
export function markdownReport(report: ReturnType<typeof experimentReport>) {
  const lines = [
    '# InferenceOS Playground v0.2 Experiment', '',
    `SIMULATED · ${report.status} · seed ${report.seed} · trace ${report.workloadFingerprint} · baseline ${report.baseline}`, '',
    '| Strategy | TTFT ms | TPOT ms/tok | Output tok/s | Completed | Rejected |',
    '|---|---:|---:|---:|---:|---:|',
    ...report.experiments.map(e => `| ${e.name} | ${e.metrics.ttft?.toFixed(1) ?? 'n/a'} | ${e.metrics.tpot?.toFixed(1) ?? 'n/a'} | ${f(e.metrics.tokensPerSecond)} | ${e.metrics.completed} | ${e.metrics.rejected} |`),
    '', '## Assumptions', '', ...report.assumptions.map(a => `- ${a}`),
    '', 'The JSON companion contains the complete immutable workload, configuration, deltas, samples and subsystem statistics.',
  ];
  return lines.join('\n');
}
