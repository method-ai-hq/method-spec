import { copyFile, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { executable, hash } from './io.js';
import { fail, resolve } from './validate.js';
import { claudeArgs, runClaude } from './claude.js';
import { codexArgs, runCodex } from './codex.js';
import { cleanRoomEnv, folderHashes } from './clean-room.js';

/**
 * One headless Claude Code or Codex session with no Method prompt, output form or tools: a plain agent, as a person
 * would run it. It runs in a clean room (cleanRoomEnv) and works in the room's own copy of its room folder, so the
 * folder itself never changes. exec.prompt is the rendered prompt; input holds the step's values, and exec.room names
 * the one that is the folder. Returns {final_text, files_written, transcript}: the agent's last message, a copy of each
 * file that it added or changed in its room, and its transcript, all under artifacts/session/attempt-*.
 */
export async function executeSession(exec, input, context) {
  const command = await executable(exec.agent);
  await mkdir(join(context.artifacts, 'session'), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(context.artifacts, 'session', 'attempt-'));
  const attempt = `session/${directory.split('/').at(-1)}`;
  const folder = exec.room ? resolve(input, exec.room) : null;
  if (folder !== null) {
    let info;
    try { info = await stat(folder); } catch { info = null; }
    if (!info?.isDirectory()) fail('setup', `The room of a session must be a folder; ${exec.room} is not one.`, 'preflight');
  }
  const room = await cleanRoomEnv(exec.agent, process.env, { folders: folder === null ? {} : { room: folder } });
  try {
    const cwd = room.folders.room ?? join(room.root, 'folders', 'room');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const before = await folderHashes(cwd);
    const profile = { model: exec.model, reasoning_effort: exec.reasoning_effort };
    let finalText;
    if (exec.agent === 'claude') {
      const last = await runClaude({ command, args: claudeArgs({ profile, bare: { tools: exec.tools } }), prompt: exec.prompt, cwd, env: room.env, directory, model: exec.model, context });
      finalText = typeof last.result === 'string' ? last.result : '';
      await context.record('agent.completed', { provider: 'claude', directory, usage: last.usage ?? null });
    } else {
      const output = join(directory, 'last-message.txt');
      const usage = await runCodex({ command, args: codexArgs({ output, profile, bare: { room: cwd, tools: exec.tools } }), prompt: exec.prompt, cwd, env: room.env, directory, model: exec.model, context,
        messages: false, resultFile: 'last-message.txt', readResult: async () => { finalText = await readFile(output, 'utf8').catch(() => ''); return finalText; } });
      await context.record('codex.completed', { directory, usage, internal_model_requests: 'managed by Codex; not counted by Method' });
    }
    const after = await folderHashes(cwd);
    const files_written = [];
    for (const path of Object.keys(after).filter(path => after[path] !== before[path]).sort()) {
      const target = join(directory, 'room', path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(cwd, path), target);
      files_written.push({ path: `${attempt}/room/${path}`, sha256: after[path] });
    }
    const transcript = await readFile(join(directory, 'transcript.jsonl'));
    return { final_text: finalText, files_written, transcript: { path: `${attempt}/transcript.jsonl`, sha256: hash(transcript) } };
  } finally {
    await room.remove();
  }
}
