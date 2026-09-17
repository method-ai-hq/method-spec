import { fail } from './validate.js';

// Resolve one tool set for preflight and every execution backend.
export function executionTools(execution, tools = {}) {
  if (execution.kind !== 'agent') return [];
  const names = [...(execution.tools ?? [])];
  if (execution.browser) {
    const connection = execution.browser.split('.')[1];
    for (const [name, tool] of Object.entries(tools)) if (tool.connection === connection) {
      if (names.includes(name)) fail(`Duplicate browser/custom tool: ${name}`, 'preflight');
      names.push(name);
    }
  }
  return names;
}
export function toolContent(value) {
  return value && Array.isArray(value.content) ? value : {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
}
export function validateToolResult(result) {
  if (!result || !Array.isArray(result.content)) fail('Connection returned invalid tool content', 'invalid_output');
  for (const item of result.content) {
    if (item.type === 'text' && typeof item.text === 'string') continue;
    if (item.type === 'image' && typeof item.data === 'string' && /^image\/(png|jpeg|webp)$/.test(item.mimeType)) continue;
    fail('Connection returned unsupported tool content', 'invalid_output');
  }
  return result;
}
