import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod } from '../src/index.js';

test('a script gets HOME, USER and TMPDIR, and not the rest of the caller environment', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.METHOD_TEST_UNRELATED = 'should-not-pass';
  t.after(() => { delete process.env.METHOD_TEST_UNRELATED; });
  await writeFile(join(dir, 'env.mjs'), 'console.log(JSON.stringify({names: ["HOME","USER","TMPDIR","METHOD_TEST_UNRELATED"].filter(n => process.env[n] !== undefined).join(",")}))');
  const path = join(dir, 'env.method');
  await writeFile(path, JSON.stringify({ format: 'method/3.4', name: 'Env', goal: 'Show the script environment.',
    steps: { env: { name: 'Environment', purpose: 'Lists the environment names the script sees. Changes nothing.', do: { kind: 'run', runtime: 'node', entrypoint: 'env.mjs' },
      out: { names: { type: 'text', description: 'Names the script sees.' } } } }, result: 'names' }));
  const config = { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } },
    limits: { timeout_ms: 10000, max_model_requests: 0, max_invocations: 2, max_tool_calls: 0, max_output_bytes: 100000, max_request_bytes: 100000 } };
  const result = await runMethod(path, config, { runDir: join(dir, 'run') });
  assert.equal(result.status, 'completed');
  const expected = ['HOME', 'USER', 'TMPDIR'].filter(name => process.env[name]).join(',');
  assert.equal(result.result, expected);
});
