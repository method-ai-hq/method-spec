/** Operator defaults. Explicit profile and step limits override these finite bounds. */
export const defaultLimits = Object.freeze({ timeout_ms: 3600000, max_model_requests: 100, max_invocations: 100,
  max_tool_calls: 200, max_output_bytes: 16777216, max_request_bytes: 16777216 });
export const defaultStepLimits = Object.freeze({ timeout_ms: 600000, max_agent_turns: 32, max_model_requests: 32 });
export function configuration(config = {}) {
  return { ...config, limits: { ...defaultLimits, ...config.limits },
    step_defaults: { ...defaultStepLimits, ...config.step_defaults },
    models: { ...config.models } };
}
