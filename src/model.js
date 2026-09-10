import { assertSchema, fail, safeData } from './validate.js';

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function boundedJSON(response, maxBytes) {
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

// The only network transport is Responses. Injection is for tests and embedded hosts;
// the CLI has no option that sends credentials to an arbitrary base URL.
export async function responsesRequest(body, profile, context) {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > context.maxRequestBytes) fail('Model input exceeds request limit', 'input_limit');
  const key = process.env[profile.api_key_env];
  if (!key && !context.transport) fail(`Missing environment variable: ${profile.api_key_env}`, 'preflight');
  context.reserveRequest();
  await context.record('model.request', { model: profile.model, request: body });
  try {
    const data = await abortable(() => context.transport
      ? context.transport(body, { signal: context.signal })
      : (async () => {
        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: json, signal: context.signal, redirect: 'error',
        });
        if (!response.ok) { await response.body?.cancel(); fail(`Responses API HTTP ${response.status}`, 'provider_error'); }
        return boundedJSON(response, context.maxOutputBytes);
      })(), context.signal);
    safeData(data);
    if (Buffer.byteLength(JSON.stringify(data)) > context.maxOutputBytes) fail('Provider response exceeds output limit', 'output_limit');
    context.usage(data.usage);
    await context.record('model.response', { response: data, usage: data.usage ?? null });
    if (data.status !== 'completed' || !Array.isArray(data.output)) fail(`Model response is not complete: ${data.status ?? 'missing status'}`, 'model_incomplete');
    return data;
  } catch (error) {
    await context.record('model.error', { code: error.code ?? 'provider_error', usage_may_be_unknown: true });
    throw error;
  }
}

export async function executeModel(execution, input, schema, context) {
  const profile = context.models[execution.model];
  const inputItems = [{ role: 'user', content: JSON.stringify(input) }];
  const tools = execution.kind === 'agent' ? execution.tools.map(name => context.toolDefinition(name)) : [];
  const turns = execution.kind === 'agent' ? context.maxAgentTurns : 1;
  for (let turn = 0; turn < turns; turn++) {
    context.guard();
    if (execution.kind === 'agent') context.reserveAgentTurn();
    const body = {
      model: profile.model, instructions: execution.prompt,
      input: inputItems, store: false, include: ['reasoning.encrypted_content'],
      max_output_tokens: profile.max_output_tokens,
      text: { format: { type: 'json_schema', name: 'method_output', strict: true, schema } },
      ...(profile.reasoning_effort ? { reasoning: { effort: profile.reasoning_effort } } : {}),
      ...(tools.length ? { tools, parallel_tool_calls: false } : {}),
    };
    const response = await responsesRequest(body, profile, context);
    context.guard();
    const calls = response.output.filter(item => item.type === 'function_call');
    const other = response.output.filter(item => !['function_call', 'message', 'reasoning'].includes(item.type));
    if (other.length) fail('Unsupported model output item', 'model_output');
    if (calls.length) {
      if (execution.kind !== 'agent') fail('A call step cannot execute tools', 'tool_denied');
      if (turn + 1 >= turns || !context.canRequest() || !context.canAgentTurn()) fail('No remaining model turn for tool results', 'model_limit');
      inputItems.push(...response.output);
      for (const item of calls) {
        if (!execution.tools.includes(item.name)) fail(`Tool is not allowed: ${item.name}`, 'tool_denied');
        const args = JSON.parse(item.arguments); safeData(args);
        const result = await context.invokeTool(item.name, args, item.call_id);
        inputItems.push({ type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) });
      }
      continue;
    }
    const content = response.output.filter(x => x.type === 'message').flatMap(x => x.content ?? []);
    if (content.some(x => x.type === 'refusal')) fail('Model refused the request', 'model_refusal');
    const text = content.filter(x => x.type === 'output_text').map(x => x.text).join('');
    let value;
    try { value = JSON.parse(text); } catch { fail('Model returned invalid JSON', 'invalid_output'); }
    safeData(value); assertSchema(schema, value, 'Model output');
    return value;
  }
  fail('Agent turn limit reached', 'model_limit');
}
