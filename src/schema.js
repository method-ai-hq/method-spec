const text = { type: 'string', minLength: 1, maxLength: 16000 };
const name = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80, not: { enum: ['constructor', 'prototype', '__proto__'] } };
const ref = { type: 'string', pattern: '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*|\\.[0-9]+)*$' };
const positive = { type: 'integer', minimum: 1, maximum: 2147483647 };
// How many items of an each step may run at once.
const width = { type: 'integer', minimum: 1, maximum: 32 };
const keyEnv = { type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$' };
// A secret name is an environment variable name. Names that the runtime sets for scripts are reserved.
const secretName = { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$', maxLength: 80, not: { anyOf: [{ enum: ['PATH', 'LANG', 'HOME'] }, { pattern: '^METHOD_' }] } };
export const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const map = (value) => ({ type: 'object', propertyNames: name, additionalProperties: value });
const list = (items) => ({ type: 'array', items, uniqueItems: true });
const path = { type: 'string', minLength: 1, maxLength: 500 };
const shapeProperties = {
  type: { enum: ['text', 'number', 'boolean', 'record', 'list', 'file'] },
  description: text, fields: map({ $ref: '#/$defs/shape' }), items: { $ref: '#/$defs/shape' }, format: text,
};
const run = object({ kind: { const: 'run' }, runtime: name, entrypoint: path, args: { type: 'array', items: { type: 'string' } } }, ['kind', 'runtime', 'entrypoint']);
// A model ID names a hosted model directly, for example openai/gpt-6-luna.
export const modelIdPattern = '^[a-z0-9-]+/[A-Za-z0-9._:-]+$';
const modelId = { type: 'string', pattern: modelIdPattern, maxLength: 200 };
// A step model is a name from models (or a configured profile), a model ID, or absent: the account default.
const stepModel = { anyOf: [name, modelId] };
const call = object({ kind: { const: 'call' }, model: stepModel, prompt: text }, ['kind', 'prompt']);
const agent = object({ kind: { const: 'agent' }, model: stepModel, prompt: text, tools: list(name), browser: ref }, ['kind', 'prompt']);
// What a models name means: a hosted model ID, or one with its output limit and reasoning effort.
const methodModel = { anyOf: [modelId, object({ model: modelId, max_output_tokens: positive, reasoning_effort: { enum: ['minimal', 'low', 'medium', 'high'] } }, ['model'])] };
// An accepted warning: the issue code and the reason the author accepts it on this step.
const accept = { type: 'object', propertyNames: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80 }, additionalProperties: text, minProperties: 1 };
// A classify step has one answer form: named options, yes or no, or 2–10 ordered levels (lowest first).
const classify = { ...object({ kind: { const: 'classify' }, question: text, options: { ...map(text), minProperties: 2, maxProperties: 255 },
  answer: { const: 'yes_no' }, levels: { type: 'array', items: name, minItems: 2, maxItems: 10, uniqueItems: true } }, ['kind', 'question']),
  oneOf: [{ required: ['options'] }, { required: ['answer'] }, { required: ['levels'] }] };
const duration = { type: 'string', pattern: '^(0|[1-9][0-9]{0,6})(s|m|h|d)$' };
const count = { type: 'integer', minimum: 0 };
// Built-in observers need no script and no fixtures; the runtime's own tests cover their judgment.
const fieldExpectation = { anyOf: [{ type: ['string', 'number', 'boolean', 'null'] }, object({ at_least: { type: 'number' }, at_most: { type: 'number' }, increases: { const: true } }, [])] };
const builtin = [
  object({ kind: { const: 'file' }, connection: name, path: text, expect: object({ exists: { type: 'boolean' }, contains: text, sha256: text }, []) }, ['kind', 'path']),
  object({ kind: { const: 'sqlite' }, connection: name, database: text, query: text, params: map({ type: ['string', 'number'] }), expect: object({ rows: count, min_rows: count, max_rows: count }, []) }, ['kind', 'database', 'query', 'expect']),
  object({ kind: { const: 'http' }, connection: name, path: text, method: { enum: ['GET', 'POST'] }, body: {},
    expect: object({ status: { type: 'array', items: { type: 'integer' }, minItems: 1 }, fields: { type: 'object', propertyNames: { type: 'string', pattern: '^[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*$' }, additionalProperties: fieldExpectation, minProperties: 1 } }, ['fields']) }, ['kind', 'path', 'expect']),
];
// An effect contract: an observer reads the changed system and a judge decides what the observations show.
const effect = object({
  intent: text, in: map(ref), observe: { oneOf: [run, ...builtin] }, judge: run, fixtures: path,
  schedule: object({ first: duration, then: { type: 'array', items: duration, maxItems: 20 }, horizon: duration }, ['horizon']),
  confirm: { enum: ['positive', 'unrefuted_at_horizon'] }, retry: { enum: ['never', 'idempotent'] }, blocking: { type: 'boolean' },
}, ['intent', 'observe']);
const exact = [
  object({ equals: object({ actual: ref, expected: ref }) }),
  object({ count: object({ value: ref, min: { type: 'integer', minimum: 0 }, max: { type: 'integer', minimum: 0 } }, ['value']) }),
  object({ present: ref }), object({ file: ref }),
];
export const formats = ['method/3.1', 'method/3.2', 'method/3.3', 'method/3.4'];
/** @type {Record<string, any>} */
export const methodSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/method-ai-hq/method-spec/raw/main/spec/method-3.schema.json',
  ...object({
    format: { enum: formats },
    // The account Method's ID. The CLI writes it once; the document digest leaves it out.
    id: { type: 'string', pattern: '^wf_[0-9a-f]{32}$' },
    models: map(methodModel),
    name: text, goal: text, run_prompt: text, run_label: ref,
    files: list(path), inputs: map({ $ref: '#/$defs/input' }), state: map({ $ref: '#/$defs/input' }),
    // Names and purposes only. The host supplies values to every script step; they never appear in the Method.
    secrets: { type: 'object', propertyNames: secretName, additionalProperties: text, maxProperties: 50 },
    // Where a signed-in host keeps run content: in the account (default) or only on the device that ran it.
    run_data: { enum: ['account', 'device'] },
    environment: map(object({ type: { enum: ['browser', 'service', 'desktop', 'files', 'tool'] }, description: text, role: { const: 'observer' } }, ['type', 'description'])),
    steps: { ...map({ $ref: '#/$defs/step' }), minProperties: 1 },
    result: { anyOf: [ref, map(ref)] },
  }, ['format', 'name', 'goal', 'steps', 'result']),
  $defs: {
    shape: { anyOf: [shapeProperties.type, object(shapeProperties, ['type'])] },
    data: object(shapeProperties, ['type']),
    input: object({ ...shapeProperties, default: {} }, ['type']),
    execution: { oneOf: [run, call, agent, classify] },
    check: { oneOf: [...exact, run, agent] },
    step: {
      ...object({
        name: text, purpose: text, reading: object({ inputs: text, outputs: text, output_name: text, condition: text, check: text, check_name: text }, []), in: map(ref), out: { oneOf: [name, map({ $ref: '#/$defs/data' })] },
        do: { $ref: '#/$defs/execution' }, ask: text, check: { $ref: '#/$defs/check' },
        each: { ...map(ref), minProperties: 1, maxProperties: 1 }, concurrency: width,
        repeat: object({ max_iterations: positive, until: ref }, ['max_iterations']), when: ref,
        after: { anyOf: [name, list(name)] }, changes: list(ref), effects: { ...map(effect), minProperties: 1 }, no_effect_reason: text,
        limits: object({ timeout_ms: positive, max_agent_turns: positive, max_model_requests: positive }, []),
        accept,
      }, []),
      oneOf: [{ required: ['do'], not: { required: ['ask'] } }, { required: ['ask'], not: { required: ['do'] } }],
      not: { required: ['each', 'repeat'] },
      allOf: [{ if: { properties: { do: { properties: { kind: { const: 'classify' } }, required: ['kind'] } }, required: ['do'] }, then: { required: ['out'], properties: { out: name } }, else: { properties: { out: map({ $ref: '#/$defs/data' }) } } }],
    },
  },
};

/** @type {Record<string, any>} */
export const configSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  ...object({
    limits: object({ timeout_ms: positive, max_model_requests: { type: 'integer', minimum: 0 }, max_invocations: positive, max_tool_calls: { type: 'integer', minimum: 0 }, max_output_bytes: positive, max_request_bytes: positive, effect_wait_ms: { type: 'integer', minimum: 0 }, max_concurrency: width }, []),
    step_defaults: object({ timeout_ms: positive, max_agent_turns: positive, max_model_requests: positive }, []),
    allow_local_processes: { type: 'boolean' },
    // With api_key_env the runtime calls Jev through OpenRouter directly with the operator's own key.
    classification: object({ provider: {const: 'typesafe'}, model: text, api_key_env: keyEnv }, ['provider', 'model']),
    runtimes: map(object({ command: text, args: { type: 'array', items: { type: 'string' } }, version: text }, ['command', 'version'])),
    // Direct API backends: each one has a fixed endpoint, so a profile cannot send its key to another host.
    // Keyed by what a step names: a profile name, or a model ID (resolved profiles of a method/3.4 document).
    models: { type: 'object', propertyNames: stepModel, additionalProperties: { oneOf: [
      object({ backend: { const: 'openai-responses' }, model: text, api_key_env: keyEnv, max_output_tokens: positive, reasoning_effort: { enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] } }, ['backend', 'model', 'api_key_env', 'max_output_tokens']),
      object({ backend: { const: 'anthropic-messages' }, model: text, api_key_env: keyEnv, max_output_tokens: positive, effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'] } }, ['backend', 'model', 'api_key_env', 'max_output_tokens']),
      object({ backend: { const: 'openrouter-chat' }, model: text, api_key_env: keyEnv, max_output_tokens: positive, reasoning_effort: { enum: ['minimal', 'low', 'medium', 'high'] } }, ['backend', 'model', 'api_key_env', 'max_output_tokens']),
      object({ backend: { enum: ['codex', 'claude'] }, command: text, model: text, reasoning_effort: text }, ['backend']),
      // A hosted model through the signed-in Method account. The host supplies the transport; there is no key.
      object({ backend: { const: 'method' }, model: text, max_output_tokens: positive, reasoning_effort: { enum: ['minimal', 'low', 'medium', 'high'] } }, ['backend', 'model'])] } },
    tools: map({oneOf: [object({ description: text, in: map({ $ref: `${methodSchema.$id}#/$defs/data` }), out: map({ $ref: `${methodSchema.$id}#/$defs/data` }), run, effects: list(name) }), object({description: text, connection: name, tool: text, parameters: {type:'object'}, effects: list(name)})]}),
    environment: map({ type: 'string' }),
    rubric: object({ judge_runs: { type: 'integer', minimum: 1, maximum: 9 }, classify_threshold: { type: 'number', minimum: 0.5, maximum: 1 }, max_value_bytes: positive }, []),
  }, []),
};

export const observationSchema = object({ observations: { type: 'array', maxItems: 1000, items: object({ source: text, ref: text, observed_at: text, data: {} }, ['source', 'ref']) } });
export const builtinObserverKinds = ['file', 'sqlite', 'http'];
export const judgmentSchema = object({ verdict: { enum: ['confirmed', 'contradicted', 'no_evidence', 'unobservable'] }, reason: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } });
export const checkResultSchema = object({ status: { enum: ['pass', 'fail', 'unknown'] }, reason: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } });
