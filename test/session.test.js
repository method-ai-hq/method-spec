import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { runMethod } from '../src/runner.js';
import { claudeArgs } from '../src/claude.js';
import { codexArgs } from '../src/codex.js';
import { cleanRoomEnv, keychain } from '../src/clean-room.js';
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
    // The agents' config folders are the room's defaults (HOME/.claude, HOME/.codex), so no variable names them.
    for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) assert.equal(room.env[name], undefined, name);
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

test('a Codex clean room links only the sign-in file into HOME/.codex, and says plainly when there is none', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-clean-codex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'user-codex');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'auth.json'), '{}');
  await writeFile(join(codexHome, 'config.toml'), 'model = "x"');
  await writeFile(join(codexHome, 'AGENTS.md'), 'User rules');
  const room = await cleanRoomEnv('codex', { PATH: '/usr/bin', CODEX_HOME: codexHome });
  try {
    assert.equal(room.env.CODEX_HOME, undefined);
    assert.equal(await readlink(join(room.env.HOME, '.codex', 'auth.json')), join(codexHome, 'auth.json'));
    for (const name of ['config.toml', 'AGENTS.md']) assert.ok(await gone(join(room.env.HOME, '.codex', name)), name);
  } finally { await room.remove(); }
  await assert.rejects(cleanRoomEnv('codex', { PATH: '/usr/bin', CODEX_HOME: join(root, 'none') }), error => error.owner === 'setup' && /codex login/.test(error.message));
  // A Method arm whose steps run on both agents gets both sign-ins; one that runs on neither gets none.
  const both = await cleanRoomEnv(['claude', 'codex'], { PATH: '/usr/bin', CODEX_HOME: codexHome, CLAUDE_CODE_OAUTH_TOKEN: 't' });
  try {
    assert.equal(both.env.CLAUDE_CODE_OAUTH_TOKEN, 't');
    assert.equal(await readlink(join(both.env.HOME, '.codex', 'auth.json')), join(codexHome, 'auth.json'));
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

test('a Claude Code clean room links the login Keychain, so Claude Code reads and refreshes the sign-in itself, and holds no copy of the token', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-clean-keychain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'user');
  await mkdir(join(user, 'Library', 'Keychains'), { recursive: true });
  const asked = [];
  const before = keychain.hasClaude;
  keychain.hasClaude = async (home, name) => { asked.push([home, name]); return true; };
  t.after(() => { keychain.hasClaude = before; });
  const room = await cleanRoomEnv('claude', { PATH: '/usr/bin', HOME: user, USER: 'ryan' });
  try {
    assert.deepEqual(asked, [[user, 'ryan']]);
    assert.equal(await readlink(join(room.env.HOME, 'Library', 'Keychains')), join(user, 'Library', 'Keychains'));
    // No token, and no CLAUDE_CONFIG_DIR: Claude Code then uses the Keychain entry of its default config folder, the user's own.
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY']) assert.equal(room.env[name], undefined, name);
  } finally { await room.remove(); }
  // A user with their own CLAUDE_CONFIG_DIR keeps the sign-in in that folder's credentials file.
  const config = join(root, 'config');
  await mkdir(config);
  await writeFile(join(config, '.credentials.json'), '{}');
  const own = await cleanRoomEnv('claude', { PATH: '/usr/bin', HOME: user, CLAUDE_CONFIG_DIR: config });
  try {
    assert.equal(await readlink(join(own.env.HOME, '.claude', '.credentials.json')), join(config, '.credentials.json'));
    assert.ok(await gone(join(own.env.HOME, 'Library')));
  } finally { await own.remove(); }
  keychain.hasClaude = async () => false;
  await assert.rejects(cleanRoomEnv('claude', { PATH: '/usr/bin', HOME: user }), error => error.owner === 'setup' && /claude auth login/.test(error.message));
});

test('a script in a clean room, and an agent that the script starts, find the room\'s sign-in through HOME alone', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-clean-script-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'user');
  await mkdir(join(user, 'Library', 'Keychains'), { recursive: true });
  await writeFile(join(user, 'Library', 'Keychains', 'login.keychain-db'), 'keychain');
  const before = keychain.hasClaude;
  keychain.hasClaude = async () => true;
  t.after(() => { keychain.hasClaude = before; });
  const room = await cleanRoomEnv('claude', { PATH: process.env.PATH, HOME: user, USER: 'ryan' });
  t.after(() => room.remove());
  // The script, like improve.method's, starts another process with only PATH and HOME.
  await writeFile(join(root, 'sign-in.mjs'), `import { execFileSync } from 'node:child_process';
const seen = execFileSync(process.execPath, ['-e', "const fs = require('fs'); process.stdout.write(fs.readFileSync(process.env.HOME + '/Library/Keychains/login.keychain-db', 'utf8'))"], { env: { PATH: process.env.PATH, HOME: process.env.HOME } }).toString();
console.log(JSON.stringify({ seen }));`);
  const file = join(root, 'sign-in.method');
  await writeFile(file, JSON.stringify({ format: 'method/3.4', name: 'Sign-in', goal: 'Show what a process started by a script finds.',
    steps: { look: { name: 'Look', purpose: 'Reads the sign-in that a process started by the script finds. Changes nothing.', do: { kind: 'run', runtime: 'node', entrypoint: 'sign-in.mjs' },
      out: { seen: { type: 'text', description: 'What the process found.' } } } }, result: 'seen' }));
  withEnv(t, Object.fromEntries([...Object.keys(process.env).map(name => [name, undefined]), ...Object.entries(room.env)]));
  const result = await runMethod(file, { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } } }, { runDir: join(root, 'run') });
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.equal(result.result, 'keychain');
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
  // The room as it was before a session wrote its files into it.
  const reset = () => Promise.all(['memo.md', 'seen.json'].map(name => rm(join(room, name), { force: true })));
  return { root, room, counter, run, reset };
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
  // What the session wrote is in the room folder, where later steps read it.
  assert.equal(await readFile(join(room, 'memo.md'), 'utf8'), 'Memo on the brief');
  const seen = JSON.parse(await readFile(join(artifacts, files_written.find(file => file.path.endsWith('seen.json')).path), 'utf8'));
  // Only the prompt: no step inputs, no "do only this step", no output form.
  assert.equal(seen.prompt, 'Read brief.md and write memo.md. Task: Be brief.');
  assert.ok(seen.argv.includes('--restricted') && !seen.argv.includes('--json-schema') && !seen.argv.includes('--mcp-config'));
  assert.equal(seen.argv[seen.argv.indexOf('--tools') + 1], 'Read,Write');
  // The clean room: a fresh home with only the sign-in; none of the caller's variables.
  assert.equal(seen.env.CLAUDE_CODE_OAUTH_TOKEN, 'session-token');
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, null);
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
  const { root, room, counter, run, reset } = await sessionFixture(t);
  const count = async () => (await readFile(counter, 'utf8')).length;
  assert.equal((await run('r0')).status, 'completed');
  await reset();
  const again = await run('r0-again', { cacheFrom: [join(root, 'r0')] });
  assert.deepEqual(again.reused, { work: 1 });
  assert.equal(await count(), 1);
  // A reused session puts its files into the room as the session did.
  assert.equal(await readFile(join(room, 'memo.md'), 'utf8'), 'Memo on the brief');
  await reset();
  const second = await run('r1', { cacheFrom: [join(root, 'r0')], repeat: 1 });
  assert.equal(second.status, 'completed'); assert.equal(second.reused, undefined);
  assert.equal(await count(), 2);
  await reset();
  assert.deepEqual((await run('r1-again', { cacheFrom: [join(root, 'r0'), join(root, 'r1')], repeat: 1 })).reused, { work: 1 });
  assert.equal(await count(), 2);
  await reset();
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
  fs.writeFileSync('seen.json', JSON.stringify({ argv, cwd: process.cwd(), env, prompt, auth: fs.readlinkSync(process.env.HOME + '/.codex/auth.json') }));
  fs.writeFileSync('memo.md', 'Memo');
  fs.writeFileSync(argv[argv.indexOf('--output-last-message') + 1], 'Done: memo.md');
  const out = e => console.log(JSON.stringify(e));
  out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'cat brief.md', aggregated_output: 'the brief', exit_code: 0 } });
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Done: memo.md' } });
  out({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 2 } });
});
`;

test('a Codex session runs in a clean HOME/.codex with only the sign-in link, and returns its last message', async t => {
  const { root, run } = await sessionFixture(t, 'codex');
  const result = await run('run-1');
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.equal(result.result.final_text, 'Done: memo.md');
  assert.equal(result.codex.processes, 1);
  const artifacts = join(root, 'run-1', 'artifacts');
  const seen = JSON.parse(await readFile(join(artifacts, result.result.files_written.find(file => file.path.endsWith('seen.json')).path), 'utf8'));
  assert.equal(seen.prompt, 'Read brief.md and write memo.md. Task: Be brief.');
  assert.equal(seen.env.CODEX_HOME, null);
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

test('a session in a room with read-only files and folders hands in its file, and its clean room is removed', async t => {
  const { root, room, run } = await sessionFixture(t);
  const { chmod } = await import('node:fs/promises');
  await mkdir(join(room, 'matter'));
  await writeFile(join(room, 'matter', 'request.txt'), 'the request');
  await chmod(join(room, 'matter', 'request.txt'), 0o444);
  await chmod(join(room, 'matter'), 0o555);
  const result = await run('run-ro');
  await chmod(join(room, 'matter'), 0o755);
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.equal(await readFile(join(room, 'memo.md'), 'utf8'), 'Memo on the brief');
  const seen = JSON.parse(await readFile(join(root, 'run-ro', 'artifacts', result.result.files_written.find(file => file.path.endsWith('seen.json')).path), 'utf8'));
  assert.ok(await gone(seen.env.HOME));
});

test('a usage limit in a replay of a case stops the test with the limit, and is not a failed case', async t => {
  const { root, run } = await sessionFixture(t);
  const { createCase, listCases, testCase } = await import('../src/cases.js');
  const source = await run('source');
  assert.equal(source.status, 'completed', source.failure?.details);
  const file = join(root, 'plain.method');
  await createCase({ methodFile: file, runDir: join(root, 'source'), id: 'memo', note: 'Say more.', config: { allow_local_processes: true },
    expect: [{ kind: 'equals', ref: 'outputs.session.final_text', value: 'A longer memo.' }] });
  // Claude Code now reports that the plan's usage limit is reached.
  const bin = process.env.PATH.split(delimiter)[0];
  await writeFile(join(bin, 'claude'), `#!/usr/bin/env node
process.stdin.on('data', () => {}).on('end', () => {
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'You have hit your limit' }));
});
`, { mode: 0o700 });
  const [item] = await listCases(file);
  await assert.rejects(testCase(file, { allow_local_processes: true }, item, {}, { live: ['work'] }), error => error.code === 'usage_limit' && /usage limit/.test(error.message));
});

test('a session reads the step\'s learned rules after its prompt, each with its condition', async t => {
  const { root, run } = await sessionFixture(t);
  await writeFile(join(root, 'learned.json'), JSON.stringify({ format: 'method-learned/1', steps: { work: [
    { id: 'lr_000000000001', when: null, then: 'Sign the memo.', by: null, from: {}, status: 'active', created: '2026-10-28T00:00:00Z' },
    { id: 'lr_000000000002', when: 'the brief names a competitor.', then: 'Mark the memo confidential.', by: null, from: {}, status: 'active', created: '2026-10-28T00:00:00Z' },
    { id: 'lr_000000000003', when: null, then: 'Retired rule.', by: null, from: {}, status: 'retired', created: '2026-10-28T00:00:00Z' }] } }));
  const result = await run('run-rules');
  assert.equal(result.status, 'completed', result.failure?.details);
  const seen = JSON.parse(await readFile(join(root, 'run-rules', 'artifacts', result.result.files_written.find(file => file.path.endsWith('seen.json')).path), 'utf8'));
  assert.equal(seen.prompt, 'Read brief.md and write memo.md. Task: Be brief.\n\nRules learned from corrections:\n- Sign the memo.\n- When the brief names a competitor: Mark the memo confidential.');
});
