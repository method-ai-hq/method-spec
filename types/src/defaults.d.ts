/**
 * The effective configuration. A method/3.4 document's own limits, limits.step, and tools come before the host's
 * configuration: they are part of the Method.
 */
export function configuration(config?: {}, method?: {}): {
    tools?: any;
    limits: any;
    step_defaults: any;
    models: any;
};
/** Operator defaults. Explicit profile and step limits override these finite bounds. */
export const defaultLimits: Readonly<{
    timeout_ms: 3600000;
    max_model_requests: 100;
    max_invocations: 100;
    max_tool_calls: 200;
    max_output_bytes: 16777216;
    max_request_bytes: 16777216;
    effect_wait_ms: 300000;
    max_concurrency: 8;
}>;
export const defaultStepLimits: Readonly<{
    timeout_ms: 600000;
    max_agent_turns: 32;
    max_model_requests: 32;
}>;
