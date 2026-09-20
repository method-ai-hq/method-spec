import { fail, safeData } from './semantics.js';

export const classificationByteLimit = 65_536;
/** Shared response contract for hosted and embedded classification providers. */
export function validateClassification(answer, options, identity) {
  const invalid = detail => fail(`Invalid classification response: ${detail}`, 'invalid_classification_response');
  safeData(answer);
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) invalid('expected an object');
  const keys = ['choice', 'probabilities', 'provider', 'model', 'confidence', 'usage'];
  if (Object.keys(answer).length !== keys.length || keys.some(key => !Object.hasOwn(answer, key))) invalid('unexpected response fields');
  if (answer.provider !== identity.provider || answer.model !== identity.model) invalid('model does not match the saved version');
  const ids = Object.keys(options), p = answer.probabilities;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== ids.length ||
      ids.some(id => !Object.hasOwn(p, id) || !Number.isFinite(p[id]) || p[id] < 0 || p[id] > 1)) invalid('expected one probability per option');
  if (!Object.hasOwn(options, answer.choice)) invalid('unknown choice');
  if (Math.abs(ids.reduce((sum, id) => sum + p[id], 0) - 1) > 1e-6) invalid('probabilities must sum to one');
  if (p[answer.choice] + 1e-6 < Math.max(...ids.map(id => p[id]))) invalid('choice is not a maximum');
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) invalid('invalid confidence');
  if (answer.usage !== null && (!answer.usage || Object.keys(answer.usage).length !== 2 ||
      !['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(answer.usage[key]) && answer.usage[key] >= 0))) invalid('invalid usage');
  return { choice: answer.choice, probabilities: answer.probabilities };
}

/** One managed request; candidate checks and acceptance remain in the runner. */
export async function executeClassification(execution, inputs, identity, provider, context) {
  const request = { request_id: crypto.randomUUID(), model: identity.model, question: execution.question, options: execution.options, inputs };
  if (new TextEncoder().encode(JSON.stringify(request)).length > Math.min(classificationByteLimit, context.maxRequestBytes)) fail('Classification input exceeds request limit', 'input_limit');
  context.reserveRequest();
  const metadata = {kind: 'classify', request_id: request.request_id, provider: identity.provider, model: identity.model};
  await context.record('model.request', metadata);
  const started = performance.now();
  try {
    const answer = await new Promise((resolve, reject) => {
      const abort = () => reject(context.signal.reason);
      context.signal.addEventListener('abort', abort, {once: true});
      if (context.signal.aborted) { context.signal.removeEventListener('abort', abort); abort(); return; }
      Promise.resolve().then(() => provider.evaluate(request, context.signal)).then(resolve, reject)
        .finally(() => context.signal.removeEventListener('abort', abort));
    });
    context.guard();
    safeData(answer);
    if (new TextEncoder().encode(JSON.stringify(answer)).length > Math.min(classificationByteLimit, context.maxOutputBytes)) fail('Classification output exceeds limit', 'output_limit');
    const output = validateClassification(answer, execution.options, identity);
    context.usage(answer.usage);
    await context.record('model.response', {...metadata, confidence: answer.confidence, usage: answer.usage,
      duration_ms: performance.now() - started});
    return output;
  } catch (error) {
    await context.record('model.error', {...metadata, code: error.code ?? 'provider_error', usage_may_be_unknown: true});
    throw error;
  }
}
