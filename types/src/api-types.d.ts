/** Public runtime API. These types describe operator settings, not Method YAML. */
export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type Shape = 'text' | 'number' | 'boolean' | 'record' | 'list' | 'file' | {
    type: Exclude<Shape, object>;
    description?: string;
    fields?: Record<string, Shape>;
    items?: Shape;
    format?: string;
};
export type Script = {
    kind: 'run';
    runtime: string;
    entrypoint: string;
    args?: string[];
};
export type ModelProfile = {
    backend: 'codex' | 'claude';
    command?: string;
    model?: string;
    reasoning_effort?: string;
} | {
    backend: 'openai-responses';
    model: string;
    api_key_env: string;
    max_output_tokens: number;
    reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
} | {
    backend: 'anthropic-messages';
    model: string;
    api_key_env: string;
    max_output_tokens: number;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
} | {
    backend: 'openrouter-chat';
    model: string;
    api_key_env: string;
    max_output_tokens: number;
    reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
} | {
    backend: 'method';
    model: string;
    max_output_tokens?: number;
};
/** Sends an openrouter-chat request through the signed-in Method account and returns the provider's response. */
export interface HostedModels {
    request(body: Record<string, any>, signal: AbortSignal): Promise<any>;
}
export interface ClassificationProvider {
    resolve(signal: AbortSignal): Promise<{
        provider: 'typesafe';
        model: string;
    }>;
    evaluate(request: {
        request_id: string;
        model: string;
        question: string;
        options: Record<string, string>;
        inputs: Record<string, Json>;
    }, signal: AbortSignal): Promise<{
        choice: string;
        probabilities: Record<string, number>;
        provider: 'typesafe';
        model: string;
        confidence: number;
        usage: {
            input_tokens: number;
            output_tokens: number;
        } | null;
    }>;
}
export interface RuntimeConfig {
    /** With api_key_env, classification calls Typesafe directly with that key. */
    classification?: {
        provider: 'typesafe';
        model: string;
        api_key_env?: string;
    };
    allow_local_processes?: boolean;
    limits?: {
        timeout_ms?: number;
        max_model_requests?: number;
        max_invocations?: number;
        max_tool_calls?: number;
        max_output_bytes?: number;
        max_request_bytes?: number;
        effect_wait_ms?: number;
        max_concurrency?: number;
    };
    step_defaults?: {
        timeout_ms?: number;
        max_agent_turns?: number;
        max_model_requests?: number;
    };
    runtimes?: Record<string, {
        command: string;
        version: string;
        args?: string[];
    }>;
    models?: Record<string, ModelProfile>;
    tools?: Record<string, {
        description: string;
        in: Record<string, Shape>;
        out: Record<string, Shape>;
        run: Script;
        effects: string[];
    } | {
        description: string;
        connection: string;
        tool: string;
        parameters: Record<string, any>;
        effects: string[];
    }>;
    environment?: Record<string, string>;
}
export interface RunOptions {
    classification?: ClassificationProvider;
    deviceName?: string;
    connections?: Record<string, {
        call: (name: string, args: any, signal: AbortSignal) => Promise<any>;
    }>;
    inputs?: Record<string, Json> | undefined;
    state?: Record<string, Json> | undefined;
    runDir?: string | undefined;
    resume?: boolean | undefined;
    retry?: string[] | undefined;
    /** Earlier run directories. An iteration whose definition, inputs, and executed files match one of their accepted iterations is reused. */
    cacheFrom?: string[] | undefined;
    /** true runs every step; a list names steps that run even when a match exists. */
    fresh?: boolean | string[] | undefined;
    /** Values of the Method's declared secrets. Without it, the process environment supplies them. */
    secrets?: Record<string, string> | undefined;
    /** The model that unconfigured call and agent steps use through hostedModels. */
    hostedModel?: string | undefined;
    hostedModels?: HostedModels | undefined;
    human?: {
        steps: Record<string, {
            outputs: Record<string, Json>;
        }>;
    } | undefined;
    agent?: 'codex' | 'claude' | undefined;
    signal?: AbortSignal | undefined;
    sourceRoot?: string | undefined;
    processPath?: string | undefined;
    prepareBundle?: ((directory: string) => void | Promise<void>) | undefined;
    onEvent?: ((event: Record<string, any>) => void | Promise<void>) | undefined;
    onStart?: ((context: {
        method: any;
        inputs: Record<string, Json>;
        state: Record<string, Json>;
        runDir: string;
    }) => void | Promise<void>) | undefined;
    /** Replay a recorded case: unchanged steps return recorded outputs and effects are judged on recorded observations. */
    replay?: {
        recording: any;
        observations?: Record<string, any[]>;
        artifacts?: string | undefined;
    } | undefined;
    /** Test/provider adapter for Responses requests. */
    transport?: ((...args: any[]) => Promise<any>) | undefined;
}
/** reused counts the iterations of each step that came from an earlier run. */
export interface RunSummary {
    run_dir: string;
    started_at: string;
    device_name: string;
    elapsed_ms: number;
    invocations: number;
    model_requests: number;
    tool_calls: number;
    usage: Record<string, Json>;
    reused?: Record<string, number>;
}
export type EffectVerdict = 'pending' | 'confirmed' | 'unrefuted' | 'contradicted' | 'unknown' | 'not_replayed';
export interface EffectSummary {
    total: number;
    confirmed: number;
    unrefuted: number;
    contradicted: number;
    unknown: number;
    pending: number;
    next_observation_at: string | null;
    effects: Array<{
        effect: string;
        verdict: EffectVerdict;
        final: boolean;
        reason: string;
        observed_at?: string;
        next_observation_at: string | null;
        horizon_at: string;
        action_outcome: 'ok' | 'indeterminate';
    }>;
}
/** completed: every step was accepted and no effect is contradicted or unconfirmed (effects.pending can be above zero).
 * unconfirmed: every step was accepted, but an observer could not confirm an external change by its horizon. */
export type RunResult = RunSummary & {
    effects?: EffectSummary;
} & ({
    status: 'completed';
    result: Json;
} | {
    status: 'unconfirmed';
    result: Json;
    code: string;
    error: string;
    recovery: string;
} | {
    status: 'failed' | 'needs_input';
    code: string;
    error: string;
    fix: string;
    recovery: string;
    failed_step?: string;
    iteration?: number;
    diagnostics?: string;
    missing?: string[];
});
