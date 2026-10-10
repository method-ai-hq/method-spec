import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod } from '../src/index.js';
import { executeProcess } from '../src/io.js';

const python = (() => { try { return execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
const pythonVersion = python ? execFileSync(python, ['--version'], { encoding: 'utf8' }).trim() : '';
const SECRET = 'archive-secret-value';
const record = { type: 'record', description: 'What the script saw.', fields: {
  ok: { type: 'boolean', description: 'Done.' }, main: { type: 'text', description: 'Module name.' },
  argv: { type: 'list', description: 'Arguments.', items: { type: 'text', description: 'One argument.' } },
  hidden: { type: 'boolean', description: 'The observation variables are hidden.' }, token: { type: 'boolean', description: 'The secret was set.' } } };
const method = (runtime, entrypoint, extra = {}) => ({
  format: 'method/3.3', name: 'Observed', goal: 'Record what a script did.', files: ['data.txt', 'helpers/__init__.py', 'helpers/util.py'],
  secrets: { ARCHIVE_TOKEN: 'Read-only archive token.' },
  inputs: { port: { type: 'number', description: 'Local server port.' } },
  steps: { act: { name: 'Act', purpose: 'Read, write, call, and spawn.', in: { port: 'inputs.port' }, do: { kind: 'run', runtime, entrypoint, args: ['first', 'second'] }, out: { seen: record } } },
  result: 'seen', ...extra,
});
const config = {
  limits: { timeout_ms: 20000, max_model_requests: 1, max_invocations: 5, max_tool_calls: 1, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
  runtimes: { node: { command: process.execPath, version: process.version }, ...(python ? { python: { command: python, version: pythonVersion } } : {}), shell: { command: '/bin/sh', version: 'sh' } },
};
const scripts = {
  'act.py': `import json, os, subprocess, sys, urllib.request
from helpers import util
port = json.load(sys.stdin)['port']
open('data.txt').read()
with open(os.path.join(os.environ['METHOD_OUTPUT_DIR'], 'reports', 'out.txt'), 'w') as f: f.write('x')
token = os.environ.get('ARCHIVE_TOKEN')
urllib.request.urlopen('http://127.0.0.1:%d/items?key=query-secret' % port).read()
subprocess.run(['echo', 'hi'], stdout=subprocess.DEVNULL)
print(json.dumps({'seen': {'ok': True, 'main': __name__, 'argv': sys.argv[1:], 'hidden': not any(k.startswith('METHOD_OBSERVE') for k in os.environ) and 'PYTHONPATH' not in os.environ, 'token': token is not None}}))
`,
  'act.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const { port } = JSON.parse(readFileSync(0, 'utf8'));
readFileSync('data.txt', 'utf8');
writeFileSync(process.env.METHOD_OUTPUT_DIR + '/reports/out.txt', 'x');
const token = process.env.ARCHIVE_TOKEN;
await (await fetch('http://127.0.0.1:' + port + '/items?key=query-secret')).text();
spawnSync('echo', ['hi']);
console.log(JSON.stringify({ seen: { ok: true, main: 'module', argv: process.argv.slice(2), hidden: !Object.keys(process.env).some(k => k.startsWith('METHOD_OBSERVE')), token: token !== undefined } }));
`,
  'act.sh': `cat >/dev/null; printf '{"seen":{"ok":true,"main":"sh","argv":[],"hidden":true,"token":true}}'`,
  'fail.py': `import json, sys\njson.load(sys.stdin)\nopen('data.txt').read()\nprint('partial')\nsys.exit(7)\n`,
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'method-observed-'));
  const server = createServer((request, response) => response.end('ok')).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(join(dir, 'helpers'), { recursive: true });
  for (const [name, source] of Object.entries({ ...scripts, 'data.txt': 'data', 'helpers/__init__.py': '', 'helpers/util.py': 'X = 1\n' })) await writeFile(join(dir, name), source);
  const port = server.address().port;
  let runs = 0;
  const dirs = [];
  const run = async (doc, options = {}) => {
    const path = join(dir, 'test.method');
    await writeFile(path, JSON.stringify(doc));
    const runDir = join(dir, `run-${++runs}`);
    const result = await runMethod(path, config, { runDir, inputs: { port }, secrets: { ARCHIVE_TOKEN: SECRET }, fresh: true, ...options });
    dirs.push(runDir);
    const text = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    return { result, text, events: text.trim().split('\n').map(line => JSON.parse(line)) };
  };
  return { dir, port, run, dirs };
}

// The script writes into a folder of METHOD_OUTPUT_DIR; the runtime creates the artifacts folder, the script its subfolder.
const withReports = (source, language) => language === 'python'
  ? source.replace("port = json", "os.makedirs(os.path.join(os.environ['METHOD_OUTPUT_DIR'], 'reports'), exist_ok=True)\nport = json")
  : source.replace("const { port }", "import { mkdirSync } from 'node:fs'; mkdirSync(process.env.METHOD_OUTPUT_DIR + '/reports', { recursive: true });\nconst { port }");

for (const [language, entrypoint] of [['python', 'act.py'], ['node', 'act.mjs']]) {
  test(`a ${language} step records the effects it really had`, { skip: language === 'python' && !python ? 'python3 is not installed' : false }, async t => {
    const f = await fixture(t);
    await writeFile(join(f.dir, entrypoint), withReports(scripts[entrypoint], language));
    const { result, text, events } = await f.run(method(language, entrypoint));
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.result, { ok: true, main: language === 'python' ? '__main__' : 'module', argv: ['first', 'second'], hidden: true, token: true });
    const accepted = events.find(e => e.event === 'step.accepted');
    const effects = accepted.observed_effects;
    assert.ok(effects.network.includes('127.0.0.1'), JSON.stringify(effects.network));
    assert.ok(effects.reads.includes('data.txt'), JSON.stringify(effects.reads));
    assert.ok(effects.writes.includes('$METHOD_OUTPUT_DIR/reports/out.txt'), JSON.stringify(effects.writes));
    assert.ok(effects.env.includes('ARCHIVE_TOKEN'), JSON.stringify(effects.env));
    assert.ok(!effects.env.some(name => name.startsWith('METHOD_')));
    assert.ok(effects.runs.includes('echo'), JSON.stringify(effects.runs));
    assert.equal(effects.truncated, undefined);
    assert.deepEqual(events.find(e => e.event === 'process.completed').observed_effects, effects);
    // Names only: no variable values, no URLs or query strings.
    assert.ok(!text.includes(SECRET)); assert.ok(!text.includes('query-secret')); assert.ok(!text.includes('/items'));

    // The same script without observation gives the same standard output.
    const bundle = join(result.run_dir, 'bundle');
    const plain = await executeProcess({ command: language === 'python' ? python : process.execPath, args: [join(bundle, entrypoint), 'first', 'second'], cwd: bundle, input: { port: f.port },
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', METHOD_OUTPUT_DIR: join(result.run_dir, 'artifacts'), ARCHIVE_TOKEN: SECRET }, signal: new AbortController().signal, maxBytes: 100000 });
    assert.equal(events.find(e => e.event === 'process.completed').output, plain.output);

    // A reused iteration copies the effects that its source run recorded.
    const again = await f.run(method(language, entrypoint), { fresh: false, cacheFrom: [f.dirs[0]] });
    const reused = again.events.find(e => e.event === 'step.accepted');
    assert.ok(reused.reused_from); assert.deepEqual(reused.observed_effects, effects);
  });
}

test('a failed python step keeps its exit code and records what it did', { skip: !python ? 'python3 is not installed' : false }, async t => {
  const f = await fixture(t);
  const { result, events } = await f.run(method('python', 'fail.py'));
  assert.equal(result.status, 'failed');
  const failed = events.find(e => e.event === 'process.failed');
  assert.equal(failed.exit_code, 7); assert.equal(failed.output, 'partial\n');
  assert.ok(failed.observed_effects.reads.includes('data.txt'));
});

test('a runtime that cannot be observed still runs and says so', async t => {
  const f = await fixture(t);
  const { result, events } = await f.run(method('shell', 'act.sh'));
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(events.find(e => e.event === 'step.accepted').observed_effects, { unavailable: 'runtime_not_observed' });
});

test('long lists are bounded and say that they are truncated', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'many.mjs'), `import { readFileSync } from 'node:fs'; readFileSync(0); for (let i = 0; i < 250; i++) process.env['VAR_' + i];
console.log(JSON.stringify({ seen: { ok: true, main: 'm', argv: [], hidden: true, token: true } }));`);
  const { events } = await f.run(method('node', 'many.mjs'));
  const effects = events.find(e => e.event === 'step.accepted').observed_effects;
  assert.ok(effects.env.length < 250); assert.equal(effects.truncated, true);
});
