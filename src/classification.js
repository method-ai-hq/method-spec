import { fail, safeData } from './semantics.js';
import { boundedJSON } from './model.js';
import { withRetries, transientStatus } from './retry.js';

export const classificationByteLimit = 65_536;
const margin = 1e-6;
const isProbability = value => Number.isFinite(value) && value >= 0 && value <= 1;
/** The answer form of a classify step or request: named options, yes or no, or ordered levels. */
export function classificationForm(execution) {
  if (execution.answer === 'yes_no') return { answer: 'yes_no' };
  if (Array.isArray(execution.levels)) return { levels: execution.levels };
  return { options: execution.options };
}
const answerKeys = form => form.answer === 'yes_no' ? ['answer', 'probability'] : form.levels ? ['level', 'score', 'probabilities'] : ['choice', 'probabilities'];
/**
 * Shared response contract for hosted and embedded classification providers.
 * @param {any} answer
 * @param {{options?: Record<string, string>, answer?: 'yes_no', levels?: string[]}} execution the classify step or request
 * @param {{provider: string, model: string}} identity
 */
export function validateClassification(answer, execution, identity) {
  const invalid = detail => fail(`Invalid classification response: ${detail}`, 'invalid_classification_response');
  safeData(answer);
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) invalid('expected an object');
  const form = classificationForm(execution);
  const keys = [...answerKeys(form), 'provider', 'model', 'confidence', 'usage'];
  if (Object.keys(answer).length !== keys.length || keys.some(key => !Object.hasOwn(answer, key))) invalid('unexpected response fields');
  if (answer.provider !== identity.provider || answer.model !== identity.model) invalid('model does not match the saved version');
  const distribution = ids => {
    const p = answer.probabilities;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== ids.length ||
        ids.some(id => !Object.hasOwn(p, id) || !isProbability(p[id]))) invalid('expected one probability per option');
    if (Math.abs(ids.reduce((sum, id) => sum + p[id], 0) - 1) > margin) invalid('probabilities must sum to one');
    return p;
  };
  let output;
  if (form.answer === 'yes_no') {
    if (typeof answer.answer !== 'boolean' || !isProbability(answer.probability)) invalid('expected a yes or no answer and the probability of yes');
    if (answer.answer ? answer.probability + margin < 0.5 : answer.probability - margin > 0.5) invalid('answer does not match the probability of yes');
    output = { answer: answer.answer, probability: answer.probability };
  } else if (form.levels) {
    const p = distribution(form.levels);
    if (!form.levels.includes(answer.level)) invalid('unknown level');
    if (p[answer.level] + margin < Math.max(...form.levels.map(id => p[id]))) invalid('level is not a maximum');
    const expected = form.levels.reduce((sum, id, index) => sum + index * p[id], 0);
    if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > form.levels.length - 1 || Math.abs(answer.score - expected) > 1e-4)
      invalid('score must be the expected level index');
    output = { level: answer.level, score: answer.score, probabilities: p };
  } else {
    const ids = Object.keys(form.options ?? {}), p = distribution(ids);
    if (!Object.hasOwn(form.options, answer.choice)) invalid('unknown choice');
    if (p[answer.choice] + margin < Math.max(...ids.map(id => p[id]))) invalid('choice is not a maximum');
    output = { choice: answer.choice, probabilities: p };
  }
  if (answer.confidence !== null && !isProbability(answer.confidence)) invalid('invalid confidence');
  const usage = answer.usage, usageKeys = usage && typeof usage === 'object' ? Object.keys(usage) : [];
  if (usage !== null && (!usage || typeof usage !== 'object' || Array.isArray(usage)
      || !['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
      || usageKeys.some(key => !['input_tokens', 'output_tokens', 'cost'].includes(key))
      || (Object.hasOwn(usage, 'cost') && !(Number.isFinite(usage.cost) && usage.cost >= 0)))) invalid('invalid usage');
  return output;
}

/** The classifier version a direct run uses when the configuration names none. */
export const typesafeModel = 'jev-1.13.0';
/** OpenRouter names a pinned Jev release without its patch number: jev-1.13.0 is jev-1.13. */
export const jevModel = pin => pin.replace(/^(jev-\d+\.\d+)\.\d+$/, '$1');
export const jevEndpoint = 'https://openrouter.ai/api/v1/systemone';

/** The Jev request body for one classification request. */
export function jevRequest(request) {
  const form = classificationForm(request);
  const question = form.answer === 'yes_no' ? { type: 'noul', instructions: request.question }
    : form.levels ? { type: 'score', instructions: request.question, criteria: form.levels }
    : { type: 'choice', instructions: request.question, criteria: form.options };
  return { model: jevModel(request.model), state: request.inputs, questions: { classification: question } };
}

/** Convert a Jev response to the provider answer. Only an answer from the pinned release is accepted; it keeps the pinned name. */
export function jevAnswer(request, data) {
  const form = classificationForm(request), a = data?.answers?.classification ?? {};
  const served = typeof data?.model === 'string' ? data.model : '', release = `typesafe/${jevModel(request.model)}`;
  if (served !== release && !served.startsWith(`${release}-`)) fail('Invalid classification response: model does not match the saved version', 'invalid_classification_response');
  const model = request.model;
  const u = data?.usage;
  const usage = u && typeof u === 'object' ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens, ...(u.cost === undefined ? {} : { cost: u.cost }) } : null;
  const meta = { provider: 'typesafe', model, confidence: a.confidence ?? null, usage };
  // A noul answer is the probability of yes; Jev gives no confidence for it.
  if (form.answer === 'yes_no') return { answer: Number.isFinite(a.noul) ? a.noul >= 0.5 : null, probability: a.noul ?? null, ...meta };
  if (form.levels) {
    const p = scoreProbabilities(form.levels, a);
    const level = p ? form.levels.reduce((best, id) => p[id] > p[best] ? id : best, form.levels[0]) : undefined;
    const score = p ? form.levels.reduce((sum, id, index) => sum + index * p[id], 0) : undefined;
    return { level: level ?? null, score: score ?? null, probabilities: p ?? null, ...meta };
  }
  return { choice: a.choice ?? null, probabilities: a.probabilities ?? null, ...meta };
}
// Jev may key score probabilities by level name, by level index, or list them in level order.
function scoreProbabilities(levels, answer) {
  const p = answer.probabilities;
  if (Array.isArray(p) && p.length === levels.length) return Object.fromEntries(levels.map((id, i) => [id, p[i]]));
  if (!p || typeof p !== 'object') return undefined;
  if (levels.every(id => Object.hasOwn(p, id))) return Object.fromEntries(levels.map(id => [id, p[id]]));
  if (levels.every((_, i) => Object.hasOwn(p, String(i)))) return Object.fromEntries(levels.map((id, i) => [id, p[String(i)]]));
  return p;
}

/**
 * Call Jev through OpenRouter directly with the operator's own key. The endpoint is fixed, so the key cannot go to
 * another host.
 * @param {string} apiKeyEnv
 * @returns {import('./api-types.js').ClassificationProvider}
 */
export function typesafeClassification(apiKeyEnv, secret = name => process.env[name]) {
  return {
    async resolve() { return { provider: 'typesafe', model: typesafeModel }; },
    async evaluate(request, signal) {
      const key = secret(apiKeyEnv);
      if (!key) fail(`Missing environment variable: ${apiKeyEnv}`, 'preflight');
      const response = await fetch(jevEndpoint, {
        method: 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(jevRequest(request)),
      });
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`OpenRouter HTTP ${response.status}`), { code: 'provider_error', status: response.status }); }
      return jevAnswer(request, await boundedJSON(response, classificationByteLimit));
    },
  };
}

const transient = error => error.code !== 'classification_daily_limit' && (transientStatus(error.status)
  || ['classification_unavailable', 'classification_timeout'].includes(error.code) || error.name === 'TimeoutError');

/** One managed classification; candidate checks and acceptance remain in the runner. */
export async function executeClassification(execution, inputs, identity, provider, context) {
  const request = { request_id: crypto.randomUUID(), model: identity.model, question: execution.question, ...classificationForm(execution), inputs };
  if (new TextEncoder().encode(JSON.stringify(request)).length > Math.min(classificationByteLimit, context.maxRequestBytes)) fail('Classification input exceeds request limit', 'input_limit');
  return withRetries(() => classifyOnce(request, execution, identity, provider, context),
    { transient, signal: context.signal, canRetry: () => context.canRequest?.() ?? true, beforeRetry: () => context.guard() });
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
    const output = validateClassification(answer, execution, identity);
    context.usage(answer.usage);
    context.cost(answer.usage?.cost);
    await context.record('model.response', {...metadata, confidence: answer.confidence, usage: answer.usage,
      duration_ms: performance.now() - started});
    return output;
  } catch (error) {
    await context.record('model.error', {...metadata, code: error.code ?? 'provider_error', usage_may_be_unknown: true});
    throw error;
  }
}
