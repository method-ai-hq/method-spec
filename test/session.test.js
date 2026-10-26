import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { runMethod } from '../src/runner.js';
import { claudeArgs } from '../src/claude.js';
import { codexArgs } from '../src/codex.js';
import { cleanRoomEnv } from '../src/clean-room.js';
import { validateMethod } from '../src/document.js';
import { isAgentRecord } from '../src/cases.js';

const gone = path => access(path).then(() => false, () => true);

/** Set process variables for one test and restore them after it. */
function withEnv(t, values) {
  const before = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
}

test('a bare Claude Code session has no output form, Method tools or MCP servers, runs restricted with only its tools, and has no skills', () => {
  const args = claudeArgs({ profile: { model: 'opus', reasoning_effort: 'high' }, bare: { tools: ['read', 'search', 'write'] } });
  for (const flag of ['--json-schema', '--mcp-config', '--disallowedTools']) assert.ok(!args.includes(flag), flag);
  assert.ok(!args.join(' ').includes('mcp__method_step'));
  for (const flag of ['--print', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Write');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,Write');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  // Shell and web only when named; no tools at all is an empty list.
  const all = claudeArgs({ bare: { tools: ['shell', 'web'] } });
  assert.equal(all[all.indexOf('--tools') + 1], 'Bash,WebSearch,WebFetch');
  const none = claudeArgs({ bare: { tools: [] } });
  assert.equal(none[none.indexOf('--tools') + 1], '');
  assert.ok(!none.includes('--allowedTools'));
});

test('a bare Codex session ignores the user config and rules, has no plugins, apps or skill search, and gets web search and writing only when named', () => {
  const read = codexArgs({ output: '/d/last.txt', bare: { room: '/room', tools: ['shell', 'read'] } });
  for (const flag of ['--output-schema', '--dangerously-bypass-approvals-and-sandbox']) assert.ok(!read.includes(flag), flag);
  assert.ok(!read.join(' ').includes('mcp_servers'));
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json']) assert.ok(read.includes(flag), flag);
  assert.equal(read[read.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(read[read.indexOf('-C') + 1], '/room');
  assert.equal(read[read.indexOf('--output-last-message') + 1], '/d/last.txt');
  const disabled = read.flatMap((arg, i) => arg === '--disable' ? [read[i + 1]] : []);
  assert.deepEqual(disabled, ['plugins', 'remote_plugin', 'apps', 'plugin_sharing', 'skill_search', 'skill_mcp_dependency_install']);
  assert.ok(read.includes('web_search="disabled"'));
  assert.equal(read.at(-1), '-');
  const write = codexArgs({ output: '/d/last.txt', profile: { model: 'gpt-test' }, bare: { room: '/room', tools: ['shell', 'write', 'web'] } });
  assert.equal(write[write.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(write.includes('web_search="live"'));
  assert.equal(write[write.indexOf('--model') + 1], 'gpt-test');
});

test('a clean room has a fresh home with only the sign-in, a short TMPDIR, and its own copy of each bound folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-clean-room-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'world');
  await mkdir(join(folder, 'docs'), { recursive: true });
  await writeFile(join(folder, 'docs', 'brief.md'), 'Brief');
  const base = { PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: join(root, 'user'), CLAUDE_CODE_OAUTH_TOKEN: 'token-1', CLAUDECODE: '1', OTHER_SECRET: 'x', TMPDIR: join(root, 'deep', 'tmp') };
  const room = await cleanRoomEnv('claude', base, { folders: { world: folder } });
  try {
    assert.equal(room.env.HOME, join(room.root, 'home'));
    assert.equal(room.env.CLAUDE_CONFIG_DIR, join(room.root, 'home', '.claude'));
    assert.equal(room.env.CLAUDE_CODE_OAUTH_TOKEN, 'token-1');
    assert.equal(room.env.PATH, '/usr/bin');
    for (const name of ['CLAUDECODE', 'OTHER_SECRET']) assert.equal(room.env[name], undefined, name);
    // A short TMPDIR: tools put Unix sockets there, and macOS cuts a socket path at 104 characters.
    assert.ok(room.env.TMPDIR.startsWith(room.root) && room.env.TMPDIR.length < 40, room.env.TMPDIR);
    assert.equal(await readFile(join(room.folders.world, 'docs', 'brief.md'), 'utf8'), 'Brief');
    await writeFile(join(room.folders.world, 'docs', 'brief.md'), 'Changed');
    assert.equal(await readFile(join(folder, 'docs', 'brief.md'), 'utf8'), 'Brief');
  } finally { await room.remove(); }
  assert.ok(await gone(room.root));
});

test('a Codex clean room links only the sign-in file into a new CODEX_HOME, and says plainly when there is none', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-clean-codex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'user-codex');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'auth.json'), '{}');
  await writeFile(join(codexHome, 'config.toml'), 'model = "x"');
  await writeFile(join(codexHome, 'AGENTS.md'), 'User rules');
  const room = await cleanRoomEnv('codex', { PATH: '/usr/bin', CODEX_HOME: codexHome });
  try {
    assert.equal(room.env.CODEX_HOME, join(room.root, 'home', '.codex'));
    assert.equal(await readlink(join(room.env.CODEX_HOME, 'auth.json')), join(codexHome, 'auth.json'));
    for (const name of ['config.toml', 'AGENTS.md']) assert.ok(await gone(join(room.env.CODEX_HOME, name)), name);
  } finally { await room.remove(); }
  await assert.rejects(cleanRoomEnv('codex', { PATH: '/usr/bin', CODEX_HOME: join(root, 'none') }), error => error.owner === 'setup' && /codex login/.test(error.message));
  // A Method arm whose steps run on both agents gets both sign-ins; one that runs on neither gets none.
  const both = await cleanRoomEnv(['claude', 'codex'], { PATH: '/usr/bin', CODEX_HOME: codexHome, CLAUDE_CODE_OAUTH_TOKEN: 't' });
  try {
    assert.equal(both.env.CLAUDE_CODE_OAUTH_TOKEN, 't');
    assert.equal(await readlink(join(both.env.CODEX_HOME, 'auth.json')), join(codexHome, 'auth.json'));
  } finally { await both.remove(); }
  const none = await cleanRoomEnv([], { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 't' });
  try { assert.deepEqual(Object.keys(none.env).sort(), ['HOME', 'PATH', 'TMPDIR']); } finally { await none.remove(); }
});

test('a session step accepts only its own output form, needs shell for Codex, and changes nothing', () => {
  const method = step => ({ format: 'method/3.4', name: 'Plain', goal: 'Run a plain agent', inputs: { room: { type: 'text' }, count: { type: 'number' } }, steps: { work: step }, result: 'session' });
  const session = { in: { room: 'inputs.room' }, do: { kind: 'session', agent: 'claude', prompt: 'Do the task.', tools: ['read'], room: 'room' }, out: 'session' };
  validateMethod(method(session));
  assert.throws(() => validateMethod(method({ ...session, out: { text: 'text' } })));
  assert.throws(() => validateMethod(method({ ...session, do: { ...session.do, tools: ['telepathy'] } })));
  assert.throws(() => validateMethod(method({ ...session, do: { ...session.do, agent: 'codex' } })), /Codex reads and writes files through its shell/);
  validateMethod(method({ ...session, do: { ...session.do, agent: 'codex', tools: ['shell', 'write'] } }));
  assert.throws(() => validateMethod(method({ ...session, in: { room: 'inputs.count' } })), /room must be a text value/);
  assert.throws(() => validateMethod(method({ ...session, do: { ...session.do, room: 'elsewhere' } })));
  assert.equal(isAgentRecord('session/attempt-1/last-message.txt'), true);
  assert.equal(isAgentRecord('session/attempt-1/room/memo.md'), false);
});

// A stand-in for Claude Code: it records what it saw in seen.json in its room, writes a memo, and returns a final text.
const claudeStub = counter => `#!/usr/bin/env node
const fs = require('fs');
let prompt = '';
process.stdin.on('data', d => prompt += d).on('end', () => {
  fs.appendFileSync(${JSON.stringify(counter)}, 'x');
  const env = Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'METHOD_OUTPUT_DIR', 'OTHER_SECRET'].map(n => [n, process.env[n] ?? null]));
  fs.writeFileSync('seen.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env, prompt }));
  fs.writeFileSync('memo.md', 'Memo on ' + fs.readFileSync('brief.md', 'utf8'));
  const out = e => console.log(JSON.stringify(e));
  out({ type: 'system', subtype: 'init', model: 'claude-test', tools: ['Read', 'Write'], mcp_servers: [] });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: process.cwd() + '/brief.md' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Brief' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'I wrote the memo.', usage: { input_tokens: 5, output_tokens: 3 } });
});
`;

async function sessionFixture(t, agent = 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'method-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), room = join(root, 'world'), counter = join(root, 'count');
  await mkdir(bin); await mkdir(room);
  await writeFile(join(room, 'brief.md'), 'the brief');
  await writeFile(counter, '');
  await writeFile(join(bin, agent), agent === 'claude' ? claudeStub(counter) : codexStub(counter), { mode: 0o700 });
  withEnv(t, { PATH: `${bin}${delimiter}${process.env.PATH}`, CLAUDE_CODE_OAUTH_TOKEN: 'session-token', CLAUDECODE: '1', OTHER_SECRET: 'user secret', CODEX_HOME: join(root, 'codex-home') });
  await mkdir(join(root, 'codex-home'));
  await writeFile(join(root, 'codex-home', 'auth.json'), '{}');
  const file = join(root, 'plain.method');
  await writeFile(file, JSON.stringify({ format: 'method/3.4', name: 'Plain', goal: 'Run a plain agent on a task',
    inputs: { room: { type: 'text' }, task: { type: 'text' } },
    steps: { work: { in: { room: 'inputs.room', task: 'inputs.task' }, out: 'session',
      do: { kind: 'session', agent, prompt: 'Read brief.md and write memo.md. Task: {{task}}', tools: agent === 'claude' ? ['read', 'write'] : ['shell', 'write'], room: 'room' } } },
    result: 'session' }));
  const run = (name, options = {}) => runMethod(file, { allow_local_processes: true }, { runDir: join(root, name), inputs: { room, task: 'Be brief.' }, ...options });
  return { root, room, counter, run };
}

test('a session runs plain Claude Code in a clean room on its own copy of the room, and returns its text, the files it wrote and its transcript', async t => {
  const { root, room, run } = await sessionFixture(t);
  const result = await run('run-1');
  assert.equal(result.status, 'completed', result.failure?.details);
  const { final_text, files_written, transcript } = result.result;
  assert.equal(final_text, 'I wrote the memo.');
  assert.deepEqual(files_written.map(file => file.path.split('/').slice(2).join('/')).sort(), ['room/memo.md', 'room/seen.json']);
  const artifacts = join(root, 'run-1', 'artifacts');
  const memo = files_written.find(file => file.path.endsWith('memo.md'));
  assert.equal(await readFile(join(artifacts, memo.path), 'utf8'), 'Memo on the brief');
  // The room folder itself does not change.
  assert.ok(await gone(join(room, 'memo.md')));
  const seen = JSON.parse(await readFile(join(artifacts, files_written.find(file => file.path.endsWith('seen.json')).path), 'utf8'));
  // Only the prompt: no step inputs, no "do only this step", no output form.
  assert.equal(seen.prompt, 'Read brief.md and write memo.md. Task: Be brief.');
  assert.ok(seen.argv.includes('--restricted') && !seen.argv.includes('--json-schema') && !seen.argv.includes('--mcp-config'));
  assert.equal(seen.argv[seen.argv.indexOf('--tools') + 1], 'Read,Write');
  // The clean room: a fresh home with only the sign-in; none of the caller's variables.
  assert.equal(seen.env.CLAUDE_CODE_OAUTH_TOKEN, 'session-token');
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, join(seen.env.HOME, '.claude'));
  for (const name of ['CLAUDECODE', 'METHOD_OUTPUT_DIR', 'OTHER_SECRET']) assert.equal(seen.env[name], null, name);
  assert.ok(seen.env.TMPDIR.length < 40, seen.env.TMPDIR);
  assert.ok(seen.cwd.endsWith('/folders/room') && !seen.cwd.startsWith(room));
  // The room is removed when the session ends.
  assert.ok(await gone(seen.env.HOME));
  const entries = (await readFile(join(artifacts, transcript.path), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(entries.map(e => [e.role, e.kind]), [['user', 'prompt'], ['assistant', 'file_read'], ['tool', 'tool_result'], ['system', 'result']]);
  assert.equal(entries.at(-1).text, 'I wrote the memo.');
  const events = (await readFile(join(root, 'run-1', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.find(e => e.event === 'model.used').message, 'Step "work" runs on Claude Code.');
});

test('repeats of the same session are separate runs; unchanged work of the same repeat is reused; a changed room runs again', async t => {
  const { root, room, counter, run } = await sessionFixture(t);
  const count = async () => (await readFile(counter, 'utf8')).length;
  assert.equal((await run('r0')).status, 'completed');
  const again = await run('r0-again', { cacheFrom: [join(root, 'r0')] });
  assert.deepEqual(again.reused, { work: 1 });
  assert.equal(await count(), 1);
  const second = await run('r1', { cacheFrom: [join(root, 'r0')], repeat: 1 });
  assert.equal(second.status, 'completed'); assert.equal(second.reused, undefined);
  assert.equal(await count(), 2);
  assert.deepEqual((await run('r1-again', { cacheFrom: [join(root, 'r0'), join(root, 'r1')], repeat: 1 })).reused, { work: 1 });
  assert.equal(await count(), 2);
  await writeFile(join(room, 'brief.md'), 'a new brief');
  const changed = await run('r0-changed', { cacheFrom: [join(root, 'r0')] });
  assert.equal(changed.reused, undefined);
  assert.equal(await count(), 3);
});

// A stand-in for Codex: it saves its last message where -o says and writes a memo in its working folder.
const codexStub = counter => `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', d => prompt += d).on('end', () => {
  fs.appendFileSync(${JSON.stringify(counter)}, 'x');
  const env = Object.fromEntries(['HOME', 'CODEX_HOME', 'TMPDIR', 'CLAUDECODE', 'OTHER_SECRET'].map(n => [n, process.env[n] ?? null]));
  fs.writeFileSync('seen.json', JSON.stringify({ argv, cwd: process.cwd(), env, prompt, auth: fs.readlinkSync(process.env.CODEX_HOME + '/auth.json') }));
  fs.writeFileSync('memo.md', 'Memo');
  fs.writeFileSync(argv[argv.indexOf('--output-last-message') + 1], 'Done: memo.md');
  const out = e => console.log(JSON.stringify(e));
  out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'cat brief.md', aggregated_output: 'the brief', exit_code: 0 } });
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Done: memo.md' } });
  out({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 2 } });
});
`;

test('a Codex session runs in a clean CODEX_HOME with only the sign-in link, and returns its last message', async t => {
  const { root, run } = await sessionFixture(t, 'codex');
  const result = await run('run-1');
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.equal(result.result.final_text, 'Done: memo.md');
  assert.equal(result.codex.processes, 1);
  const artifacts = join(root, 'run-1', 'artifacts');
  const seen = JSON.parse(await readFile(join(artifacts, result.result.files_written.find(file => file.path.endsWith('seen.json')).path), 'utf8'));
  assert.equal(seen.prompt, 'Read brief.md and write memo.md. Task: Be brief.');
  assert.equal(seen.env.CODEX_HOME, join(seen.env.HOME, '.codex'));
  assert.equal(seen.auth, join(root, 'codex-home', 'auth.json'));
  for (const name of ['CLAUDECODE', 'OTHER_SECRET']) assert.equal(seen.env[name], null, name);
  assert.ok(seen.argv.includes('--ignore-user-config') && !seen.argv.includes('--output-schema'));
  assert.equal(seen.argv[seen.argv.indexOf('-C') + 1], seen.cwd);
  // A session's messages are its work, not progress updates.
  const events = (await readFile(join(root, 'run-1', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(!events.some(e => e.event === 'progress' && e.message === 'Done: memo.md'));
  const entries = (await readFile(join(artifacts, result.result.transcript.path), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const { at, ...last } = entries.at(-1);
  assert.deepEqual(last, { i: entries.length - 1, role: 'system', kind: 'result', text: 'Done: memo.md', tool: null, path: null, raw_ref: 'last-message.txt' });
  assert.ok(!Number.isNaN(Date.parse(at)));
});
