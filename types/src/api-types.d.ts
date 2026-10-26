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
    reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
};
/** Sends an openrouter-chat request through the signed-in Method account and returns the provider's response. */
export interface HostedModels {
    request(body: Record<string, any>, signal: AbortSignal): Promise<any>;
}
/** One classify step's answer form: named options, yes or no, or 2-10 ordered levels (lowest first). */
export type ClassificationForm = {
    options: Record<string, string>;
} | {
    answer: 'yes_no';
} | {
    levels: string[];
};
/** cost is in US dollars when the service reports it. */
export type ClassificationUsage = {
    input_tokens: number;
    output_tokens: number;
    cost?: number;
} | null;
type ClassificationMeta = {
    provider: 'typesafe';
    model: string;
    confidence: number | null;
    usage: ClassificationUsage;
};
/** choice: the most likely option. answer: true is yes. score: the expected level index (0 = first level). */
export type ClassificationAnswer = ClassificationMeta & ({
    choice: string;
    probabilities: Record<string, number>;
} | {
    answer: boolean;
    probability: number;
} | {
    level: string;
    score: number;
    probabilities: Record<string, number>;
});
export type ClassificationRequest = {
    request_id: string;
    model: string;
    question: string;
    inputs: Record<string, Json>;
} & ClassificationForm;
export interface ClassificationProvider {
    resolve(signal: AbortSignal): Promise<{
        provider: 'typesafe';
        model: string;
    }>;
    evaluate(request: ClassificationRequest, signal: AbortSignal): Promise<ClassificationAnswer>;
}
export interface RuntimeConfig {
    /** With api_key_env, classification calls Jev through OpenRouter (openrouter.ai) directly with that key, for example OPENROUTER_API_KEY. */
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
    /** Which repeat of the same work this run is (0 when omitted). Repeats are separate runs: a step is reused only from
     * an earlier run of the same repeat. */
    repeat?: number | undefined;
    /** true runs every step; a list names steps that run even when a match exists. */
    fresh?: boolean | string[] | undefined;
    /** Values of the Method's declared secrets. Without it, the process environment supplies them. */
    secrets?: Record<string, string> | undefined;
    /** The hosted model (account credit) for steps that name no model, used only when no local agent can run them. */
    hostedModel?: string | undefined;
    hostedModels?: HostedModels | undefined;
    human?: {
        steps: Record<string, {
            outputs: Record<string, Json>;
        }>;
    } | undefined;
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
    /** Replay a recorded case: unchanged steps return recorded outputs and effects are judged on recorded observations.
     * paths maps each scratch copy to the path that the recorded run saw, copies maps the other way; missing lists paths
     * that the case could not keep; live names steps that run even when they match; scratch is the attempt's own folder. */
    replay?: {
        recording: any;
        observations?: Record<string, any[]>;
        artifacts?: string | undefined;
        only?: string[] | undefined;
        paths?: Record<string, string> | undefined;
        copies?: Record<string, string> | undefined;
        missing?: string[] | undefined;
        live?: string[] | undefined;
        scratch?: string | undefined;
    } | undefined;
    /** Test/provider adapter for Responses requests. */
    transport?: ((...args: any[]) => Promise<any>) | undefined;
}
/** reused counts the iterations of each step that came from an earlier run. */
export interface RunSummary {
    run_dir: string;
    execution_id: string;
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
    status: 'completed' | 'unconfirmed';
    result: Json;
} | {
    status: 'failed' | 'needs_input';
    failure: Failure;
});
/** Whose problem a failure is. */
export type FailureOwner = 'method_code' | 'agent_work' | 'outside_service' | 'limit' | 'setup' | 'needs_you' | 'method_platform';
/**
 * The failure record of a stopped run, written once. headline and next.text never contain run content; evidence,
 * details and diagnostics may. iteration is 0-based; text says "task 1 of N". A run that cannot start rejects with an
 * error that carries the same record as `failure`.
 */
export interface Failure {
    owner: FailureOwner;
    code: string;
    headline: string;
    step: string | null;
    step_name: string | null;
    iteration: number | null;
    /** Every failed task of a parallel each step; [] otherwise. */
    failed_iterations: number[];
    total: number | null;
    phase: 'action' | 'check' | 'effect' | 'tool' | 'setup' | null;
    check_name: string | null;
    next: {
        action: 'fix_method' | 'run_again' | 'raise_limit' | 'fix_setup' | 'answer' | 'report_bug';
        text: string;
        command?: string;
    };
    evidence: string[];
    details: string;
    /** The last 20 stderr lines, only when a process failed. */
    diagnostics?: string;
}
/** One problem that a check found. message says what is wrong and fix says what to do, each in one sentence. */
export type Issue = {
    code: string;
    level: 'error' | 'warning' | 'note';
    step?: string;
    field?: string;
    file?: string;
    line?: number;
    message: string;
    fix: string;
    evidence?: {
        probability?: number;
        check?: string;
        run_id?: string;
    };
    /** The reason, when the step accepts this code. Errors are never accepted. */
    accepted?: string;
    /** untrusted_reaches_action: the values from the source to the step, as step.output references (or the connection, when one step reads and acts). */
    path?: string[];
    /** A change that fixes the issue. behavioral: the Method then runs differently (here, it asks you first). */
    patch?: {
        safety: 'behavioral';
        edits: Edit[];
    };
};
/** One change to a Method document; applyEdits applies a list of them. Paths are lists of keys from the root. */
export type Edit = {
    op: 'set';
    path: string[];
    value: unknown;
} | {
    op: 'remove';
    path: string[];
} | {
    op: 'insert_step';
    before: string;
    id: string;
    step: Record<string, unknown>;
};
/** A property that the code checks prove about a Method, in one plain sentence. */
export type Proof = {
    code: 'no_untrusted_action';
    statement: string;
};
export interface IssueOptions {
    /** Secret values to find by exact match (values shorter than 8 characters are skipped). A record names each secret in the message; the value never appears. */
    secretValues?: string[] | Record<string, string>;
    /** Files that will be uploaded with the Method, by package path, checked for secretValues. */
    files?: Record<string, string | Uint8Array>;
    /** Names of the secrets that have a value. Without it, missing secrets are not checked. */
    availableSecrets?: string[];
    /** run makes a missing secret an error; validate (the default) makes it a warning. */
    phase?: 'validate' | 'run';
    /** Operator tools, so that a tool with effects counts as one that changes things. Document tools come first. */
    tools?: RuntimeConfig['tools'];
    /** Issues from other checks (for example model checks); accepts apply to them too. */
    issues?: Issue[];
    /** Codes that were not checked this time; an accept of one of them gives no accept_unused note. */
    notChecked?: string[];
}
export {};
