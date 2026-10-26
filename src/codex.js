import { modelName } from './semantics.js';
import { startMethodTools } from './method-tools.js';
export { startMethodTools } from './method-tools.js';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { executable, executeProcess, writeJSON } from './io.js';
import { fail, safeData, assertSchema } from './validate.js';
import { codexProgress, agentEvent } from './progress.js';
import { agentNotice } from './event-text.js';
import { codexTranscript, writeTranscript } from './transcript.js';

/**
 * The Codex arguments of one step. A live run bypasses the sandbox, as before. A replay runs in Codex's workspace-write
 * sandbox rooted at its scratch folder, with the run's artifacts as the only other writable folder and no network.
 */
export function codexArgs({ schemaFile, output, url, profile = {}, artifacts, replay = null }) {
  const sandbox = replay
    ? ['--sandbox', 'workspace-write', '-C', replay.scratch, '--add-dir', artifacts, '-c', 'sandbox_workspace_write.network_access=false',
      // Codex also lets a workspace-write sandbox write to /tmp and $TMPDIR unless told not to; a replay must not.
      '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true']
    : ['--dangerously-bypass-approvals-and-sandbox'];
  const args = ['exec', '--ephemeral', ...sandbox, '--skip-git-repo-check',
    '--json', '--output-schema', schemaFile, '--output-last-message', output,
    '-c', `mcp_servers.method_step.url=${JSON.stringify(url)}`,
    '-c', 'mcp_servers.method_step.bearer_token_env_var="METHOD_CODEX_TOOL_TOKEN"',
    '-c', 'mcp_servers.method_step.required=true'];
  if (profile.model) args.push('--model', profile.model);
  if (profile.reasoning_effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(profile.reasoning_effort)}`);
  args.push('-');
  return args;
}

export async function executeCodex(execution, input, schema, context) {
  const profile = context.models[modelName(execution)];
  const command = await executable(profile.command ?? 'codex');
  await mkdir(join(context.artifacts, 'codex'), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(context.artifacts, 'codex', 'attempt-'));
  const output = join(directory, 'result.json');
  await writeJSON(join(directory, 'schema.json'), schema);
  const prompt = [execution.prompt, 'Step inputs:', JSON.stringify(input),
    'Give a short progress update when you start a new part of the work or finish a group of tool calls. Describe the work; do not quote sources or secrets. Updates do not replace the final output.',
    'Do only this step; Method runs the other steps. Use the Method tools for the operations they declare. Do not change the Method, its scripts, or its input files.',
    `Save any output files under ${context.artifacts}. Return the step output in the requested JSON format.`].join('\n\n');
  if (Buffer.byteLength(prompt) > context.maxRequestBytes) fail('limit', 'Codex prompt exceeds request limit', 'input_limit', { limit: 'request size', value: context.maxRequestBytes });
  await writeFile(join(directory, 'prompt.md'), prompt, { mode: 0o600 });
  const bridge = await startMethodTools(execution, context);
  const args = codexArgs({ schemaFile: join(directory, 'schema.json'), output, url: bridge.url, profile, artifacts: context.artifacts, replay: context.replay });
  const env = { ...process.env, METHOD_CODEX_TOOL_TOKEN: bridge.token,
    PATH: [dirname(command), process.env.PATH ?? ''].join(delimiter), METHOD_OUTPUT_DIR: context.artifacts };
  // A usage limit of the person's ChatGPT plan: Codex says so only in its error message.
  const usageLimit = message => /\b(hit|reached) your usage limit\b/i.test(message ?? '');
  const clean = value => String(value).replaceAll(bridge.token, '[REDACTED]');
  let eventsText = '', value;
  try {
    await context.record('codex.started', { provider: 'codex', command, model: profile.model ?? 'user-default', directory, prompt, output_schema: schema });
    const result = await executeProcess({ command, args, cwd: directory, input: prompt, rawInput: true,
      env, signal: context.signal, maxBytes: context.maxOutputBytes,
      onStdoutLine: async line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        const progress = codexProgress(event);
        if (progress && !context.signal.aborted) await context.record('progress', { ...progress, message: progress.message.replaceAll(bridge.token, '[REDACTED]') });
        // Codex reports problems that it handles itself (a retry, a tool that did not start) as error-type events.
        const reported = agentEvent(event);
        if (reported && !context.signal.aborted) await context.notice?.({ kind: 'agent', sub: `codex_${reported.level}`, message: agentNotice({ agent: 'Codex', ...reported, message: reported.message.replaceAll(bridge.token, '[REDACTED]') }) });
      },
    });
    eventsText = clean(result.output);
    await writeFile(join(directory, 'events.jsonl'), eventsText, { mode: 0o600 });
    await writeFile(join(directory, 'stderr.log'), result.diagnostics, { mode: 0o600 });
    // A failed turn is a failure of the model service, whatever partial output it left: check it before the output's form.
    const events = result.output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const failed = events.find(event => event.type === 'turn.failed');
    if (failed && usageLimit(failed.error?.message)) fail('limit', failed.error.message, 'usage_limit', { producer: 'Codex' });
    if (failed) fail('outside_service', failed.error?.message ?? 'Codex turn failed', 'codex_failed', { producer: 'Codex', provider_message: failed.error?.message });
    try {
      if ((await stat(output)).size > context.maxOutputBytes) fail('limit', 'Codex output exceeds output limit', 'output_limit', { limit: 'output size', value: context.maxOutputBytes });
      value = JSON.parse(await readFile(output, 'utf8'));
    } catch (error) { if (error.owner) throw error; fail('agent_work', 'Codex did not save a JSON result', 'invalid_output', { producer: 'Codex', problem: 'did not save a JSON result' }); }
    safeData(value, 'agent_work'); assertSchema(schema, value, 'Codex output', { producer: 'Codex', owner: 'agent_work' });
    await context.record('codex.completed', { directory, output: value,
      usage: events.filter(event => event.type === 'turn.completed').map(event => event.usage),
      internal_model_requests: 'managed by Codex; not counted by Method' });
    return value;
  } catch (error) {
    if (context.signal.aborted) error = context.signal.reason;
    if (error.output) {
      eventsText = clean(error.output);
      await writeFile(join(directory, 'events.jsonl'), eventsText, { mode: 0o600 });
      const failure = error.output.split('\n').reverse().flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
        .find(event => event.type === 'turn.failed' || event.type === 'error');
      const message = failure?.error?.message ?? failure?.message;
      if (message && !context.signal.aborted) error.message = `Codex failed: ${message}`;
      // Codex exited with an error: the agent or its model service failed.
      if (!context.signal.aborted && error.code === 'process_failed') Object.assign(error, usageLimit(message) ? { owner: 'limit', code: 'usage_limit', producer: 'Codex', message } : { owner: 'outside_service', producer: 'Codex', provider_message: message });
    }
    if (error.diagnostics) await writeFile(join(directory, 'stderr.log'), clean(error.diagnostics), { mode: 0o600 });
    await context.record('codex.failed', { directory, message: error.message });
    throw error;
  } finally {
    await bridge.close();
    await writeTranscript(directory, codexTranscript(prompt, eventsText, value), text => context.redact(clean(text)));
  }
}
