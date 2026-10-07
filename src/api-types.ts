/** Public runtime API. These types describe operator settings, not Method YAML. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Shape = 'text' | 'number' | 'boolean' | 'record' | 'list' | 'file' | {type: Exclude<Shape, object>; description?: string; fields?: Record<string, Shape>; items?: Shape; format?: string};
export type Script = {kind: 'run'; runtime: string; entrypoint: string; args?: string[]};
export type ModelProfile = {backend: 'codex' | 'claude'; command?: string; model?: string; reasoning_effort?: string} | {backend: 'openai-responses'; model: string; api_key_env: string; max_output_tokens: number; reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'};
export interface ClassificationProvider {
  resolve(signal: AbortSignal): Promise<{provider: 'typesafe'; model: string}>;
  evaluate(request: {request_id: string; model: string; question: string; options: Record<string, string>; inputs: Record<string, Json>}, signal: AbortSignal): Promise<{
    choice: string; probabilities: Record<string, number>; provider: 'typesafe'; model: string;
    confidence: number; usage: {input_tokens: number; output_tokens: number} | null;
  }>;
}
export interface RuntimeConfig {
  classification?: {provider: 'typesafe'; model: string};
  allow_local_processes?: boolean;
  limits?: {timeout_ms?: number; max_model_requests?: number; max_invocations?: number; max_tool_calls?: number; max_output_bytes?: number; max_request_bytes?: number};
  step_defaults?: {timeout_ms?: number; max_agent_turns?: number; max_model_requests?: number};
  runtimes?: Record<string, {command: string; version: string; args?: string[]; env?: string[]}>;
  models?: Record<string, ModelProfile>;
  tools?: Record<string, {description: string; in: Record<string, Shape>; out: Record<string, Shape>; run: Script; effects: string[]} | {description:string; connection:string; tool:string; parameters:Record<string,any>; effects:string[]}>;
  environment?: Record<string, string>;
}
export interface RunOptions {
  classification?: ClassificationProvider;
  deviceName?: string;
  connections?: Record<string, {call: (name:string, args:any, signal:AbortSignal) => Promise<any>}>;
  inputs?: Record<string, Json> | undefined; state?: Record<string, Json> | undefined;
  runDir?: string | undefined; resume?: boolean | undefined; retry?: string[] | undefined;
  /** Parent run directory for a new run that reuses accepted steps. Requires reuse. */
  fromRun?: string | undefined;
  /** Steps whose accepted outputs a fork takes from the parent run. Their upstream steps must be listed too. */
  reuse?: string[] | undefined;
  human?: {steps: Record<string, {outputs: Record<string, Json>}>} | undefined;
  agent?: 'codex' | 'claude' | undefined;
  signal?: AbortSignal | undefined; sourceRoot?: string | undefined; processPath?: string | undefined;
  prepareBundle?: ((directory: string) => void | Promise<void>) | undefined;
  onEvent?: ((event: Record<string, any>) => void | Promise<void>) | undefined;
  onStart?: ((context: {method: any; inputs: Record<string, Json>; state: Record<string, Json>; runDir: string}) => void | Promise<void>) | undefined;
  /** Replay a recorded case: unchanged steps return recorded outputs and effects are judged on recorded observations. */
  replay?: {recording: any; observations?: Record<string, any[]>; artifacts?: string | undefined} | undefined;
  /** Test/provider adapter for Responses requests. */
  transport?: ((...args: any[]) => Promise<any>) | undefined;
}
export interface ForkProvenance {run_dir: string; execution_id: string; executor_version: string; method_sha256: string; steps: Array<{step: string; skipped?: true; iterations?: number; outputs_sha256?: string}>; changed_files: Array<{file: string; change: 'added' | 'removed' | 'changed'}>; file_evidence: 'bundle' | 'entrypoints'}
export interface RunSummary {run_dir: string; started_at: string; device_name: string; elapsed_ms: number; invocations: number; model_requests: number; tool_calls: number; usage: Record<string, Json>; forked_from?: ForkProvenance}
export type EffectVerdict = 'pending' | 'confirmed' | 'unrefuted' | 'contradicted' | 'unknown' | 'not_replayed';
export interface EffectSummary {
  total: number; confirmed: number; unrefuted: number; contradicted: number; unknown: number; pending: number; next_observation_at: string | null;
  effects: Array<{effect: string; verdict: EffectVerdict; final: boolean; reason: string; observed_at?: string; next_observation_at: string | null; horizon_at: string; action_outcome: 'ok' | 'indeterminate'}>;
}
/** completed: every step was accepted and no effect is contradicted or unconfirmed (effects.pending can be above zero).
 * unconfirmed: every step was accepted, but an observer could not confirm an external change by its horizon. */
export type RunResult = RunSummary & {effects?: EffectSummary} & ({status: 'completed'; result: Json} | {status: 'unconfirmed'; result: Json; code: string; error: string; recovery: string} | {status: 'failed' | 'needs_input'; code: string; error: string; recovery: string});
