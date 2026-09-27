// Trace adapters: convert third-party serving logs into the generic
// InferenceOS trace format (see trace.ts) without coupling the simulation
// core to any external schema.
//
// Pipeline target:
//   mini-vllm (or any server) -> serving log -> adapter -> generic trace
//   -> parseTrace -> traceToScenario -> deterministic experiment
//
// The repository ships a fully implemented OpenAI-compatible adapter and a
// DOCUMENTED mini-vllm adapter interface with an example converter. The
// mini-vllm log schema is intentionally not invented here — fill in the
// field map once the real format is known.

import type { RequestInput } from '../types.ts';

export interface GenericTraceRecord {
  timestamp_ms: number;
  prompt_tokens: number;
  output_tokens: number;
  priority?: number | string;
  prefix_group?: string;
  observed_ttft_ms?: number;
  observed_tpot_ms?: number;
  observed_e2e_ms?: number;
}

export interface AdapterResult {
  records: GenericTraceRecord[];
  problems: string[];
}

/** Shared normalization for adapter outputs (validates shape, keeps provenance). */
function collect(mapped: GenericTraceRecord[], problems: string[]): AdapterResult {
  return { records: mapped, problems };
}

export interface OpenAICompatibleRecord {
  /** Request creation time in epoch ms (or offset ms — relative timestamps work too). */
  created_ms?: number;
  created?: number; // OpenAI seconds field, if present
  prompt_tokens?: number;
  completion_tokens?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  priority?: string;
  /** Any grouping key worth caching together (e.g. system-prompt hash). */
  prefix_group?: string;
  observed_ttft_ms?: number;
  observed_tpot_ms?: number;
  observed_e2e_ms?: number;
}

/**
 * OpenAI-compatible request-log adapter. Maps the common fields of an
 * /v1/chat/completions access log onto the generic trace format. Epoch-second
 * `created` fields are converted to ms. Records without token counts are
 * reported as problems, not silently dropped.
 */
export function fromOpenAICompatible(logs: unknown[]): AdapterResult {
  const records: GenericTraceRecord[] = [];
  const problems: string[] = [];
  logs.forEach((raw, i) => {
    const where = `record ${i + 1}`;
    if (typeof raw !== 'object' || raw === null) { problems.push(`${where}: expected an object`); return; }
    const o = raw as OpenAICompatibleRecord;
    const createdMs = o.created_ms ?? (o.created !== undefined ? o.created * 1000 : undefined);
    const prompt = o.prompt_tokens ?? o.usage?.prompt_tokens;
    const completion = o.completion_tokens ?? o.usage?.completion_tokens;
    if (createdMs === undefined || !Number.isFinite(createdMs)) { problems.push(`${where}: missing created_ms/created`); return; }
    if (!Number.isInteger(prompt) || (prompt as number) < 1) { problems.push(`${where}: missing prompt_tokens`); return; }
    if (!Number.isInteger(completion) || (completion as number) < 1) { problems.push(`${where}: missing completion_tokens`); return; }
    records.push({
      timestamp_ms: createdMs,
      prompt_tokens: prompt as number,
      output_tokens: completion as number,
      ...(o.priority !== undefined ? { priority: o.priority } : {}),
      ...(o.prefix_group !== undefined ? { prefix_group: o.prefix_group } : {}),
      ...(o.observed_ttft_ms !== undefined ? { observed_ttft_ms: o.observed_ttft_ms } : {}),
      ...(o.observed_tpot_ms !== undefined ? { observed_tpot_ms: o.observed_tpot_ms } : {}),
      ...(o.observed_e2e_ms !== undefined ? { observed_e2e_ms: o.observed_e2e_ms } : {}),
    });
  });
  return collect(records, problems);
}

/**
 * mini-vllm adapter: DOCUMENTED INTERFACE, not a fabricated schema.
 *
 * To wire up real mini-vllm logs:
 *   1. Identify per-request fields: arrival time, prompt tokens, output
 *      tokens, and (optionally) priority / shared prefix / measured latencies.
 *   2. Fill in FIELD_MAP below with those field names.
 *   3. Call `convertMiniVllmLogs(logs)` — validation and error reporting are
 *      handled exactly like the other adapters.
 *
 * Until the real schema is supplied, this adapter throws on use rather than
 * guessing (no invented fields).
 */
export const MINI_VLLM_FIELD_MAP: Record<
  'timestamp_ms' | 'prompt_tokens' | 'output_tokens' | 'priority' | 'prefix_group',
  string | null
> = {
  timestamp_ms: null, // TODO: real mini-vllm arrival field
  prompt_tokens: null, // TODO
  output_tokens: null, // TODO
  priority: null, // optional
  prefix_group: null, // optional
};

export function convertMiniVllmLogs(_logs: unknown[]): AdapterResult {
  const required: (keyof typeof MINI_VLLM_FIELD_MAP)[] = ['timestamp_ms', 'prompt_tokens', 'output_tokens'];
  const missing = required.filter(k => MINI_VLLM_FIELD_MAP[k] === null);
  if (missing.length) {
    throw new Error(
      `mini-vllm adapter is not configured: fill MINI_VLLM_FIELD_MAP (missing: ${missing.join(', ')}) `
      + 'with the real mini-vllm log field names. See docs/experiments.md — schemas are not invented here.');
  }
  return { records: [], problems: [] };
}
