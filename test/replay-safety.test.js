import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runMethod, createCase, listCases, testCase, testSuite, recordRun } from '../src/index.js';
import { claudeArgs } from '../src/claude.js';
import { codexArgs } from '../src/codex.js';
import { rewritePaths, namedPath } from '../src/replay.js';

const text = { type: 'text', description: 'A test value.' };
const script = entrypoint => ({ kind: 'run', runtime: 'node', entrypoint });
const config = (extra = {}) => ({
  limits: { timeout_ms: 20000, max_model_requests: 20, max_invocations: 20, max_tool_calls: 5, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
  runtimes: { node: { command: process.execPath, version: process.version } }, ...extra,
});
const model = { model: { backend: 'openai-responses', model: 'test-model', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100 } };
const reply = value => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 1, output_tokens: 1 } });
const call = (name, args) => ({ status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name, arguments: JSON.stringify(args) }], usage: { input_tokens: 1, output_tokens: 1 } });
async function folder(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// prepare copies a room folder into the run's artifacts and returns its absolute path, as the arena's prepare step does.
const prepare = 'import{readFileSync,cpSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const w=process.env.METHOD_OUTPUT_DIR+"/room";cpSync(a.room,w,{recursive:true});console.log(JSON.stringify({workdir:w}))';
const work = tag => `import{readFileSync,writeFileSync,mkdirSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const notes=readFileSync(a.workdir+"/notes.md","utf8");mkdirSync(a.workdir+"/work",{recursive:true});const token=Math.random().toString(36).slice(2);writeFileSync(a.workdir+"/work/memo.md",notes+"${tag}"+token);console.log(JSON.stringify({memo:notes+"${tag}",token}))`;
const roomMethod = { format: 'method/3.3', name: 'Room', goal: 'Write a memo from a room.', inputs: { room: text },
  steps: { prepare: { name: 'Prepare', in: { room: 'inputs.room' }, do: script('prepare.mjs'), out: { workdir: text } },
    work: { name: 'Work', in: { workdir: 'workdir' }, do: script('work.mjs'), out: { memo: text, token: text } } }, result: 'memo' };
async function roomCase(t) {
  const dir = await folder(t, 'method-room-');
  const room = join(dir, 'rooms', 'seed-11'), runs = join(dir, 'runs');
  await mkdir(room, { recursive: true }); await writeFile(join(room, 'notes.md'), 'The sanctions apply.');
  await writeFile(join(dir, 'prepare.mjs'), prepare); await writeFile(join(dir, 'work.mjs'), work(''));
  const file = join(dir, 'room.method'); await writeFile(file, JSON.stringify(roomMethod));
  const source = join(runs, 'source');
  assert.equal((await runMethod(file, config(), { runDir: source, inputs: { room } })).status, 'completed');
  const created = await createCase({ methodFile: file, runDir: source, id: 'names-board', note: 'Tell the Board.', config: config(),
    expect: [{ kind: 'equals', ref: 'outputs.memo', value: 'The sanctions apply. Tell the Board.' }] });
  return { dir, room, runs, source, file, created };
}

test('a case keeps a copy of every folder its run read, and replays after the run and the room are deleted', async t => {
  const { dir, room, runs, source, file, created } = await roomCase(t);
  const kinds = Object.fromEntries(created.snapshots.map(s => [s.kind, s]));
  assert.equal(kinds.ext.original, room); assert.match(kinds.ext.copy, /^snapshot\/ext\/0\/seed-11$/);
  assert.equal(kinds.run.original, join(source, 'artifacts', 'room')); assert.equal(kinds.run.copy, 'snapshot/run/artifacts/room');
  assert.deepEqual(created.snapshot_missing, []);
  assert.equal(JSON.parse(await readFile(join(created.dir, 'recording.json'), 'utf8')).source_run_dir, source);
  await rm(runs, { recursive: true }); await rm(join(dir, 'rooms'), { recursive: true });
  // The changed work step runs live; prepare is served from the recording, and its path now names the attempt's copy.
  await writeFile(join(dir, 'work.mjs'), work(' Tell the Board.'));
  const [item] = await listCases(file);
  const result = await testCase(file, config(), item);
  assert.equal(result.status, 'pass', JSON.stringify(result.attempts));
  assert.deepEqual(result.attempts[0].live_steps, ['work']);
  // Nothing was written back to the deleted source paths.
  await assert.rejects(readdir(runs)); await assert.rejects(readdir(join(dir, 'rooms')));
});

test('a file ref names the file that the live step wrote in the replay copy of the run folder', async t => {
  const { dir, runs, file, created } = await roomCase(t);
  const caseFile = join(created.dir, 'case.json'), value = JSON.parse(await readFile(caseFile, 'utf8'));
  value.expect = [{ kind: 'predicate', runtime: 'node', entrypoint: 'check.mjs', text: 'The memo tells the Board.' }, { kind: 'equals', ref: 'file:room/work/memo.md', value: 'The sanctions apply. Tell the Board.' }];
  await writeFile(caseFile, JSON.stringify(value));
  await writeFile(join(created.dir, 'check.mjs'), 'import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const f=a.files["room/work/memo.md"];console.log(JSON.stringify({pass:!!f&&readFileSync(f,"utf8").includes("Tell the Board.")}))');
  await rm(runs, { recursive: true }); await rm(join(dir, 'rooms'), { recursive: true });
  await writeFile(join(dir, 'work.mjs'), work(' Tell the Board.').replace('notes+" Tell the Board."+token', 'notes+" Tell the Board."'));
  const [item] = await listCases(file);
  const result = await testCase(file, config(), item);
  assert.equal(result.status, 'pass', JSON.stringify(result.attempts));
  // The attempt shows what the person would have seen: the result and the file the live step wrote, not the room's notes.
  assert.deepEqual(result.attempts[0].output, { result: 'The sanctions apply. Tell the Board.', files: { 'room/work/memo.md': 'The sanctions apply. Tell the Board.' } });
});

test('two parallel attempts of one case never share a folder', async t => {
  const { dir, file } = await roomCase(t);
  await writeFile(join(dir, 'work.mjs'), work(' Tell the Board.'));
  const [item] = await listCases(file);
  const keep = join(dir, 'kept');
  const [a, b] = await Promise.all([testCase(file, config(), item, {}, { keepDir: keep }), testCase(file, config(), item, {}, { keepDir: keep })]);
  const memo = async attempt => {
    const runDir = attempt.attempts[0].run_dir;
    const token = JSON.parse(await readFile(join(runDir, 'checkpoint.json'), 'utf8')).root.token;
    return { runDir, token, written: await readFile(join(dirname(runDir), 'scratch-1', 'snapshot', 'run', 'artifacts', 'room', 'work', 'memo.md'), 'utf8') };
  };
  const [x, y] = [await memo(a), await memo(b)];
  assert.notEqual(dirname(x.runDir), dirname(y.runDir));
  assert.ok(x.written.endsWith(x.token) && y.written.endsWith(y.token) && x.token !== y.token);
});

test('a path that the case could not keep makes a live step unverifiable, with the path', async t => {
  const { dir, room, file, created } = await roomCase(t);
  // The case lists the room as missing, as when it is larger than the limits.
  const caseFile = join(created.dir, 'case.json');
  const value = JSON.parse(await readFile(caseFile, 'utf8'));
  await writeFile(caseFile, JSON.stringify({ ...value, snapshots: value.snapshots.filter(s => s.kind !== 'ext'), snapshot_missing: [room] }));
  await writeFile(join(dir, 'prepare.mjs'), prepare + ';');
  const [item] = await listCases(file);
  const result = await testCase(file, config(), item);
  assert.equal(result.status, 'unverifiable');
  assert.deepEqual([result.attempts[0].reason, result.attempts[0].path], ['missing_file', room]);
});

test('paths are rewritten as whole paths, below a path, and inside text, never inside a longer name', () => {
  const map = { '/a/run': '/s/run', '/a/run/artifacts/room': '/s/room' };
  assert.deepEqual(rewritePaths({ x: '/a/run', y: ['/a/run/artifacts/room/work/m.md'], z: 'see /a/run/bundle.', w: '/a/runner', v: '/b/a/run' }, map),
    { x: '/s/run', y: ['/s/room/work/m.md'], z: 'see /s/run/bundle.', w: '/a/runner', v: '/b/a/run' });
  assert.equal(namedPath({ prompt: 'read /a/run/x' }, ['/a/run']), '/a/run');
  assert.equal(namedPath({ prompt: 'read /a/runner' }, ['/a/run']), null);
});

test('a replayed Claude Code agent may read and write only in its scratch folder and run folder, and has no shell', () => {
  const live = claudeArgs({ schema: {}, mcpConfig: '/m.json', artifacts: '/r/artifacts' });
  assert.equal(live[live.indexOf('--allowedTools') + 1], 'Read,Write,Edit,Glob,Grep,mcp__method_step__*');
  assert.ok(!live.includes('--disallowedTools'));
  const replay = claudeArgs({ schema: {}, mcpConfig: '/m.json', artifacts: '/r/artifacts', replay: { scratch: '/s', runDir: '/r' } });
  const allowed = replay[replay.indexOf('--allowedTools') + 1].split(',');
  assert.deepEqual(allowed, ['Read(//s/**)', 'Read(//r/**)', 'Glob(//s/**)', 'Glob(//r/**)', 'Grep(//s/**)', 'Grep(//r/**)',
    'Write(//r/artifacts/**)', 'Write(//s/**)', 'Edit(//r/artifacts/**)', 'Edit(//s/**)', 'mcp__method_step__*']);
  assert.ok(!allowed.some(rule => rule.startsWith('Bash')));
  assert.equal(replay[replay.indexOf('--disallowedTools') + 1], 'Bash');
  assert.equal(replay[replay.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('a replayed Codex agent runs in its sandbox at the scratch folder, with the artifacts and no network', () => {
  const base = { schemaFile: '/d/schema.json', output: '/d/result.json', url: 'http://127.0.0.1:1/mcp', artifacts: '/r/artifacts' };
  assert.ok(codexArgs(base).includes('--dangerously-bypass-approvals-and-sandbox'));
  const replay = codexArgs({ ...base, replay: { scratch: '/s', runDir: '/r' } });
  assert.ok(!replay.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(replay[replay.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(replay[replay.indexOf('-C') + 1], '/s');
  assert.equal(replay[replay.indexOf('--add-dir') + 1], '/r/artifacts');
  assert.ok(replay.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(replay.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
  assert.ok(replay.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
});

test('in a replay, a Method tool with effects returns a stand-in and the event keeps its arguments', async t => {
  const dir = await folder(t, 'method-standin-');
  const outbox = join(dir, 'outbox'); await mkdir(outbox);
  await writeFile(join(dir, 'send.mjs'), 'import{readFileSync,writeFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));writeFileSync(JSON.parse(process.env.METHOD_ENVIRONMENT).mail+"/"+Date.now()+Math.random()+".json",JSON.stringify(a));console.log(JSON.stringify({status:"sent"}))');
  const doc = prompt => ({ format: 'method/3.3', name: 'Mail', goal: 'Mail the Board.', environment: { mail: { type: 'service', description: 'Outgoing mail.' } },
    steps: { mail: { name: 'Mail', do: { kind: 'agent', model: 'model', prompt, tools: ['send_email'] }, out: { done: text }, changes: ['environment.mail'], no_effect_reason: 'A test outbox.' } }, result: 'done' });
  const file = join(dir, 'mail.method'); await writeFile(file, JSON.stringify(doc('Mail the Board.')));
  const cfg = config({ models: model, environment: { mail: outbox },
    tools: { send_email: { description: 'Send an email.', in: { to: text, body: text }, out: { status: text }, run: script('send.mjs'), effects: ['mail'] } } });
  const agent = body => async request => JSON.stringify(request).includes('function_call_output') ? reply({ done: 'Mailed.' }) : call('send_email', { to: 'board@example.com', body });
  assert.equal((await runMethod(file, cfg, { runDir: join(dir, 'run'), transport: agent('Hello.') })).status, 'completed');
  assert.equal((await readdir(outbox)).length, 1);
  await createCase({ methodFile: file, runDir: join(dir, 'run'), id: 'names-sanctions', note: 'Say that the sanctions apply.', config: cfg,
    expect: [{ kind: 'equals', ref: 'effect:send_email', value: [{ to: 'board@example.com', body: 'The sanctions apply.' }] }] });
  await writeFile(file, JSON.stringify(doc('Mail the Board. Say that the sanctions apply.')));
  const report = await testSuite(file, cfg, { runOptions: { transport: agent('The sanctions apply.') } });
  const attempt = report.cases[0].candidate.attempts[0];
  assert.equal(report.cases[0].verdict, 'pass', JSON.stringify(attempt));
  assert.deepEqual(attempt.standins, [{ step: 'mail', iteration: 0, tool: 'send_email', arguments: { to: 'board@example.com', body: 'The sanctions apply.' } }]);
  // The tool did not run: the outbox still holds only the source run's mail.
  assert.equal((await readdir(outbox)).length, 1);
});

test('live forces a matching step to run live, and target_live reports it', async t => {
  const { dir, file } = await roomCase(t);
  const [item] = await listCases(file);
  const served = await testCase(file, config(), item);
  assert.deepEqual(served.attempts[0].live_steps, []); assert.equal(served.target_live, undefined);
  const forced = await testCase(file, config(), item, {}, { live: ['work'], runs: 2, minPass: 1 });
  assert.deepEqual(forced.attempts[0].live_steps, ['work']); assert.equal(forced.attempts[0].target_live, true); assert.equal(forced.target_live, true);
  assert.equal(forced.status, 'fail'); assert.equal(forced.runs, 2); assert.equal(forced.min_pass, 1);
  await assert.rejects(testCase(file, config(), item, {}, { live: ['nope'] }), /No step nope/);
  void dir;
});

test('judgeCache false judges again instead of reading the judgment cache', async t => {
  const dir = await folder(t, 'method-judge-cache-');
  const doc = { format: 'method/3.3', name: 'Line', goal: 'Write a line.', steps: { write: { name: 'Write', do: script('write.mjs'), out: { line: text } } }, result: 'line' };
  await writeFile(join(dir, 'write.mjs'), 'console.log(JSON.stringify({line:"delivery not yet confirmed"}))');
  const file = join(dir, 'l.method'); await writeFile(file, JSON.stringify(doc));
  const cfg = config({ models: { judge: model.model } });
  await runMethod(file, cfg, { runDir: join(dir, 'run') });
  let calls = 0;
  const transport = async () => { calls++; return reply({ verdicts: [{ id: 'c1', pass: true, quote: 'delivery not yet confirmed', reason: 'It says so.' }] }); };
  const cacheDir = join(dir, 'cache');
  await createCase({ methodFile: file, passingRun: join(dir, 'run'), id: 'delivery', note: 'Keep it.', rubric: ['The line says whether delivery is confirmed.'], config: cfg, options: { runOptions: { transport }, cacheDir } });
  const first = calls;
  assert.equal((await testSuite(file, cfg, { runOptions: { transport, cacheDir } })).cases[0].verdict, 'pass');
  assert.equal(calls, first);
  assert.equal((await testSuite(file, cfg, { judgeCache: false, runOptions: { transport, cacheDir } })).cases[0].verdict, 'pass');
  assert.equal(calls, first + 3);
});

test('a run step key changes when a declared helper file changes; a step without scripts keeps its key', async t => {
  const dir = await folder(t, 'method-helpers-');
  const doc = { format: 'method/3.3', name: 'Helper', goal: 'Read instructions.', files: ['INSTRUCTIONS.md'],
    steps: { read: { name: 'Read', do: script('read.mjs'), out: { instructions: text } },
      write: { name: 'Write', in: { instructions: 'instructions' }, do: { kind: 'call', model: 'model', prompt: 'Follow {{instructions}}' }, out: { line: text } } }, result: 'line' };
  await writeFile(join(dir, 'read.mjs'), 'import{readFileSync}from"node:fs";console.log(JSON.stringify({instructions:readFileSync("INSTRUCTIONS.md","utf8")}))');
  await writeFile(join(dir, 'INSTRUCTIONS.md'), 'Be short.');
  const file = join(dir, 'h.method'); await writeFile(file, JSON.stringify(doc));
  const cfg = config({ models: model });
  const transport = async () => reply({ line: 'Short.' });
  await runMethod(file, cfg, { runDir: join(dir, 'a'), transport });
  await writeFile(join(dir, 'INSTRUCTIONS.md'), 'Be long.');
  await runMethod(file, cfg, { runDir: join(dir, 'b'), transport });
  const [a, b] = [await recordRun(join(dir, 'a')), await recordRun(join(dir, 'b'))];
  assert.notEqual(a.keys.read, b.keys.read); assert.equal(a.keys.write, b.keys.write);
  // In a test, the changed helper reaches the step: it runs live.
  await createCase({ methodFile: file, passingRun: join(dir, 'a'), id: 'short', note: 'Keep it short.', expect: [{ kind: 'equals', ref: 'outputs.instructions', value: 'Be short.' }], config: cfg });
  const report = await testSuite(file, cfg, { runOptions: { transport } });
  assert.deepEqual(report.cases[0].candidate.attempts[0].live_steps, ['read']); assert.equal(report.cases[0].verdict, 'fail');
});

test('learned rules: active ones are selected, end the prompt, are recorded, and change the key of their step only', async t => {
  const dir = await folder(t, 'method-learned-');
  const doc = { format: 'method/3.3', name: 'Learned', goal: 'Write a line.', inputs: { topic: text },
    steps: { write: { name: 'Write', in: { topic: 'inputs.topic' }, do: { kind: 'call', model: 'model', prompt: 'Write about {{topic}}.' }, out: { line: text } },
      other: { name: 'Other', in: { line: 'line' }, do: { kind: 'call', model: 'model', prompt: 'Repeat {{line}}.' }, out: { again: text } } }, result: 'again' };
  const file = join(dir, 'w.method'); await writeFile(file, JSON.stringify(doc));
  const rule = (id, when, then, status = 'active') => ({ id, when, then, by: 'Ryan', from: { judgment: 'jdg_1', case: 'correction-1' }, status, created: '2026-10-19T00:00:00Z', retired_at: null, retired_reason: null });
  const learned = steps => writeFile(join(dir, 'learned.json'), JSON.stringify({ format: 'method-learned/1', steps }));
  const always = rule('lr_aaaaaaaaaaaa', null, 'Name the source.'), cats = rule('lr_bbbbbbbbbbbb', 'the topic is about cats', 'Mention whiskers.'),
    dogs = rule('lr_cccccccccccc', 'the topic is about dogs', 'Mention barking.'), old = rule('lr_dddddddddddd', null, 'Use capitals.', 'retired');
  await learned({ write: [always, cats, dogs, old] });
  const requests = [];
  // The selection call is mocked: it chooses the cats rule.
  const transport = async body => {
    requests.push(body);
    if (body.instructions.startsWith('Each condition below')) return reply({ applies: ['lr_bbbbbbbbbbbb', 'lr_unknown00000'] });
    return reply(body.instructions.startsWith('Write') ? { line: 'Cats.' } : { again: 'Cats.' });
  };
  const cfg = config({ models: model });
  const runDir = join(dir, 'run');
  assert.equal((await runMethod(file, cfg, { runDir, inputs: { topic: 'cats' }, transport })).status, 'completed');
  const selection = requests.find(r => r.instructions.startsWith('Each condition below'));
  assert.deepEqual(JSON.parse(selection.input[0].content).conditions, [{ id: 'lr_bbbbbbbbbbbb', when: 'the topic is about cats' }, { id: 'lr_cccccccccccc', when: 'the topic is about dogs' }]);
  const action = requests.find(r => r.instructions.startsWith('Write'));
  assert.ok(action.instructions.endsWith('Write about cats.\n\nRules learned from corrections:\n- Name the source.\n- Mention whiskers.'), action.instructions);
  assert.ok(!requests.find(r => r.instructions.startsWith('Repeat')).instructions.includes('Rules learned'));
  const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(e => e.event === 'learned.applied').map(({ step, iteration, considered, applied }) => ({ step, iteration, considered, applied })),
    [{ step: 'write', iteration: 0, considered: ['lr_aaaaaaaaaaaa', 'lr_bbbbbbbbbbbb', 'lr_cccccccccccc'], applied: ['lr_aaaaaaaaaaaa', 'lr_bbbbbbbbbbbb'] }]);
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files['learned.json']);
  // The key covers the step's active rules: a retired rule or another step's rules do not change it.
  const keys = async (steps, name) => { await learned(steps); await runMethod(file, cfg, { runDir: join(dir, name), inputs: { topic: 'cats' }, transport }); return (await recordRun(join(dir, name))).keys; };
  const base = (await recordRun(runDir)).keys;
  const retired = await keys({ write: [always, cats, dogs, { ...old, then: 'Use small letters.' }] }, 'retired');
  assert.deepEqual(retired, base);
  const changed = await keys({ write: [always, cats, dogs, old, rule('lr_eeeeeeeeeeee', null, 'Be brief.')] }, 'changed');
  assert.notEqual(changed.write, base.write); assert.equal(changed.other, base.other);
  // A rule without a condition needs no selection call.
  requests.length = 0;
  await keys({ write: [always] }, 'plain');
  assert.ok(!requests.some(r => r.instructions.startsWith('Each condition below')));
  // In a replay, a served step makes no selection call.
  await createCase({ methodFile: file, passingRun: join(dir, 'plain'), id: 'cats', note: 'Keep it.', expect: [{ kind: 'equals', ref: 'outputs.line', value: 'Cats.' }], config: cfg });
  requests.length = 0;
  assert.equal((await testSuite(file, cfg, { runOptions: { transport } })).cases[0].verdict, 'pass');
  assert.equal(requests.length, 0);
  // An invalid file stops the run before any step.
  await writeFile(join(dir, 'learned.json'), JSON.stringify({ format: 'method-learned/1', steps: { write: [{ id: 'bad' }] } }));
  await assert.rejects(runMethod(file, cfg, { runDir: join(dir, 'invalid'), inputs: { topic: 'cats' }, transport }), /learned\.json/);
});

test('a script that runs live in a replay gets HOME and TMPDIR in the scratch folder and METHOD_REPLAY', async t => {
  const dir = await folder(t, 'method-replay-env-');
  const env = extra => `console.log(JSON.stringify({home:process.env.HOME,tmp:process.env.TMPDIR,replay:process.env.METHOD_REPLAY??"no"}))${extra}`;
  await writeFile(join(dir, 'env.mjs'), env(''));
  const doc = { format: 'method/3.3', name: 'Env', goal: 'Report the environment.', steps: { env: { name: 'Env', do: script('env.mjs'), out: { home: text, tmp: text, replay: text } } }, result: 'replay' };
  const file = join(dir, 'e.method'); await writeFile(file, JSON.stringify(doc));
  await runMethod(file, config(), { runDir: join(dir, 'run') });
  assert.equal(JSON.parse(await readFile(join(dir, 'run', 'result.json'), 'utf8')), 'no');
  await createCase({ methodFile: file, passingRun: join(dir, 'run'), id: 'live', note: 'Keep it.', expect: [{ kind: 'equals', ref: 'outputs.replay', value: 'no' }], config: config() });
  await writeFile(join(dir, 'env.mjs'), env(';'));
  const [item] = await listCases(file);
  const result = await testCase(file, config(), item, {}, { keepDir: join(dir, 'kept') });
  const runDir = result.attempts[0].run_dir, root = JSON.parse(await readFile(join(runDir, 'checkpoint.json'), 'utf8')).root;
  assert.equal(root.replay, '1');
  assert.equal(root.home, join(dirname(runDir), 'scratch-1', 'home')); assert.equal(root.tmp, join(dirname(runDir), 'scratch-1', 'tmp'));
});

test('file refs read what the run wrote, in its artifacts or in a files connection', async t => {
  const dir = await folder(t, 'method-file-ref-');
  const out = join(dir, 'out'); await mkdir(out);
  const save = extra => `import{writeFileSync}from"node:fs";const o=JSON.parse(process.env.METHOD_ENVIRONMENT).out;writeFileSync(process.env.METHOD_OUTPUT_DIR+"/report.md","v1");writeFileSync(o+"/report.md","v1");console.log(JSON.stringify({saved:"yes"}))${extra}`;
  await writeFile(join(dir, 'save.mjs'), save(''));
  const doc = { format: 'method/3.3', name: 'Files', goal: 'Save a report.', environment: { out: { type: 'files', description: 'Out.' } },
    steps: { save: { name: 'Save', do: script('save.mjs'), out: { saved: text }, changes: ['environment.out'] } }, result: 'saved' };
  const file = join(dir, 'f.method'); await writeFile(file, JSON.stringify(doc));
  const cfg = config({ environment: { out } });
  await runMethod(file, cfg, { runDir: join(dir, 'run') });
  await createCase({ methodFile: file, passingRun: join(dir, 'run'), id: 'v1', note: 'Keep v1.', config: cfg,
    expect: [{ kind: 'equals', ref: 'file:report.md', value: 'v1' }, { kind: 'equals', ref: `file:${join(out, 'report.md')}`, value: 'v1' }, { kind: 'equals', ref: 'result', value: 'yes' }] });
  await writeFile(join(out, 'report.md'), 'something else');
  await writeFile(join(dir, 'save.mjs'), save(';'));
  const report = await testSuite(file, cfg);
  assert.equal(report.cases[0].verdict, 'pass', JSON.stringify(report.cases[0].candidate.attempts));
  assert.deepEqual(report.cases[0].candidate.attempts[0].live_steps, ['save']);
  assert.equal(await readFile(join(out, 'report.md'), 'utf8'), 'something else');
});

test('a case attempt whose copied folders are read-only is still removed after the test', async () => {
  const { mkdtemp, mkdir, writeFile, chmod, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { _removeTree } = await import('../src/cases.js');
  const dir = await mkdtemp(join(tmpdir(), 'ro-tree-'));
  await mkdir(join(dir, 'a', 'b'), { recursive: true });
  await writeFile(join(dir, 'a', 'b', 'f.txt'), 'x');
  await chmod(join(dir, 'a', 'b', 'f.txt'), 0o444); await chmod(join(dir, 'a', 'b'), 0o555); await chmod(join(dir, 'a'), 0o555);
  await _removeTree(dir);
  await assert.rejects(readdir(dir));
});
