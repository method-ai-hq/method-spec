import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { writeJSON } from '../src/io.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod, validateMethod, validateConfig } from '../src/index.js';
import { typesafeClassification } from '../src/classification.js';

const identity = { provider: 'typesafe', model: 'jev-fixture' };
const items = [1, 2, 3, 4, 5, 6, 7];
const doc = (concurrency = 3) => ({
  format: 'method/3.3', name: 'Route', goal: 'Choose a team for each message.',
  inputs: { messages: { type: 'list', items: 'number' } },
  steps: { route: { name: 'Classify message', each: { message: 'inputs.messages' }, ...(concurrency ? { concurrency } : {}),
    do: { kind: 'classify', question: 'Which team?', options: { billing: 'Invoices', other: 'Anything else' } }, out: 'category' } },
  result: 'category',
});
const answer = message => ({ ...identity, choice: message % 2 ? 'billing' : 'other', probabilities: message % 2 ? { billing: 1, other: 0 } : { billing: 0, other: 1 }, confidence: 1, usage: null });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, method = doc()) {
  const dir = await mkdtemp(join(tmpdir(), 'method-concurrency-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.method'); await writeFile(file, JSON.stringify(method));
  const runDir = join(dir, 'run');
  const cfg = { classification: identity, limits: { max_invocations: 50, max_model_requests: 50 } };
  return { file, runDir, cfg,
    run: (provider, options = {}, config = cfg) => runMethod(file, config, { runDir, ...(options.resume ? {} : { inputs: { messages: items } }), classification: provider, ...options }),
    checkpoint: async () => JSON.parse(await readFile(join(runDir, 'checkpoint.json'), 'utf8')) };
}
/** A provider that answers after a delay and counts how many requests are open at once. */
function counting(delay = message => 30 - message * 3) {
  const seen = { open: 0, most: 0, calls: [] };
  seen.provider = { resolve: async () => identity, async evaluate(request) {
    seen.calls.push(request.inputs.message); seen.most = Math.max(seen.most, ++seen.open);
    try { await pause(delay(request.inputs.message)); if (seen.fail?.(request.inputs.message)) throw Object.assign(Error('provider down'), { code: 'provider_error' }); return answer(request.inputs.message); }
    finally { seen.open--; }
  } };
  return seen;
}

test('each with concurrency runs items at once and keeps item order', async t => {
  const f = await fixture(t), seen = counting();
  const result = await f.run(seen.provider);
  assert.equal(result.status, 'completed');
  assert.ok(seen.most > 1 && seen.most <= 3, `at most 3 at once, ran ${seen.most}`);
  assert.deepEqual(result.result.map(x => x.choice), items.map(m => m % 2 ? 'billing' : 'other'));
  assert.equal(result.invocations, items.length); assert.equal(result.model_requests, items.length);
});

test('the operator limit caps concurrency, and no concurrency runs one item at a time', async t => {
  const capped = await fixture(t, doc(32)), seen = counting();
  assert.equal((await capped.run(seen.provider, {}, { ...capped.cfg, limits: { ...capped.cfg.limits, max_concurrency: 2 } })).status, 'completed');
  assert.ok(seen.most <= 2, `at most 2 at once, ran ${seen.most}`);
  const serial = await fixture(t, doc(0)), one = counting();
  assert.equal((await serial.run(one.provider)).status, 'completed');
  assert.equal(one.most, 1); assert.deepEqual(one.calls, items);
});

test('the first failure stops the other items, and resume runs only the unfinished ones', async t => {
  const f = await fixture(t), seen = counting(message => message === 2 ? 5 : 40);
  seen.fail = message => message === 2;
  const failed = await f.run(seen.provider);
  assert.equal(failed.status, 'failed'); assert.equal(failed.code, 'provider_error');
  const saved = await f.checkpoint();
  // The failure stopped the run before every item started.
  assert.ok(seen.calls.length < items.length);
  const again = counting(); seen.fail = null;
  await assert.rejects(f.run(again.provider, { resume: true }), /--retry route:/);
  const resumed = await f.run(again.provider, { resume: true, retry: [saved.active] });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.result.map(x => x.choice), items.map(m => m % 2 ? 'billing' : 'other'));
});

test('resume keeps the items that finished before a failure', async t => {
  const f = await fixture(t), seen = counting(message => message === 6 ? 60 : 5);
  seen.fail = message => message === 6;
  assert.equal((await f.run(seen.provider)).status, 'failed');
  const accepted = (await f.checkpoint()).accepted.route;
  assert.ok(accepted.filter(Boolean).length >= 4);
  const again = counting();
  const resumed = await f.run(again.provider, { resume: true, retry: ['route:5'] });
  assert.equal(resumed.status, 'completed');
  assert.equal(again.calls.length, items.length - accepted.filter(Boolean).length);
  assert.deepEqual(resumed.result.map(x => x.choice), items.map(m => m % 2 ? 'billing' : 'other'));
});

test('concurrency requires each and a step that changes nothing', () => {
  validateMethod(doc());
  for (const edit of [
    m => { delete m.steps.route.each; m.steps.route.in = { message: 'inputs.messages' }; },
    m => m.steps.route.concurrency = 0,
    m => { m.state = { seen: { type: 'number', default: 0 } }; m.steps.route.do = { kind: 'run', runtime: 'node', entrypoint: 'a.mjs' }; m.steps.route.name = 'Count'; m.steps.route.purpose = 'Count.'; m.steps.route.out = { n: { type: 'number', description: 'N.' } }; m.steps.route.changes = ['state.seen']; m.result = 'n'; },
  ]) { const m = doc(); edit(m); assert.throws(() => validateMethod(m)); }
  validateConfig({ limits: { max_concurrency: 4 } });
  assert.throws(() => validateConfig({ limits: { max_concurrency: 0 } }));
});

test('an own OpenRouter key calls Jev through OpenRouter directly and is never recorded', async t => {
  const f = await fixture(t, doc(2));
  const original = globalThis.fetch, requests = [];
  process.env.METHOD_TEST_OPENROUTER_KEY = 'ts-secret-key';
  t.after(() => { globalThis.fetch = original; delete process.env.METHOD_TEST_OPENROUTER_KEY; });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, auth: init.headers.authorization, body });
    const a = answer(body.state.message);
    return new Response(JSON.stringify({ model: `typesafe/${body.model}-20260917`, answers: { classification: { type: 'choice', choice: a.choice, probabilities: a.probabilities, confidence: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1, cost: 0.5 } }));
  };
  const managed = { resolve: async () => identity, evaluate: async () => { throw Error('the managed provider must not be used'); } };
  const result = await f.run(managed, {}, { ...f.cfg, classification: { ...identity, api_key_env: 'METHOD_TEST_OPENROUTER_KEY' } });
  assert.equal(result.status, 'completed');
  assert.equal(requests.length, items.length);
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/systemone'); assert.equal(requests[0].auth, 'Bearer ts-secret-key');
  assert.equal(result.usage.input_tokens, 3 * items.length); assert.equal(result.usage.cost_usd, 0.5 * items.length);
  assert.ok(!(await readFile(join(f.runDir, 'events.jsonl'), 'utf8')).includes('ts-secret-key'));
});

test('a missing own OpenRouter key fails before any request', async t => {
  const f = await fixture(t);
  const result = await f.run(undefined, {}, { ...f.cfg, classification: { ...identity, api_key_env: 'METHOD_TEST_MISSING_KEY' } }).catch(error => error);
  assert.match(String(result.message ?? result.error), /METHOD_TEST_MISSING_KEY/);
  await assert.rejects(typesafeClassification('METHOD_TEST_MISSING_KEY').evaluate({ model: 'x', question: 'q', options: {}, inputs: {} }), /METHOD_TEST_MISSING_KEY/);
});

test('writes of the same JSON file at the same time do not collide', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  await Promise.all(Array.from({ length: 50 }, (_, i) => writeJSON(file, { i })));
  assert.equal(typeof JSON.parse(await readFile(file, 'utf8')).i, 'number');
  assert.deepEqual((await readdir(dir)).sort(), ['state.json']);
});
