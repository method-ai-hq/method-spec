import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod } from '../src/index.js';
import { assertSchema } from '../src/validate.js';
import { checkResultSchema } from '../src/schema.js';
import { agentEvent } from '../src/progress.js';

// The failure record, notices, event sentences, and the check retry, seen from a run's files.
const number = { type: 'number', description: 'A test number.' };
const script = entrypoint => ({ kind: 'run', runtime: 'node', entrypoint });
const scriptStep = extra => ({ name: 'Find the value', purpose: 'Return a value.', do: script('action.mjs'), out: { value: number }, limits: { timeout_ms: 3000 }, ...extra });
const modelStep = extra => ({ name: 'Ask the model', purpose: 'Ask a model.', do: { kind: 'call', model: 'model', prompt: 'Return value.' }, out: { value: number }, limits: { timeout_ms: 10000, max_model_requests: 5 }, ...extra });
const method = (step, extra = {}) => ({ format: 'method/3.1', name: 'Test', goal: 'Test failures.', steps: { work: step }, result: 'value', ...extra });
const config = (extra = {}) => ({ limits: { timeout_ms: 20000, max_model_requests: 5, max_invocations: 20, max_tool_calls: 5, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
  runtimes: { node: { command: process.execPath, version: process.version } },
  models: { model: { backend: 'openai-responses', model: 'test-model', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100 } }, ...extra });
const response = value => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 1, output_tokens: 1 } });
const checkScript = result => `console.log(JSON.stringify(${JSON.stringify(result)}))`;

async function fixture(t, doc, files = { 'action.mjs': 'console.log(JSON.stringify({value: 4}))' }) {
  const dir = await mkdtemp(join(tmpdir(), 'method-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source, { mode: 0o700 });
  const file = join(dir, 'test.method'); await writeFile(file, JSON.stringify(doc));
  const runDir = join(dir, 'run');
  return { dir, file, runDir, run: (cfg = config(), options = {}) => runMethod(file, cfg, { runDir, ...options }),
    events: async () => (await readFile(join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse),
    summary: async () => JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8')) };
}
const failureKeys = ['owner', 'code', 'headline', 'step', 'step_name', 'iteration', 'failed_iterations', 'total', 'phase', 'check_name', 'next', 'evidence', 'details'];
const removed = ['code', 'error', 'failed_step', 'iteration', 'diagnostics', 'fix', 'recovery'];
function assertRecord(summary) {
  for (const key of removed) assert.ok(!(key in summary), `summary has no top-level ${key}`);
  for (const key of failureKeys) assert.ok(key in summary.failure, `failure has ${key}`);
  assert.equal(typeof summary.failure.headline, 'string'); assert.match(summary.failure.headline, /^[A-Z].*\.$/);
  assert.ok(Array.isArray(summary.failure.evidence) && summary.failure.evidence.every(item => typeof item === 'string'));
  assert.equal(typeof summary.failure.next.text, 'string');
  return summary.failure;
}

test('a script check that returns evidence as objects passes or fails on its status (R1)', async t => {
  for (const status of ['pass', 'fail']) {
    const result = { status, reason: { code: 7 }, evidence: [{ url: 'https://example.com/a', ok: true }, 'text item'] };
    const f = await fixture(t, method(scriptStep({ check: script('check.mjs'), reading: { check_name: 'Open every cited link' } })),
      { 'action.mjs': 'console.log(JSON.stringify({value: 4}))', 'check.mjs': checkScript(result) });
    const run = await f.run();
    const check = (await f.events()).find(e => e.event === 'check.completed').check;
    assert.deepEqual(check.evidence, ['{"url":"https://example.com/a","ok":true}', 'text item']);
    assert.equal(check.reason, '{"code":7}');
    if (status === 'pass') { assert.equal(run.status, 'completed'); continue; }
    const failure = assertRecord(run);
    assert.equal(failure.code, 'check_failed'); assert.equal(failure.owner, 'agent_work'); assert.equal(failure.phase, 'check');
    assert.equal(failure.check_name, 'Open every cited link'); assert.equal(failure.step, 'work'); assert.equal(failure.step_name, 'Find the value');
    assert.equal(failure.headline, 'In step "Find the value", the check "Open every cited link" did not pass.');
    assert.equal(failure.next.action, 'run_again');
    assert.deepEqual(failure.evidence, check.evidence);
    assert.match(failure.details, /Declared check returned fail/);
    // A script action is not run again: only model and agent work gets a second attempt.
    assert.ok(!(await f.events()).some(e => e.event === 'step.retry'));
  }
  // Evidence that is not a list becomes a list of one; status is never converted.
  const f = await fixture(t, method(scriptStep({ check: script('check.mjs') })), { 'action.mjs': 'console.log(JSON.stringify({value: 4}))', 'check.mjs': checkScript({ status: 'pass', reason: 'ok', evidence: 'one link' }) });
  assert.equal((await f.run()).status, 'completed');
  assert.deepEqual((await f.events()).find(e => e.event === 'check.completed').check.evidence, ['one link']);
});

test('a check status in the wrong form is a problem in the Method code, named by the check and its script', async t => {
  const f = await fixture(t, method(scriptStep({ check: script('check.mjs'), reading: { check_name: 'Open every cited link' } })),
    { 'action.mjs': 'console.log(JSON.stringify({value: 4}))', 'check.mjs': checkScript({ status: 'maybe', reason: 'unsure', evidence: [] }) });
  const failure = assertRecord(await f.run());
  assert.equal(failure.owner, 'method_code'); assert.equal(failure.code, 'invalid_output'); assert.equal(failure.phase, 'check');
  assert.equal(failure.headline, 'In step "Find the value", the check "Open every cited link" (check.mjs) returned status as other text, but it must be one of "pass", "fail", "unknown".');
  assert.equal(failure.next.action, 'fix_method');
  assert.deepEqual(failure.evidence, ['status: found other text, expected one of "pass", "fail", "unknown"']);
  assert.match(failure.details, /check output: data\/status must be equal to one of the allowed values/);
  assert.doesNotMatch(failure.headline, /maybe/);
});

test('validation errors are data: path, expected and found, with the producer', () => {
  assert.throws(() => assertSchema(checkResultSchema, { status: 'pass', reason: 'x', evidence: [{ a: 1 }] }, 'check output', { producer: 'the check script check.mjs', owner: 'method_code' }), error => {
    assert.deepEqual(error.validation, [{ path: 'evidence[0]', expected: 'text', found: 'an object' }]);
    assert.equal(error.producer, 'the check script check.mjs'); assert.equal(error.owner, 'method_code'); assert.equal(error.code, 'invalid_output');
    return true;
  });
  assert.throws(() => assertSchema(checkResultSchema, { reason: 'x' }, 'check output', { producer: 'p', owner: 'agent_work' }), error => error.validation.some(v => v.path === 'status' && v.found === 'missing'));
});

test('a script that exits with an error keeps its last stderr lines in the failure', async t => {
  const f = await fixture(t, method(scriptStep()), { 'action.mjs': 'console.error("first\\nlast line");process.exit(7)' });
  const failure = assertRecord(await f.run());
  assert.equal(failure.owner, 'method_code'); assert.equal(failure.code, 'process_failed'); assert.equal(failure.phase, 'action');
  assert.equal(failure.headline, 'In step "Find the value", the script action.mjs exited with code 7.');
  assert.match(failure.diagnostics, /last line/);
});

test('a provider that still fails after the retries is an outside service, and each retry records a notice', async t => {
  const f = await fixture(t, method(modelStep()));
  let calls = 0;
  const run = await f.run(config(), { transport: async () => { calls++; throw Object.assign(new Error('openai-responses HTTP 429'), { code: 'provider_error', status: 429 }); } });
  assert.equal(calls, 3);
  const failure = assertRecord(run);
  assert.equal(failure.owner, 'outside_service'); assert.equal(failure.code, 'provider_error'); assert.equal(failure.next.action, 'run_again');
  assert.equal(failure.headline, 'In step "Ask the model", the model test-model failed after 3 attempts: openai-responses HTTP 429.');
  const notices = (await f.events()).filter(e => e.event === 'notice');
  assert.deepEqual(notices.map(n => [n.kind, n.key, n.attempt, n.attempts]), [['retry', 'work:0:retry:model', 2, 3], ['retry', 'work:0:retry:model', 3, 3]]);
  assert.equal(notices[0].message, 'The model service (openai-responses) did not answer (rate limit, HTTP 429). Method tries again: attempt 2 of 3.');
  assert.equal(notices[0].step, 'work'); assert.equal(notices[0].iteration, 0);
  // The run.failed event carries the same record and its headline as its message.
  const failed = (await f.events()).find(e => e.event === 'run.failed');
  assert.deepEqual(failed.failure, failure); assert.equal(failed.message, failure.headline);
  assert.deepEqual((await f.summary()).failure, failure);
});

test('a server error that clears records a retry notice and the step completes', async t => {
  const f = await fixture(t, method(modelStep()));
  let calls = 0;
  const run = await f.run(config(), { transport: async () => ++calls === 1 ? Promise.reject(Object.assign(new Error('HTTP 503'), { code: 'provider_error', status: 503 })) : response({ value: 6 }) });
  assert.equal(run.status, 'completed'); assert.equal(run.result, 6);
  const [notice] = (await f.events()).filter(e => e.event === 'notice');
  assert.match(notice.message, /\(server error, HTTP 503\)\. Method tries again: attempt 2 of 3\./);
});

test('a classification timeout records a retry notice with its class', async t => {
  const identity = { provider: 'typesafe', model: 'jev-fixture' };
  const doc = { format: 'method/3.3', name: 'Route', goal: 'Choose a team.', inputs: { message: { type: 'text' } },
    steps: { route: { name: 'Classify message', in: { message: 'inputs.message' }, do: { kind: 'classify', question: 'Which team?', options: { billing: 'Invoices', other: 'Anything else' } }, out: 'category' } }, result: 'category' };
  const f = await fixture(t, doc, {});
  let calls = 0;
  const provider = { resolve: async () => identity, evaluate: async () => {
    if (++calls === 1) throw Object.assign(new Error('timed out'), { code: 'classification_timeout' });
    return { ...identity, choice: 'billing', probabilities: { billing: 1, other: 0 }, confidence: 1, usage: null };
  } };
  const run = await runMethod(f.file, { classification: identity }, { runDir: f.runDir, inputs: { message: 'invoice' }, classification: provider });
  assert.equal(run.status, 'completed');
  const [notice] = (await f.events()).filter(e => e.event === 'notice');
  assert.equal(notice.message, 'The classification service did not answer (timeout). Method tries again: attempt 2 of 3.');
  assert.equal(notice.key, 'route:0:retry:classification');
});

test('time and model request limits: a limit failure says which limit, and 80% use records one notice', async t => {
  const timed = await fixture(t, method(scriptStep({ limits: { timeout_ms: 100 } })), { 'action.mjs': 'setInterval(()=>{},1000)' });
  const failure = assertRecord(await timed.run());
  assert.equal(failure.owner, 'limit'); assert.equal(failure.code, 'timeout'); assert.equal(failure.next.action, 'raise_limit');
  assert.equal(failure.headline, 'In step "Find the value", the run reached its time limit.');
  // The step limit of 100 ms is 80% used before it stops the step.
  assert.ok((await timed.events()).some(e => e.event === 'notice' && e.kind === 'limit' && e.key === 'work:0:limit:time'));

  const doc = method(modelStep({ each: { item: 'inputs.items' } }), { inputs: { items: { type: 'list', items: 'number', description: 'Items.', default: [1, 2, 3, 4, 5, 6] } } });
  const f = await fixture(t, doc);
  const run = await f.run(config(), { transport: async () => response({ value: 1 }) });
  const limit = assertRecord(run);
  assert.equal(limit.owner, 'limit'); assert.equal(limit.code, 'model_limit'); assert.equal(limit.iteration, 5); assert.equal(limit.total, 6);
  assert.equal(limit.headline, 'In step "Ask the model" (task 6 of 6), the run reached its model requests limit (5).');
  const notices = (await f.events()).filter(e => e.event === 'notice' && e.kind === 'limit');
  assert.deepEqual(notices.map(n => [n.key, n.message]), [['::limit:model_requests', 'This run has used 4 of 5 model requests.']]);
});

test('a missing secret stops the run before it starts, with a setup failure that names the next command', async t => {
  const doc = method(scriptStep(), { format: 'method/3.3', secrets: { ARCHIVE_TOKEN: 'Read-only archive token.' } });
  const f = await fixture(t, doc);
  await assert.rejects(f.run(config(), { secrets: {} }), error => {
    const { failure } = error;
    for (const key of failureKeys) assert.ok(key in failure, `failure has ${key}`);
    assert.equal(failure.owner, 'setup'); assert.equal(failure.code, 'missing_secret'); assert.equal(failure.phase, 'setup');
    assert.equal(failure.headline, 'Missing secrets: ARCHIVE_TOKEN.');
    assert.deepEqual(failure.next, { action: 'fix_setup', text: 'Run method secret find to look for ARCHIVE_TOKEN on this computer, or method secret set to enter it. Then run again. No step ran. Never open or print a key file, and never paste a key into a chat.', command: 'method secret set ARCHIVE_TOKEN' });
    return true;
  });
});

test('an ask step that waits is needs_you, with the answer as its next step', async t => {
  const f = await fixture(t, method({ name: 'Approve', purpose: 'Ask a person.', ask: 'Approve the value?', out: { value: number } }));
  const run = await f.run();
  assert.equal(run.status, 'needs_input');
  const failure = assertRecord(run);
  assert.equal(failure.owner, 'needs_you'); assert.equal(failure.code, 'needs_input'); assert.equal(failure.next.action, 'answer');
  assert.equal(failure.headline, 'Step "Approve" waits for your answer.');
  assert.equal((await f.events()).find(e => e.event === 'human.required').message, 'Step "Approve" waits for your answer.');
});

test('a Codex turn that failed with partial output is a Codex failure, not invalid output; stream errors are notices', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-codex-failed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, 'codex');
  await writeFile(command, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{"partial":');
console.log(JSON.stringify({type:'item.completed',item:{id:'e1',type:'error',message:'stream disconnected; retrying 1/5'}}));
console.log(JSON.stringify({type:'error',message:'429 Too Many Requests'}));
console.log(JSON.stringify({type:'turn.failed',error:{message:'exceeded retry limit, last status: 429 Too Many Requests'}}));
`, { mode: 0o700 });
  const file = join(root, 'task.method');
  await writeFile(file, JSON.stringify({ format: 'method/3.1', name: 'Codex', goal: 'Report the turn failure.', steps: { read: { name: 'Search the web', do: { kind: 'agent', model: 'writer', prompt: 'Search.', tools: [] }, out: { text: { type: 'text' } } } }, result: 'text' }));
  const run = await runMethod(file, { allow_local_processes: true, models: { writer: { backend: 'codex', command } } }, { runDir: join(root, 'run') });
  const failure = assertRecord(run);
  assert.equal(failure.code, 'codex_failed'); assert.equal(failure.owner, 'outside_service');
  assert.equal(failure.headline, 'In step "Search the web", Codex failed: exceeded retry limit, last status: 429 Too Many Requests.');
  const events = (await readFile(join(root, 'run/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const notices = events.filter(e => e.event === 'notice');
  assert.deepEqual(notices.map(n => [n.kind, n.key]), [['agent', 'read:0:agent:codex_error'], ['agent', 'read:0:agent:codex_error']]);
  assert.equal(notices[1].message, 'Codex reported an error: 429 Too Many Requests');
});

test('agent stream events become notices by their type only', () => {
  assert.deepEqual(agentEvent({ type: 'error', message: 'x' }), { level: 'error', message: 'x' });
  assert.deepEqual(agentEvent({ type: 'system', subtype: 'api_retry', error: 'rate_limit' }), { level: 'warning', message: 'rate_limit' });
  assert.equal(agentEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'error 429 warning' } }), null);
  assert.equal(agentEvent({ type: 'turn.failed', error: { message: 'x' } }), null);
});

test('a model step whose check fails once gets one more attempt with the check feedback, and is accepted', async t => {
  const doc = method(modelStep({ check: script('check.mjs'), reading: { check_name: 'Value is six' } }));
  const f = await fixture(t, doc, { 'check.mjs': 'let s="";for await(const x of process.stdin)s+=x;const v=JSON.parse(s).outputs.value;console.log(JSON.stringify(v===6?{status:"pass",reason:"six",evidence:[]}:{status:"fail",reason:"The value is not six.",evidence:["value="+v]}))' });
  let calls = 0;
  const run = await f.run(config(), { transport: async () => response({ value: ++calls === 1 ? 4 : 6 }) });
  assert.equal(run.status, 'completed'); assert.equal(run.result, 6); assert.equal(calls, 2);
  const events = await f.events();
  const retry = events.find(e => e.event === 'step.retry');
  assert.deepEqual({ step: retry.step, iteration: retry.iteration, attempt: retry.attempt, attempts: retry.attempts, reason: retry.reason, evidence: retry.evidence },
    { step: 'work', iteration: 0, attempt: 2, attempts: 2, reason: 'The value is not six.', evidence: ['value=4'] });
  assert.equal(retry.message, 'The check "Value is six" did not pass. Step "Ask the model" runs again: attempt 2 of 2.');
  const prompts = events.filter(e => e.event === 'prompt.rendered' && e.phase === 'action');
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0].rendered, /did not pass/);
  assert.match(prompts[1].rendered, /did not pass the check "Value is six"/); assert.match(prompts[1].rendered, /The value is not six\./); assert.match(prompts[1].rendered, /- value=4/);
  // A second failure fails the run as a failed check after 2 attempts.
  const g = await fixture(t, doc, { 'check.mjs': checkScript({ status: 'fail', reason: 'never', evidence: [] }) });
  const failure = assertRecord(await g.run(config(), { transport: async () => response({ value: 1 }) }));
  assert.equal(failure.code, 'check_failed'); assert.equal(failure.headline, 'In step "Ask the model", the check "Value is six" did not pass after 2 attempts.');
  assert.equal((await g.events()).filter(e => e.event === 'step.retry').length, 1);
});

test('a step that changes the outside world is not run again after a failed check', async t => {
  const doc = method(modelStep({ check: script('check.mjs'), changes: ['environment.game'] }), { environment: { game: { type: 'service', description: 'Test target.' } } });
  const f = await fixture(t, doc, { 'check.mjs': checkScript({ status: 'fail', reason: 'no', evidence: [] }) });
  let calls = 0;
  const failure = assertRecord(await f.run(config({ environment: { game: 'test-game' } }), { transport: async () => { calls++; return response({ value: 1 }); } }));
  assert.equal(failure.code, 'check_failed'); assert.equal(calls, 1);
  assert.ok(!(await f.events()).some(e => e.event === 'step.retry'));
});

test('user-facing events carry one plain sentence, and step.started of an each step carries the task total', async t => {
  const doc = method(scriptStep({ each: { item: 'inputs.items' }, check: { present: 'value' } }), { inputs: { items: { type: 'list', items: 'number', description: 'Items.', default: [1, 2, 3] } } });
  const f = await fixture(t, doc);
  assert.equal((await f.run()).status, 'completed');
  const events = await f.events();
  const message = name => events.filter(e => e.event === name).map(e => e.message);
  assert.deepEqual(message('run.started'), ['Method "Test" started.']);
  assert.deepEqual(message('step.started'), ['Step "Find the value" (task 1 of 3) started.', 'Step "Find the value" (task 2 of 3) started.', 'Step "Find the value" (task 3 of 3) started.']);
  assert.deepEqual(events.filter(e => e.event === 'step.started').map(e => e.total), [3, 3, 3]);
  assert.equal(message('step.accepted')[0], 'Step "Find the value" (task 1 of 3) finished.');
  assert.equal(message('check.completed')[0], 'The check "present" passed.');
  assert.deepEqual(message('run.completed'), ['The run finished.']);
  // A step without each has no total.
  const g = await fixture(t, method(scriptStep()));
  await g.run();
  assert.ok(!('total' in (await g.events()).find(e => e.event === 'step.started')));
});

test('a stopped run is a setup failure that says it was stopped', async t => {
  const f = await fixture(t, method(scriptStep()), { 'action.mjs': 'setInterval(()=>{},1000)' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(Object.assign(new Error('Interrupted by operator'), { code: 'interrupted' })), 200);
  const failure = assertRecord(await f.run(config(), { signal: controller.signal }));
  assert.equal(failure.owner, 'setup'); assert.equal(failure.code, 'stopped');
  assert.equal(failure.headline, 'The run was stopped on this computer (in step "Find the value").');
});
