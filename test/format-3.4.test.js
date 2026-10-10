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

test('the 3.4 fields need format method/3.4', () => {
  const older = change => newsletter(m => { m.format = 'method/3.3'; delete m.id; delete m.models; m.steps.write.do.model = 'writer'; m.steps.intro.do.model = 'writer'; m.steps.fields.do.model = 'writer'; delete m.steps.fields.accept; change(m); });
  validateMethod(older(() => {}));
  for (const [change, pattern] of [
    [m => { m.id = 'wf_3cfa2d6d2c00552ce5a4ab723a8248fe'; }, /id requires method\/3\.4/],
    [m => { m.models = { writer: 'openai/gpt-6-luna' }; }, /models requires method\/3\.4/],
    [m => { m.steps.fields.accept = { unused_output: 'Kept for later.' }; }, /fields\.accept requires method\/3\.4/],
    [m => { delete m.steps.fields.do.model; }, /fields\.do\.model/],
    [m => { m.steps.intro.do.model = 'openai/gpt-6-luna'; }, /model ID requires method\/3\.4/],
  ]) assert.throws(() => validateMethod(older(change)), pattern);
});

test('a method/3.3 file validates unchanged', async () => {
  for (const file of ['examples/counter.method', 'examples/model-tools.method', 'examples/factory-decision.method']) {
    const doc = await readDocument(file);
    const before = JSON.stringify(doc);
    validateMethod(doc);
    assert.equal(JSON.stringify(doc), before);
    assert.equal(methodIssues(doc).filter(issue => issue.level === 'error').length, 0, file);
  }
  const current = { format: 'method/3.3', name: 'Count words', goal: 'Count the words in a text.', inputs: { text: { type: 'text' } },
    steps: { count: { in: { text: 'inputs.text' }, do: { kind: 'call', model: 'default', prompt: 'Count the words in {{text}}.' }, out: { words: { type: 'number' } } } }, result: 'words' };
  assert.deepEqual(validateMethod(current).order, ['count']);
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

test('the contributor harness reads no configuration file and has no --config', async t => {
  const help = execFileSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' });
  assert.equal(help.includes('--config'), false);
  assert.match(execFileSync(process.execPath, ['src/cli.js', '--version'], { encoding: 'utf8' }), /method\/3\.4/);
  const dir = await mkdtemp(join(tmpdir(), 'method-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'newsletter.method');
  await writeFile(file, JSON.stringify(newsletter(m => { m.steps.write.out.draft_notes = { type: 'text' }; })));
  const report = JSON.parse(execFileSync(process.execPath, ['src/cli.js', 'validate', file], { encoding: 'utf8' }));
  assert.equal(report.valid, true);
  assert.deepEqual(report.issues.map(issue => issue.code), ['unused_output', 'accept_unused']);
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
  assert.throws(() => validateMethod(newsletter(m => { m.format = 'method/3.3'; delete m.id; delete m.models; delete m.steps.fields.accept; m.limits = { timeout_ms: 1 }; })), /limits requires method\/3.4|requires method\/3.4/);
});

test('a run uses the document limits and tools without configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'method-34-limits-'));
  try {
    const method = { format: 'method/3.4', name: 'Limits', goal: 'Stop at the document cap.', limits: { max_invocations: 1 },
      steps: { a: { name: 'A', purpose: 'Return one; changes nothing.', do: { kind: 'run', runtime: 'node', entrypoint: 'one.mjs' }, out: { one: { type: 'number', description: 'One.' } } },
        b: { name: 'B', purpose: 'Return two; changes nothing.', after: 'a', do: { kind: 'run', runtime: 'node', entrypoint: 'one.mjs' }, out: { two: { type: 'number', description: 'Two.' } } } }, result: 'two' };
    await writeFile(join(root, 'task.method'), JSON.stringify(method));
    await writeFile(join(root, 'one.mjs'), 'for await (const c of process.stdin) {}; console.log(JSON.stringify({one: 1, two: 2}));');
    const result = await runMethod(join(root, 'task.method'), { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: 'test' } } }, { runDir: join(root, 'run') });
    assert.notEqual(result.status, 'completed');
    assert.match(JSON.stringify(result), /invocation/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
