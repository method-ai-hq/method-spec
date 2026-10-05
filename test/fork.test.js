import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod } from '../src/index.js';

const number = { type: 'number', description: 'A test number.' };
const file = { type: 'file', description: 'A test file.' };
const script = entrypoint => ({ kind: 'run', runtime: 'node', entrypoint });
const config = () => ({
  limits: { timeout_ms: 10000, max_model_requests: 5, max_invocations: 20, max_tool_calls: 5, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
  runtimes: { node: { command: process.execPath, version: process.version } },
  models: { model: { backend: 'openai-responses', model: 'test-model', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100 } },
});
const response = value => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 1, output_tokens: 1 } });

// prepare (script with a file output) -> write (expensive model call) -> finish (script that has a bug)
const method = () => ({
  format: 'method/3.1', name: 'Fork', goal: 'Test forks.',
  inputs: { start: number },
  steps: {
    prepare: { purpose: 'Save a note.', in: { start: 'inputs.start' }, do: script('prepare.mjs'), out: { note: file, base: number }, limits: { timeout_ms: 1500 } },
    write: { purpose: 'Ask a model.', in: { base: 'base' }, do: { kind: 'call', model: 'model', prompt: 'Return value.' }, out: { draft: number }, limits: { timeout_ms: 1500, max_model_requests: 1 } },
    finish: { purpose: 'Finish.', in: { draft: 'draft', note: 'note' }, do: script('finish.mjs'), out: { total: number }, limits: { timeout_ms: 1500 } },
  },
  result: 'total',
});
const prepare = 'import{writeFileSync,readFileSync}from"node:fs";import{createHash}from"node:crypto";const a=JSON.parse(readFileSync(0,"utf8"));const p=process.env.METHOD_OUTPUT_DIR+"/note.txt";writeFileSync(p,"note");console.log(JSON.stringify({note:{path:"note.txt",sha256:createHash("sha256").update("note").digest("hex")},base:a.start}))';
const broken = 'console.log(JSON.stringify({wrong:1}))';
const fixed = 'import{readFileSync,existsSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));if(!existsSync(process.env.METHOD_OUTPUT_DIR+"/"+a.note.path))process.exit(3);console.log(JSON.stringify({total:a.draft+1}))';

async function failedParent(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'method3-fork-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries({ 'prepare.mjs': prepare, 'finish.mjs': broken, ...files })) await writeFile(join(dir, name), source);
  const path = join(dir, 'test.method'); await writeFile(path, JSON.stringify(method()));
  let calls = 0;
  const transport = async () => { calls++; return response({ draft: 41 }); };
  const parent = join(dir, 'parent');
  const failed = await runMethod(path, config(), { runDir: parent, inputs: { start: 2 }, transport });
  assert.equal(failed.status, 'failed'); assert.equal(failed.code, 'invalid_output'); assert.equal(calls, 1);
  assert.match(failed.recovery, new RegExp(`--from-run ${parent} --reuse prepare,write\\.`));
  let forks = 0;
  const fork = (options = {}, doc = method()) => writeFile(path, JSON.stringify(doc)).then(() => runMethod(path, config(), { runDir: join(dir, `fork-${++forks}`), fromRun: parent, transport, ...options }));
  return { dir, parent, fork, calls: () => calls, write: (name, source) => writeFile(join(dir, name), source) };
}
const events = async dir => (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

test('a fork reuses accepted upstream steps after a downstream fix', async t => {
  const f = await failedParent(t);
  await f.write('finish.mjs', fixed);
  const result = await f.fork({ reuse: ['prepare', 'write'] });
  assert.equal(result.status, 'completed'); assert.equal(result.result, 42);
  assert.equal(f.calls(), 1, 'the model step is not called again');
  assert.equal(result.invocations, 1);
  assert.deepEqual(result.forked_from.changed_files, [{ file: 'finish.mjs', change: 'changed' }]);
  assert.equal(result.forked_from.file_evidence, 'entrypoints');
  const log = await events(result.run_dir);
  const parentStart = (await events(f.parent)).find(e => e.event === 'run.started');
  assert.deepEqual(log.filter(e => e.event === 'step.imported').map(e => [e.step, e.parent_execution_id]), [['prepare', parentStart.execution_id], ['write', parentStart.execution_id]]);
  assert.equal(log.find(e => e.event === 'run.started').forked_from.run_dir, f.parent);
  assert.deepEqual(log.filter(e => e.event === 'step.started').map(e => e.step), ['finish']);
  assert.equal(await readFile(join(result.run_dir, 'artifacts', 'note.txt'), 'utf8'), 'note');
  assert.equal(JSON.parse(await readFile(join(result.run_dir, 'checkpoint.json'), 'utf8')).forked_from.execution_id, parentStart.execution_id);
});

test('a fork refuses steps whose execution could differ from the parent', async t => {
  const f = await failedParent(t);
  const refused = async (options, pattern, doc) => {
    const result = await f.fork(options, doc);
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'fork_mismatch'); assert.match(result.error, pattern);
  };
  await refused({ reuse: ['write'] }, /depends on prepare/);
  await refused({ reuse: ['prepare', 'write', 'finish'] }, /did not accept all/);
  await refused({ reuse: ['prepare'], inputs: { start: 3 } }, /inputs\.start differs/);
  const changed = method(); changed.steps.write.do.prompt = 'Return another value.';
  await refused({ reuse: ['prepare', 'write'] }, /write: its definition changed/, changed);
  const relabeled = method(); relabeled.steps.write.reading = { outputs: 'A new description.' };
  await f.write('finish.mjs', fixed);
  assert.equal((await f.fork({ reuse: ['prepare', 'write'] }, relabeled)).status, 'completed', 'display text does not block reuse');
  await f.write('prepare.mjs', prepare + '\n');
  await refused({ reuse: ['prepare'] }, /prepare\.mjs changed/);
  assert.equal(f.calls(), 1);
});

test('fork options are explicit', async t => {
  const f = await failedParent(t);
  await assert.rejects(f.fork({ reuse: [] }), /--reuse STEP/);
  await assert.rejects(f.fork({ reuse: ['prepare'], resume: true }), /starts a new run/);
  await assert.rejects(f.fork({ fromRun: undefined, reuse: ['prepare'] }), /--from-run/);
  await assert.rejects(f.fork({ fromRun: join(f.dir, 'missing'), reuse: ['prepare'] }), { code: 'fork_mismatch' });
});
