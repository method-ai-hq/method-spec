import baseline from '../spec/method-2.schema.json' with { type: 'json' };
import Ajv from 'ajv';
import { validateMethod, fail } from './validate.js';
const validateBaseline = new Ajv({ strict: false, allErrors: true }).compile(baseline);
export function migrateMethod2(source, settings) {
  if (!validateBaseline(source)) fail('Input does not match the published Method 2 grammar');
  if (!settings?.model || !settings.timeout_ms || !settings.max_agent_turns || !settings.max_model_requests) fail('Migration requires model, timeout_ms, max_agent_turns, and max_model_requests');
  const method = structuredClone(source);
  const warnings = ['The operator configuration and selected agent determine the backend and tool access. Empty Method tool lists do not restrict a local coding agent\'s built-in or installed tools.', 'Initial persistent state must be supplied explicitly or have a default. Migration does not load legacy state files.'];
  method.format = 'method/3';
  for (const state of Object.values(method.state ?? {})) delete state.file;
  for (const step of Object.values(method.steps)) {
    step.purpose = step.name ?? step.do ?? step.ask;
    step.limits = { timeout_ms: settings.timeout_ms };
    const agent = prompt => ({ kind: 'agent', model: settings.model, prompt, tools: [] });
    if (step.do) step.do = agent(step.do);
    if (typeof step.check === 'string') step.check = agent(step.check);
    if (step.do?.kind === 'agent' || step.check?.kind === 'agent') {
      step.limits.max_agent_turns = settings.max_agent_turns;
      step.limits.max_model_requests = settings.max_model_requests;
    }
  }
  validateMethod(method);
  return { method, warnings };
}
