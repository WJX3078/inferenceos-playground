// Real workload trace import.
//
// A trace replays the SHAPE of a real serving workload (arrival times, prompt
// / output lengths, priority classes, optional prefix groups) through the
// deterministic simulator. Traces may optionally carry real observations
// (observed_ttft_ms / observed_tpot_ms / observed_e2e_ms); those are stored
// for SIDE-BY-SIDE REFERENCE ONLY — the simulator is not a calibrated
// hardware predictor, and no "prediction accuracy" is computed anywhere.
//
// Supported container formats: JSONL (one request object per line) and JSON
// (a single array). See trace-adapters/ for source-specific mappings.

import type { RequestInput } from './types.ts';
import type { TraceRequest } from './workload.ts';

export const TRACE_SCHEMA_VERSION = 1;

export interface ObservedMetrics { ttftMs?: number; tpotMs?: number; e2eMs?: number }

export interface NormalizedTraceRequest extends TraceRequest {
  observed?: ObservedMetrics;
  line: number; // 1-based source line for error reporting
}

export interface TraceParseResult {
  requests: NormalizedTraceRequest[];
  format: 'jsonl' | 'json';
  schemaVersion: number;
  warnings: string[];
}

export class TraceParseError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid trace:\n${problems.join('\n')}`);
    this.name = 'TraceParseError';
    this.problems = problems;
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const PRIORITY_NAMES = ['low', 'normal', 'high'] as const;

/** Validate and normalize one raw request object. Returns problems instead of throwing. */
function normalizeRequest(raw: unknown, line: number): { request?: NormalizedTraceRequest; problems: string[] } {
  const problems: string[] = [];
  const where = `line ${line}`;
  if (typeof raw !== 'object' || raw === null) return { problems: [`${where}: expected an object`] };
  const o = raw as Record<string, unknown>;

  const timestamp = num(o.timestamp_ms);
  if (timestamp === null || timestamp < 0) problems.push(`${where}: timestamp_ms must be a non-negative number`);
  const prompt = num(o.prompt_tokens);
  if (prompt === null || prompt < 1 || !Number.isInteger(prompt)) problems.push(`${where}: prompt_tokens must be a positive integer`);
  const output = num(o.output_tokens);
  if (output === null || output < 1 || !Number.isInteger(output)) problems.push(`${where}: output_tokens must be a positive integer`);
  if (problems.length) return { problems };

  let priority: RequestInput['priority'] = undefined;
  if (o.priority !== undefined) {
    const p = num(o.priority);
    if (p !== null && [0, 1, 2].includes(p)) {
      priority = PRIORITY_NAMES[p];
    } else if (typeof o.priority === 'string' && (PRIORITY_NAMES as readonly string[]).includes(o.priority)) {
      priority = o.priority as RequestInput['priority'];
    } else {
      problems.push(`${where}: priority must be 0|1|2 or "low"|"normal"|"high"`);
    }
  }

  const observed: ObservedMetrics = {};
  const ttft = num(o.observed_ttft_ms);
  const tpot = num(o.observed_tpot_ms);
  const e2e = num(o.observed_e2e_ms);
  if (ttft !== null) observed.ttftMs = ttft;
  if (tpot !== null) observed.tpotMs = tpot;
  if (e2e !== null) observed.e2eMs = e2e;

  const request: NormalizedTraceRequest = {
    atMs: timestamp!,
    line,
    input: {
      promptTokens: prompt!,
      outputTokens: output!,
      prefix: typeof o.prefix_group === 'string' && o.prefix_group ? o.prefix_group : 'none',
      ...(priority ? { priority } : {}),
    },
    ...(Object.keys(observed).length ? { observed } : {}),
  };
  return { request, problems };
}

/**
 * Parse a trace in JSONL or JSON form. Throws TraceParseError listing every
 * problem found (with line numbers) rather than failing on the first one.
 */
export function parseTrace(text: string): TraceParseResult {
  const trimmed = text.trim();
  if (!trimmed) throw new TraceParseError(['trace is empty']);
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines = trimmed.split(/\r?\n/);
  const isJsonl = !trimmed.startsWith('[');
  const requests: NormalizedTraceRequest[] = [];

  if (isJsonl) {
    lines.forEach((raw, idx) => {
      const line = idx + 1;
      if (!raw.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        problems.push(`line ${line}: invalid JSON`);
        return;
      }
      const { request, problems: p } = normalizeRequest(parsed, line);
      problems.push(...p);
      if (request) requests.push(request);
    });
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new TraceParseError(['invalid JSON array']);
    }
    if (!Array.isArray(parsed)) throw new TraceParseError(['JSON trace must be an array of request objects']);
    parsed.forEach((raw, idx) => {
      const { request, problems: p } = normalizeRequest(raw, idx + 1);
      problems.push(...p);
      if (request) requests.push(request);
    });
  }

  if (!requests.length && !problems.length) problems.push('trace contains no requests');
  if (problems.length) throw new TraceParseError(problems);

  requests.sort((a, b) => a.atMs - b.atMs || a.line - b.line);
  const negativeGap = requests.some((r, i) => i > 0 && r.atMs < requests[i - 1].atMs);
  void negativeGap;
  return { requests, format: isJsonl ? 'jsonl' : 'json', schemaVersion: TRACE_SCHEMA_VERSION, warnings };
}

/** Build a v1 scenario file from a parsed trace (traffic = trace replay). */
export function traceToScenario(parsed: TraceParseResult, overrides?: {
  name?: string; seed?: number; config?: Record<string, unknown>; maxSimMs?: number;
}): import('./experiment.ts').ScenarioFile {
  const last = parsed.requests.length ? parsed.requests[parsed.requests.length - 1].atMs : 0;
  // Add headroom for the last request to finish (default cost model: ~64 tokens/s worst case).
  const longest = Math.max(...parsed.requests.map(r => r.input.outputTokens), 1);
  const defaultMax = last + longest * 40 + 20000;
  return {
    version: 1,
    name: overrides?.name ?? 'imported-trace',
    seed: overrides?.seed ?? 73,
    config: overrides?.config ?? {},
    traffic: {
      enabled: true,
      arrival: 'trace',
      requests: parsed.requests.map(r => ({ atMs: r.atMs, input: r.input, ...(r.observed ? { observed: r.observed } : {}) })),
    },
    maxSimMs: overrides?.maxSimMs ?? defaultMax,
    notes: `Imported ${parsed.format} trace, schema v${parsed.schemaVersion}, ${parsed.requests.length} requests. Observed metrics in the source are reference-only.`,
  };
}
