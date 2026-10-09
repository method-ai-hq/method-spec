import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod, validateConfig } from '../src/index.js';

const number = { type: 'number', description: 'A test number.' };
const step = (kind = 'call') => ({ purpose: 'Ask a model.', do: { kind, model: 'model', prompt: 'Return value.', ...(kind === 'agent' ? { tools: ['increment'] } : {}) },
  out: { value: number }, limits: { timeout_ms: 3000, max_model_requests: 3, max_agent_turns: 3 } });
const method = s => ({ format: 'method/3.1', name: 'Test', goal: 'Test a provider.', steps: { work: s }, result: 'value' });
const config = profile => ({
  limits: { timeout_ms: 10000, max_model_requests: 5, max_invocations: 5, max_tool_calls: 5, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
  runtimes: { node: { command: process.execPath, version: process.version } },
  models: { model: { model: 'test-model', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100, ...profile } },
  tools: { increment: { description: 'Add one.', in: { value: number }, out: { result: number }, run: { kind: 'run', runtime: 'node', entrypoint: 'tool.mjs' }, effects: [] } },
});
async function fixture(t, doc) {
  const dir = await mkdtemp(join(tmpdir(), 'method-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'tool.mjs'), 'let s="";for await(const x of process.stdin)s+=x;console.log(JSON.stringify({result:JSON.parse(s).value+1}))');
  const file = join(dir, 'test.method'); await writeFile(file, JSON.stringify(doc));
  return { dir, file, run: (cfg, transport) => runMethod(file, cfg, { runDir: join(dir, 'run'), transport }) };
}

const claude = {
  text: (value, usage = { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }) =>
    ({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: JSON.stringify(value) }], usage }),
  tool: () => ({ type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'increment', input: { value: 4 } }], usage: { input_tokens: 8, output_tokens: 3 } }),
};
const router = {
  text: value => ({ id: 'gen-1', provider: 'Fixture', model: 'test-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
  tool: () => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'increment', arguments: '{"value":4}' } }] } }] }),
};

test('the provider profiles validate', () => {
  validateConfig(config({ backend: 'anthropic-messages', effort: 'low' }));
  validateConfig(config({ backend: 'openrouter-chat', reasoning_effort: 'low' }));
  assert.throws(() => validateConfig(config({ backend: 'anthropic-messages', base_url: 'https://example.com' })));
  assert.throws(() => validateConfig(config({ backend: 'openrouter-chat', api_key_env: undefined })));
});

test('anthropic-messages call sends the output schema and counts cached input', async t => {
  const f = await fixture(t, method(step()));
  let request, backend;
  const result = await f.run(config({ backend: 'anthropic-messages', effort: 'low' }), async (body, info) => { request = body; backend = info.backend; return claude.text({ value: 7 }); });
  assert.equal(result.status, 'completed'); assert.equal(result.result, 7);
  assert.equal(backend, 'anthropic-messages');
  assert.equal(request.system, 'Return value.'); assert.equal(request.max_tokens, 100);
  assert.deepEqual(request.messages, [{ role: 'user', content: '{}' }]);
  assert.equal(request.output_config.format.type, 'json_schema'); assert.equal(request.output_config.effort, 'low');
  assert.equal(request.tools, undefined);
  assert.equal(result.usage.input_tokens, 15); assert.equal(result.usage.output_tokens, 4);
});

test('anthropic-messages agent runs a tool and keeps thinking blocks unchanged', async t => {
  const f = await fixture(t, method(step('agent')));
  const requests = [];
  const result = await f.run(config({ backend: 'anthropic-messages' }), async body => {
    requests.push(structuredClone(body));
    return requests.length === 1 ? claude.tool() : claude.text({ value: 5 });
  });
  assert.equal(result.status, 'completed'); assert.equal(result.result, 5); assert.equal(result.tool_calls, 1);
  assert.deepEqual(requests[0].tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.equal(requests[0].tools[0].name, 'increment'); assert.equal(requests[0].tools[0].strict, true);
  const [, assistant, results] = requests[1].messages;
  assert.deepEqual(assistant, { role: 'assistant', content: claude.tool().content });
  assert.deepEqual(results, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"result":5}' }] });
});

test('anthropic-messages refusal and max_tokens stop the step', async t => {
  for (const [reply, code] of [[{ ...claude.text({ value: 1 }), stop_reason: 'refusal' }, 'model_refusal'], [{ ...claude.text({ value: 1 }), stop_reason: 'max_tokens' }, 'model_incomplete']]) {
    const f = await fixture(t, method(step()));
    const result = await f.run(config({ backend: 'anthropic-messages' }), async () => reply);
    assert.equal(result.status, 'failed'); assert.equal(result.code, code);
  }
});

test('openrouter-chat call requires providers that honor the schema', async t => {
  const f = await fixture(t, method(step()));
  let request;
  const result = await f.run(config({ backend: 'openrouter-chat' }), async body => { request = body; return router.text({ value: 3 }); });
  assert.equal(result.status, 'completed'); assert.equal(result.result, 3);
  assert.deepEqual(request.messages, [{ role: 'system', content: 'Return value.' }, { role: 'user', content: '{}' }]);
  assert.equal(request.response_format.json_schema.strict, true);
  assert.deepEqual(request.provider, { require_parameters: true }); assert.equal(request.models, undefined);
  assert.equal(result.usage.input_tokens, 7); assert.equal(result.usage.output_tokens, 2);
});

test('openrouter-chat agent runs a tool and returns its result', async t => {
  const f = await fixture(t, method(step('agent')));
  const requests = [];
  const result = await f.run(config({ backend: 'openrouter-chat' }), async body => {
    requests.push(structuredClone(body));
    return requests.length === 1 ? router.tool() : router.text({ value: 5 });
  });
  assert.equal(result.status, 'completed'); assert.equal(result.result, 5);
  assert.equal(requests[0].parallel_tool_calls, false);
  assert.deepEqual(requests[1].messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: '{"result":5}' });
  assert.equal(requests[1].messages.at(-2).tool_calls[0].id, 'call_1');
});

test('openrouter-chat length, filter, and error responses stop the step', async t => {
  const stopped = finish => ({ choices: [{ finish_reason: finish, message: { role: 'assistant', content: '{"value":1}' } }] });
  for (const [reply, code] of [[stopped('length'), 'model_incomplete'], [stopped('content_filter'), 'model_refusal'], [{ error: { message: 'No provider' } }, 'provider_error']]) {
    const f = await fixture(t, method(step()));
    const result = await f.run(config({ backend: 'openrouter-chat' }), async () => reply);
    assert.equal(result.status, 'failed'); assert.equal(result.code, code);
  }
});

test('direct backends use their fixed endpoints and key headers', async t => {
  const original = globalThis.fetch, seen = [];
  process.env.METHOD_TEST_PROVIDER_KEY = 'provider-secret';
  t.after(() => { globalThis.fetch = original; delete process.env.METHOD_TEST_PROVIDER_KEY; });
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return new Response(JSON.stringify(url.includes('anthropic') ? claude.text({ value: 1 }) : router.text({ value: 1 })));
  };
  for (const backend of ['anthropic-messages', 'openrouter-chat']) {
    const f = await fixture(t, method(step()));
    assert.equal((await f.run(config({ backend, api_key_env: 'METHOD_TEST_PROVIDER_KEY' }))).status, 'completed');
  }
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], 'provider-secret'); assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[1].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen[1].headers.authorization, 'Bearer provider-secret');
});

test('a hosted profile sends the openrouter-chat request through the host and records its cost', async t => {
  const f = await fixture(t, method(step('agent')));
  const sent = [];
  const hostedModels = { request: async body => { sent.push(body); return { ...(sent.length === 1 ? router.tool() : router.text({ value: 5 })), usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.25 } }; } };
  const cfg = config({}); delete cfg.models;
  const result = await runMethod(f.file, cfg, { runDir: join(f.dir, 'hosted'), hostedModel: 'test/hosted', hostedModels, env: {} });
  assert.equal(result.status, 'completed'); assert.equal(result.result, 5);
  assert.equal(sent[0].model, 'test/hosted'); assert.equal(sent[0].response_format.type, 'json_schema');
  assert.equal(result.usage.cost_usd, 0.5);
});

test('a hosted model is chosen before the calling agent; --agent and configured profiles win', async () => {
  const { resolveModels } = await import('../src/agents.js');
  const doc = method(step());
  const env = { CLAUDECODE: '1' };
  assert.deepEqual((await resolveModels(doc, {}, { hostedModel: 'x/y', env })).model, { backend: 'method', model: 'x/y' });
  assert.deepEqual((await resolveModels(doc, {}, { hostedModel: 'x/y', env, agent: 'codex' })).model, { backend: 'codex' });
  assert.equal((await resolveModels(doc, { models: { default: { backend: 'codex', command: 'my-codex' } } }, { hostedModel: 'x/y', env })).model.command, 'my-codex');
});

test('no default profile is chosen when every step names a configured profile', async () => {
  const { resolveModels } = await import('../src/agents.js');
  const doc = method({ ...step(), do: { kind: 'call', model: 'writer', prompt: 'Return value.' } });
  const profiles = await resolveModels(doc, { models: { writer: { backend: 'method', model: 'x/y' } } }, { env: { CODEX_THREAD_ID: '1' } });
  assert.deepEqual(Object.keys(profiles), ['writer']);
});
