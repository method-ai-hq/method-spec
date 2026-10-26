import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * One transcript format for every agent attempt: Claude Code, Codex, and the executor's own model steps. Each attempt
 * folder gets a transcript.jsonl with one entry per line:
 *   {i, role, kind, text, tool, path, raw_ref, inferred?}
 * role: user | assistant | tool | system. kind: prompt | message | thinking | tool_call | tool_result | file_read |
 * file_write | command | search | plan | error | result. text is never clipped. tool and path are null when they do
 * not apply. raw_ref names the source: `prompt.md`, `events.jsonl:LINE` (a line of the attempt's own events.jsonl), or
 * `run:SEQUENCE` (an event of the run's events.jsonl, for model steps). inferred: true marks an entry that Method
 * guessed, such as a file that a Codex shell command read. at: when the entry happened (ISO time): the agent's own time
 * of the event when it gives one, else the time Method read the event. parent: the i of the subagent call (Claude
 * Code's Agent or Task tool) whose subagent made the entry.
 */

const text = value => typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
/**
 * The JSON events of an agent's event stream, each with its 1-based line number and its time: the event's own
 * timestamp, or times[n], the time the n-th JSON event was read (n counts JSON events from 0).
 */
function parsedLines(output, times = []) {
  let n = 0;
  return String(output ?? '').split('\n').flatMap((line, index) => {
    let event;
    try { event = JSON.parse(line); } catch { return []; }
    if (!event || typeof event !== 'object') return [];
    const read = times[n++];
    return [{ event, line: index + 1, at: typeof event.timestamp === 'string' ? event.timestamp : read }];
  });
}
function numbered(entries) {
  return entries.map((entry, i) => ({ i, role: entry.role, kind: entry.kind, text: entry.text ?? '', tool: entry.tool ?? null, path: entry.path ?? null, raw_ref: entry.raw_ref,
    ...(entry.inferred ? { inferred: true } : {}), ...(entry.at ? { at: entry.at } : {}), ...(entry.parent !== undefined ? { parent: entry.parent } : {}) }));
}
const promptEntry = (prompt, at) => ({ role: 'user', kind: 'prompt', text: prompt, raw_ref: 'prompt.md', at });

// Claude Code's file tools name their file in the input.
const claudeReads = new Set(['Read']), claudeWrites = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const blockText = content => Array.isArray(content) ? content.map(block => block?.type === 'text' ? block.text : block?.type === 'image' ? '[image]' : text(block)).join('\n') : text(content);

/**
 * Claude Code's stream-json output as a transcript. started: when the prompt was sent; times: when each JSON event was
 * read (for events without a timestamp of their own). A subagent's entries name the Agent or Task call that made them.
 */
export function claudeTranscript(prompt, output, { started, times } = {}) {
  const entries = [promptEntry(prompt, started)], calls = new Map();
  for (const { event, line, at } of parsedLines(output, times)) {
    const raw_ref = `events.jsonl:${line}`;
    const parent = calls.get(event.parent_tool_use_id)?.i;
    const push = entry => entries.push({ ...entry, at, parent });
    if (event.type === 'assistant') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block.type === 'text') push({ role: event.error ? 'system' : 'assistant', kind: event.error ? 'error' : 'message', text: block.text, raw_ref });
        else if (block.type === 'thinking') push({ role: 'assistant', kind: 'thinking', text: block.thinking, raw_ref });
        else if (block.type === 'tool_use') {
          const input = block.input ?? {}, path = input.file_path ?? input.notebook_path ?? input.path ?? null;
          calls.set(block.id, { tool: block.name, path, i: entries.length });
          const kind = claudeReads.has(block.name) ? 'file_read' : claudeWrites.has(block.name) ? 'file_write' : block.name === 'Bash' ? 'command' : block.name === 'WebSearch' ? 'search' : 'tool_call';
          push({ role: 'assistant', kind, tool: block.name, path, text: kind === 'command' ? text(input.command) : kind === 'search' ? text(input.query) : text(input), raw_ref });
        }
      }
    } else if (event.type === 'user') {
      const content = event.message?.content;
      if (typeof content === 'string') push({ role: 'user', kind: 'message', text: content, raw_ref });
      else for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'tool_result') {
          const call = calls.get(block.tool_use_id) ?? {};
          push({ role: 'tool', kind: block.is_error ? 'error' : 'tool_result', tool: call.tool ?? null, path: call.path ?? null, text: blockText(block.content), raw_ref });
        } else if (block.type === 'text') push({ role: 'user', kind: 'message', text: block.text, raw_ref });
      }
    } else if (event.type === 'system' && event.subtype === 'permission_denied') {
      push({ role: 'system', kind: 'error', tool: event.tool_name ?? null, text: text(event.message), raw_ref });
    } else if (event.type === 'result') {
      const failed = event.is_error || event.subtype !== 'success';
      push({ role: 'system', kind: failed ? 'error' : 'result', text: failed ? text(event.errors?.join('\n') || event.result) : text(event.structured_output ?? event.result), raw_ref });
    }
  }
  return numbered(entries);
}

/**
 * The files that a shell command reads, as a guess: the file operands of cat, head, tail, nl, less, more, sed -n and
 * wc in each part of the command. A pipe's input or a quoted pattern is not a file.
 */
export function shellReads(command) {
  const reads = [];
  for (const part of String(command).replace(/^\s*(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/, '$2').split(/&&|\|\||;|\|/)) {
    const words = part.trim().match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    const [program, ...rest] = words.map(word => word.replace(/^(['"])(.*)\1$/, '$2'));
    if (!['cat', 'head', 'tail', 'nl', 'less', 'more', 'sed', 'wc'].includes(program)) continue;
    const operands = [];
    for (let n = 0; n < rest.length; n++) {
      const word = rest[n];
      if (/^\d?>>?$/.test(word)) n++; // the next word is where the output goes
      else if (word === '<') { if (rest[n + 1]) operands.push(rest[++n]); }
      else if (word.startsWith('<')) operands.push(word.slice(1));
      else if (!word.startsWith('-') && !/^\d?>/.test(word)) operands.push(word);
    }
    // sed's first operand is its script.
    for (const operand of program === 'sed' ? operands.slice(1) : operands) if (!/^\d+(,\d+)?p?$/.test(operand)) reads.push(operand);
  }
  return reads;
}

/**
 * Codex's JSON event stream as a transcript. result: what Codex saved as its result, when it saved one, in the
 * attempt's file resultFile. started and times as for claudeTranscript (Codex gives its events no time).
 */
export function codexTranscript(prompt, output, result, resultFile = 'result.json', { started, times } = {}) {
  const entries = [promptEntry(prompt, started)];
  const events = parsedLines(output, times);
  const completed = new Set(events.filter(({ event }) => event.type === 'item.completed').map(({ event }) => event.item?.id));
  let lastError = null, last = started;
  for (const { event, line, at } of events) {
    const raw_ref = `events.jsonl:${line}`, item = event.item ?? {};
    last = at ?? last;
    const before = entries.length;
    // An item that never completed (the process stopped) is shown as it started.
    if (event.type === 'item.started' && completed.has(item.id)) continue;
    if (event.type === 'item.completed' || event.type === 'item.started') {
      if (item.type === 'agent_message') entries.push({ role: 'assistant', kind: 'message', text: item.text, raw_ref });
      else if (item.type === 'reasoning') entries.push({ role: 'assistant', kind: 'thinking', text: item.text, raw_ref });
      else if (item.type === 'command_execution') {
        entries.push({ role: 'assistant', kind: 'command', tool: 'shell', text: text(item.command), raw_ref });
        for (const path of shellReads(item.command)) entries.push({ role: 'assistant', kind: 'file_read', tool: 'shell', path, text: text(item.command), raw_ref, inferred: true });
        if (event.type === 'item.completed') entries.push({ role: 'tool', kind: item.exit_code === 0 ? 'tool_result' : 'error', tool: 'shell', text: `${text(item.aggregated_output)}${item.exit_code === 0 ? '' : `\n(exit code ${item.exit_code})`}`, raw_ref });
      } else if (item.type === 'file_change') {
        for (const change of item.changes ?? []) entries.push({ role: 'assistant', kind: 'file_write', tool: 'apply_patch', path: change.path ?? null, text: text(change.kind), raw_ref });
      } else if (item.type === 'mcp_tool_call') {
        const tool = `${item.server}.${item.tool}`;
        entries.push({ role: 'assistant', kind: 'tool_call', tool, text: text(item.arguments), raw_ref });
        if (event.type === 'item.completed') entries.push({ role: 'tool', kind: item.error ? 'error' : 'tool_result', tool, text: item.error ? text(item.error.message ?? item.error) : blockText(item.result?.content), raw_ref });
      } else if (item.type === 'web_search') {
        entries.push({ role: 'assistant', kind: 'search', tool: 'web_search', text: text(item.query), raw_ref });
        if (item.results?.length) entries.push({ role: 'tool', kind: 'tool_result', tool: 'web_search', text: item.results.map(r => [r.title, r.url, r.snippet].filter(Boolean).join('\n')).join('\n\n'), raw_ref });
      } else if (item.type === 'todo_list') entries.push({ role: 'assistant', kind: 'plan', text: (item.items ?? []).map(todo => `[${todo.completed ? 'x' : ' '}] ${todo.text}`).join('\n'), raw_ref });
      else if (item.type === 'error') entries.push({ role: 'system', kind: 'error', text: text(item.message), raw_ref });
    } else if (event.type === 'error' || event.type === 'turn.failed') {
      // Codex reports a failed turn twice: as an error and as turn.failed.
      const message = text(event.message ?? event.error?.message);
      if (message !== lastError) entries.push({ role: 'system', kind: 'error', text: message, raw_ref });
      lastError = message;
    }
    for (const entry of entries.slice(before)) entry.at = at;
  }
  if (result !== undefined) entries.push({ role: 'system', kind: 'result', text: text(result), raw_ref: resultFile, at: last });
  return numbered(entries);
}

/**
 * A model step's conversation as a transcript. turns: each provider reply as the adapter read it ({text, calls}), the
 * tool outputs that answered its calls, the run event sequence of the reply and when it was read (at). started: when
 * the prompt was sent.
 */
export function modelTranscript(prompt, turns, started) {
  const entries = [{ ...promptEntry(prompt, started), raw_ref: turns[0]?.request ? `run:${turns[0].request}` : 'run' }];
  for (const { reply, results = [], sequence, final, at } of turns) {
    const raw_ref = `run:${sequence}`;
    if (reply.text) entries.push({ role: final ? 'system' : 'assistant', kind: final ? 'result' : 'message', text: reply.text, raw_ref, at });
    for (const call of reply.calls ?? []) entries.push({ role: 'assistant', kind: 'tool_call', tool: call.name, text: text(call.arguments), raw_ref, at });
    for (const { call, output } of results) entries.push({ role: 'tool', kind: 'tool_result', tool: call.name, text: text(output), raw_ref, at });
  }
  return numbered(entries);
}

/** Write an attempt's transcript.jsonl. clean: the redaction of a text that the attempt's other records get. */
export async function writeTranscript(directory, entries, clean = value => value) {
  const lines = entries.map(entry => JSON.stringify({ ...entry, text: clean(entry.text), path: entry.path === null ? null : clean(entry.path) }) + '\n');
  await writeFile(join(directory, 'transcript.jsonl'), lines.join(''), { mode: 0o600 });
}
