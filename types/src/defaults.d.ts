export function configuration(config?: {}): {
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
}>;
export const defaultStepLimits: Readonly<{
    timeout_ms: 600000;
    max_agent_turns: 32;
    max_model_requests: 32;
}>;
