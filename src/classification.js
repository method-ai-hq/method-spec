import { fail, safeData } from './semantics.js';
import { boundedJSON } from './model.js';

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

/** The classifier version a direct run uses when the configuration names none. */
export const typesafeModel = 'jev-1.13.0';

/**
 * Call Typesafe directly with the operator's own key. The endpoint is fixed, so the key cannot go to another host.
 * @param {string} apiKeyEnv
 * @returns {import('./api-types.js').ClassificationProvider}
 */
export function typesafeClassification(apiKeyEnv, secret = name => process.env[name]) {
  return {
    async resolve() { return { provider: 'typesafe', model: typesafeModel }; },
    async evaluate(request, signal) {
      const key = secret(apiKeyEnv);
      if (!key) fail(`Missing environment variable: ${apiKeyEnv}`, 'preflight');
      const response = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: request.model, state: request.inputs,
          questions: { classification: { type: 'choice', instructions: request.question, criteria: request.options } } }),
      });
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Typesafe HTTP ${response.status}`), { code: 'provider_error', status: response.status }); }
      const data = await boundedJSON(response, classificationByteLimit);
      const answer = data?.answers?.classification;
      return { choice: answer?.choice, probabilities: answer?.probabilities, confidence: answer?.confidence,
        provider: 'typesafe', model: data?.model, usage: data?.usage ?? null };
    },
  };
}

// A service that is briefly unavailable gets three attempts in all. A rejected request is not retried.
const attempts = 3;
const transient = error => error.code !== 'classification_daily_limit' && (error.status === 429 || error.status >= 500
  || ['classification_unavailable', 'classification_timeout'].includes(error.code) || error.name === 'TimeoutError');

/** One managed classification; candidate checks and acceptance remain in the runner. */
export async function executeClassification(execution, inputs, identity, provider, context) {
  const request = { request_id: crypto.randomUUID(), model: identity.model, question: execution.question, options: execution.options, inputs };
  if (new TextEncoder().encode(JSON.stringify(request)).length > Math.min(classificationByteLimit, context.maxRequestBytes)) fail('Classification input exceeds request limit', 'input_limit');
  for (let attempt = 1; ; attempt++) {
    try { return await classifyOnce(request, execution, identity, provider, context); }
    catch (error) {
      if (attempt >= attempts || context.signal.aborted || !transient(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt * (1 + Math.random() / 4)));
      context.guard();
    }
  }
}

async function classifyOnce(request, execution, identity, provider, context) {
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
