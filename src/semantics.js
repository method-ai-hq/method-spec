import { object } from './schema.js';
import { validatePrompt } from './prompt.js';
const reserved = new Set(['inputs', 'state', 'environment', 'run', 'constructor', 'prototype', '__proto__']);
export const own = (obj, key) => obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key);
export function fail(message, code = 'validation') { throw Object.assign(new Error(message), { code }); }
export function safeData(value, seen = new Set(), depth = 0) {
  if (depth > 100) fail('Data nesting exceeds 100 levels');
  if (typeof value === 'number' && !Number.isFinite(value)) fail('Non-finite number');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Only JSON objects and arrays are allowed');
    if (seen.has(value)) fail('Cyclic data is not allowed');
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(`Reserved data key: ${key}`);
      safeData(value[key], seen, depth + 1);
    }
    seen.delete(value);
  }
  if (typeof value === 'bigint' || typeof value === 'undefined' || typeof value === 'function') fail('Value is not JSON data');
}
export function shape(def) { return typeof def === 'string' ? { type: def } : def; }
/** Derive primitive outputs once for validators, executors, and readers. */
export function effectiveOutputs(step) {
  if (step.do?.kind !== 'classify') return step.out ?? {};
  return { [step.out]: {
    type: 'record', description: 'Selected category and probabilities for each option.',
    fields: { choice: 'text', probabilities: { type: 'record', fields:
      Object.fromEntries(Object.keys(step.do.options).map(id => [id, 'number'])) } },
  } };
}
function containsFile(definition) {
  const def = shape(definition);
  return def.type === 'file' || Object.values(def.fields ?? {}).some(containsFile) ||
    (def.items ? containsFile(def.items) : false);
}
function requiredText(value, path, message) {
  if (typeof value !== 'string' || !value.trim()) fail(`${path}: ${message}`);
}
export function dataSchema(definition) {
  const def = shape(definition);
  let result;
  switch (def.type) {
    case 'text': result = { type: 'string' }; break;
    case 'number': result = { type: 'number' }; break;
    case 'boolean': result = { type: 'boolean' }; break;
    case 'record':
      if (!def.fields) fail('A record requires fields');
      result = outputSchema(def.fields); break;
    case 'list':
      if (!!def.fields === !!def.items) fail('A list requires exactly one of fields or items');
      result = { type: 'array', items: def.fields ? outputSchema(def.fields) : dataSchema(def.items) }; break;
    case 'file': result = object({ path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }); break;
    default: fail(`Unknown type: ${def.type}`);
  }
  if (def.type !== 'record' && def.type !== 'list' && (def.fields || def.items)) fail('fields/items only apply to record/list');
  if (def.type === 'record' && def.items) fail('A record cannot have items');
  if (def.description) result.description = def.description;
  return result;
}
export function outputSchema(definitions = {}) {
  return object(Object.fromEntries(Object.entries(definitions).map(([key, def]) => [key, dataSchema(def)])));
}
export function resolve(root, reference) {
  let result = root;
  for (const key of reference.split('.')) {
    if (!own(result, key)) fail(`Missing reference: ${reference}`, 'missing_reference');
    result = result[key];
  }
  return result;
}
export function typeAt(root, reference) {
  const [head, ...tail] = reference.split('.');
  if (!own(root, head)) fail(`Unknown reference: ${reference}`);
  let def = shape(root[head]);
  for (const part of tail) {
    if (def.type === 'record' && own(def.fields, part)) def = shape(def.fields[part]);
    else if (def.type === 'list' && /^(0|[1-9][0-9]*)$/.test(part)) def = def.fields ? { type: 'record', fields: def.fields } : shape(def.items);
    else fail(`Invalid reference path: ${reference}`);
  }
  return def;
}
export function validateSemantics(method, assertData) {
  safeData(method);

  const validateDefs = (defs = {}) => { for (const def of Object.values(defs)) { dataSchema(def); if (own(def, 'default')) assertData(def, def.default); } };
  validateDefs(method.inputs); validateDefs(method.state);
  if (method.run_label_input !== undefined) {
    const input = method.inputs?.[method.run_label_input];
    if (!input || !['text', 'number', 'boolean'].includes(input.type)) fail('run_label_input must name a text, number, or boolean input');
  }
  const definitions = {
    inputs: { type: 'record', fields: method.inputs ?? {} }, state: { type: 'record', fields: method.state ?? {} },
    environment: { type: 'record', fields: Object.fromEntries(Object.keys(method.environment ?? {}).map(k => [k, 'text'])) },
    run: { type: 'record', fields: { started_at: 'text' } },
  };
  const producers = {};
  for (const [id, step] of Object.entries(method.steps)) {
    if (reserved.has(id)) fail(`Reserved step name: ${id}`);
    const outputs = effectiveOutputs(step);
    if (method.format === 'method/3.2') {
      if (step.do?.kind === 'run') {
        requiredText(step.name, `${id}.name`, 'Give this script step a name.');
        requiredText(step.purpose, `${id}.purpose`, "Describe this script's rules, result, and external changes.");
        for (const [name, def] of Object.entries(outputs)) requiredText(def.description, `${id}.out.${name}.description`, 'Describe the returned value.');
      }
      if (step.check?.kind === 'run') requiredText(step.reading?.check, `${id}.reading.check`, 'Describe what this script checks.');
    }
    if (step.do?.kind === 'classify') {
      if (method.format !== 'method/3.2') fail(`${id}: classify requires method/3.2`);
      requiredText(step.name, `${id}.name`, 'Give this classification step a name.');
      requiredText(step.do.question, `${id}.do.question`, 'Write the classification question.');
      for (const [name, description] of Object.entries(step.do.options)) requiredText(description, `${id}.do.options.${name}`, 'Describe this option.');
      if (!Object.keys(step.in ?? {}).length && !Object.keys(step.each ?? {}).length) fail(`${id}: classification requires an input`);
      if (step.changes?.length) fail(`${id}: classification cannot change state or connections`);
    }
    validateDefs(outputs);
    for (const [key, def] of Object.entries(outputs)) {
      if (own(definitions, key)) fail(`Duplicate or reserved output: ${key}`);
      definitions[key] = step.each ? { type: 'list', items: def } : def;
      producers[key] = id;
    }
  }
  const dependencies = {};
  for (const [id, step] of Object.entries(method.steps)) {
    const outputs = effectiveOutputs(step);
    const deps = new Set(typeof step.after === 'string' ? [step.after] : step.after ?? []);
    const globalRef = (ref) => {
      const def = typeAt(definitions, ref);
      const producer = producers[ref.split('.')[0]];
      if (producer) deps.add(producer);
      return def;
    };
    const local = {};
    for (const [key, ref] of Object.entries(step.in ?? {})) {
      if (reserved.has(key) || own(outputs, key)) fail(`Reserved or ambiguous input alias: ${key}`);
      local[key] = globalRef(ref);
    }
    for (const [key, ref] of Object.entries(step.each ?? {})) {
      if (reserved.has(key) || own(local, key) || own(outputs, key)) fail(`Duplicate iteration alias: ${key}`);
      const def = globalRef(ref);
      if (def.type !== 'list') fail(`each requires a list: ${ref}`);
      local[key] = def.fields ? { type: 'record', fields: def.fields } : def.items;
    }
    if (step.do?.kind === 'classify' && Object.values(local).some(containsFile)) fail(`${id}: extract file content before classification`);
    if (step.when && globalRef(step.when).type !== 'boolean') fail('when requires a boolean');
    if (step.repeat?.until && typeAt(outputs, step.repeat.until).type !== 'boolean') fail('repeat.until requires a boolean output');
    const changes = step.changes ?? [];
    for (const target of changes) {
      if (!/^(state|environment)\.[a-z][a-z0-9_]*$/.test(target)) fail(`Invalid change target: ${target}`);
      globalRef(target);
    }
    for (const exec of [step.do, step.check]) if (exec?.kind === 'agent' && exec.browser) {
      const match = /^environment\.([a-z][a-z0-9_]*)$/.exec(exec.browser);
      if (!match || method.environment?.[match[1]]?.type !== 'browser') fail('Agent browser must refer to a browser environment');
    }
    if (changes.some(x => x.startsWith('environment.')) && !step.check) fail('External changes require a check');
    const validate = (prompt, definitions, location) => {
      try { validatePrompt(prompt, definitions, typeAt); }
      catch (error) { fail(`${id}.${location}: ${error.message}`, 'invalid_prompt'); }
    };
    if (['call', 'agent'].includes(step.do?.kind)) validate(step.do.prompt, local, 'do.prompt');
    if (step.ask) validate(step.ask, local, 'ask');
    if (step.check?.kind === 'agent') validate(step.check.prompt, {
      inputs: { type: 'record', fields: local }, outputs: { type: 'record', fields: outputs },
      state_before: definitions.state, state_after: definitions.state,
      evidence: { type: 'list', items: 'text' },
    }, 'check.prompt');
    const check = step.check;
    if (check && !check.kind) {
      const scope = { ...local, ...outputs };
      if (check.equals) {
        typeAt(scope, check.equals.actual); typeAt(scope, check.equals.expected);
      } else if (check.count) {
        if (typeAt(scope, check.count.value).type !== 'list') fail('count requires a list');
        if (check.count.min !== undefined && check.count.max !== undefined && check.count.min > check.count.max) fail('count minimum exceeds maximum');
      } else if (check.file) {
        if (typeAt(scope, check.file).type !== 'file') fail('file check requires a file');
      } else typeAt(scope, check.present);
    }
    for (const dependency of deps) if (!own(method.steps, dependency) || dependency === id) fail(`Invalid dependency ${id} -> ${dependency}`);
    dependencies[id] = [...deps];
  }
  for (const ref of typeof method.result === 'string' ? [method.result] : Object.values(method.result)) typeAt(definitions, ref);
  const order = [], pending = new Set(Object.keys(method.steps));
  while (pending.size) {
    const ready = [...pending].find(id => dependencies[id].every(dep => order.includes(dep)));
    if (!ready) fail('Cyclic step dependencies');
    pending.delete(ready); order.push(ready);
  }
  return { method, order };
}
