import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod } from '../src/runner.js';
import { claudeTranscript, codexTranscript, shellReads } from '../src/transcript.js';
import { tempFolder } from '../src/io.js';

// Small synthetic streams in the shapes that Claude Code (stream-json) and Codex (exec --json) write.
const lines = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';
const longText = 'A long tool result. '.repeat(5000);
const claudeStream = lines([
  { type: 'system', subtype: 'init', session_id: 's', model: 'claude-test', tools: ['Read'], mcp_servers: [] },
  { type: 'system', subtype: 'hook_started', hook_id: 'h', hook_name: 'SessionStart', hook_event: 'SessionStart', session_id: 's' },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Read the brief first.', signature: 'x' }] }, session_id: 's' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'I will read the brief.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/brief.md' } }] }, session_id: 's' },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: longText }] }, session_id: 's' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls /w' } }] }, session_id: 's' },
  { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't2', message: 'Bash is not allowed.', session_id: 's' },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'Permission denied.' }] }] }, session_id: 's' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: '/w/memo.md', content: 'Memo' } }] }, session_id: 's' },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Written.' }] }, session_id: 's' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'mcp__method_step__lookup', input: { name: 'Ada' } }] }, session_id: 's' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: 's' },
  { type: 'result', subtype: 'success', is_error: false, structured_output: { memo: 'Memo' }, session_id: 's' },
]);

test('a Claude Code stream becomes one transcript entry per message, tool call and result, with full text', () => {
  const entries = claudeTranscript('Write the memo.', 'not json\n' + claudeStream);
  assert.deepEqual(entries.map(e => [e.role, e.kind, e.tool, e.path]), [
    ['user', 'prompt', null, null],
    ['assistant', 'thinking', null, null],
    ['assistant', 'message', null, null],
    ['assistant', 'file_read', 'Read', '/w/brief.md'],
    ['tool', 'tool_result', 'Read', '/w/brief.md'],
    ['assistant', 'command', 'Bash', null],
    ['system', 'error', 'Bash', null],
    ['tool', 'error', 'Bash', null],
    ['assistant', 'file_write', 'Write', '/w/memo.md'],
    ['tool', 'tool_result', 'Write', '/w/memo.md'],
    ['assistant', 'tool_call', 'mcp__method_step__lookup', null],
    ['system', 'result', null, null],
  ]);
  assert.deepEqual(entries.map(e => e.i), entries.map((_, i) => i));
  assert.equal(entries[0].raw_ref, 'prompt.md');
  // Line 1 is not JSON; the init event is line 2, so the first thinking block is line 4.
  assert.equal(entries[1].raw_ref, 'events.jsonl:4');
  assert.equal(entries[4].text, longText);
  assert.equal(entries[5].text, 'ls /w');
  assert.equal(entries[7].text, 'Permission denied.');
  assert.equal(entries[11].text, '{"memo":"Memo"}');
  assert.ok(entries.every(e => !('inferred' in e)));
});

test('a Claude Code stream that stopped at a usage limit ends with the limit message as an error', () => {
  const entries = claudeTranscript('Write.', lines([
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792110600, rateLimitType: 'five_hour' } },
    { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your session limit · resets 8:30pm (America/New_York)" }] } },
    { type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 8:30pm (America/New_York)" },
  ]));
  assert.deepEqual(entries.slice(1).map(e => [e.role, e.kind]), [['system', 'error'], ['system', 'error']]);
});

const codexStream = lines([
  { type: 'thread.started', thread_id: 'th' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'Look at the files.' } },
  { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'sed -n 1,80p src/a.js && cat notes.md | head -5'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'sed -n 1,80p src/a.js && cat notes.md | head -5'", aggregated_output: longText, exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: '/w/memo.md', kind: 'add' }], status: 'completed' } },
  { type: 'item.started', item: { id: 'i3', type: 'mcp_tool_call', server: 'method_step', tool: 'lookup', arguments: { name: 'Ada' }, result: null, error: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'i3', type: 'mcp_tool_call', server: 'method_step', tool: 'lookup', arguments: { name: 'Ada' }, result: { content: [{ type: 'text', text: 'Ada Lovelace' }] }, error: null, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i4', type: 'web_search', query: 'memo style', action: { type: 'search' }, results: [{ title: 'Style', url: 'https://example.com/style', snippet: 'Short.' }] } },
  { type: 'item.completed', item: { id: 'i5', type: 'agent_message', text: 'The memo is saved.' } },
  { type: 'item.started', item: { id: 'i6', type: 'command_execution', command: 'npm test', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'error', message: 'stream disconnected' },
  { type: 'turn.failed', error: { message: 'stream disconnected' } },
]);

test('a Codex stream becomes the same transcript format; files read through the shell are marked inferred', () => {
  const entries = codexTranscript('Write the memo.', codexStream, { memo: 'Memo' });
  assert.deepEqual(entries.map(e => [e.role, e.kind, e.tool, e.path, e.inferred ?? false]), [
    ['user', 'prompt', null, null, false],
    ['assistant', 'thinking', null, null, false],
    ['assistant', 'command', 'shell', null, false],
    ['assistant', 'file_read', 'shell', 'src/a.js', true],
    ['assistant', 'file_read', 'shell', 'notes.md', true],
    ['tool', 'tool_result', 'shell', null, false],
    ['assistant', 'file_write', 'apply_patch', '/w/memo.md', false],
    ['assistant', 'tool_call', 'method_step.lookup', null, false],
    ['tool', 'tool_result', 'method_step.lookup', null, false],
    ['assistant', 'search', 'web_search', null, false],
    ['tool', 'tool_result', 'web_search', null, false],
    ['assistant', 'message', null, null, false],
    // A command that never completed is shown as it started.
    ['assistant', 'command', 'shell', null, false],
    // Codex reports one failure as an error and as turn.failed: it is one entry.
    ['system', 'error', null, null, false],
    ['system', 'result', null, null, false],
  ]);
  assert.equal(entries[5].text, longText);
  assert.equal(entries[5].raw_ref, 'events.jsonl:5');
  assert.equal(entries[8].text, 'Ada Lovelace');
  assert.equal(entries.at(-1).raw_ref, 'result.json');
});

test('shell reads are guesses from the file operands of reading commands', () => {
  assert.deepEqual(shellReads("bash -lc 'nl -ba a.md | sed -n 1,20p; head -n 5 b.txt; rg foo c.md; wc -l d.csv'"), ['a.md', 'b.txt', 'd.csv']);
  assert.deepEqual(shellReads('cat "my notes.md" > copy.md'), ['my notes.md']);
  assert.deepEqual(shellReads('wc -l < data.csv 2>/dev/null'), ['data.csv']);
  assert.deepEqual(shellReads('ls -la'), []);
});

const agentMethod = backend => ({ format: 'method/3.1', name: 'Agent', goal: 'Write a memo.', steps: { write: { name: 'Write the memo', do: { kind: 'agent', model: 'writer', prompt: 'Write the memo.', tools: [] }, out: { memo: { type: 'text' } } } }, result: 'memo' });
async function agentRun(t, backend, program) {
  const root = await mkdtemp(join(tmpdir(), 'method-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, backend);
  await writeFile(command, `#!/usr/bin/env node\n${program}\n`, { mode: 0o700 });
  const file = join(root, 'task.method');
  await writeFile(file, JSON.stringify(agentMethod(backend)));
  const runDir = join(root, 'run');
  const result = await runMethod(file, { allow_local_processes: true, models: { writer: { backend, command } } }, { runDir });
  const [attempt] = await readdir(join(runDir, 'artifacts', backend));
  const folder = join(runDir, 'artifacts', backend, attempt);
  const transcript = (await readFile(join(folder, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { result, folder, transcript, summary: JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8')) };
}

test('a Claude Code attempt keeps its prompt and transcript; the summary has the execution ID', async t => {
  const stream = lines([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Writing.' }] } },
    { type: 'result', subtype: 'success', is_error: false, structured_output: { memo: 'Memo' } },
  ]);
  const { result, folder, transcript, summary } = await agentRun(t, 'claude', `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(stream)}));`);
  assert.equal(result.status, 'completed', result.failure?.details);
  const prompt = await readFile(join(folder, 'prompt.md'), 'utf8');
  assert.match(prompt, /^Write the memo\.\n\nStep inputs:/);
  assert.deepEqual(transcript.map(e => e.kind), ['prompt', 'message', 'result']);
  assert.equal(transcript[0].text, prompt);
  assert.match(result.execution_id, /^[0-9a-f-]{36}$/);
  assert.equal(summary.execution_id, result.execution_id);
});

test('a Claude Code usage limit is a readable limit failure, with its transcript', async t => {
  const message = "You've hit your session limit · resets 8:30pm (America/New_York)";
  const stream = lines([
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792110600, rateLimitType: 'five_hour' } },
    { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: message }] } },
    { type: 'result', subtype: 'success', is_error: true, result: message, api_error_status: 429 },
  ]);
  for (const exitCode of [1, 0]) {
    const { result, transcript } = await agentRun(t, 'claude', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(stream)});process.exitCode=${exitCode};});`);
    assert.equal(result.status, 'failed');
    assert.equal(result.failure.owner, 'limit'); assert.equal(result.failure.code, 'usage_limit');
    assert.equal(result.failure.headline, `In step "Write the memo", Claude Code reached the usage limit of your plan: ${message}.`);
    assert.deepEqual(result.failure.next, { action: 'run_again', text: 'This is a usage limit, not a problem in the Method. Run again after the limit resets. Steps that finished are reused.' });
    assert.equal(transcript.at(-1).kind, 'error');
  }
});

test('a Codex usage limit is a readable limit failure, with its transcript', async t => {
  const message = 'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 22nd, 2026 11:45 AM.';
  const stream = lines([{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }, { type: 'error', message }, { type: 'turn.failed', error: { message } }]);
  for (const exitCode of [1, 0]) {
    const { result, folder, transcript } = await agentRun(t, 'codex', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(stream)});process.exitCode=${exitCode};});`);
    assert.equal(result.failure.owner, 'limit'); assert.equal(result.failure.code, 'usage_limit');
    assert.match(result.failure.headline, /^In step "Write the memo", Codex reached the usage limit of your plan: You’ve hit your usage limit\./);
    assert.equal(result.failure.next.action, 'run_again');
    assert.deepEqual(transcript.map(e => e.kind), ['prompt', 'error']);
    assert.equal(transcript[0].text, await readFile(join(folder, 'prompt.md'), 'utf8'));
  }
});

test('a model step attempt gets a transcript whose entries point at the run events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-model-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'task.method');
  await writeFile(join(root, 'tool.mjs'), 'let s="";for await(const x of process.stdin)s+=x;console.log(JSON.stringify({result:JSON.parse(s).value+1}))');
  await writeFile(file, JSON.stringify({ format: 'method/3.1', name: 'Model', goal: 'Add one.', steps: { add: { do: { kind: 'agent', model: 'model', prompt: 'Add one to 4.', tools: ['increment'] }, out: { value: { type: 'number' } }, limits: { max_model_requests: 3, max_agent_turns: 3 } } }, result: 'value' }));
  const number = { type: 'number', description: 'A number.' };
  const config = { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } },
    tools: { increment: { description: 'Add one.', in: { value: number }, out: { result: number }, run: { kind: 'run', runtime: 'node', entrypoint: 'tool.mjs' }, effects: [] } },
    models: { model: { backend: 'openai-responses', model: 'test-model', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100 } } };
  let calls = 0;
  const transport = async () => ++calls === 1
    ? { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'increment', arguments: '{"value":4}' }] }
    : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"value":5}' }] }] };
  const runDir = join(root, 'run');
  const result = await runMethod(file, config, { runDir, transport });
  assert.equal(result.status, 'completed', result.failure?.details);
  const [attempt] = await readdir(join(runDir, 'artifacts', 'model'));
  const transcript = (await readFile(join(runDir, 'artifacts', 'model', attempt, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(transcript.map(e => [e.role, e.kind, e.tool, e.text]), [
    ['user', 'prompt', null, 'Add one to 4.\n\n{}'],
    ['assistant', 'tool_call', 'increment', '{"value":4}'],
    ['tool', 'tool_result', 'increment', '{"result":5}'],
    ['system', 'result', null, '{"value":5}'],
  ]);
  const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const at = ref => events.find(e => e.sequence === Number(ref.slice('run:'.length)));
  assert.equal(at(transcript[0].raw_ref).event, 'model.request');
  assert.equal(at(transcript[1].raw_ref).event, 'model.response');
  assert.equal(at(transcript[3].raw_ref).event, 'model.response');
  assert.notEqual(transcript[1].raw_ref, transcript[3].raw_ref);
});

test('a temporary folder is short even when the inherited TMPDIR is deep', async t => {
  const deep = join(tmpdir(), 'method-deep-', 'a'.repeat(60), 'b'.repeat(60));
  await mkdir(deep, { recursive: true });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = deep;
  t.after(async () => { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; await rm(join(tmpdir(), 'method-deep-'), { recursive: true, force: true }); });
  const folder = await tempFolder('mx-');
  t.after(() => rm(folder, { recursive: true, force: true }));
  assert.ok(!folder.includes('method-deep-'));
  if (process.platform !== 'win32') assert.match(folder, /^(\/private)?\/tmp\/mx-\w{6}$/);
});
