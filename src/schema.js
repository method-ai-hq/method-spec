const text = { type: 'string', minLength: 1, maxLength: 16000 };
const name = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80, not: { enum: ['constructor', 'prototype', '__proto__'] } };
const ref = { type: 'string', pattern: '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*|\\.[0-9]+)*$' };
const positive = { type: 'integer', minimum: 1, maximum: 2147483647 };
export const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const map = (value) => ({ type: 'object', propertyNames: name, additionalProperties: value });
const list = (items) => ({ type: 'array', items, uniqueItems: true });
const path = { type: 'string', minLength: 1, maxLength: 500 };
const shapeProperties = {
  type: { enum: ['text', 'number', 'boolean', 'record', 'list', 'file'] },
  description: text, fields: map({ $ref: '#/$defs/shape' }), items: { $ref: '#/$defs/shape' }, format: text,
};
const run = object({ kind: { const: 'run' }, runtime: name, entrypoint: path, args: { type: 'array', items: { type: 'string' } } }, ['kind', 'runtime', 'entrypoint']);
const call = object({ kind: { const: 'call' }, model: name, prompt: text });
const agent = object({ kind: { const: 'agent' }, model: name, prompt: text, tools: list(name), browser: ref }, ['kind', 'model', 'prompt']);
const classify = object({ kind: { const: 'classify' }, question: text, options: { ...map(text), minProperties: 2, maxProperties: 255 } });
const exact = [
  object({ equals: object({ actual: ref, expected: ref }) }),
  object({ count: object({ value: ref, min: { type: 'integer', minimum: 0 }, max: { type: 'integer', minimum: 0 } }, ['value']) }),
  object({ present: ref }), object({ file: ref }),
];
/** @type {Record<string, any>} */
export const methodSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/method-ai-hq/method-spec/raw/main/spec/method-3.schema.json',
  ...object({
    format: { enum: ['method/3.1', 'method/3.2'] }, name: text, goal: text, run_prompt: text,
    files: list(path), inputs: map({ $ref: '#/$defs/input' }), state: map({ $ref: '#/$defs/input' }),
    environment: map(object({ type: { enum: ['browser', 'service', 'desktop', 'files', 'tool'] }, description: text })),
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
        each: { ...map(ref), minProperties: 1, maxProperties: 1 },
        repeat: object({ max_iterations: positive, until: ref }, ['max_iterations']), when: ref,
        after: { anyOf: [name, list(name)] }, changes: list(ref),
        limits: object({ timeout_ms: positive, max_agent_turns: positive, max_model_requests: positive }, []),
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
    limits: object({ timeout_ms: positive, max_model_requests: { type: 'integer', minimum: 0 }, max_invocations: positive, max_tool_calls: { type: 'integer', minimum: 0 }, max_output_bytes: positive, max_request_bytes: positive }, []),
    step_defaults: object({ timeout_ms: positive, max_agent_turns: positive, max_model_requests: positive }, []),
    allow_local_processes: { type: 'boolean' },
    classification: object({ provider: {const: 'typesafe'}, model: text }),
    runtimes: map(object({ command: text, args: { type: 'array', items: { type: 'string' } }, version: text, env: list({ type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$' }) }, ['command', 'version'])),
    models: map({ oneOf: [object({ backend: { const: 'openai-responses' }, model: text, api_key_env: { type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$' }, max_output_tokens: positive, reasoning_effort: { enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] } }, ['backend', 'model', 'api_key_env', 'max_output_tokens']), object({ backend: { enum: ['codex', 'claude'] }, command: text, model: text, reasoning_effort: text }, ['backend'])] }),
    tools: map({oneOf: [object({ description: text, in: map({ $ref: `${methodSchema.$id}#/$defs/data` }), out: map({ $ref: `${methodSchema.$id}#/$defs/data` }), run, effects: list(name) }), object({description: text, connection: name, tool: text, parameters: {type:'object'}, effects: list(name)})]}),
    environment: map({ type: 'string' }),
  }, []),
};

export const checkResultSchema = object({ status: { enum: ['pass', 'fail', 'unknown'] }, reason: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } });
