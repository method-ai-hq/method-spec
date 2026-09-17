import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { executable, executeProcess, writeJSON } from './io.js';
import { fail, safeData, assertSchema } from './validate.js';
import { startMethodTools } from './method-tools.js';

export async function executeClaude(execution, input, schema, context) {
  const profile = context.models[execution.model];
  const command = await executable(profile.command ?? 'claude');
  await mkdir(join(context.artifacts, 'claude'), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(context.artifacts, 'claude', 'attempt-'));
  const bridge = await startMethodTools(execution, context);
  const clean = value => String(value).replaceAll(bridge.token, '[REDACTED]');
  const prompt = [execution.prompt, 'Step inputs:', JSON.stringify(input),
    `Save output files under ${context.artifacts}. Use the declared Method tools for their operations. Return the requested JSON output. Do not edit the Method or its input files.`].join('\n\n');
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--json-schema', JSON.stringify(schema), '--strict-mcp-config', '--mcp-config', join(directory, 'mcp.json'),
    '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Write,Edit,Glob,Grep,mcp__method_step__*'];
  if (profile.model) args.push('--model', profile.model);
  if (context.maxAgentTurns) args.push('--max-turns', String(context.maxAgentTurns));
  // Tokens stay in a private file, never process arguments or run events.
  await writeJSON(join(directory, 'mcp.json'), { mcpServers: { method_step: { type: 'http', url: bridge.url, headers: { Authorization: `Bearer ${bridge.token}` } } } });
  const events = [];
  try {
    if (Buffer.byteLength(prompt) > context.maxRequestBytes) fail('Claude prompt exceeds request limit', 'input_limit');
    await context.record('agent.started', { provider: 'claude', command, model: profile.model ?? 'user-default', directory });
    const result = await executeProcess({ command, args, cwd: directory, input: prompt, rawInput: true,
      env: { ...process.env, METHOD_OUTPUT_DIR: context.artifacts }, signal: context.signal, maxBytes: context.maxOutputBytes,
      onStdoutLine: async line => {
        let event; try { event = JSON.parse(line); } catch { return; }
        events.push(event);
        for (const item of event.type === 'assistant' ? event.message?.content ?? [] : []) {
          if (item.type === 'tool_use' && typeof item.name === 'string') await context.record('progress', {provider:'claude',message:`Using ${item.name}.`});
        }
        if (event.type === 'system' && event.subtype === 'init') {
          if (event.mcp_server_errors?.length || event.mcp_servers?.some(s => s.name === 'method_step' && !['connected', 'pending'].includes(s.status))) fail('Claude could not connect to Method tools.', 'tool_unavailable');
          await context.record('agent.ready', { provider: 'claude', model: event.model });
        }
      } });
    await writeFile(join(directory, 'events.jsonl'), clean(result.output), { mode: 0o600 });
    await writeFile(join(directory, 'stderr.log'), clean(result.diagnostics), { mode: 0o600 });
    const last = events.filter(e => e.type === 'result').at(-1);
    if (!last || last.is_error || last.subtype !== 'success') fail(clean(last?.errors?.join('\n') || last?.result || 'Claude did not return a successful result.'), 'claude_failed');
    const value = last.structured_output;
    safeData(value); assertSchema(schema, value, 'Claude output');
    await context.record('agent.completed', { provider: 'claude', directory, usage: last.usage ?? null });
    return value;
  } catch (error) {
    if (error.output) await writeFile(join(directory, 'events.jsonl'), clean(error.output), { mode: 0o600 });
    if (error.diagnostics) await writeFile(join(directory, 'stderr.log'), clean(error.diagnostics), { mode: 0o600 });
    const failure = events.findLast(event => event.type === 'result' && (event.is_error || event.subtype !== 'success'));
    error.message = clean(failure?.errors?.join('\n') || failure?.result || error.diagnostics || error.message);
    await context.record('agent.failed', { provider: 'claude', directory, message: error.message });
    throw error;
  } finally { await bridge.close(); await rm(join(directory,'mcp.json'),{force:true}); }
}
