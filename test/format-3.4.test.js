import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateMethod, methodIssues, documentForDigest, runMethod, readDocument } from '../src/index.js';
import { resolveModels, packageModels } from '../src/agents.js';
import { hash } from '../src/io.js';

// A newsletter Method: one named model, one model ID, and one step on the account default.
const newsletter = (change = () => {}) => {
  const method = {
    format: 'method/3.4', id: 'wf_3cfa2d6d2c00552ce5a4ab723a8248fe', name: 'Weekly newsletter', goal: 'Write the weekly customer newsletter.',
    models: { writer: 'openai/gpt-6-luna', fields_writer: { model: 'deepseek/deepseek-v4.1-flash', max_output_tokens: 4000, reasoning_effort: 'low' } },
    inputs: { notes: { type: 'text', description: 'This week\'s release notes.' } },
    steps: {
      write: { in: { notes: 'inputs.notes' }, do: { kind: 'call', model: 'writer', prompt: 'Write the newsletter from {{notes}}.' }, out: { body: { type: 'text' } } },
      intro: { in: { body: 'body' }, do: { kind: 'call', model: 'openai/gpt-6-luna', prompt: 'Write a two-line intro for {{body}}.' }, out: { intro: { type: 'text' } } },
      fields: { in: { body: 'body' }, do: { kind: 'call', prompt: 'List the subject line and preview text for {{body}}.' },
        out: { subject: { type: 'text' }, preview: { type: 'text' } }, accept: { prompt_multiple_tasks: 'The user wants one combined field list.' } },
    },
    result: { intro: 'intro', subject: 'subject', preview: 'preview', body: 'body' },
  };
  change(method);
  return method;
};

test('method/3.4 accepts id, models, a model ID, an absent model, and accept', () => {
  const { order } = validateMethod(newsletter());
  assert.deepEqual(order, ['write', 'intro', 'fields']);
  assert.deepEqual(methodIssues(newsletter(), { notChecked: ['prompt_multiple_tasks'] }), []);
  assert.throws(() => validateMethod(newsletter(m => { m.id = 'wf_short'; })), /id/);
  assert.throws(() => validateMethod(newsletter(m => { m.models.writer = 'gpt-6-luna'; })), /models/);
  assert.throws(() => validateMethod(newsletter(m => { m.models.writer = { model: 'openai/gpt-6-luna', temperature: 1 }; })), /models/);
  assert.throws(() => validateMethod(newsletter(m => { m.steps.fields.accept = { 'Not A Code': 'x' }; })), /accept/);
});

test('a plain model name must be in models; default keeps meaning the account default', () => {
  const [issue] = methodIssues(newsletter(m => { m.steps.write.do.model = 'editor'; }));
  assert.equal(issue.code, 'unknown_model'); assert.equal(issue.step, 'write'); assert.equal(issue.field, 'do.model'); assert.match(issue.fix, /Add editor to models/);
  validateMethod(newsletter(m => { m.steps.write.do.model = 'default'; }));
  // Without a models block, a plain name is unknown too: no configuration file supplies models.
  const [missing] = methodIssues(newsletter(m => { delete m.models; m.steps.write.do.model = 'editor'; m.steps.intro.do.model = 'default'; m.steps.fields.do.model = 'default'; }));
  assert.equal(missing.code, 'unknown_model'); assert.equal(missing.step, 'write');
});

test('every example validates with no errors and is not changed by validation', async () => {
  const { readdir } = await import('node:fs/promises');
  const examples = (await readdir('examples')).filter(name => name.endsWith('.method'));
  assert.ok(examples.length > 0);
  for (const file of examples.map(name => join('examples', name))) {
    const doc = await readDocument(file);
    const before = JSON.stringify(doc);
    validateMethod(doc);
    assert.equal(JSON.stringify(doc), before);
    assert.equal(methodIssues(doc).filter(issue => issue.level === 'error').length, 0, file);
  }
});

test('the document digest leaves out id', () => {
  const withId = newsletter(), copy = newsletter(m => { m.id = 'wf_00000000000000000000000000000001'; }), without = newsletter(m => { delete m.id; });
  assert.equal(hash(documentForDigest(withId)), hash(documentForDigest(copy)));
  assert.equal(hash(documentForDigest(withId)), hash(documentForDigest(without)));
  assert.notEqual(hash(documentForDigest(withId)), hash(documentForDigest(newsletter(m => { m.goal = 'Another goal.'; }))));
  assert.equal(withId.id, 'wf_3cfa2d6d2c00552ce5a4ab723a8248fe');
});

test('model resolution: Method models and model IDs are hosted, before configured profiles; --agent runs every step', async () => {
  const doc = newsletter();
  const config = { models: { writer: { backend: 'openai-responses', model: 'gpt-x', api_key_env: 'OPENAI_API_KEY', max_output_tokens: 100 } } };
  const profiles = await resolveModels(doc, config, { hostedModel: 'account/default-model', env: {} });
  assert.deepEqual(profiles.writer, { backend: 'method', model: 'openai/gpt-6-luna' });
  assert.deepEqual(profiles.fields_writer, { backend: 'method', model: 'deepseek/deepseek-v4.1-flash', max_output_tokens: 4000, reasoning_effort: 'low' });
  assert.deepEqual(profiles['openai/gpt-6-luna'], { backend: 'method', model: 'openai/gpt-6-luna' });
  assert.deepEqual(profiles.default, { backend: 'method', model: 'account/default-model' });
  // Configured profiles fill names that the Method does not define.
  const legacy = newsletter(m => { delete m.models; m.steps.write.do.model = 'editor'; });
  assert.equal((await resolveModels(legacy, { models: { editor: { backend: 'claude' } } }, { hostedModel: 'a/b', env: {} })).editor.backend, 'claude');
  // --agent overrides every model step.
  const local = await resolveModels(doc, config, { agent: 'codex', hostedModel: 'a/b', env: {} });
  assert.deepEqual(Object.keys(local).sort(), ['default', 'openai/gpt-6-luna', 'writer']);
  assert.ok(Object.values(local).every(profile => profile.backend === 'codex'));
  // Resume keeps the saved profiles.
  const saved = { writer: { backend: 'claude' }, 'openai/gpt-6-luna': { backend: 'claude' }, default: { backend: 'claude' } };
  assert.deepEqual(await resolveModels(doc, config, { savedModels: saved, agent: 'codex' }), saved);
});

test('a saved package with runtime.json still runs: its models are used only when the document has no models', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'runtime.json'), JSON.stringify({ models: { editor: { backend: 'method', model: 'old/model' } }, allow_local_processes: true }));
  const legacy = newsletter(m => { delete m.models; m.steps.write.do.model = 'editor'; m.steps.intro.do.model = 'editor'; });
  const models = await packageModels(legacy, dir);
  assert.deepEqual(models, { editor: { backend: 'method', model: 'old/model' } });
  assert.deepEqual((await resolveModels(legacy, {}, { packageModels: models, hostedModel: 'a/b', env: {} })).editor, { backend: 'method', model: 'old/model' });
  assert.equal(await packageModels(newsletter(), dir), undefined);
  assert.equal(await packageModels(legacy, join(dir, 'missing')), undefined);
});

test('a 3.4 run sends each step to its hosted model, and resume survives an id written after the run started', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-34-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'newsletter.method');
  const doc = newsletter(m => { delete m.id; });
  await writeFile(file, JSON.stringify(doc));
  const sent = [];
  const reply = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const hostedModels = { request: async body => {
    sent.push(body);
    const prompt = body.messages[0].content;
    return reply(prompt.startsWith('Write the newsletter') ? { body: 'News.' } : prompt.startsWith('Write a two-line') ? { intro: 'Hi.' } : { subject: 'S', preview: 'P' });
  } };
  const result = await runMethod(file, {}, { runDir: join(dir, 'run'), inputs: { notes: 'Faster search.' }, hostedModels, hostedModel: 'account/default-model', env: {} });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(sent.map(body => body.model), ['openai/gpt-6-luna', 'openai/gpt-6-luna', 'account/default-model']);
  const checkpoint = JSON.parse(await readFile(join(dir, 'run', 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.method_sha256, hash(documentForDigest(doc)));
  // The CLI writes the id line at the first signed-in save; the saved digest still matches.
  await writeFile(file, JSON.stringify({ ...doc, id: 'wf_3cfa2d6d2c00552ce5a4ab723a8248fe' }));
  assert.equal(hash(documentForDigest(await readDocument(file))), checkpoint.method_sha256);
});

test('the contributor harness validates a document without a configuration file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'newsletter.method');
  await writeFile(file, JSON.stringify(newsletter(m => { m.steps.write.out.draft_notes = { type: 'text' }; })));
  const report = JSON.parse(execFileSync(process.execPath, ['src/cli.js', 'validate', file], { encoding: 'utf8' }));
  assert.equal(report.valid, true);
  assert.deepEqual(report.issues.map(issue => issue.code).sort(), ['accept_unused', 'unused_output']);
});

test('method/3.4 holds limits, limits.step, and tools; the document comes before the configuration', async () => {
  const { configuration } = await import('../src/defaults.js');
  const tool = { description: 'Double a number.', in: { n: { type: 'number' } }, out: { doubled: { type: 'number' } }, run: { kind: 'run', runtime: 'node', entrypoint: 'double.mjs' }, effects: [] };
  const method = newsletter(m => { m.limits = { max_model_requests: 3, step: { timeout_ms: 5000 } }; m.tools = { double: tool }; });
  validateMethod(method);
  const config = configuration({ limits: { max_model_requests: 50, max_tool_calls: 7 }, step_defaults: { timeout_ms: 1, max_agent_turns: 4 }, tools: { double: { ...tool, description: 'Old.' }, other: tool } }, method);
  assert.equal(config.limits.max_model_requests, 3); assert.equal(config.limits.max_tool_calls, 7);
  assert.deepEqual([config.step_defaults.timeout_ms, config.step_defaults.max_agent_turns], [5000, 4]);
  assert.equal(config.tools.double.description, 'Double a number.'); assert.ok(config.tools.other);
  assert.throws(() => validateMethod(newsletter(m => { m.limits = { effect_wait_ms: 1 }; })), /limits/);
});

test('a run uses the document limits and tools without configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'method-34-limits-'));
  try {
    const method = { format: 'method/3.4', name: 'Limits', goal: 'Stop at the document cap.', limits: { max_invocations: 1 },
      steps: { a: { name: 'A', purpose: 'Return one; changes nothing.', do: { kind: 'run', runtime: 'node', entrypoint: 'one.mjs' }, out: { one: { type: 'number', description: 'One.' } } },
        b: { name: 'B', purpose: 'Return two; changes nothing.', after: 'a', do: { kind: 'run', runtime: 'node', entrypoint: 'two.mjs' }, out: { two: { type: 'number', description: 'Two.' } } } }, result: 'two' };
    await writeFile(join(root, 'task.method'), JSON.stringify(method));
    await writeFile(join(root, 'one.mjs'), 'for await (const c of process.stdin) {}; console.log(JSON.stringify({one: 1}));');
    await writeFile(join(root, 'two.mjs'), 'for await (const c of process.stdin) {}; console.log(JSON.stringify({two: 2}));');
    const result = await runMethod(join(root, 'task.method'), { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: 'test' } } }, { runDir: join(root, 'run') });
    assert.equal(result.code, 'invocation_limit');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Method 3.4 local-agent entries: models: {NAME: {agent: codex | claude, model?, reasoning_effort?}}.
const mixed = (change = () => {}) => {
  const method = {
    format: 'method/3.4', name: 'Mixed models', goal: 'Draft with Codex, edit with Claude, and title with a hosted model.',
    models: { drafter: { agent: 'codex', reasoning_effort: 'low' }, editor: { agent: 'claude', model: 'claude-test', reasoning_effort: 'high' }, titler: 'openai/gpt-6-luna' },
    inputs: { notes: { type: 'text' } },
    steps: {
      draft: { in: { notes: 'inputs.notes' }, do: { kind: 'call', model: 'drafter', prompt: 'Draft from {{notes}}.' }, out: { draft: { type: 'text' } } },
      edit: { in: { draft: 'draft' }, do: { kind: 'agent', model: 'editor', prompt: 'Edit {{draft}}.', tools: [] }, out: { edited: { type: 'text' } } },
      title: { in: { edited: 'edited' }, do: { kind: 'call', model: 'titler', prompt: 'Title {{edited}}.' }, out: { title: { type: 'text' } } },
    },
    result: { title: 'title', edited: 'edited' },
  };
  change(method);
  return method;
};

test('a models entry can name a local agent; other agent fields are refused', () => {
  validateMethod(mixed());
  validateMethod(mixed(m => { m.models.drafter = { agent: 'claude' }; }));
  assert.throws(() => validateMethod(mixed(m => { m.models.drafter = { agent: 'gemini' }; })), /models/);
  assert.throws(() => validateMethod(mixed(m => { m.models.drafter = { agent: 'codex', max_output_tokens: 10 }; })), /models/);
  assert.throws(() => validateMethod(mixed(m => { m.models.drafter = { agent: 'codex', model: 'x', command: '/bin/sh' }; })), /models/);
});

test('model resolution: an agent entry is a local-agent profile; --agent still runs every step', async () => {
  const profiles = await resolveModels(mixed(), {}, { hostedModel: 'a/b', env: {} });
  assert.deepEqual(profiles.drafter, { backend: 'codex', reasoning_effort: 'low' });
  assert.deepEqual(profiles.editor, { backend: 'claude', model: 'claude-test', reasoning_effort: 'high' });
  assert.deepEqual(profiles.titler, { backend: 'method', model: 'openai/gpt-6-luna' });
  // The Method's entry comes before a configured profile of the same name.
  assert.deepEqual((await resolveModels(mixed(), { models: { drafter: { backend: 'claude' } } }, { env: {} })).drafter, { backend: 'codex', reasoning_effort: 'low' });
  const claude = await resolveModels(mixed(), {}, { agent: 'claude', env: {} });
  assert.deepEqual(claude, { drafter: { backend: 'claude' }, editor: { backend: 'claude', model: 'claude-test', reasoning_effort: 'high' }, titler: { backend: 'claude' } });
  const codex = await resolveModels(mixed(), {}, { agent: 'codex', env: {} });
  assert.deepEqual(codex, { drafter: { backend: 'codex', reasoning_effort: 'low' }, editor: { backend: 'codex' }, titler: { backend: 'codex' } });
});

test('a 3.4 Method that mixes hosted and agent entries runs each step on its own backend', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-34-agents-'));
  const prior = process.env.PATH;
  t.after(async () => { process.env.PATH = prior; await rm(dir, { recursive: true, force: true }); });
  const log = join(dir, 'calls.jsonl');
  // Fake agents on PATH: each records its arguments and returns its step output.
  await writeFile(join(dir, 'codex'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: 'codex', args }) + '\\n');
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ draft: 'Codex draft.' }));
`, { mode: 0o700 });
  await writeFile(join(dir, 'claude'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: 'claude', args }) + '\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { edited: 'Claude edit.' } }));
`, { mode: 0o700 });
  const file = join(dir, 'mixed.method');
  await writeFile(file, JSON.stringify(mixed()));
  const sent = [];
  const hostedModels = { request: async body => { sent.push(body.model); return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'Title.' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } };
  // An agent entry needs that agent installed.
  process.env.PATH = join(dir, 'missing');
  await assert.rejects(runMethod(file, { allow_local_processes: true }, { runDir: join(dir, 'missing-run'), inputs: { notes: 'N' }, hostedModels, env: {} }), /codex/);
  process.env.PATH = dir;
  const result = await runMethod(file, { allow_local_processes: true }, { runDir: join(dir, 'run'), inputs: { notes: 'N' }, hostedModels, env: {} });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.result, { title: 'Title.', edited: 'Claude edit.' });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.agent), ['codex', 'claude']);
  assert.ok(calls[0].args.includes('model_reasoning_effort="low"'));
  assert.equal(calls[0].args.includes('--model'), false);
  assert.equal(calls[1].args[calls[1].args.indexOf('--model') + 1], 'claude-test');
  assert.equal(calls[1].args[calls[1].args.indexOf('--effort') + 1], 'high');
  assert.deepEqual(sent, ['openai/gpt-6-luna']);
});
