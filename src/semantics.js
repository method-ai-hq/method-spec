import { object, modelIdPattern } from './schema.js';
import { validatePrompt } from './prompt.js';
const reserved = new Set(['inputs', 'state', 'environment', 'run', 'constructor', 'prototype', '__proto__']);
export const own = (obj, key) => obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key);
export function fail(message, code = 'validation', details = {}) { throw Object.assign(new Error(message), { ...details, code }); }
export function safeData(value, seen = new Set(), depth = 0) {
  if (depth > 100) fail('Data nesting exceeds 100 levels', 'validation', { fix: 'Nest data no more than 100 levels deep.' });
  if (typeof value === 'number' && !Number.isFinite(value)) fail('Non-finite number', 'validation', { fix: 'Use a finite number.' });
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Only JSON objects and arrays are allowed', 'validation', { fix: 'Use plain JSON objects and lists.' });
    if (seen.has(value)) fail('Cyclic data is not allowed', 'validation', { fix: 'Remove the YAML alias that makes the data refer to itself.' });
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(`Reserved data key: ${key}`, 'validation', { fix: 'Rename the key.' });
      safeData(value[key], seen, depth + 1);
    }
    seen.delete(value);
  }
  if (typeof value === 'bigint' || typeof value === 'undefined' || typeof value === 'function') fail('Value is not JSON data', 'validation', { fix: 'Use only text, numbers, true or false, null, lists, and records.' });
}
export function shape(def) { return typeof def === 'string' ? { type: def } : def; }
/** Derive primitive outputs once for validators, executors, and readers. */
export function effectiveOutputs(step) {
  if (step.do?.kind !== 'classify') return step.out ?? {};
  const probabilities = ids => ({ type: 'record', fields: Object.fromEntries(ids.map(id => [id, 'number'])) });
  if (step.do.answer === 'yes_no') return { [step.out]: {
    type: 'record', description: 'Yes (true) or no (false), and the probability of yes.', fields: { answer: 'boolean', probability: 'number' } } };
  if (step.do.levels) return { [step.out]: {
    type: 'record', description: 'Most likely level, expected level index (0 = first level), and probabilities for each level.',
    fields: { level: 'text', score: 'number', probabilities: probabilities(step.do.levels) } } };
  return { [step.out]: {
    type: 'record', description: 'Selected category and probabilities for each option.',
    fields: { choice: 'text', probabilities: probabilities(Object.keys(step.do.options ?? {})) },
  } };
}
function containsFile(definition) {
  const def = shape(definition);
  return def.type === 'file' || Object.values(def.fields ?? {}).some(containsFile) ||
    (def.items ? containsFile(def.items) : false);
}
function requiredText(value, path, message) {
  if (typeof value !== 'string' || !value.trim()) fail(`${path}: ${message}`, 'validation', { fix: message });
}
export function dataSchema(definition) {
  const def = shape(definition);
  let result;
  switch (def.type) {
    case 'text': result = { type: 'string' }; break;
    case 'number': result = { type: 'number' }; break;
    case 'boolean': result = { type: 'boolean' }; break;
    case 'record':
      if (!def.fields) fail('A record requires fields', 'validation', { fix: 'Add fields to the record.' });
      result = outputSchema(def.fields); break;
    case 'list':
      if (!!def.fields === !!def.items) fail('A list requires exactly one of fields or items', 'validation', { fix: 'Give the list either fields (a list of records) or items, not both.' });
      result = { type: 'array', items: def.fields ? outputSchema(def.fields) : dataSchema(def.items) }; break;
    case 'file': result = object({ path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }); break;
    default: fail(`Unknown type: ${def.type}`, 'validation', { fix: 'Use one of text, number, boolean, record, list, or file.' });
  }
  if (def.type !== 'record' && def.type !== 'list' && (def.fields || def.items)) fail('fields/items only apply to record/list', 'validation', { fix: 'Remove fields and items, or change the type to record or list.' });
  if (def.type === 'record' && def.items) fail('A record cannot have items', 'validation', { fix: 'Use fields for a record, or change the type to list.' });
  if (def.description) result.description = def.description;
  return result;
}
export function outputSchema(definitions = {}) {
  return object(Object.fromEntries(Object.entries(definitions).map(([key, def]) => [key, dataSchema(def)])));
}
export function resolve(root, reference) {
  let result = root;
  for (const key of reference.split('.')) {
    if (!own(result, key)) fail(`Missing reference: ${reference}`, 'missing_reference', { fix: 'Supply the referenced value.' });
    result = result[key];
  }
  return result;
}
export function typeAt(root, reference) {
  const [head, ...tail] = reference.split('.');
  if (!own(root, head)) fail(`Unknown reference: ${reference}`, 'validation', { fix: 'Refer to an input, state, environment, run, or a step output that exists.' });
  let def = shape(root[head]);
  for (const part of tail) {
    if (def.type === 'record' && own(def.fields, part)) def = shape(def.fields[part]);
    else if (def.type === 'list' && /^(0|[1-9][0-9]*)$/.test(part)) def = def.fields ? { type: 'record', fields: def.fields } : shape(def.items);
    else fail(`Invalid reference path: ${reference}`, 'validation', { fix: 'Refer only to fields that the referenced record or list declares.' });
  }
  return def;
}
/** A label selects one scalar input or one non-repeated step's saved output. */
export function runLabelType(method) {
  const reference = method.run_label;
  if (typeof reference !== 'string' || reference.split('.').some(key => ['constructor', 'prototype', '__proto__'].includes(key))) fail('Invalid run_label reference', 'validation', { fix: 'Set run_label to inputs.NAME or steps.STEP.outputs.NAME.' });
  let def;
  if (reference.startsWith('inputs.')) {
    def = typeAt(method.inputs ?? {}, reference.slice(7));
  } else {
    const [root, id, outputs, ...path] = reference.split('.');
    if (root !== 'steps' || outputs !== 'outputs' || !path.length || !own(method.steps, id)) fail('run_label must reference inputs or a step output', 'validation', { fix: 'Set run_label to inputs.NAME or steps.STEP.outputs.NAME.' });
    const step = method.steps[id];
    if (step.each || step.repeat) fail('run_label cannot select a repeated step', 'validation', { fix: 'Choose an output of a step without each or repeat.' });
    def = typeAt(effectiveOutputs(step), path.join('.'));
  }
  if (!['text', 'number', 'boolean'].includes(def.type)) fail('run_label must select a text, number, or boolean value', 'validation', { fix: 'Choose a text, number, or boolean field.' });
  return def.type;
}
const durationUnits = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** Milliseconds in a schedule duration such as 60s, 10m, 1h or 5d. */
export function durationMs(value) { return Number(value.slice(0, -1)) * durationUnits[value.at(-1)]; }
/** Observation offsets from the action's completion; the last offset is the finality horizon. */
export function effectSchedule(effect) {
  // Default: one reading at once, final after a minute. Mail and payments set longer horizons.
  const { first = '0s', then = [], horizon = '1m' } = effect.schedule ?? {};
  return [first, ...then, horizon].map(durationMs);
}
const observers = method => new Set(Object.entries(method.environment ?? {}).filter(([, env]) => env.role === 'observer').map(([name]) => `environment.${name}`));
function templateAliases(value, out = []) {
  if (typeof value === 'string') for (const match of value.matchAll(/\{inputs\.([a-z][a-z0-9_]*)/g)) out.push(match[1]);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) templateAliases(item, out);
  return out;
}
export const effectConfirm = effect => effect.confirm ?? 'positive';
/** A built-in observer reads its own connection, or by default the one connection the step changes. */
export function observerConnection(effect, step) {
  if (effect.observe.connection) return effect.observe.connection;
  const changed = (step.changes ?? []).filter(x => x.startsWith('environment.'));
  return changed.length === 1 ? changed[0].slice(12) : null;
}
const isFiles = (method, ref) => method.environment?.[ref.slice(12)]?.type === 'files';
function validateEffects(method, id, step, globalRef, outputs) {
  const environmentChanges = (step.changes ?? []).filter(x => x.startsWith('environment.'));
  // The runtime observes files connections itself, so only other connections need an effect or a waiver.
  const needsObserver = environmentChanges.filter(ref => !isFiles(method, ref));
  if (step.no_effect_reason !== undefined) {
    // A declared waiver: the run report lists it, so a person can see which changes nobody observes.
    // On a step that changes only files, the waiver is redundant and has no effect.
    requiredText(step.no_effect_reason, `${id}.no_effect_reason`, 'Say why no observer confirms this change.');
    if (step.effects) fail(`${id}: use effects or no_effect_reason, not both`, 'validation', { fix: 'Keep effects or no_effect_reason, and remove the other.' });
    return;
  }
  if (!step.effects) {
    // Documents saved before method/3.3 have no effects; they still run.
    if (needsObserver.length && formatRank(method.format) >= 3) fail(`${id}: ${needsObserver.join(', ')} needs an effect that says how to confirm the intended result, or a no_effect_reason sentence that says why nothing can confirm it.`, 'validation', { fix: 'Add an effect that observes the change, or a no_effect_reason sentence.' });
    return;
  }
  if (!environmentChanges.length) fail(`${id}: effects describe external changes; declare the changed connection in changes`, 'validation', { fix: 'Add the changed connection to changes, or remove effects.' });
  const observed = observers(method);
  for (const [name, effect] of Object.entries(step.effects)) {
    const where = `${id}.effects.${name}`;
    requiredText(effect.intent, `${where}.intent`, 'State the intended external result.');
    for (const [alias, ref] of Object.entries(effect.in ?? {})) {
      if (reserved.has(alias) || alias === 'token') fail(`${where}.in: reserved alias ${alias}`, 'validation', { fix: 'Choose another alias.' });
      // An observer receives the correlation token, never the action's receipt.
      if (own(outputs, ref.split('.')[0])) fail(`${where}.in: an observer cannot read this step's outputs (${ref}); it receives only the correlation token`, 'validation', { fix: "Remove the step output from the effect's in." });
      if (!observed.has(ref) && ref.startsWith('environment.')) fail(`${where}.in: observers bind only observer connections`, 'validation', { fix: "Give the environment role: observer, or remove it from the effect's in." });
      globalRef(ref);
    }
    if (effect.observe.kind === 'run') {
      if (!effect.judge || !effect.fixtures) fail(`${where}: a script observer needs a judge and fixtures`, 'validation', { fix: 'Add judge and fixtures to the effect.' });
    } else {
      if (effect.judge || effect.fixtures) fail(`${where}: a built-in ${effect.observe.kind} observer has its own judge; remove judge and fixtures`, 'validation', { fix: 'Remove judge and fixtures from the effect.' });
      const connection = observerConnection(effect, step);
      if (!connection) fail(`${where}.observe.connection: the step changes several connections; name the one to read`, 'validation', { fix: 'Set observe.connection to the connection to read.' });
      if (!observed.has(`environment.${connection}`) && !environmentChanges.includes(`environment.${connection}`)) fail(`${where}.observe.connection must be a connection that the step changes, or an environment with role: observer`, 'validation', { fix: 'Set observe.connection to a changed connection or an observer environment.' });
      const type = method.environment[connection].type;
      if (['file', 'sqlite'].includes(effect.observe.kind) && type !== 'files') fail(`${where}: a ${effect.observe.kind} observer reads a files connection`, 'validation', { fix: 'Use an http or run observer, or observe a files connection.' });
      for (const alias of templateAliases(effect.observe)) if (!own(effect.in ?? {}, alias)) fail(`${where}.observe uses {inputs.${alias}}, which effect in does not bind`, 'validation', { fix: "Add the alias to the effect's in." });
    }
    const offsets = effectSchedule(effect);
    for (let i = 1; i < offsets.length; i++) if (offsets[i] <= offsets[i - 1]) fail(`${where}.schedule: each observation must come after the one before it, and the horizon last`, 'validation', { fix: 'Order first, then, and horizon from earliest to latest.' });
  }
}
const formatRank = format => Number(format.slice('method/3.'.length));
/** The model a call or agent step uses: a models name, a model ID, or default (the account default). */
export const modelName = exec => exec.model ?? 'default';
export const isModelId = model => typeof model === 'string' && new RegExp(modelIdPattern).test(model);
/** Method 3.4 fields: id, models (hosted or a local agent), accept, a step model that is a model ID or absent. */
function validateModels(method) {
  // Documents saved before method/3.4 name configured profiles (or a saved package's runtime.json models), so they still run.
  if (formatRank(method.format) < 4) return;
  const executions = Object.entries(method.steps).flatMap(([id, step]) => [['do', step.do], ['check', step.check]]
    .filter(([, exec]) => ['call', 'agent'].includes(exec?.kind)).map(([phase, exec]) => [id, phase, exec]));
  // A plain name must be in models (with or without a models block); default keeps meaning the account default.
  for (const [id, phase, exec] of executions) {
    const model = modelName(exec);
    if (model !== 'default' && !isModelId(model) && !own(method.models ?? {}, model)) fail(`${id}.${phase}.model: ${model} is not in models`, 'unknown_model',
      { fix: `Add ${model} to models, or use a model ID such as openai/gpt-6-luna.`, step: id, field: `${phase}.model` });
  }
}
/** Name the step that a validation failure belongs to, so that issues can point at it. */
function inStep(id, check) {
  try { check(); }
  catch (error) {
    if (error.step === undefined) {
      error.step = id;
      const field = error.message.startsWith(`${id}.`) ? /^[^:\s]+/.exec(error.message.slice(id.length + 1))?.[0] : undefined;
      if (field && error.field === undefined) error.field = field;
    }
    throw error;
  }
}
export function validateSemantics(method, assertData) {
  safeData(method);
  validateModels(method);

  const validateDefs = (defs = {}) => { for (const def of Object.values(defs)) { dataSchema(def); if (own(def, 'default')) assertData(def, def.default); } };
  validateDefs(method.inputs); validateDefs(method.state);
  for (const tool of Object.values(method.tools ?? {})) { validateDefs(tool.in); validateDefs(tool.out); }
  if (method.run_label !== undefined) runLabelType(method);
  const definitions = {
    inputs: { type: 'record', fields: method.inputs ?? {} }, state: { type: 'record', fields: method.state ?? {} },
    environment: { type: 'record', fields: Object.fromEntries(Object.keys(method.environment ?? {}).map(k => [k, 'text'])) },
    run: { type: 'record', fields: { started_at: 'text' } },
  };
  const producers = {};
  for (const [id, step] of Object.entries(method.steps)) inStep(id, () => {
    if (reserved.has(id)) fail(`Reserved step name: ${id}`, 'validation', { fix: 'Rename the step.' });
    const outputs = effectiveOutputs(step);
    if (step.do?.kind === 'classify') {
      requiredText(step.do.question, `${id}.do.question`, 'Write the classification question.');
      if ([step.do.options, step.do.answer, step.do.levels].filter(value => value !== undefined).length !== 1)
        fail(`${id}.do: give exactly one of options, answer: yes_no, or levels`, 'validation', { fix: 'Keep one of options, answer: yes_no, or levels.' });
      for (const [name, description] of Object.entries(step.do.options ?? {})) requiredText(description, `${id}.do.options.${name}`, 'Describe this option.');
      if (!Object.keys(step.in ?? {}).length && !Object.keys(step.each ?? {}).length) fail(`${id}: classification requires an input`, 'validation', { fix: 'Give the step in or each.' });
      if (step.changes?.length) fail(`${id}: classification cannot change state or connections`, 'validation', { fix: 'Remove changes, and make the change in a later step.' });
    }
    if (step.concurrency !== undefined) {
      if (!step.each) fail(`${id}.concurrency requires each`, 'validation', { fix: 'Add each, or remove concurrency.' });
      // Items that run at once share no state, ask nobody, and change nothing outside the run.
      if (step.ask || step.changes?.length || step.effects) fail(`${id}.concurrency: a step that runs items at once cannot use ask, changes, or effects`, 'validation', { fix: 'Remove concurrency, or move the ask or the change to another step.' });
    }
    validateDefs(outputs);
    for (const [key, def] of Object.entries(outputs)) {
      if (own(definitions, key)) fail(`Duplicate or reserved output: ${key}`, 'validation', { fix: 'Give the output a name that no other step or root field uses.' });
      definitions[key] = step.each ? { type: 'list', items: def } : def;
      producers[key] = id;
    }
  });
  const dependencies = {};
  for (const [id, step] of Object.entries(method.steps)) inStep(id, () => {
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
      if (reserved.has(key)) fail(`${id}.in.${key}: ${key} is a reserved name (inputs, state, environment, run). Choose another alias.`, 'validation', { fix: 'Choose another alias.' });
      if (own(step.each ?? {}, ref.split('.')[0])) fail(`${id}.in.${key}: ${ref.split('.')[0]} is the each item, and the step receives it already. Remove it from in.`, 'validation', { fix: 'Remove it from in.' });
      if (own(outputs, key)) fail(`${id}.in.${key}: this step also has an output named ${key}. Give the input or the output another name.`, 'validation', { fix: 'Give the input or the output another name.' });
      local[key] = globalRef(ref);
    }
    for (const [key, ref] of Object.entries(step.each ?? {})) {
      if (reserved.has(key) || own(local, key) || own(outputs, key)) fail(`Duplicate iteration alias: ${key}`, 'validation', { fix: 'Choose another each alias.' });
      const def = globalRef(ref);
      if (def.type !== 'list') fail(`each requires a list: ${ref}`, 'validation', { fix: 'Refer each to a list.' });
      local[key] = def.fields ? { type: 'record', fields: def.fields } : def.items;
    }
    if (step.do?.kind === 'classify' && Object.values(local).some(containsFile)) fail(`${id}: extract file content before classification`, 'validation', { fix: 'Add a step that reads the file and returns text, and classify that text.' });
    if (step.when && globalRef(step.when).type !== 'boolean') fail('when requires a boolean', 'validation', { fix: 'Refer when to a boolean value.' });
    if (step.repeat?.until && typeAt(outputs, step.repeat.until).type !== 'boolean') fail('repeat.until requires a boolean output', 'validation', { fix: 'Refer repeat.until to a boolean output of this step.' });
    const changes = step.changes ?? [];
    for (const target of changes) {
      if (!/^(state|environment)\.[a-z][a-z0-9_]*$/.test(target)) fail(`Invalid change target: ${target}`, 'validation', { fix: 'Use state.NAME or environment.NAME in changes.' });
      globalRef(target);
    }
    for (const exec of [step.do, step.check]) if (exec?.kind === 'agent' && exec.browser) {
      const match = /^environment\.([a-z][a-z0-9_]*)$/.exec(exec.browser);
      if (!match || method.environment?.[match[1]]?.type !== 'browser') fail('Agent browser must refer to a browser environment', 'validation', { fix: 'Set browser to environment.NAME of a browser environment.' });
    }
    const observed = observers(method);
    for (const ref of [...Object.values(step.in ?? {}), ...Object.values(step.each ?? {}), ...changes]) if (observed.has(ref)) fail(`${id}: only effect observers can use ${ref}`, 'validation', { fix: 'Remove the observer environment from this step; only an effect may read it.' });
    validateEffects(method, id, step, globalRef, outputs);
    const validate = (prompt, definitions, location) => {
      try { validatePrompt(prompt, definitions, typeAt); }
      catch (error) { fail(`${id}.${location}: ${error.message}`, 'invalid_prompt', { fix: 'Refer in the prompt only to names that the step receives in in or each.' }); }
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
        if (typeAt(scope, check.count.value).type !== 'list') fail('count requires a list', 'validation', { fix: 'Refer count.value to a list.' });
        if (check.count.min !== undefined && check.count.max !== undefined && check.count.min > check.count.max) fail('count minimum exceeds maximum', 'validation', { fix: 'Make count.min no larger than count.max.' });
      } else if (check.file) {
        if (typeAt(scope, check.file).type !== 'file') fail('file check requires a file', 'validation', { fix: 'Refer the file check to a file value.' });
      } else typeAt(scope, check.present);
    }
    for (const dependency of deps) if (!own(method.steps, dependency) || dependency === id) fail(`Invalid dependency ${id} -> ${dependency}`, 'validation', { fix: 'Refer after to another step that exists.' });
    dependencies[id] = [...deps];
  });
  for (const ref of typeof method.result === 'string' ? [method.result] : Object.values(method.result)) typeAt(definitions, ref);
  const order = [], pending = new Set(Object.keys(method.steps));
  while (pending.size) {
    const ready = [...pending].find(id => dependencies[id].every(dep => order.includes(dep)));
    if (!ready) fail('Cyclic step dependencies', 'validation', { fix: 'Remove a reference or after entry so that the steps do not depend on each other in a loop.' });
    pending.delete(ready); order.push(ready);
  }
  return { method, order, dependencies };
}
