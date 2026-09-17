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
};
export interface RuntimeConfig {
    allow_local_processes?: boolean;
    limits?: {
        timeout_ms?: number;
        max_model_requests?: number;
        max_invocations?: number;
        max_tool_calls?: number;
        max_output_bytes?: number;
        max_request_bytes?: number;
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
        env?: string[];
    }>;
    models?: Record<string, ModelProfile>;
    tools?: Record<string, {
        description: string;
        in: Record<string, Shape>;
        out: Record<string, Shape>;
        run: Script;
        effects: string[];
    }>;
    environment?: Record<string, string>;
}
export interface RunOptions {
    inputs?: Record<string, Json> | undefined;
    state?: Record<string, Json> | undefined;
    runDir?: string | undefined;
    resume?: boolean | undefined;
    retry?: string[] | undefined;
    human?: {
        steps: Record<string, {
            outputs: Record<string, Json>;
        }>;
    } | undefined;
    agent?: 'codex' | 'claude' | undefined;
    preference?: 'codex' | 'claude' | undefined;
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
    /** Test/provider adapter for Responses requests. */
    transport?: ((...args: any[]) => Promise<any>) | undefined;
}
export interface RunSummary {
    run_dir: string;
    elapsed_ms: number;
    invocations: number;
    model_requests: number;
    tool_calls: number;
    usage: Record<string, Json>;
}
export type RunResult = RunSummary & ({
    status: 'completed';
    result: Json;
} | {
    status: 'failed' | 'needs_input';
    code: string;
    error: string;
    recovery: string;
});
