import { startMethodTools } from './method-tools.js';
export { startMethodTools } from './method-tools.js';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { executable, executeProcess, writeJSON } from './io.js';
import { fail, safeData, assertSchema } from './validate.js';
import { codexProgress } from './progress.js';

export async function executeCodex(execution, input, schema, context) {
  const profile = context.models[execution.model];
  const command = await executable(profile.command ?? 'codex');
  await mkdir(join(context.artifacts, 'codex'), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(context.artifacts, 'codex', 'attempt-'));
  const output = join(directory, 'result.json');
  await writeJSON(join(directory, 'schema.json'), schema);
  const prompt = [execution.prompt, 'Step inputs:', JSON.stringify(input),
    'Give brief public progress updates when you start a new part of the work or finish a group of tool calls. Describe the work, without source passages or secrets. Progress messages do not replace the final output.',
    `Return the step output in the supplied format. Save any output files under ${context.artifacts}.`,
    'Use the Method tools for declared calculations and operations. Method runs the other steps. Do not change the Method, its scripts, or its input files.'].join('\n\n');
  if (Buffer.byteLength(prompt) > context.maxRequestBytes) fail('Codex prompt exceeds request limit', 'input_limit');
  await writeFile(join(directory, 'prompt.md'), prompt, { mode: 0o600 });
  const bridge = await startMethodTools(execution, context);
  const args = ['exec', '--ephemeral', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
    '--json', '--output-schema', join(directory, 'schema.json'), '--output-last-message', output,
    '-c', `mcp_servers.method_step.url=${JSON.stringify(bridge.url)}`,
    '-c', 'mcp_servers.method_step.bearer_token_env_var="METHOD_CODEX_TOOL_TOKEN"',
    '-c', 'mcp_servers.method_step.required=true'];
  if (profile.model) args.push('--model', profile.model);
  if (profile.reasoning_effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(profile.reasoning_effort)}`);
  args.push('-');
  const env = { ...process.env, METHOD_CODEX_TOOL_TOKEN: bridge.token,
    PATH: [dirname(command), process.env.PATH ?? ''].join(delimiter), METHOD_OUTPUT_DIR: context.artifacts };
  try {
    await context.record('codex.started', { provider: 'codex', command, model: profile.model ?? 'user-default', directory, prompt, output_schema: schema });
    const result = await executeProcess({ command, args, cwd: directory, input: prompt, rawInput: true,
      env, signal: context.signal, maxBytes: context.maxOutputBytes,
      onStdoutLine: async line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        const progress = codexProgress(event);
        if (progress && !context.signal.aborted) await context.record('progress', { ...progress, message: progress.message.replaceAll(bridge.token, '[REDACTED]') });
      },
    });
    await writeFile(join(directory, 'events.jsonl'), result.output, { mode: 0o600 });
    await writeFile(join(directory, 'stderr.log'), result.diagnostics, { mode: 0o600 });
    if ((await stat(output)).size > context.maxOutputBytes) fail('Codex output exceeds output limit', 'output_limit');
    const value = JSON.parse(await readFile(output, 'utf8'));
    safeData(value); assertSchema(schema, value, 'Codex output');
    const events = result.output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const failed = events.find(event => event.type === 'turn.failed');
    if (failed) fail(failed.error?.message ?? 'Codex turn failed', 'codex_failed');
    await context.record('codex.completed', { directory, output: value,
      usage: events.filter(event => event.type === 'turn.completed').map(event => event.usage),
      internal_model_requests: 'managed by Codex; not counted by Method' });
    return value;
  } catch (error) {
    if (context.signal.aborted) error = context.signal.reason;
    if (error.output) {
      await writeFile(join(directory, 'events.jsonl'), error.output.replaceAll(bridge.token, '[REDACTED]'), { mode: 0o600 });
      const failure = error.output.split('\n').reverse().flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
        .find(event => event.type === 'turn.failed' || event.type === 'error');
      const message = failure?.error?.message ?? failure?.message;
      if (message && !context.signal.aborted) error.message = `Codex failed: ${message}`;
    }
    if (error.diagnostics) await writeFile(join(directory, 'stderr.log'), error.diagnostics.replaceAll(bridge.token, '[REDACTED]'), { mode: 0o600 });
    await context.record('codex.failed', { directory, message: error.message });
    throw error;
  } finally { await bridge.close(); }
}
