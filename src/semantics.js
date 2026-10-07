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
/** A label selects one scalar input or one non-repeated step's saved output. */
export function runLabelType(method) {
  const reference = method.run_label;
  if (typeof reference !== 'string' || reference.split('.').some(key => ['constructor', 'prototype', '__proto__'].includes(key))) fail('Invalid run_label reference');
  let def;
  if (reference.startsWith('inputs.')) {
    def = typeAt(method.inputs ?? {}, reference.slice(7));
  } else {
    const [root, id, outputs, ...path] = reference.split('.');
    if (root !== 'steps' || outputs !== 'outputs' || !path.length || !own(method.steps, id)) fail('run_label must reference inputs or a step output');
    const step = method.steps[id];
    if (step.each || step.repeat) fail('run_label cannot select a repeated step');
    def = typeAt(effectiveOutputs(step), path.join('.'));
  }
  if (!['text', 'number', 'boolean'].includes(def.type)) fail('run_label must select a text, number, or boolean value');
  return def.type;
}
const durationUnits = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** Milliseconds in a schedule duration such as 60s, 10m, 1h or 5d. */
export function durationMs(value) { return Number(value.slice(0, -1)) * durationUnits[value.at(-1)]; }
/** Observation offsets from the action's completion; the last offset is the finality horizon. */
export function effectSchedule(effect) {
  const { first = '0s', then = [], horizon } = effect.schedule;
  return [first, ...then, horizon].map(durationMs);
}
const observers = method => new Set(Object.entries(method.environment ?? {}).filter(([, env]) => env.role === 'observer').map(([name]) => `environment.${name}`));
function validateEffects(method, id, step, globalRef, outputs) {
  const environmentChanges = (step.changes ?? []).filter(x => x.startsWith('environment.'));
  if (!step.effects) {
    if (environmentChanges.length) fail(`${id}: external changes require effects. Declare how an observer confirms each intended change.`);
    return;
  }
  if (!environmentChanges.length) fail(`${id}: effects describe external changes; declare the changed connection in changes`);
  const observed = observers(method);
  for (const [name, effect] of Object.entries(step.effects)) {
    const where = `${id}.effects.${name}`;
    requiredText(effect.intent, `${where}.intent`, 'State the intended external result.');
    for (const [alias, ref] of Object.entries(effect.in ?? {})) {
      if (reserved.has(alias) || alias === 'token') fail(`${where}.in: reserved alias ${alias}`);
      // An observer receives the correlation token, never the action's receipt.
      if (own(outputs, ref.split('.')[0])) fail(`${where}.in: an observer cannot read this step's outputs (${ref}); it receives only the correlation token`);
      if (!observed.has(ref) && ref.startsWith('environment.')) fail(`${where}.in: observers bind only observer connections`);
      globalRef(ref);
    }
    const offsets = effectSchedule(effect);
    for (let i = 1; i < offsets.length; i++) if (offsets[i] <= offsets[i - 1]) fail(`${where}.schedule: each observation must come after the one before it, and the horizon last`);
  }
}
export function validateSemantics(method, assertData) {
  safeData(method);
  const current = method.format === 'method/3.3';
  if (!current) {
    if (Object.values(method.steps).some(step => step.effects)) fail('effects require method/3.3');
    if (Object.values(method.environment ?? {}).some(env => env.role)) fail('Environment roles require method/3.3');
  }

  const validateDefs = (defs = {}) => { for (const def of Object.values(defs)) { dataSchema(def); if (own(def, 'default')) assertData(def, def.default); } };
  validateDefs(method.inputs); validateDefs(method.state);
  if (method.run_label !== undefined) runLabelType(method);
  const definitions = {
    inputs: { type: 'record', fields: method.inputs ?? {} }, state: { type: 'record', fields: method.state ?? {} },
    environment: { type: 'record', fields: Object.fromEntries(Object.keys(method.environment ?? {}).map(k => [k, 'text'])) },
    run: { type: 'record', fields: { started_at: 'text' } },
  };
  const producers = {};
  for (const [id, step] of Object.entries(method.steps)) {
    if (reserved.has(id)) fail(`Reserved step name: ${id}`);
    const outputs = effectiveOutputs(step);
    if (method.format !== 'method/3.1') {
      if (step.do?.kind === 'run') {
        requiredText(step.name, `${id}.name`, 'Give this script step a name.');
        requiredText(step.purpose, `${id}.purpose`, "Describe this script's rules, result, and external changes.");
        for (const [name, def] of Object.entries(outputs)) requiredText(def.description, `${id}.out.${name}.description`, 'Describe the returned value.');
      }
      if (step.check?.kind === 'run') requiredText(step.reading?.check, `${id}.reading.check`, 'Describe what this script checks.');
    }
    if (step.do?.kind === 'classify') {
      if (method.format === 'method/3.1') fail(`${id}: classify requires method/3.2 or later`);
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
    if (current) {
      if (['run', 'agent'].includes(step.do?.kind) && !own(step, 'changes')) fail(`${id}: state the changes this step can make; use changes: [] when it changes nothing`);
      const observed = observers(method);
      for (const ref of [...Object.values(step.in ?? {}), ...Object.values(step.each ?? {}), ...changes]) if (observed.has(ref)) fail(`${id}: only effect observers can use ${ref}`);
      validateEffects(method, id, step, globalRef, outputs);
    } else if (changes.some(x => x.startsWith('environment.')) && !step.check) fail('External changes require a check');
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
  return { method, order, dependencies };
}
