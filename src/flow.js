/**
 * Where untrusted text can go. Decided from declarations only: no name lists and no model calls.
 * Browser-safe: no file system, no network.
 *
 * A source is a step that reads untrusted content: an agent with a browser, a step that binds a service
 * connection that it does not change, or an agent with a tool that reads a service connection. Its outputs that
 * can hold text get the label. A step that reads a labelled value (in, each, when, effect in, or state that a
 * labelled step changed) passes the label to its outputs that can hold text. An ask step and a classify step pass
 * nothing, and a number or a boolean holds no text. An acting step changes a connection that is not files, or
 * uses a tool whose declaration has effects. A labelled value that reaches an acting step is a finding, unless the
 * acting step runs only on the yes of an ask step that shows the person that value.
 */
import { effectiveOutputs, shape, typeAt, own } from './semantics.js';

const connectionName = ref => /^environment\.([a-z][a-z0-9_]*)$/.exec(ref ?? '')?.[1];
const head = ref => ref.split('.')[0];

/** True when a value of this declared type can hold free text. Numbers and booleans cannot. */
function holdsText(definition) {
  const def = shape(definition);
  if (def.type === 'number' || def.type === 'boolean') return false;
  if (def.type === 'record') return Object.values(def.fields ?? {}).some(holdsText);
  if (def.type === 'list') return def.fields ? Object.values(def.fields).some(holdsText) : holdsText(def.items);
  return true;
}

/** The tools of an agent step: the ones it names, and the connection tools of its browser. */
function agentTools(exec, tools) {
  if (exec?.kind !== 'agent') return [];
  const names = new Set(exec.tools ?? []);
  const browser = connectionName(exec.browser);
  if (browser) for (const [name, tool] of Object.entries(tools)) if (tool.connection === browser) names.add(name);
  return [...names].filter(name => tools[name]).map(name => [name, tools[name]]);
}

/** The untrusted connection that a step reads itself, or null. */
function sourceOf(method, step, tools) {
  if (step.ask) return null;
  if (step.do?.kind === 'agent' && step.do.browser) return { connection: step.do.browser, kind: 'browser' };
  const changed = new Set(step.changes ?? []);
  for (const ref of [...Object.values(step.in ?? {}), ...Object.values(step.each ?? {})]) {
    const env = method.environment?.[connectionName(ref)];
    if (env?.type === 'service' && env.role !== 'observer' && !changed.has(ref)) return { connection: ref, kind: 'service' };
  }
  for (const [, tool] of agentTools(step.do, tools)) {
    if (tool.effects?.length) continue;
    if (method.environment?.[tool.connection]?.type === 'service') return { connection: `environment.${tool.connection}`, kind: 'service' };
  }
  return null;
}

/** What an acting step does, in short phrases; empty for a step that does not act. */
function actionsOf(method, step, tools) {
  if (step.ask) return [];
  const changed = (step.changes ?? []).filter(ref => connectionName(ref) && method.environment?.[connectionName(ref)]?.type !== 'files');
  return [...changed.map(ref => `changes ${connectionName(ref)}`),
    ...agentTools(step.do, tools).filter(([, tool]) => tool.effects?.length).map(([name]) => `uses ${name}`)];
}

/** Every value a step reads, with the field of the step that reads it. */
function readsOf(step) {
  const reads = [];
  for (const [alias, ref] of Object.entries(step.in ?? {})) reads.push({ ref, field: `in.${alias}`, alias });
  for (const [alias, ref] of Object.entries(step.each ?? {})) reads.push({ ref, field: `each.${alias}`, alias });
  if (step.when) reads.push({ ref: step.when, field: 'when', alias: null });
  for (const [name, effect] of Object.entries(step.effects ?? {})) for (const [alias, ref] of Object.entries(effect.in ?? {})) reads.push({ ref, field: `effects.${name}.in.${alias}`, alias });
  return reads;
}

/** The declared type of every value a reference can start from, and the step that produces each output. */
function valueTypes(method) {
  const definitions = {
    inputs: { type: 'record', fields: method.inputs ?? {} }, state: { type: 'record', fields: method.state ?? {} },
    environment: { type: 'record', fields: Object.fromEntries(Object.keys(method.environment ?? {}).map(k => [k, 'text'])) },
    run: { type: 'record', fields: { started_at: 'text' } },
  };
  const producers = {};
  for (const [id, step] of Object.entries(method.steps)) for (const [name, def] of Object.entries(effectiveOutputs(step))) {
    definitions[name] = step.each ? { type: 'list', items: def } : def;
    producers[name] = id;
  }
  return { definitions, producers };
}

const shorter = (a, b) => !b || a.path.length < b.path.length;

/**
 * Trace untrusted text through a valid Method. Returns its sources, its acting steps, and one finding per acting
 * step that untrusted text can reach without a question to the person.
 */
export function traceUntrusted(method, options = {}) {
  const tools = { ...(options.tools ?? {}), ...(method.tools ?? {}) };
  const steps = Object.entries(method.steps);
  const { definitions, producers } = valueTypes(method);
  const sources = new Map(steps.map(([id, step]) => [id, sourceOf(method, step, tools)]).filter(([, source]) => source));
  // Labels by value: an output name, or state.NAME. Each keeps the shortest path from its source.
  const labels = new Map();
  const labelOf = ref => {
    const parts = ref.split('.');
    if (['inputs', 'environment', 'run'].includes(parts[0])) return null;
    const label = labels.get(parts[0] === 'state' ? `state.${parts[1]}` : parts[0]);
    return label && holdsText(typeAt(definitions, ref)) ? label : null;
  };
  const gate = step => Boolean(step.ask) || step.do?.kind === 'classify';
  for (let changed = true; changed;) {
    changed = false;
    const set = (key, label) => { if (shorter(label, labels.get(key))) { labels.set(key, label); changed = true; } };
    for (const [id, step] of steps) {
      if (gate(step)) continue;
      const own = sources.get(id);
      let base = own ? { source: id, connection: own.connection, kind: own.kind, path: [] } : null;
      if (!base) for (const { ref } of readsOf(step)) { const label = labelOf(ref); if (label && shorter(label, base)) base = label; }
      if (!base) continue;
      for (const [name, def] of Object.entries(effectiveOutputs(step))) if (holdsText(def)) set(name, { ...base, path: [...base.path, `${id}.${name}`] });
      for (const target of step.changes ?? []) if (target.startsWith('state.') && holdsText(typeAt(definitions, target))) set(target, { ...base, path: [...base.path, `${id}.${target}`] });
    }
  }
  const acting = new Map(steps.map(([id, step]) => [id, actionsOf(method, step, tools)]).filter(([, actions]) => actions.length));
  const findings = [];
  for (const [id, actions] of acting) {
    const step = method.steps[id];
    const own = sources.get(id);
    if (own) {
      findings.push({ step: id, actions, field: 'do', source: id, connection: own.connection, kind: own.kind, path: [own.connection], reads: [] });
      continue;
    }
    // An ask step whose yes the step waits for shows the person the values that it reads.
    const asked = step.when && method.steps[producers[head(step.when)]]?.ask ? method.steps[producers[head(step.when)]] : null;
    const shown = asked ? [...Object.values(asked.in ?? {}), ...Object.values(asked.each ?? {})] : [];
    const seen = ref => shown.some(value => ref === value || ref.startsWith(`${value}.`));
    const reads = readsOf(step).map(read => ({ ...read, label: labelOf(read.ref) })).filter(read => read.label && !seen(read.ref));
    if (!reads.length) continue;
    const first = reads.reduce((best, read) => shorter(read.label, best.label) ? read : best);
    findings.push({ step: id, actions, field: first.field, source: first.label.source, connection: first.label.connection, kind: first.label.kind, path: first.label.path, reads });
  }
  return { sources, acting, findings };
}

/** An ask step before the acting step that shows the untrusted values, and a when that runs the step only on yes. */
function askPatch(method, finding) {
  const step = method.steps[finding.step];
  // A step with its own when, or one that reads the content itself, cannot be fixed by a question before it.
  if (step.when || !finding.reads.length) return undefined;
  const { definitions } = valueTypes(method);
  const taken = new Set([...Object.keys(method.steps), ...Object.values(method.steps).flatMap(s => Object.keys(effectiveOutputs(s)))]);
  const unique = base => { let name = base; for (let n = 2; taken.has(name); n++) name = `${base}_${n}`; taken.add(name); return name; };
  const askId = unique(`confirm_${finding.step}`);
  const answer = unique(`${finding.step}_approved`);
  const bound = {}, shown = [];
  for (const read of finding.reads) {
    if (Object.values(bound).includes(read.ref)) continue;
    let alias = read.alias ?? head(read.ref);
    while (own(bound, alias) || alias === answer || ['inputs', 'state', 'environment', 'run', 'token'].includes(alias)) alias = `${alias}_value`;
    bound[alias] = read.ref;
    shown.push(shape(typeAt(definitions, read.ref)).type === 'text' ? `${alias}: {{${alias}}}` : `${alias} (shown with this question)`);
  }
  const name = step.name ?? finding.step;
  const ask = `${name} will use text that came from ${connectionName(finding.connection)} through ${finding.source}. Read it before it ${finding.actions.join(' and ')}.\n\n${shown.join('\n\n')}\n\nAnswer yes to let ${name} go on, or no to skip it.`;
  return {
    safety: 'behavioral',
    edits: [
      { op: 'insert_step', before: finding.step, id: askId, step: {
        name: `Approve ${name}`, purpose: `Show the person the text that ${name} uses, and run ${name} only on yes.`,
        in: bound, ask, out: { [answer]: { type: 'boolean', description: `Yes to let ${name} go on.` } } } },
      { op: 'set', path: ['steps', finding.step, 'when'], value: answer },
    ],
  };
}

/** The untrusted_reaches_action issues of a valid Method. */
export function untrustedIssues(method, options = {}) {
  return traceUntrusted(method, options).findings.map(finding => {
    const self = finding.source === finding.step;
    const patch = askPatch(method, finding);
    return {
      code: 'untrusted_reaches_action', level: 'warning', step: finding.step, field: finding.field, path: finding.path,
      message: self
        ? `${finding.step} reads text from ${finding.connection} and ${finding.actions.join(' and ')} in the same step, without a question to you.`
        : `Text from ${finding.source} (${finding.connection}) can reach ${finding.step}, which ${finding.actions.join(' and ')}, without a question to you.`,
      fix: self
        ? `Split ${finding.step}: one step reads the content and returns data, and a later step makes the change after a question to you.`
        : `Add a question before ${finding.step}, or pass only a choice or a number from the reading step.`,
      ...(patch ? { patch } : {}),
    };
  });
}

const sourceWords = { browser: 'web pages', service: 'connected services' };
/** What the flow check proves about a valid Method: a list of {code, statement}; empty when it proves nothing. */
export function untrustedProofs(method, options = {}) {
  const { sources, acting, findings } = traceUntrusted(method, options);
  if (!sources.size || !acting.size || findings.length) return [];
  const kinds = [...new Set([...sources.values()].map(source => sourceWords[source.kind]))].sort();
  return [{ code: 'no_untrusted_action', statement: `Text from ${kinds.join(' and ')} cannot reach a step that sends or changes things without a question to you.` }];
}

/**
 * Apply a list of edits to a Method document (an object) and return a new document; the input is not changed.
 * Edits:
 *   {op: 'set', path: [KEY, ...], value}      set the value at path; missing records on the way are made
 *   {op: 'remove', path: [KEY, ...]}          remove the value at path
 *   {op: 'insert_step', before, id, step}     add step id to steps, placed just before step before
 * Paths are lists of keys from the document root, for example ['steps', 'send', 'when'].
 * @param {Record<string, any>} document
 * @param {import('./api-types.js').Edit[]} edits
 * @returns {Record<string, any>}
 */
export function applyEdits(document, edits) {
  const result = structuredClone(document);
  const bad = message => { throw Object.assign(new Error(message), { code: 'invalid_edit' }); };
  const keyOk = key => typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key);
  for (const edit of edits) {
    if (edit.op === 'set' || edit.op === 'remove') {
      if (!Array.isArray(edit.path) || !edit.path.length || !edit.path.every(keyOk)) bad(`Edit ${edit.op} needs a path of keys.`);
      let parent = result;
      for (const key of edit.path.slice(0, -1)) {
        if (!own(parent, key)) { if (edit.op === 'remove') bad(`Nothing to remove at ${edit.path.join('.')}.`); parent[key] = {}; }
        parent = parent[key];
        if (!parent || typeof parent !== 'object') bad(`${edit.path.join('.')} goes through a value that is not a record.`);
      }
      const last = edit.path.at(-1);
      if (edit.op === 'set') parent[last] = structuredClone(edit.value);
      else if (!own(parent, last)) bad(`Nothing to remove at ${edit.path.join('.')}.`);
      else delete parent[last];
    } else if (edit.op === 'insert_step') {
      const steps = result.steps ?? {};
      if (!keyOk(edit.id) || own(steps, edit.id)) bad(`Step ${edit.id} already exists.`);
      if (!own(steps, edit.before)) bad(`Step ${edit.before} does not exist.`);
      result.steps = Object.fromEntries(Object.entries(steps).flatMap(([id, step]) => id === edit.before ? [[edit.id, structuredClone(edit.step)], [id, step]] : [[id, step]]));
    } else bad(`Unknown edit op: ${edit.op}.`);
  }
  return result;
}
