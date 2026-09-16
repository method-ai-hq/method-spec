// Only explicitly public progress enters the dashboard. Never forward reasoning,
// tool arguments, command strings, tool output, or final assistant results here.
export function progressMessage(value) {
  if (!value || typeof value !== 'object' || typeof value.message !== 'string' || !value.message.trim()) return null;
  const result = { message: value.message.trim().slice(0, 1000) };
  if (typeof value.child === 'string' && value.child.trim()) result.child = value.child.trim().slice(0, 100);
  if (Number.isSafeInteger(value.completed) && value.completed >= 0 && Number.isSafeInteger(value.total) && value.total >= value.completed && value.total > 0) {
    result.completed = value.completed; result.total = value.total;
    if (typeof value.unit === 'string') result.unit = value.unit.slice(0, 50);
  }
  return result;
}

export function codexProgress(event) {
  const item = event?.item;
  if (!item || !['item.started', 'item.completed'].includes(event.type)) return null;
  // Current Codex JSON uses agent_message for public assistant text. Exclude
  // JSON results: the result has its own validated upload path.
  if (item.type === 'agent_message' && event.type === 'item.completed' && typeof item.text === 'string') {
    if (/^\s*[\[{]/.test(item.text)) return null;
    return progressMessage({ message: item.text });
  }
  const started = event.type === 'item.started';
  if (item.type === 'command_execution') return { message: started ? 'Running a command.' : item.exit_code === 0 ? 'Command completed.' : 'A command failed.', ...(typeof item.id === 'string' ? { call_id: item.id } : {}) };
  // Method tools already have richer, authoritative events from the executor.
  if (item.type === 'mcp_tool_call' && item.server !== 'method_step') return { message: started ? 'Calling a tool.' : item.status === 'failed' ? 'A tool call failed.' : 'Tool call completed.', ...(typeof item.id === 'string' ? { call_id: item.id } : {}) };
  if (item.type === 'web_search') return { message: started ? 'Searching the web.' : 'Web search completed.' };
  return null;
}
