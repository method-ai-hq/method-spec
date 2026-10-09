import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod } from '../src/index.js';

const number = { type: 'number', description: 'A test number.' };
const file = { type: 'file', description: 'A test file.' };
const script = entrypoint => ({ kind: 'run', runtime: 'node', entrypoint });
const config = {
  limits: { timeout_ms: 10000, max_model_requests: 10, max_invocations: 20, max_tool_calls: 5, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
  runtimes: { node: { command: process.execPath, version: process.version } },
  models: { model: { backend: 'openai-responses', model: 'test-model', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100 } },
};
const response = value => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 1, output_tokens: 1 } });

// prepare (script with a file output) -> write (model call) -> finish (script that starts with a bug)
const method = (prompt = 'Return value.') => ({
  format: 'method/3.3', name: 'Cache', goal: 'Test reuse.',
  inputs: { start: number },
  steps: {
    prepare: { name: 'Prepare', purpose: 'Save a note.', in: { start: 'inputs.start' }, do: script('prepare.mjs'), out: { note: file, base: number } },
    write: { in: { base: 'base' }, do: { kind: 'call', model: 'model', prompt }, out: { draft: number }, limits: { max_model_requests: 1 } },
    finish: { name: 'Finish', purpose: 'Add one.', in: { draft: 'draft', note: 'note' }, do: script('finish.mjs'), out: { total: number } },
  },
  result: 'total',
});
const prepare = 'import{writeFileSync,readFileSync}from"node:fs";import{createHash}from"node:crypto";const a=JSON.parse(readFileSync(0,"utf8"));writeFileSync(process.env.METHOD_OUTPUT_DIR+"/note.txt","note");console.log(JSON.stringify({note:{path:"note.txt",sha256:createHash("sha256").update("note").digest("hex")},base:a.start}))';
const broken = 'console.log(JSON.stringify({wrong:1}))';
const fixed = 'import{readFileSync,existsSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));if(!existsSync(process.env.METHOD_OUTPUT_DIR+"/"+a.note.path))process.exit(3);console.log(JSON.stringify({total:a.draft+1}))';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'method-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries({ 'prepare.mjs': prepare, 'finish.mjs': broken })) await writeFile(join(dir, name), source);
  const path = join(dir, 'test.method');
  let calls = 0, runs = 0;
  const transport = async () => { calls++; return response({ draft: 41 }); };
  const dirs = [];
  const run = async (options = {}, doc = method()) => {
    await writeFile(path, JSON.stringify(doc));
    const runDir = join(dir, `run-${++runs}`);
    const result = await runMethod(path, config, { runDir, inputs: { start: 2 }, transport, cacheFrom: [...dirs].reverse(), ...options });
    dirs.push(runDir);
    return result;
  };
  return { run, calls: () => calls, write: (name, source) => writeFile(join(dir, name), source) };
}
const started = async dir => (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  .filter(e => e.event === 'step.started' && !e.reused_from).map(e => e.step);

test('a new run reuses unchanged accepted steps and runs the fixed one', async t => {
  const f = await fixture(t);
  const failed = await f.run();
  assert.equal(failed.status, 'failed'); assert.equal(failed.failed_step, 'finish'); assert.equal(failed.code, 'invalid_output');
  assert.match(failed.fix, /Unchanged steps are reused/);
  await f.write('finish.mjs', fixed);
  const result = await f.run();
  // finish.mjs is only finish's entrypoint, so prepare and the model step are reused.
  assert.equal(result.status, 'completed'); assert.equal(result.result, 42);
  assert.equal(f.calls(), 1);
  assert.deepEqual(result.reused, { prepare: 1, write: 1 });
  assert.deepEqual(await started(result.run_dir), ['finish']);
  // A helper file that is no step's entrypoint could be imported by any script, so script steps run again.
  await f.write('helper.mjs', 'export const x = 1;');
  const helper = await f.run({}, { ...method(), files: ['helper.mjs'] });
  assert.deepEqual(helper.reused, { write: 1 });
  assert.equal(await readFile(join(result.run_dir, 'artifacts', 'note.txt'), 'utf8'), 'note');
  const again = await f.run({}, { ...method(), files: ['helper.mjs'] });
  assert.deepEqual(again.reused, { prepare: 1, write: 1, finish: 1 }); assert.equal(again.invocations, 0);
});

test('a changed prompt, new inputs, or --fresh run the step again', async t => {
  const f = await fixture(t);
  await f.write('finish.mjs', fixed);
  await f.run();
  const edited = await f.run({}, method('Return a value.'));
  assert.deepEqual(edited.reused, { prepare: 1, finish: 1 }, 'finish reads the same draft, so it is reused');
  assert.equal(f.calls(), 2);
  const other = await f.run({ inputs: { start: 3 } });
  assert.deepEqual(other.reused, { finish: 1 }, 'the model returns the same draft, so finish is reused'); assert.equal(f.calls(), 3);
  assert.deepEqual((await f.run({ fresh: ['write'] })).reused, { prepare: 1, finish: 1 }); assert.equal(f.calls(), 4);
  assert.equal((await f.run({ fresh: true })).reused, undefined); assert.equal(f.calls(), 5);
});

test('a step that changes state is not reused', async t => {
  const f = await fixture(t);
  await f.write('finish.mjs', fixed);
  const doc = method();
  doc.state = { seen: { type: 'number', default: 0 } };
  doc.steps.finish.changes = ['state.seen'];
  await f.write('finish.mjs', 'import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({total:a.draft+1,state:{seen:1}}))');
  await f.run({}, doc);
  const result = await f.run({}, doc);
  assert.deepEqual(result.reused, { prepare: 1, write: 1 });
});
