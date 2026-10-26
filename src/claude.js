import { modelName } from './semantics.js';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { executable, executeProcess, writeJSON } from './io.js';
import { fail, safeData, assertSchema } from './validate.js';
import { startMethodTools } from './method-tools.js';
import { agentEvent } from './progress.js';
import { agentNotice } from './event-text.js';
import { claudeTranscript, writeTranscript } from './transcript.js';

// An absolute path in a Claude Code permission rule starts with //.
const under = (tool, dir) => `${tool}(/${resolve(dir)}/**)`;
/**
 * The Claude Code arguments of one step. A live run allows the file tools everywhere and web search and fetch. A replay
 * allows reading only in its scratch folder and its run folder, writing only in its scratch folder and the run's
 * artifacts, and no shell or network.
 */
export function claudeArgs({ schema, mcpConfig, profile = {}, artifacts, replay = null }) {
  const allowed = replay
    ? [...['Read', 'Glob', 'Grep'].flatMap(tool => [under(tool, replay.scratch), under(tool, replay.runDir)]),
      ...['Write', 'Edit'].flatMap(tool => [under(tool, artifacts), under(tool, replay.scratch)]), 'mcp__method_step__*']
    : ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__method_step__*'];
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--json-schema', JSON.stringify(schema), '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--permission-mode', 'dontAsk', '--allowedTools', allowed.join(',')];
  if (replay) args.push('--disallowedTools', 'Bash,WebSearch,WebFetch');
  if (profile.model) args.push('--model', profile.model);
  if (profile.reasoning_effort) args.push('--effort', profile.reasoning_effort);
  return args;
}

export async function executeClaude(execution, input, schema, context) {
  const profile = context.models[modelName(execution)];
  const command = await executable(profile.command ?? 'claude');
  await mkdir(join(context.artifacts, 'claude'), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(context.artifacts, 'claude', 'attempt-'));
  const bridge = await startMethodTools(execution, context);
  const clean = value => String(value).replaceAll(bridge.token, '[REDACTED]');
  const prompt = [execution.prompt, 'Step inputs:', JSON.stringify(input),
    'Do only this step; Method runs the other steps. Use the Method tools for the operations they declare. Do not change the Method, its scripts, or its input files.',
    `Save any output files under ${context.artifacts}. Return the step output in the requested JSON format.`].join('\n\n');
  const args = claudeArgs({ schema, mcpConfig: join(directory, 'mcp.json'), profile, artifacts: context.artifacts, replay: context.replay });
  // Tokens stay in a private file, never process arguments or run events.
  await writeJSON(join(directory, 'mcp.json'), { mcpServers: { method_step: { type: 'http', url: bridge.url, headers: { Authorization: `Bearer ${bridge.token}` } } } });
  const events = [];
  // A usage limit of the person's Claude plan: Claude Code reports it as a rejected rate limit event.
  const usageLimit = () => events.some(event => event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected');
  let output = '';
  try {
    if (Buffer.byteLength(prompt) > context.maxRequestBytes) fail('limit', 'Claude prompt exceeds request limit', 'input_limit', { limit: 'request size', value: context.maxRequestBytes });
    await writeFile(join(directory, 'prompt.md'), prompt, { mode: 0o600 });
    await context.record('agent.started', { provider: 'claude', command, model: profile.model ?? 'user-default', directory });
    const result = await executeProcess({ command, args, cwd: directory, input: prompt, rawInput: true,
      env: { ...process.env, METHOD_OUTPUT_DIR: context.artifacts }, signal: context.signal, maxBytes: context.maxOutputBytes,
      onStdoutLine: async line => {
        let event; try { event = JSON.parse(line); } catch { return; }
        events.push(event);
        // Claude Code reports problems that it handles itself as error-type or warning-type events.
        const reported = agentEvent(event);
        if (reported && !context.signal.aborted) await context.notice?.({ kind: 'agent', sub: `claude_${reported.level}`, message: agentNotice({ agent: 'Claude Code', ...reported, message: clean(reported.message) }) });
        for (const item of event.type === 'assistant' ? event.message?.content ?? [] : []) {
          if (item.type === 'tool_use' && typeof item.name === 'string') await context.record('progress', {provider:'claude',message:`Using ${item.name}.`});
        }
        if (event.type === 'system' && event.subtype === 'init') {
          if (event.mcp_server_errors?.length || event.mcp_servers?.some(s => s.name === 'method_step' && !['connected', 'pending'].includes(s.status))) fail('setup', 'Claude could not connect to Method tools.', 'tool_unavailable');
          await context.record('agent.ready', { provider: 'claude', model: event.model });
        }
      } });
    output = clean(result.output);
    await writeFile(join(directory, 'events.jsonl'), output, { mode: 0o600 });
    await writeFile(join(directory, 'stderr.log'), clean(result.diagnostics), { mode: 0o600 });
    const last = events.filter(e => e.type === 'result').at(-1);
    // A failed result is a failure of Claude Code or its model service: check it before the output's form.
    if (!last || last.is_error || last.subtype !== 'success') {
      const message = clean(last?.errors?.join('\n') || last?.result || 'Claude did not return a successful result.');
      if (usageLimit()) fail('limit', message, 'usage_limit', { producer: 'Claude Code' });
      fail('outside_service', message, 'claude_failed', { producer: 'Claude Code' });
    }
    const value = last.structured_output;
    safeData(value, 'agent_work'); assertSchema(schema, value, 'Claude output', { producer: 'Claude Code', owner: 'agent_work' });
    await context.record('agent.completed', { provider: 'claude', directory, usage: last.usage ?? null });
    return value;
  } catch (error) {
    if (context.signal.aborted) error = context.signal.reason;
    if (error.output) { output = clean(error.output); await writeFile(join(directory, 'events.jsonl'), output, { mode: 0o600 }); }
    if (error.diagnostics) await writeFile(join(directory, 'stderr.log'), clean(error.diagnostics), { mode: 0o600 });
    const failure = events.findLast(event => event.type === 'result' && (event.is_error || event.subtype !== 'success'));
    if (!context.signal.aborted) error.message = clean(failure?.errors?.join('\n') || failure?.result || error.diagnostics || error.message);
    // Claude Code exited with an error: the agent or its model service failed.
    if (!context.signal.aborted && error.code === 'process_failed') Object.assign(error, usageLimit() ? { owner: 'limit', code: 'usage_limit', producer: 'Claude Code' } : { owner: 'outside_service', producer: 'Claude Code' });
    await context.record('agent.failed', { provider: 'claude', directory, message: error.message });
    throw error;
  } finally {
    await bridge.close(); await rm(join(directory,'mcp.json'),{force:true});
    await writeTranscript(directory, claudeTranscript(prompt, output), value => context.redact(clean(value)));
  }
}
