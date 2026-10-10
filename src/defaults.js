/** Operator defaults. Explicit profile and step limits override these finite bounds. */
export const defaultLimits = Object.freeze({ timeout_ms: 3600000, max_model_requests: 100, max_invocations: 100,
  max_tool_calls: 200, max_output_bytes: 16777216, max_request_bytes: 16777216, effect_wait_ms: 300000, max_concurrency: 8 });
export const defaultStepLimits = Object.freeze({ timeout_ms: 600000, max_agent_turns: 32, max_model_requests: 32 });
/**
 * The effective configuration. A method/3.4 document's own limits, limits.step, and tools come before the host's
 * configuration: they are part of the Method.
 */
export function configuration(config = {}, method = {}) {
  const { step, ...runLimits } = method.limits ?? {};
  return { ...config, limits: { ...defaultLimits, ...config.limits, ...runLimits },
    step_defaults: { ...defaultStepLimits, ...config.step_defaults, ...step },
    models: { ...config.models },
    ...(config.tools || method.tools ? { tools: { ...config.tools, ...method.tools } } : {}) };
}
