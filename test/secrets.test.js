import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod, validateMethod } from '../src/index.js';
import { modelCall } from '../src/preflight.js';

const config = { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } } };
const method = (extra = {}) => ({
  format: 'method/3.3', name: 'Secret', goal: 'Read a secret.', secrets: { ARCHIVE_TOKEN: 'Read-only archive token.' },
  steps: { read: { name: 'Read', purpose: 'Return the token length.', do: { kind: 'run', runtime: 'node', entrypoint: 'read.mjs' }, out: { length: { type: 'number', description: 'Length.' } } } },
  result: 'length', ...extra,
});
async function fixture(t, source = 'console.log(JSON.stringify({length:process.env.ARCHIVE_TOKEN.length,echo:process.env.ARCHIVE_TOKEN}))') {
  const dir = await mkdtemp(join(tmpdir(), 'method-secret-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'read.mjs'), source);
  const file = join(dir, 'test.method');
  return { dir, file, run: async (options, doc = method()) => { await writeFile(file, JSON.stringify(doc)); return runMethod(file, config, { runDir: join(dir, `run-${Math.random()}`), ...options }); } };
}

test('a declared secret reaches scripts and never reaches the run records', async t => {
  const f = await fixture(t, 'console.log(JSON.stringify({length:process.env.ARCHIVE_TOKEN.length}));console.error("token "+process.env.ARCHIVE_TOKEN)');
  const result = await f.run({ secrets: { ARCHIVE_TOKEN: 'archive-secret-value' } });
  assert.equal(result.status, 'completed'); assert.equal(result.result, 20);
  assert.equal((await readFile(join(result.run_dir, 'events.jsonl'), 'utf8')).includes('archive-secret-value'), false);
});

test('a missing secret stops the run before any step and names the secret', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ secrets: {} }), error => error.code === 'missing_secret' && error.missing[0] === 'ARCHIVE_TOKEN');
  assert.throws(() => validateMethod(method({ secrets: { PATH: 'Not allowed.' } })));
});

test('a script that calls a model API is refused', async t => {
  for (const source of ['fetch("https://openrouter.ai/api/v1/chat/completions")', 'import OpenAI from "openai";', 'import Anthropic from "@anthropic-ai/sdk";']) {
    const f = await fixture(t, source);
    await assert.rejects(f.run({ secrets: { ARCHIVE_TOKEN: 'x' } }), error => error.code === 'model_call_in_script' && /read\.mjs uses/.test(error.message));
  }
  assert.equal(modelCall('from openai import OpenAI'), 'openai');
  assert.equal(modelCall('import os\nlinks = ["https://example.com/openai"]'), null);
  // Managing keys is not a model request.
  assert.equal(modelCall('url = "https://openrouter.ai/api/v1/keys/" + key_hash'), null);
});

test('an each item named again in in gets an error that says so', () => {
  const doc = { format: 'method/3.3', name: 'Each', goal: 'Score texts.', inputs: { items: { type: 'list', items: 'text' } },
    steps: { score: { name: 'Score', each: { text: 'inputs.items' }, in: { text: 'text' }, do: { kind: 'classify', question: 'Is it long?', options: { yes: 'Long.', no: 'Short.' } }, out: 'score' } }, result: 'score' };
  assert.throws(() => validateMethod(doc), /text is the each item, and the step receives it already/);
});
