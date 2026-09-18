import { expect, test as base, type Page } from '@playwright/test';
import type { SimulationEngine } from '../src/simulation/engine';
import type { experimentReport } from '../src/simulation/report';

type ExperimentReport = ReturnType<typeof experimentReport>;
type RuntimeTrace = Pick<SimulationEngine,
  'config' | 'metrics' | 'requests' | 'events' | 'iterations' | 'schedulerStats' | 'tpStats' | 'preemptionStats'
> & { schemaVersion: number; simulatedMs: number };

const strategyIds = ['static', 'continuous', 'prefix', 'spec'];
const metricKeys = ['ttft', 'tpot', 'tokensPerSecond', 'requestsPerSecond', 'gpuUtilization',
  'kvUtilization', 'prefixHitRate', 'queueTime', 'completed'] as const;

const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.stack ?? error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });
    await use(errors);
    expect(errors, 'Every v0.2 journey must finish without console errors or uncaught exceptions').toEqual([]);
  }, { auto: true }],
});

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-17T00:00:00Z') });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'InferenceOS' })).toBeVisible();
  await page.clock.pauseAt(new Date('2026-09-17T01:00:00Z'));
  await page.getByRole('button', { name: 'Pause simulation', exact: true }).click();
});

async function downloadText(page: Page, button: string, filename: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function exportReport(page: Page): Promise<ExperimentReport> {
  return JSON.parse(await downloadText(page, 'Export Experiment Report', 'inferenceos-experiment.json'));
}

async function exportTrace(page: Page): Promise<RuntimeTrace> {
  return JSON.parse(await downloadText(page, 'Export trace', 'inferenceos-trace.json'));
}

async function generateWorkload(page: Page, options: { count?: number; prompt?: number; output?: number; interval?: number } = {}) {
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByLabel('Request count', { exact: true }).fill(String(options.count ?? 12));
  await page.getByLabel('Workload seed', { exact: true }).fill('2026');
  await page.getByLabel('Arrival pattern', { exact: true }).selectOption('uniform');
  await page.getByLabel('Arrival interval', { exact: true }).fill(String(options.interval ?? 40));
  for (const [kind, value] of [['prompt', options.prompt ?? 64], ['output', options.output ?? 8]] as const) {
    await page.getByLabel(`${kind} distribution`, { exact: true }).selectOption('fixed');
    await page.getByLabel(`${kind} min`, { exact: true }).fill(String(value));
    await page.getByLabel(`${kind} max`, { exact: true }).fill(String(value));
  }
  // Use native range keyboard controls; zero long-context ratio keeps these journeys small.
  await page.getByRole('slider', { name: 'Long-context ratio', exact: true }).press('Home');
  await page.getByRole('slider', { name: 'Prefix reuse ratio', exact: true }).press('End');
  await expect(page.getByRole('slider', { name: 'Long-context ratio', exact: true })).toHaveValue('0');
  await expect(page.getByRole('slider', { name: 'Prefix reuse ratio', exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Generate workload', exact: true }).click();
  await expect(page.getByTestId('comparison-status')).toHaveText(/^READY/);
  await expect(page.locator('.trace-identity')).toContainText(`${options.count ?? 12} requests`);
  await expect(page.locator('.trace-identity')).toContainText('seed 2026');
}

async function runComparison(page: Page) {
  await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
  await expect(page.getByTestId('comparison-status')).toHaveText(/^RUNNING/);
  // runFor fires every 100 ms comparison timer; fastForward would fire it only once.
  for (let frame = 0; frame < 120; frame++) {
    await page.clock.runFor(100);
    if ((await page.getByTestId('comparison-status').innerText()).startsWith('COMPLETE')) break;
  }
  await expect(page.getByTestId('comparison-status')).toHaveText(/^COMPLETE/);
  await expect(page.getByRole('button', { name: 'Run comparison', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export Experiment Report', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Markdown', exact: true })).toBeEnabled();
}

async function advanceRuntime(page: Page, milliseconds: number) {
  expect(milliseconds % 40, 'Runtime advances must align with its 40 ms display timer').toBe(0);
  await page.getByRole('button', { name: 'Resume simulation', exact: true }).click();
  await page.clock.runFor(milliseconds);
  await page.getByRole('button', { name: 'Pause simulation', exact: true }).click();
}

function requestRow(page: Page, id: string) {
  return page.locator('.request-table tbody tr').filter({
    has: page.getByRole('button', { name: id, exact: true }),
  });
}

function expectCompleteReplay(report: ExperimentReport, count: number) {
  expect(report).toMatchObject({ schemaVersion: 2, version: '0.2.0', simulated: true, status: 'complete', seed: 2026 });
  expect(report.workload).toHaveLength(count);
  expect(report.workloadFingerprint).toMatch(/^[0-9a-f]{8}$/);
  const received = report.workload.map(({ id, arrival, promptTokens, outputTokens, prefix, priority, tokenIds }) =>
    ({ id, arrival, promptTokens, outputTokens, prefix, priority, tokenIds }));
  const outputTokens = report.workload.reduce((sum, entry) => sum + entry.outputTokens, 0);
  for (const run of report.experiments) {
    expect(run.received, `${run.id} must replay every input field, not just the checksum`).toEqual(received);
    expect(run.metrics).toMatchObject({ completed: count, rejected: 0, cancelled: 0, active: 0, waiting: 0, outputTokens });
    expect(run.finishedAt).toBeGreaterThan(0);
    expect(run.metrics.duration).toBe(run.finishedAt);
    expect(run.metrics.tokensPerSecond).toBeCloseTo(outputTokens / (run.finishedAt! / 1000), 8);
    expect(run.metrics.requestsPerSecond).toBeCloseTo(count / (run.finishedAt! / 1000), 8);
    for (const value of Object.values(run.metrics)) {
      if (value !== null) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    expect(run.samples.length).toBeGreaterThan(1);
    expect(run.samples.map(sample => sample.at)).toEqual(report.experiments[0].samples.map(sample => sample.at));
    expect(run.schedulerStats.usedTokens).toBeGreaterThan(0);
    expect(run.tpStats.computeMs).toBeGreaterThan(0);
  }
}

async function expectMetricDeltas(page: Page, report: ExperimentReport) {
  const baseline = report.experiments.find(run => run.id === report.baseline)!;
  for (const run of report.experiments) {
    for (const key of metricKeys) {
      const value = run.metrics[key], reference = baseline.metrics[key];
      const change = value === null || reference === null || reference === 0 ? null : (value - reference) / reference * 100;
      if (change === null) expect(run.delta[key]).toBeNull();
      else expect(run.delta[key]).toBeCloseTo(change, 8);
      const cell = page.getByTestId(`metric-${run.id}-${key}`);
      if (value !== null) {
        expect(Number((await cell.getByRole('button').innerText()).replaceAll(',', ''))).toBeCloseTo(value, 0);
      }
      const label = run.id === baseline.id ? 'baseline' : change === null ? /n\/a$/ : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
      await expect(cell.locator('span')).toHaveText(label);
    }
  }
}

test('four strategies replay one frozen workload, rebase results, explain metrics and export JSON/Markdown', async ({ page }) => {
  await generateWorkload(page);
  const fingerprint = await page.locator('.trace-identity strong').innerText();
  await page.getByText('Inspect request trace', { exact: true }).click();
  const frozenPreview = await page.locator('.trace-preview > div').allTextContents();
  expect(frozenPreview).toHaveLength(12);
  await expect(page.getByRole('button', { name: 'Export Experiment Report', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Markdown', exact: true })).toBeDisabled();

  // Draft edits are intentionally not generated: the running trace and seed must stay frozen.
  await page.getByLabel('Request count', { exact: true }).fill('3');
  await page.getByLabel('Workload seed', { exact: true }).fill('99');
  await expect(page.locator('.trace-identity strong')).toHaveText(fingerprint);
  await expect(page.locator('.trace-identity')).toContainText('12 requests');
  expect(await page.locator('.trace-preview > div').allTextContents()).toEqual(frozenPreview);
  await runComparison(page);
  const original = await exportReport(page);
  expectCompleteReplay(original, 12);
  expect(original.workloadFingerprint).toBe(fingerprint);
  expect(original.baseline).toBe('static');
  expect(original.experiments.map(run => run.id)).toEqual(strategyIds);
  expect(original.workload.map(entry => entry.arrival)).toEqual(Array.from({ length: 12 }, (_, i) => i * 40));
  expect(original.workload.every(entry => entry.promptTokens === 64 && entry.outputTokens === 8)).toBe(true);
  expect(original.experiments.map(run => [
    run.config.continuousBatching, run.config.prefixCaching, run.config.speculativeDecoding,
  ])).toEqual([[false, false, false], [true, false, false], [true, true, false], [true, true, true]]);
  await expectMetricDeltas(page, original);
  for (const id of strategyIds) {
    await expect(page.getByTestId(`metric-${id}-completed`).getByRole('button')).toHaveText('12');
  }
  await expect(page.locator('.comparison-table thead th small')).toHaveText(Array(4).fill(/s to drain$/));
  for (const name of ['Queue depth', 'Output throughput', 'GPU utilization', 'KV utilization', 'Active requests']) {
    const chart = page.getByRole('img', { name: `${name}: overlaid strategies`, exact: true });
    await expect(chart).toBeVisible();
    await expect(chart.locator('polyline')).toHaveCount(4);
    for (const id of strategyIds) {
      await expect(chart.locator(`polyline[data-strategy="${id}"]`)).toHaveAttribute('points', /\S+\s+\S+/);
    }
  }

  await page.getByLabel('Comparison baseline', { exact: true }).selectOption('spec');
  const rebased = await exportReport(page);
  expect(rebased.baseline).toBe('spec');
  expect(rebased.workload).toEqual(original.workload);
  expect(rebased.experiments.map(run => run.metrics)).toEqual(original.experiments.map(run => run.metrics));
  await expectMetricDeltas(page, rebased);
  await page.getByRole('button', { name: 'Explain Static Throughput', exact: true }).click();
  const explanation = page.getByRole('region', { name: 'Explain why', exact: true });
  await expect(explanation).toContainText('Static vs + Spec');
  await expect(explanation).toContainText('Completed 12/12; rejected 0');
  await expect(explanation).toContainText('not isolated causal estimates');
  const explanationText = await explanation.innerText();
  await page.getByRole('button', { name: 'Explain Static Throughput', exact: true }).click();
  await expect(explanation).toHaveText(explanationText, { useInnerText: true });

  const markdown = await downloadText(page, 'Markdown', 'inferenceos-experiment.md');
  expect(markdown).toContain('# InferenceOS Playground v0.2 Experiment');
  expect(markdown).toContain(`trace ${fingerprint}`);
  expect(markdown).toContain('baseline spec');
  expect(markdown).toContain('seed 2026');
  for (const run of rebased.experiments) {
    expect(markdown).toContain(`| ${run.name} | ${run.metrics.ttft!.toFixed(1)} | ${run.metrics.tpot!.toFixed(1)} | ${run.metrics.tokensPerSecond.toFixed(1)} | 12 | 0 |`);
  }
  for (const assumption of rebased.assumptions) expect(markdown).toContain(assumption);

  await page.getByRole('button', { name: 'Reset comparison', exact: true }).click();
  await expect(page.getByTestId('comparison-status')).toHaveText(/^READY.*0\.0 s$/);
  await expect(page.locator('.trace-identity strong')).toHaveText(fingerprint);
  for (const id of strategyIds) {
    await expect(page.getByTestId(`metric-${id}-completed`).getByRole('button')).toHaveText('0');
  }
  await runComparison(page);
  expect(await exportReport(page), 'Reset must replay the generated seed, not the uncommitted builder edits').toEqual(rebased);
});

test('Beginner and Expert preserve paused runtime state, pending controls and comparison state', async ({ page }) => {
  await page.getByLabel('Scenario', { exact: true }).selectOption('chunked');
  await advanceRuntime(page, 120);
  await page.getByLabel('Token budget', { exact: true }).fill('127');
  await page.getByLabel('Prompt length', { exact: true }).fill('96');
  const runtime = await exportTrace(page);
  const time = await page.getByTestId('sim-time').innerText();
  const selectedRequest = await page.locator('.inspector .section-heading .mono').innerText();
  await page.getByRole('button', { name: 'Beginner', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Beginner', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.beginner-guide')).toBeVisible();
  for (const detail of [
    page.getByLabel('Token budget', { exact: true }),
    page.getByLabel('Request priority', { exact: true }),
    page.getByTestId('scheduler-inspector'),
    page.locator('.prefix-inspector'),
    page.locator('.tp-inspector'),
  ]) await expect(detail).toBeHidden();
  await expect(page.getByLabel('Prompt length', { exact: true })).toHaveValue('96');
  await expect(page.locator('.inspector .section-heading .mono')).toHaveText(selectedRequest);
  await page.clock.runFor(400);
  await expect(page.getByTestId('sim-time')).toHaveText(time);
  expect(await exportTrace(page)).toEqual(runtime);
  await page.getByRole('button', { name: 'Expert', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expert', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.beginner-guide')).toBeHidden();
  await expect(page.getByLabel('Token budget', { exact: true })).toHaveValue('127');
  await expect(page.getByRole('button', { name: 'Apply & restart', exact: true })).toBeEnabled();
  await expect(page.getByTestId('scheduler-inspector')).toBeVisible();
  await expect(page.locator('.prefix-inspector')).toBeVisible();
  await expect(page.locator('.tp-inspector')).toBeVisible();
  await expect(page.locator('.inspector .section-heading .mono')).toHaveText(selectedRequest);
  expect(await exportTrace(page)).toEqual(runtime);

  await generateWorkload(page, { output: 32 });
  await page.getByText('Inspect request trace', { exact: true }).click();
  const preview = await page.locator('.trace-preview > div').allTextContents();
  await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
  await page.clock.runFor(100);
  await page.getByRole('button', { name: 'Pause comparison', exact: true }).click();
  await page.getByLabel('Comparison baseline', { exact: true }).selectOption('continuous');
  const results = await page.locator('.comparison-table').innerText();
  const status = await page.getByTestId('comparison-status').innerText();
  const identity = await page.locator('.trace-identity').innerText();
  await page.getByRole('button', { name: 'Beginner', exact: true }).click();
  await expect(page.getByText('Inspect request trace', { exact: true })).toBeHidden();
  await expect(page.locator('.trace-preview')).toBeHidden();
  await page.clock.runFor(400);
  await expect(page.locator('.comparison-table')).toHaveText(results, { useInnerText: true });
  await expect(page.getByTestId('comparison-status')).toHaveText(status);
  await expect(page.locator('.trace-identity')).toHaveText(identity, { useInnerText: true });
  await expect(page.getByLabel('Comparison baseline', { exact: true })).toHaveValue('continuous');
  await page.getByRole('button', { name: 'Expert', exact: true }).click();
  await page.getByText('Inspect request trace', { exact: true }).click();
  expect(await page.locator('.trace-preview > div').allTextContents()).toEqual(preview);
  await expect(page.locator('.comparison-table')).toHaveText(results, { useInnerText: true });
  await expect(page.getByTestId('comparison-status')).toHaveText(status);
});

test('scheduler controls reach the engine and historical mixed iterations honor token and chunk budgets', async ({ page }) => {
  await page.getByLabel('Scenario', { exact: true }).selectOption('chunked');
  await page.getByLabel('Max batch size', { exact: true }).fill('2');
  await page.getByLabel('Token budget', { exact: true }).fill('33');
  await page.getByLabel('Prefill chunk limit', { exact: true }).fill('16');
  await page.getByRole('button', { name: 'Apply & restart', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply & restart', exact: true })).toBeDisabled();
  await expect(page.getByTestId('sim-time')).toHaveText('0.00 s');
  await expect(page.getByRole('button', { name: 'Stream traffic', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await advanceRuntime(page, 400);
  const trace = await exportTrace(page);
  expect(trace.config).toMatchObject({ gpuCount: 1, maxBatchSize: 2, maxNumSeqs: 2, maxNumBatchedTokens: 33, maxPrefillTokensPerStep: 16 });
  expect(trace.requests.map(request => [request.promptTokens, request.arrivedAt])).toEqual([[16, 0], [4096, 0], [2048, 60]]);
  expect(trace.schedulerStats.mixedIterations).toBeGreaterThan(0);
  for (const snapshot of trace.iterations) {
    expect(snapshot.budget).toBe(33);
    expect(snapshot.used + snapshot.remaining).toBe(33);
    expect(snapshot.used).toBe(snapshot.prefillTokens + snapshot.decodeTokens);
    expect(snapshot.slots).toBeLessThanOrEqual(2);
    expect(snapshot.scheduled.reduce((sum, allocation) => sum + allocation.tokens, 0)).toBe(snapshot.used);
    for (const allocation of snapshot.scheduled.filter(allocation => allocation.phase === 'prefill')) {
      expect(allocation.tokens).toBeGreaterThan(0);
      expect(allocation.tokens).toBeLessThanOrEqual(16);
    }
  }
  const mixed = trace.iterations.find(snapshot => snapshot.decodeTokens > 0 && snapshot.prefillTokens > 0);
  expect(mixed, 'At least one actual iteration must contain both phases').toBeDefined();
  await page.getByLabel('Scheduler iteration', { exact: true }).selectOption(`${mixed!.iteration}:${mixed!.group}`);
  const inspector = page.getByTestId('scheduler-inspector');
  await expect(inspector).toContainText('33 TOKEN BUDGET');
  await expect(inspector).toContainText(`ITERATION ${mixed!.iteration} / REPLICA ${mixed!.group}`);
  await expect(inspector.getByRole('img', { name: /tokens used$/ })).toHaveAttribute('aria-label', `${mixed!.used} of 33 tokens used`);
  await expect(inspector.locator('.budget-legend')).toContainText(`Decode ${mixed!.decodeTokens}`);
  await expect(inspector.locator('.budget-legend')).toContainText(`Prefill ${mixed!.prefillTokens}`);
  await expect(inspector.locator('.budget-legend')).toContainText(`Unused ${mixed!.remaining}`);
  for (const allocation of mixed!.scheduled) {
    const decision = inspector.locator('.decision-list > div').filter({ has: page.getByText(allocation.requestId, { exact: true }) });
    await expect(decision).toContainText(allocation.phase.toUpperCase());
    await expect(decision).toContainText(`${allocation.tokens} tok`);
  }
  await page.getByRole('button', { name: 'Step 20 milliseconds', exact: true }).click();
  await expect(inspector).toContainText(`ITERATION ${mixed!.iteration} / REPLICA ${mixed!.group}`);
  await page.getByLabel('Scheduler iteration', { exact: true }).selectOption('latest');
  await expect(inspector).not.toContainText(`ITERATION ${mixed!.iteration} / REPLICA ${mixed!.group}`);
});

test('prefix block selection shows chained hashes, cache hits, private suffixes and resets with the request', async ({ page }) => {
  await page.getByLabel('Scenario', { exact: true }).selectOption('shared-system');
  await advanceRuntime(page, 3200);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await requestRow(page, 'R003').getByRole('button', { name: 'R003', exact: true }).click();
  const prefix = page.locator('.prefix-inspector');
  await expect(prefix).toContainText('R003');
  await expect(prefix).toContainText('128 tokens reused');
  await expect(prefix.getByRole('button', { name: /^Prefix block \d+: HIT$/ })).toHaveCount(8);
  await expect(prefix.getByRole('button', { name: /^Prefix block \d+: MISS$/ })).toHaveCount(24);
  const request = (await exportTrace(page)).requests.find(entry => entry.id === 'R003')!;
  expect(request.cachedTokens).toBe(128);
  for (const index of [0, 1, 7, 8]) {
    const hit = index < 8;
    const block = request.prefixLookup[index];
    const button = prefix.getByRole('button', { name: `Prefix block ${index}: ${hit ? 'HIT' : 'MISS'}`, exact: true });
    await button.click();
    await expect(button).toHaveClass(/selected/);
    const detail = page.getByTestId('prefix-block-detail');
    await expect(detail).toContainText(`BLOCK ${index}`);
    await expect(detail).toContainText(hit ? 'HIT' : 'MISS');
    await expect(detail).toContainText(`parent ${index ? request.prefixChain[index - 1].hash : 'root'}`);
    await expect(detail).toContainText(`hash ${block.hash}`);
    await expect(detail).toContainText(`tokens [${index * 16}, ${(index + 1) * 16})`);
    await expect(detail).toContainText(hit ? `Reused physical page ${block.page} at admission` : 'Not reused at admission');
  }
  await requestRow(page, 'R001').getByRole('button', { name: 'R001', exact: true }).click();
  await expect(prefix).toContainText('R001');
  await expect(page.getByTestId('prefix-block-detail')).toContainText('BLOCK 0');
  await expect(page.getByTestId('prefix-block-detail')).toContainText('MISS');
  await expect(prefix.getByRole('button', { name: /^Prefix block \d+: HIT$/ })).toHaveCount(0);
});

test('TP scaling preserves inputs and exposes NVLink, PCIe and custom communication costs', async ({ page }) => {
  await generateWorkload(page, { count: 4, prompt: 64, output: 4, interval: 0 });
  await page.getByLabel('Experiment mode', { exact: true }).selectOption('tp');
  await expect(page.getByRole('heading', { name: 'Find the cost of another rank.', exact: true })).toBeVisible();
  await expect(page.getByLabel('Comparison baseline', { exact: true })).toHaveValue('tp1');
  await expect(page.getByLabel('Scaling bandwidth', { exact: true })).toBeHidden();
  const reports: ExperimentReport[] = [];
  for (const link of ['nvlink', 'pcie', 'custom']) {
    await page.getByLabel('Scaling interconnect', { exact: true }).selectOption(link);
    if (link === 'custom') {
      await page.getByLabel('Scaling bandwidth', { exact: true }).fill('16');
      await page.getByLabel('Scaling latency', { exact: true }).fill('100');
    }
    await expect(page.getByTestId('comparison-status')).toHaveText(/^READY.*0\.0 s$/);
    await runComparison(page);
    const report = await exportReport(page);
    expectCompleteReplay(report, 4);
    expect(report.experiments.map(run => run.id)).toEqual(['tp1', 'tp2', 'tp4', 'tp8']);
    if (reports.length) expect(report.workload).toEqual(reports[0].workload);
    for (const [index, run] of report.experiments.entries()) {
      const degree = 2 ** index;
      expect(run.config).toMatchObject({ gpuCount: degree, tensorParallel: degree, numBlocks: 512, interconnect: link });
      if (link === 'custom') expect(run.config).toMatchObject({ bandwidthGBps: 16, latencyUs: 100 });
      expect(run.tpStats.communicationMs).toBeGreaterThanOrEqual(0);
      if (degree === 1) {
        expect(run.tpStats.communicationMs).toBe(0);
        expect(run.tpStats.collectiveBytes).toBe(0);
      } else {
        expect(run.tpStats.communicationMs).toBeGreaterThan(0);
        expect(run.tpStats.collectiveBytes).toBeGreaterThan(0);
      }
      const summary = page.locator('.tp-summary > div').nth(index);
      await expect(summary).toContainText(`TP${degree}`);
      await expect(summary).toContainText('Compute');
      await expect(summary).toContainText('Communication');
    }
    reports.push(report);
  }
  for (const slower of reports.slice(1)) {
    expect(slower.experiments[0].metrics).toEqual(reports[0].experiments[0].metrics);
    expect(slower.experiments[3].tpStats.communicationMs).toBeGreaterThan(reports[0].experiments[3].tpStats.communicationMs);
    expect(slower.experiments[3].finishedAt!).toBeGreaterThan(reports[0].experiments[3].finishedAt!);
  }
  expect(reports[2].experiments[3].tpStats.communicationMs).toBeGreaterThan(reports[1].experiments[3].tpStats.communicationMs);
  await page.getByLabel('Scaling interconnect', { exact: true }).selectOption('nvlink');
  await expect(page.getByLabel('Scaling bandwidth', { exact: true })).toBeHidden();
  await expect(page.getByLabel('Scaling latency', { exact: true })).toBeHidden();
  await expect(page.getByTestId('comparison-status')).toHaveText(/^READY/);

  await page.getByRole('button', { name: 'Runtime', exact: true }).click();
  await page.getByLabel('Scenario', { exact: true }).selectOption('tp-bottleneck');
  await advanceRuntime(page, 160);
  await expect(page.locator('.tp-inspector')).toContainText('CUSTOM');
  await expect(page.locator('.tp-stage-group')).toHaveCount(1);
  await expect(page.locator('.tp-stage-row')).toHaveCount(8);
  await expect(page.locator('.tp-stage-row').first()).toContainText('ATTN');
  await expect(page.locator('.tp-stage-row').first()).toContainText('ALLREDUCE');
  await expect(page.locator('.tp-stage-row').first()).toContainText('MLP');
  const trace = await exportTrace(page);
  expect(trace.tpStats.communicationMs).toBeGreaterThan(0);
  expect(trace.tpStats.collectiveBytes).toBeGreaterThan(0);
  await expect(page.locator('.tp-inspector')).toContainText(`${trace.tpStats.communicationMs.toFixed(1)} ms`);
});

test('priority scheduling admits HIGH requests first and the priority comparison exports both policies', async ({ page }) => {
  await page.getByLabel('Scenario', { exact: true }).selectOption('priority');
  await page.getByRole('button', { name: 'Step 20 milliseconds', exact: true }).click();
  const trace = await exportTrace(page);
  expect(trace.config.schedulerPolicy).toBe('priority');
  expect(trace.requests.filter(request => request.status === 'prefill').map(request => request.id)).toEqual(['R001', 'R004']);
  expect(trace.iterations[0].scheduled.map(allocation => allocation.priority)).toEqual(['HIGH', 'HIGH']);
  await expect(requestRow(page, 'R002').locator('.phase-label')).toHaveText('waiting');
  await expect(requestRow(page, 'R004').locator('.phase-label')).toHaveText('prefill');
  await expect(page.getByTestId('scheduler-inspector').locator('.decision-list').first()).toContainText('HIGH');

  await generateWorkload(page, { count: 10, prompt: 32, output: 4 });
  await page.getByLabel('Experiment mode', { exact: true }).selectOption('priority');
  await expect(page.getByLabel('Comparison baseline', { exact: true })).toHaveValue('fcfs');
  await runComparison(page);
  const report = await exportReport(page);
  expectCompleteReplay(report, 10);
  expect(report.experiments.map(run => run.id)).toEqual(['fcfs', 'priority']);
  expect(report.experiments[0].config).toMatchObject({ schedulerPolicy: 'fcfs', preemption: false });
  expect(report.experiments[1].config).toMatchObject({ schedulerPolicy: 'priority', preemption: true });
  expect(new Set(report.workload.map(entry => entry.priority))).toEqual(new Set(['LOW', 'NORMAL', 'HIGH']));
  await expectMetricDeltas(page, report);
});

test('preemption releases LOW KV, exposes recompute and completes every output exactly once', async ({ page }) => {
  await page.getByLabel('Scenario', { exact: true }).selectOption('preemption');
  await expect(page.getByRole('button', { name: 'Recompute preemption', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await advanceRuntime(page, 400);
  const before = await exportTrace(page);
  expect(before.simulatedMs).toBe(400);
  expect(before.requests).toHaveLength(1);
  const emitted = before.requests[0].generated;
  expect(emitted).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Step 20 milliseconds', exact: true }).click();
  const preempted = await exportTrace(page);
  expect(preempted.preemptionStats.count).toBe(1);
  expect(preempted.requests[0]).toMatchObject({ id: 'R001', status: 'waiting', priority: 'LOW', recomputing: true,
    group: null, blockTable: [], generated: emitted, recomputeUntil: 128 + emitted });
  expect(preempted.requests[1]).toMatchObject({ id: 'R002', priority: 'HIGH', status: 'prefill', arrivedAt: 400 });
  await expect(requestRow(page, 'R001').locator('.phase-label')).toHaveText('preempted');
  await expect(page.locator('.inspector')).toContainText('LOW / 1');
  await expect(page.locator('.inspector')).toContainText('PREEMPTED');
  await expect(page.locator('.scheduler-log')).toContainText('PREEMPT');
  await expect(page.locator('.kv-block.highlighted')).toHaveCount(0);

  await advanceRuntime(page, 160);
  await expect(requestRow(page, 'R001').locator('.phase-label')).toHaveText('recompute');
  await expect(page.locator('.inspector')).toContainText('Recompute context');
  const recomputing = await exportTrace(page);
  expect(recomputing.requests[0]).toMatchObject({ status: 'prefill', recomputing: true, generated: emitted });
  expect(recomputing.requests[0].recomputedTokens).toBeGreaterThan(0);
  await advanceRuntime(page, 6400);
  const completed = await exportTrace(page);
  expect(completed.requests).toHaveLength(3);
  expect(completed.metrics).toMatchObject({ completed: 3, rejected: 0, cancelled: 0, active: 0, waiting: 0, outputTokens: 101 });
  for (const request of completed.requests) {
    expect(request.status).toBe('completed');
    expect(request.generated).toBe(request.outputTokens);
  }
  expect(completed.requests[0].recomputedTokens).toBeGreaterThanOrEqual(128 + emitted);
  expect(completed.preemptionStats.recomputedTokens).toBe(completed.requests.reduce((sum, request) => sum + request.recomputedTokens, 0));
  expect(completed.preemptionStats.overheadMs).toBeGreaterThan(0);
  await expect(page.getByTestId('timeline').locator('.timeline-span.preempted').first()).toBeVisible();
  await expect(page.getByTestId('timeline').locator('.timeline-span.recompute').first()).toBeVisible();
  await expect(page.locator('.pipeline')).toContainText('0 rejected / 0 cancelled');
});
