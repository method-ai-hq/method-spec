import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { runMethod, validateMethod, validateConfig, readDocument, migrateMethod2 } from '../src/index.js';
import { safeData } from '../src/validate.js';

const number = { type: 'number', description: 'A test number.' };
const boolean = { type: 'boolean', description: 'A test condition.' };
const script = entrypoint => ({ kind: 'run', runtime: 'node', entrypoint });
const step = (out = { value: number }) => ({ purpose: 'Test an operation.', do: script('action.mjs'), out, limits: { timeout_ms: 1500 } });
const method = (s = step()) => ({ format: 'method/3', name: 'Test', goal: 'Test execution.', steps: { work: s }, result: Object.keys(s.out ?? {})[0] ?? 'inputs.value' });
function config() {
  return { limits: { timeout_ms: 10000, max_model_requests: 5, max_invocations: 20, max_tool_calls: 5, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
    runtimes: { node: { command: process.execPath, version: process.version } },
    models: { model: { backend: 'openai-responses', model: 'test-model', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100 } } };
}
const response = (value, usage = { input_tokens: 12, output_tokens: 5 }) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], ...(usage ? { usage } : {}) });
const toolResponse = (name = 'increment', args = { value: 4 }) => ({ status: 'completed', output: [{ type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] }, { type: 'function_call', call_id: 'c1', name, arguments: JSON.stringify(args) }] });
async function fixture(t, doc = method(), files = { 'action.mjs': 'console.log(JSON.stringify({value: 4}))' }) {
  const dir = await mkdtemp(join(tmpdir(), 'method3-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source);
  const file = join(dir, 'test.method'); await writeFile(file, JSON.stringify(doc));
  const runDir = join(dir, 'run');
  return { dir, file, runDir, run: (cfg = config(), options = {}) => runMethod(file, cfg, { runDir, ...options }), events: async () => (await readFile(join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse), state: async () => JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')) };
}
function modelStep(kind = 'call') {
  return { purpose: 'Ask a model.', do: { kind, model: 'model', prompt: 'Return value.', ...(kind === 'agent' ? { tools: [] } : {}) }, out: { value: number }, limits: { timeout_ms: 1500, max_model_requests: 3, max_agent_turns: 3 } };
}
function addTool(cfg, effects = []) {
  cfg.tools = { increment: { description: 'Add one.', in: { value: number }, out: { result: number }, run: script('tool.mjs'), effects } };
  return cfg;
}

test('checked counter runs real scripts, commits state, and records each iteration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method3-example-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runMethod(pathResolve('examples/counter.method'), await readDocument('examples/local.config.json'), { runDir: join(dir, 'run') });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.result, { final_count: 3, target_reached: true });
  assert.equal(result.model_requests, 0); assert.equal(result.invocations, 3);
  const state = JSON.parse(await readFile(join(dir, 'run/state.json'), 'utf8')); assert.deepEqual(state, { count: 3 });
  const events = (await readFile(join(dir, 'run/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'check.completed').length, 3);
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
});
test('invalid reference and cyclic dependencies fail before execution', () => {
  const a = method(); a.steps.work.in = { x: 'missing' }; assert.throws(() => validateMethod(a), /Unknown reference/);
  const b = method(); b.steps.work.after = 'later'; b.steps.later = { ...step({ second: number }), after: 'work' };
  assert.throws(() => validateMethod(b), /Cyclic/);
});
test('type defaults, loop condition types, duplicate outputs and unknown fields are rejected', () => {
  for (const edit of [
    m => { m.inputs = { n: { ...number, default: 'wrong' } }; },
    m => { m.steps.work.when = 'value'; },
    m => { m.steps.later = step(); },
    m => { m.steps.work.do.mystery = true; },
    m => { m.steps.work.repeat = { max_iterations: 2, until: 'value' }; },
  ]) { const m = method(); edit(m); assert.throws(() => validateMethod(m)); }
});
test('dependencies run in data order, not YAML order', async t => {
  const m = method();
  m.steps = { second: { ...step({ answer: number }), in: { value: 'value' }, do: script('second.mjs') }, first: step() }; m.result = 'answer';
  const f = await fixture(t, m, { 'action.mjs': 'console.log(JSON.stringify({value:4}))', 'second.mjs': 'let s="";for await(const x of process.stdin)s+=x;console.log(JSON.stringify({answer:JSON.parse(s).value+1}))' });
  assert.equal((await f.run()).result, 5);
});
test('invalid script output fails without accepting the step', async t => {
  const f = await fixture(t, method(), { 'action.mjs': 'console.log(JSON.stringify({value:"wrong"}))' });
  assert.equal((await f.run()).code, 'invalid_output'); assert.equal((await f.events()).filter(e => e.event === 'step.accepted').length, 0);
});
for (const status of ['fail', 'unknown']) test(`a ${status} checker preserves the candidate but does not commit state`, async t => {
  const m = method(); m.state = { n: { ...number, default: 0 } }; m.steps.work.changes = ['state.n']; m.steps.work.check = script('check.mjs');
  const f = await fixture(t, m, { 'action.mjs': 'console.log(JSON.stringify({value:4,state:{n:4}}))', 'check.mjs': `console.log(JSON.stringify({status:${JSON.stringify(status)},reason:"test",evidence:[]}))` });
  assert.equal((await f.run()).code, 'check_failed'); assert.deepEqual(await f.state(), { n: 0 });
  assert.ok((await f.events()).some(e => e.event === 'step.candidate' && e.candidate.state.n === 4));
});
test('checker execution error is distinct from a failed check', async t => {
  const m = method(); m.steps.work.check = script('check.mjs');
  const f = await fixture(t, m, { 'action.mjs': 'console.log(JSON.stringify({value:4}))', 'check.mjs': 'process.exit(3)' });
  assert.equal((await f.run()).code, 'process_failed'); assert.ok(!(await f.events()).some(e => e.event === 'check.completed'));
});
test('process timeout terminates work and records a stopped run', async t => {
  const m = method(); m.steps.work.limits.timeout_ms = 80;
  const f = await fixture(t, m, { 'action.mjs': 'setInterval(()=>{},1000)' });
  const result = await f.run(); assert.equal(result.code, 'timeout'); assert.ok(result.elapsed_ms < 2000);
});
test('process output is bounded', async t => {
  const f = await fixture(t, method(), { 'action.mjs': 'console.log("x".repeat(10000))' });
  const cfg = config(); cfg.limits.max_output_bytes = 1000;
  assert.equal((await f.run(cfg)).code, 'output_limit');
});
test('process failure diagnostics are retained', async t => {
  const f = await fixture(t, method(), { 'action.mjs': 'console.error("diagnostic");process.exit(7)' });
  assert.equal((await f.run()).code, 'process_failed'); assert.ok((await f.events()).some(e => e.diagnostics?.includes('diagnostic')));
});
test('each collects ordered results and an empty each creates empty lists', async t => {
  for (const items of [[1, 2, 3], []]) {
    const m = method(); m.inputs = { items: { type: 'list', items: 'number', description: 'Items.', default: items } }; m.steps.work.each = { item: 'inputs.items' };
    const f = await fixture(t, m, { 'action.mjs': 'let s="";for await(const x of process.stdin)s+=x;console.log(JSON.stringify({value:JSON.parse(s).item*2}))' });
    assert.deepEqual((await f.run()).result, items.map(x => x * 2));
  }
});
test('repeat stopping condition can finish before a smaller host invocation cap', async t => {
  const m = method(step({ value: number, done: boolean })); m.steps.work.repeat = { max_iterations: 100, until: 'done' };
  const f = await fixture(t, m, { 'action.mjs': 'console.log(JSON.stringify({value:4,done:true}))' });
  const cfg = config(); cfg.limits.max_invocations = 1;
  assert.equal((await f.run(cfg)).status, 'completed');
});
test('repeat exhaustion is failure even after accepted intermediate outputs', async t => {
  const m = method(step({ value: number, done: boolean })); m.steps.work.repeat = { max_iterations: 2, until: 'done' };
  const f = await fixture(t, m, { 'action.mjs': 'console.log(JSON.stringify({value:4,done:false}))' });
  assert.equal((await f.run()).code, 'iteration_limit'); assert.equal((await f.events()).filter(e => e.event === 'step.accepted').length, 2);
});
test('a consumer of skipped output fails explicitly', async t => {
  const m = method(); m.inputs = { enabled: { ...boolean, default: false } }; m.steps.work.when = 'inputs.enabled';
  const f = await fixture(t, m); assert.equal((await f.run()).code, 'missing_reference');
});
test('bundle paths and symlinks cannot escape the source directory', async t => {
  const m = method(); m.steps.work.do.entrypoint = '../outside.mjs';
  const f = await fixture(t, m); assert.equal((await f.run()).status, 'failed');
  const g = await fixture(t); await symlink(process.execPath, join(g.dir, 'link.mjs'));
  const doc = method(); doc.steps.work.do.entrypoint = 'link.mjs'; await writeFile(g.file, JSON.stringify(doc));
  assert.equal((await g.run()).status, 'failed');
});
test('local process capability must be declared by the operator', async t => {
  const f = await fixture(t); const cfg = config(); delete cfg.allow_local_processes;
  await assert.rejects(f.run(cfg), /allow_local_processes/);
});
test('a model call is one request with strict output schema and no tool loop', async t => {
  const f = await fixture(t, method(modelStep())); const bodies = [];
  const result = await f.run(config(), { transport: async body => { bodies.push(structuredClone(body)); return response({ value: 4 }); } });
  assert.equal(result.result, 4); assert.equal(bodies.length, 1); assert.equal(bodies[0].text.format.strict, true); assert.equal(bodies[0].tools, undefined);
  assert.equal(result.usage.input_tokens, 12); assert.equal(result.usage.responses_without_usage, 0);
});
test('bad model output is not repaired with hidden calls', async t => {
  const f = await fixture(t, method(modelStep())); let requests = 0;
  assert.equal((await f.run(config(), { transport: async () => { requests++; return response({ value: 'bad' }); } })).code, 'invalid_output');
  assert.equal(requests, 1);
});
test('agent dispatches a real tool and preserves reasoning items between requests', async t => {
  const s = modelStep('agent'); s.do.tools = ['increment']; const f = await fixture(t, method(s), { 'tool.mjs': 'let s="";for await(const x of process.stdin)s+=x;console.log(JSON.stringify({result:JSON.parse(s).value+1}))' });
  let calls = 0;
  const result = await f.run(addTool(config()), { transport: async body => {
    if (++calls === 1) return toolResponse();
    assert.ok(body.input.some(x => x.type === 'reasoning' && x.encrypted_content === 'opaque'));
    assert.equal(body.input.find(x => x.type === 'function_call_output').output, '{"result":5}');
    return response({ value: 5 });
  } });
  assert.equal(result.result, 5); assert.equal(result.tool_calls, 1); assert.equal(result.model_requests, 2); assert.equal(result.usage.responses_without_usage, 1);
});
test('unlisted tools and invalid tool arguments are not dispatched', async t => {
  for (const reply of [toolResponse('forbidden'), toolResponse('increment', { value: 'bad' })]) {
    const s = modelStep('agent'); s.do.tools = ['increment']; const f = await fixture(t, method(s), { 'tool.mjs': 'throw Error("must not run")' });
    const result = await f.run(addTool(config()), { transport: async () => reply });
    assert.equal(result.status, 'failed'); assert.ok(!(await f.events()).some(e => e.event === 'tool.dispatched'));
  }
});
test('a call step rejects tool responses', async t => {
  const f = await fixture(t, method(modelStep()));
  assert.equal((await f.run(config(), { transport: async () => toolResponse() })).code, 'tool_denied');
});
test('host model cap prevents dispatch', async t => {
  const f = await fixture(t, method(modelStep())); const cfg = config(); cfg.limits.max_model_requests = 0;
  const result = await f.run(cfg, { transport: async () => { throw Error('must not request'); } });
  assert.equal(result.code, 'model_limit'); assert.equal(result.model_requests, 0);
});
test('action and checker share the request cap; candidate state is not committed', async t => {
  const m = method(modelStep()); m.state = { n: { ...number, default: 0 } }; m.steps.work.changes = ['state.n'];
  m.steps.work.check = { kind: 'agent', model: 'model', prompt: 'Check.', tools: [] }; m.steps.work.limits.max_model_requests = 1;
  const f = await fixture(t, m); const result = await f.run(config(), { transport: async () => response({ value: 4, state: { n: 4 } }) });
  assert.equal(result.code, 'model_limit'); assert.equal(result.model_requests, 1); assert.deepEqual(await f.state(), { n: 0 });
});
test('agent does not dispatch a tool when no follow-up turn remains', async t => {
  const s = modelStep('agent'); s.do.tools = ['increment']; s.limits.max_agent_turns = 1;
  const f = await fixture(t, method(s), { 'tool.mjs': 'throw Error("must not run")' });
  assert.equal((await f.run(addTool(config()), { transport: async () => toolResponse() })).code, 'model_limit');
  assert.ok(!(await f.events()).some(e => e.event === 'tool.dispatched'));
});
test('effectful tools need declared changes and are forbidden to checkers', async t => {
  const s = modelStep('agent'); s.do.tools = ['increment']; const f = await fixture(t, method(s), { 'tool.mjs': '' });
  await assert.rejects(f.run(addTool(config(), ['game']), { transport: async () => response({ value: 1 }) }), /Undeclared tool effect/);
  const m = method(); m.steps.work.check = { kind: 'agent', model: 'model', prompt: 'Check.', tools: ['increment'] }; m.steps.work.limits.max_agent_turns = 2; m.steps.work.limits.max_model_requests = 2;
  const g = await fixture(t, m, { 'action.mjs': '', 'tool.mjs': '' });
  await assert.rejects(g.run(addTool(config(), ['game']), { transport: async () => response({ value: 1 }) }), /Checker cannot use effectful/);
});
test('an external write followed by process failure is recorded and never retried', async t => {
  const m = method(); m.environment = { game: { type: 'service', description: 'Test target.' } }; m.steps.work.changes = ['environment.game']; m.steps.work.check = { present: 'value' };
  const f = await fixture(t, m, { 'action.mjs': 'import{appendFileSync}from"node:fs";appendFileSync(process.env.METHOD_OUTPUT_DIR+"/effect.txt","write\\n");process.exit(9)' });
  const cfg = config(); cfg.environment = { game: 'test-game' }; const result = await f.run(cfg);
  assert.equal(result.code, 'process_failed'); assert.equal(await readFile(join(f.runDir, 'artifacts/effect.txt'), 'utf8'), 'write\n');
  assert.equal((await f.events()).filter(e => e.event === 'process.started').length, 1);
});
test('a deadline covers action and checker together', async t => {
  const m = method(); m.steps.work.check = script('check.mjs'); m.steps.work.limits.timeout_ms = 180;
  const f = await fixture(t, m, { 'action.mjs': 'setTimeout(()=>console.log(JSON.stringify({value:4})),100)', 'check.mjs': 'setTimeout(()=>console.log(JSON.stringify({status:"pass",reason:"ok",evidence:[]})),120)' });
  assert.equal((await f.run()).code, 'timeout');
});
test('file outputs require matching content hashes', async t => {
  const m = method(step({ artifact: { type: 'file', description: 'A file.' } })); m.steps.work.check = { file: 'artifact' };
  const f = await fixture(t, m, { 'action.mjs': 'import{writeFileSync}from"node:fs";writeFileSync(process.env.METHOD_OUTPUT_DIR+"/test.txt","hello");console.log(JSON.stringify({artifact:{path:"test.txt",sha256:"0".repeat(64)}}))' });
  assert.equal((await f.run()).code, 'file_mismatch');
});
test('a changed bundle is detected before the next invocation', async t => {
  const m = method(); m.steps.work.repeat = { max_iterations: 2 };
  const f = await fixture(t, m, { 'action.mjs': 'import{appendFileSync}from"node:fs";appendFileSync("action.mjs","\\n//changed");console.log(JSON.stringify({value:4}))' });
  assert.equal((await f.run()).code, 'bundle_changed');
});
test('ask stops with an inspectable request and never calls a model', async t => {
  const m = method(); delete m.steps.work.do; m.steps.work.ask = 'Supply value.';
  const f = await fixture(t, m); assert.equal((await f.run()).status, 'needs_input');
  assert.ok((await f.events()).some(e => e.event === 'human.required'));
});
test('existing run directories cannot be overwritten', async t => {
  const f = await fixture(t); await f.run(); await assert.rejects(f.run(), /EEXIST/);
});
test('migration preserves a Method 2 equality check and makes defaults explicit', async t => {
  const old = { format: 'method/2', name: 'Copy', goal: 'Copy exactly.', inputs: { message: { type: 'text', description: 'Message.', default: 'hello' } }, steps: { copy: { in: { message: 'inputs.message' }, do: 'Copy message as copied.', out: { copied: { type: 'text', description: 'Copy.' } }, check: { equals: { actual: 'copied', expected: 'message' } } } }, result: 'copied' };
  const { method: migrated, warnings } = migrateMethod2(old, { model: 'model', timeout_ms: 1000, max_agent_turns: 2, max_model_requests: 2 });
  assert.equal(migrated.steps.copy.do.kind, 'agent'); assert.ok(warnings.length);
  const f = await fixture(t, migrated); assert.equal((await f.run(config(), { transport: async () => response({ copied: 'hello' }) })).result, 'hello');
  assert.throws(() => migrateMethod2(old, {}), /requires/);
});
test('unknown configuration fields, unsafe data and cycles are rejected', () => {
  const cfg = config(); cfg.models.model.temperature = 0.2; assert.throws(() => validateConfig(cfg));
  assert.throws(() => safeData(JSON.parse('{"__proto__":1}')), /Reserved/);
  const cycle = {}; cycle.self = cycle; assert.throws(() => safeData(cycle), /Cyclic/);
});

test('Responses HTTP transport sends strict JSON and never records the API key', async t => {
  const oldFetch = globalThis.fetch, oldKey = process.env.METHOD_TEST_UNUSED_KEY;
  process.env.METHOD_TEST_UNUSED_KEY = 'local-test-credential-not-a-real-key';
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.METHOD_TEST_UNUSED_KEY; else process.env.METHOD_TEST_UNUSED_KEY = oldKey; });
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer local-test-credential-not-a-real-key');
    assert.equal(JSON.parse(init.body).text.format.type, 'json_schema');
    return new Response(JSON.stringify(response({ value: 8 })), { status: 200 });
  };
  const f = await fixture(t, method(modelStep()));
  const result = await f.run(); assert.equal(result.result, 8); assert.equal(requests, 1);
  assert.ok(!(await readFile(join(f.runDir, 'events.jsonl'), 'utf8')).includes('local-test-credential-not-a-real-key'));
});
test('HTTP provider errors are not retried and usage remains unknown', async t => {
  const oldFetch = globalThis.fetch, oldKey = process.env.METHOD_TEST_UNUSED_KEY;
  process.env.METHOD_TEST_UNUSED_KEY = 'local-test-key';
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.METHOD_TEST_UNUSED_KEY; else process.env.METHOD_TEST_UNUSED_KEY = oldKey; });
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response('do not log provider error bodies', { status: 429 }); };
  const f = await fixture(t, method(modelStep())); const result = await f.run();
  assert.equal(result.code, 'provider_error'); assert.equal(calls, 1); assert.equal(result.usage.responses_without_usage, 1); assert.equal(result.usage.cost_usd, null);
});
test('model timeout cancels the wait even if an injected transport ignores cancellation', async t => {
  const s = modelStep(); s.limits.timeout_ms = 50;
  const f = await fixture(t, method(s)); const result = await f.run(config(), { transport: () => new Promise(() => {}) });
  assert.equal(result.code, 'timeout'); assert.ok(result.elapsed_ms < 1000); assert.equal(result.model_requests, 1);
});
test('incomplete and refused model responses cannot pass', async t => {
  for (const value of [{ status: 'incomplete', output: [] }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] }]) {
    const f = await fixture(t, method(modelStep())); const result = await f.run(config(), { transport: async () => value });
    assert.equal(result.status, 'failed'); assert.ok(!(await f.events()).some(e => e.event === 'step.accepted'));
  }
});
test('a passed agent check commits the candidate state', async t => {
  const m = method(modelStep()); m.state = { n: { ...number, default: 0 } }; m.steps.work.changes = ['state.n'];
  m.steps.work.check = { kind: 'agent', model: 'model', prompt: 'Check.', tools: [] };
  const f = await fixture(t, m); let calls = 0;
  const result = await f.run(config(), { transport: async body => {
    if (++calls === 1) return response({ value: 4, state: { n: 4 } });
    const checkerInput = JSON.parse(body.input[0].content);
    assert.deepEqual(checkerInput.state_before, { n: 0 }); assert.deepEqual(checkerInput.state_after, { n: 4 });
    return response({ status: 'pass', reason: 'Observed.', evidence: [] });
  } });
  assert.equal(result.status, 'completed'); assert.deepEqual(await f.state(), { n: 4 }); assert.equal(calls, 2);
});
test('unchanged external source files are snapshotted for execution', async t => {
  const f = await fixture(t); await f.run();
  const manifest = JSON.parse(await readFile(join(f.runDir, 'manifest.json'), 'utf8'));
  assert.match(manifest.files['action.mjs'], /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(f.runDir, 'bundle/action.mjs'), 'utf8'), await readFile(join(f.dir, 'action.mjs'), 'utf8'));
});

test('resume reuses accepted repeat iterations and committed state', async t => {
  const m = method({ ...step(), in: { count: 'state.count' }, changes: ['state.count'], repeat: { max_iterations: 3 } });
  m.state = { count: { ...number, default: 0 } };
  const f = await fixture(t, m, { 'action.mjs': 'let s="";for await(const x of process.stdin)s+=x;const n=JSON.parse(s).count+1;console.log(JSON.stringify({value:n,state:{count:n}}))' });
  const controller = new AbortController();
  const first = await f.run(config(), { signal: controller.signal, onEvent(e) { if (e.event === 'step.accepted') controller.abort(new Error('Stop after acceptance')); } });
  assert.equal(first.status, 'failed'); assert.deepEqual(await f.state(), { count: 1 });
  const resumed = await f.run(config(), { resume: true });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.result, 3);
  assert.deepEqual(await f.state(), { count: 3 });
  assert.equal((await f.events()).filter(e => e.event === 'step.accepted').length, 3);
});

test('resume retains each collection output order', async t => {
  const m = method({ ...step(), each: { item: 'inputs.items' } });
  m.inputs = { items: { type: 'list', items: 'number', description: 'Numbers.', default: [2, 4, 8] } };
  const f = await fixture(t, m, { 'action.mjs': 'let s="";for await(const x of process.stdin)s+=x;console.log(JSON.stringify({value:JSON.parse(s).item}))' });
  const controller = new AbortController();
  await f.run(config(), { signal: controller.signal, onEvent(e) { if (e.event === 'step.accepted') controller.abort(new Error('Stop')); } });
  assert.deepEqual((await f.run(config(), { resume: true })).result, [2, 4, 8]);
});

test('unfinished actions require explicit retry and never repeat accepted steps', async t => {
  const m = method(); m.steps.next = { ...step({ final: number }), after: 'work', do: script('next.mjs') }; m.result = 'final';
  const f = await fixture(t, m, { 'action.mjs': 'console.log(JSON.stringify({value:4}))', 'next.mjs': `import {existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const p=join(process.env.METHOD_OUTPUT_DIR,'attempt');if(!existsSync(p)){writeFileSync(p,'attempted');process.exit(1)}console.log(JSON.stringify({final:5}));` });
  assert.equal((await f.run()).status, 'failed');
  await assert.rejects(f.run(config(), { resume: true }), /--retry next:0/);
  const result = await f.run(config(), { resume: true, retry: ['next:0'] });
  assert.equal(result.status, 'completed'); assert.equal(result.result, 5);
  assert.equal((await f.events()).filter(e => e.event === 'step.started' && e.step === 'work').length, 1);
});

test('resume rejects changed methods, config, inputs, and bundles', async t => {
  const f = await fixture(t); await f.run();
  await assert.rejects(f.run({ ...config(), allow_local_processes: false }, { resume: true }), /configuration changed/);
  await assert.rejects(f.run(config(), { resume: true, inputs: {} }), /saved inputs/);
  await writeFile(join(f.runDir, 'bundle/action.mjs'), 'console.log("changed")');
  assert.equal((await f.run(config(), { resume: true })).code, 'bundle_changed');
  await writeFile(f.file, JSON.stringify({ ...method(), goal: 'Changed goal' }));
  await assert.rejects(f.run(config(), { resume: true }), /Method or configuration changed/);
});

test('ask resumes with an actual supplied answer and runs its check', async t => {
  const m = method({ purpose: 'Ask a person.', ask: 'Supply a number.', out: { value: number }, check: { present: 'value' }, limits: { timeout_ms: 1500 } });
  const f = await fixture(t, m, {});
  assert.equal((await f.run()).status, 'needs_input');
  const result = await f.run(config(), { resume: true, human: { steps: { 'work:0': { outputs: { value: 7 } } } } });
  assert.equal(result.status, 'completed'); assert.equal(result.result, 7);
  assert.equal((await f.events()).filter(e => e.event === 'check.completed').length, 1);
});

test('resume does not reset the model request budget', async t => {
  const f = await fixture(t, method(modelStep()), {}), cfg = config(); cfg.limits.max_model_requests = 1;
  let calls = 0;
  const transport = async () => { calls++; throw Error('Provider failed after dispatch'); };
  assert.equal((await f.run(cfg, { transport })).model_requests, 1);
  const resumed = await f.run(cfg, { resume: true, retry: ['work:0'], transport });
  assert.equal(resumed.code, 'model_limit'); assert.equal(resumed.model_requests, 1); assert.equal(calls, 1);
});

test('a second process cannot resume an active run', async t => {
  const f = await fixture(t, method(modelStep()), {});
  const transport = async () => { await assert.rejects(f.run(config(), { resume: true }), /Run is locked/); return response({ value: 4 }); };
  assert.equal((await f.run(config(), { transport })).status, 'completed');
});
