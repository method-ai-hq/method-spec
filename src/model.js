import { modelName } from './semantics.js';
import { assertSchema, fail, safeData } from './validate.js';
import { withRetries, transientStatus } from './retry.js';

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function boundedJSON(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) fail('Empty provider response', 'provider_error');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail('Provider response exceeds output limit', 'output_limit'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

const json = value => JSON.stringify(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * One adapter per direct API backend. Each adapter has a fixed endpoint: the CLI has no option that sends
 * credentials to an arbitrary base URL. Injection (`context.transport`) is for tests and embedded hosts.
 * read() returns the model's tool calls, its final text, or why it stopped. history() is what the
 * conversation keeps from a response, unchanged, so that later requests replay it as the provider sent it.
 */
const completeJson = text => { try { return JSON.parse(text) !== null && /^[\[{]/.test(text.trim()); } catch { return false; } };
const adapters = {
  'openai-responses': {
    url: 'https://api.openai.com/v1/responses',
    headers: key => ({ authorization: `Bearer ${key}` }),
    body: ({ profile, instructions, messages, schema, tools }) => ({
      model: profile.model, instructions, input: messages, store: false, include: ['reasoning.encrypted_content'],
      max_output_tokens: profile.max_output_tokens,
      text: { format: { type: 'json_schema', name: 'method_output', strict: true, schema } },
      ...(profile.reasoning_effort ? { reasoning: { effort: profile.reasoning_effort } } : {}),
      ...(tools.length ? { tools, parallel_tool_calls: false } : {}),
    }),
    read(data) {
      if (data.status !== 'completed' || !Array.isArray(data.output)) return { incomplete: data.status ?? 'missing status' };
      if (data.output.some(item => !['function_call', 'message', 'reasoning'].includes(item.type))) fail('Unsupported model output item', 'model_output');
      const calls = data.output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
      const content = data.output.filter(x => x.type === 'message').flatMap(x => x.content ?? []);
      return { calls, refusal: content.some(x => x.type === 'refusal'), text: content.filter(x => x.type === 'output_text').map(x => x.text).join('') };
    },
    history: data => data.output,
    results: results => results.map(({ call, output }) => ({ type: 'function_call_output', call_id: call.id, output: json(output) })),
    usage: data => data.usage,
  },
  'anthropic-messages': {
    url: 'https://api.anthropic.com/v1/messages',
    headers: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    body: ({ profile, instructions, messages, schema, tools }) => ({
      model: profile.model, max_tokens: profile.max_output_tokens, system: instructions, messages,
      output_config: { format: { type: 'json_schema', schema }, ...(profile.effort ? { effort: profile.effort } : {}) },
      // Current models reject a forced tool choice. One call per turn matches the other backends.
      ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters, ...(tool.strict ? { strict: true } : {}) })),
        tool_choice: { type: 'auto', disable_parallel_tool_use: true } } : {}),
    }),
    read(data) {
      if (data.type !== 'message' || !Array.isArray(data.content)) return { incomplete: 'missing content' };
      if (data.stop_reason === 'refusal') return { calls: [], refusal: true };
      if (!['end_turn', 'tool_use', 'stop_sequence'].includes(data.stop_reason)) return { incomplete: data.stop_reason ?? 'missing stop reason' };
      const calls = data.content.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, arguments: block.input }));
      return { calls, refusal: false, text: data.content.filter(block => block.type === 'text').map(block => block.text).join('') };
    },
    // Thinking blocks stay in the history unchanged; current models reject an edited history.
    history: data => [{ role: 'assistant', content: data.content }],
    results: results => [{ role: 'user', content: results.map(({ call, output }) => ({ type: 'tool_result', tool_use_id: call.id, content: json(output) })) }],
    usage(data) {
      const usage = object(data.usage);
      const input = [usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
      return input.every(Number.isSafeInteger) ? { input_tokens: input.reduce((a, b) => a + b, 0), output_tokens: usage.output_tokens } : null;
    },
  },
  'openrouter-chat': {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: key => ({ authorization: `Bearer ${key}` }),
    body: ({ profile, instructions, messages, schema, tools }) => ({
      model: profile.model, max_tokens: profile.max_output_tokens, messages: [{ role: 'system', content: instructions }, ...messages],
      response_format: { type: 'json_schema', json_schema: { name: 'method_output', strict: true, schema } },
      // Route only to providers that honor the output schema and tools. There is no models list, so no other model is used.
      provider: { require_parameters: true },
      ...(profile.reasoning_effort ? { reasoning: { effort: profile.reasoning_effort } } : {}),
      // No parallel_tool_calls: with require_parameters, a provider that does not list it is refused, and every call of a reply runs.
      ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict } })) } : {}),
    }),
    read(data) {
      if (data.error) fail(`OpenRouter error: ${object(data.error).message ?? 'unknown'}`, 'provider_error');
      const choice = data.choices?.[0];
      if (!choice?.message) return { incomplete: 'missing choice' };
      if (choice.finish_reason === 'content_filter' || choice.message.refusal) return { calls: [], refusal: true };
      // Some models finish the JSON answer and then pad with spaces until the token limit. A complete answer is kept.
      const text = typeof choice.message.content === 'string' ? choice.message.content : '';
      if (choice.finish_reason === 'length' && !choice.message.tool_calls?.length && completeJson(text)) return { calls: [], refusal: false, text: text.trim() };
      if (!['stop', 'tool_calls'].includes(choice.finish_reason)) return { incomplete: choice.finish_reason ?? 'missing finish reason' };
      const calls = (choice.message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }));
      return { calls, refusal: false, text };
    },
    history: data => [data.choices[0].message],
    results: results => results.map(({ call, output }) => ({ role: 'tool', tool_call_id: call.id, content: json(output) })),
    usage(data) {
      const usage = object(data.usage);
      return { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens };
    },
  },
};
// Hosted models: the same request as openrouter-chat, sent through the signed-in Method account by the host.
adapters.method = { ...adapters['openrouter-chat'], url: null, headers: () => ({}) };
export const directBackends = Object.keys(adapters);
const hostedOutputTokens = 16_000;

/** A rate limit or a server error is retried like a classification; any other failure stops the step. */
function providerRequest(body, profile, adapter, context) {
  return withRetries(() => providerRequestOnce(body, profile, adapter, context),
    { transient: error => transientStatus(error.status), signal: context.signal, canRetry: () => context.canRequest?.() ?? true, beforeRetry: () => context.guard() });
}

async function providerRequestOnce(body, profile, adapter, context) {
  const text = json(body);
  if (Buffer.byteLength(text) > context.maxRequestBytes) fail('Model input exceeds request limit', 'input_limit');
  const hosted = profile.backend === 'method';
  const key = hosted ? null : context.secret(profile.api_key_env);
  if (hosted && !context.hosted && !context.transport) fail('Hosted models need Method sign-in. Run method login, then run again.', 'needs_input');
  if (!hosted && !key && !context.transport) fail(`Missing environment variable: ${profile.api_key_env}`, 'preflight');
  context.reserveRequest();
  await context.record('model.request', { backend: profile.backend, model: profile.model, request: body });
  try {
    const data = await abortable(() => context.transport
      ? context.transport(body, { signal: context.signal, backend: profile.backend })
      : hosted ? context.hosted.request(body, context.signal)
      : (async () => {
        const response = await fetch(adapter.url, {
          method: 'POST', headers: { ...adapter.headers(key), 'content-type': 'application/json' },
          body: text, signal: context.signal, redirect: 'error',
        });
        if (!response.ok) { await response.body?.cancel(); fail(`${profile.backend} HTTP ${response.status}`, 'provider_error', { status: response.status }); }
        return boundedJSON(response, context.maxOutputBytes);
      })(), context.signal);
    safeData(data);
    if (Buffer.byteLength(json(data)) > context.maxOutputBytes) fail('Provider response exceeds output limit', 'output_limit');
    const usage = adapter.usage(data);
    context.usage(usage);
    context.cost?.(object(data.usage).cost);
    await context.record('model.response', { backend: profile.backend, response: data, usage: usage ?? null });
    return data;
  } catch (error) {
    await context.record('model.error', { backend: profile.backend, code: error.code ?? 'provider_error', usage_may_be_unknown: true });
    throw error;
  }
}

export async function executeModel(execution, input, schema, context) {
  const profile = context.models[modelName(execution)];
  const adapter = adapters[profile.backend];
  const messages = [{ role: 'user', content: json(input) }];
  const tools = execution.kind === 'agent' ? (execution.tools ?? []).map(name => context.toolDefinition(name)) : [];
  const turns = execution.kind === 'agent' ? context.maxAgentTurns : 1;
  for (let turn = 0; turn < turns; turn++) {
    context.guard();
    if (execution.kind === 'agent') context.reserveAgentTurn();
    const settings = profile.backend === 'method' ? { max_output_tokens: hostedOutputTokens, ...profile } : profile;
    const data = await providerRequest(adapter.body({ profile: settings, instructions: execution.prompt, messages, schema, tools }), profile, adapter, context);
    context.guard();
    const reply = adapter.read(data);
    if (reply.incomplete) fail(`Model response is not complete: ${reply.incomplete}`, 'model_incomplete');
    if (reply.calls.length) {
      if (execution.kind !== 'agent') fail('A call step cannot execute tools', 'tool_denied');
      if (turn + 1 >= turns || !context.canRequest() || !context.canAgentTurn()) fail('No remaining model turn for tool results', 'model_limit');
      messages.push(...adapter.history(data));
      const results = [];
      for (const call of reply.calls) {
        if (!(execution.tools ?? []).includes(call.name)) fail(`Tool is not allowed: ${call.name}`, 'tool_denied');
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; safeData(args);
        results.push({ call, output: await context.invokeTool(call.name, args, call.id) });
      }
      messages.push(...adapter.results(results));
      continue;
    }
    if (reply.refusal) fail('Model refused the request', 'model_refusal');
    let value;
    try { value = JSON.parse(reply.text); } catch { fail('Model returned invalid JSON', 'invalid_output'); }
    safeData(value); assertSchema(schema, value, 'Model output');
    return value;
  }
  fail('Agent turn limit reached', 'model_limit');
}
