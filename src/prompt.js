/** Method 3.1 prompts: declared values only, without expressions or recursive expansion. */
export function parsePrompt(template) {
  /** @type {Array<{text?: string, reference?: string, source?: string}>} */
  const parts = []; let cursor = 0;
  const text = value => { if (value) parts.push({ text: value }); };
  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor);
    const plain = template.slice(cursor, start < 0 ? undefined : start);
    if (plain.includes('}}')) throw Error('Unexpected closing prompt braces');
    if (start < 0) { text(plain); break; }
    const end = template.indexOf('}}', start + 2);
    if (end < 0) throw Error('Unclosed prompt variable');
    if (start > cursor && template[start - 1] === '\\') {
      text(plain.slice(0, -1) + template.slice(start, end + 2));
    } else {
      text(plain);
      const reference = template.slice(start + 2, end).trim();
      if (!/^[a-z][a-z0-9_]*(?:\.(?:[a-z][a-z0-9_]*|0|[1-9][0-9]*))*$/.test(reference)
          || reference.split('.').some(key => ['constructor', 'prototype', '__proto__'].includes(key))) {
        throw Error(`Invalid prompt variable: ${reference || '(empty)'}`);
      }
      parts.push({ reference, source: template.slice(start, end + 2) });
    }
    cursor = end + 2;
  }
  return parts;
}

export function validatePrompt(template, definitions, typeAt) {
  for (const part of parsePrompt(template)) {
    if (!part.reference) continue;
    let def;
    try { def = typeAt(definitions, part.reference); }
    catch { throw Error(`Unknown prompt variable "${part.reference}". Declared inputs: ${Object.keys(definitions).join(', ') || '(none)'}`); }
    if (!['text', 'number', 'boolean'].includes(def.type)) {
      throw Error(`Prompt variable "${part.reference}" is a ${def.type}. Select a text, number, or boolean field; pass structured data as inputs.`);
    }
  }
}

export function renderPrompt(template, inputs) {
  return parsePrompt(template).map(part => {
    if (!part.reference) return part.text;
    let value = inputs;
    for (const key of part.reference.split('.')) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Error(`Missing prompt variable: ${part.reference}`);
      value = value[key];
    }
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw Error(`Prompt variable "${part.reference}" must be text, a finite number, or a boolean`);
    }
    return String(value);
  }).join('');
}
