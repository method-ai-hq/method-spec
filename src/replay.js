import { modelName } from './semantics.js';
import { documentForDigest } from './document.js';
import { readFile, cp, mkdir, access } from 'node:fs/promises';
import { resolve as pathResolve, relative, isAbsolute, dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { executionTools } from './tool-connections.js';
import { fail } from './validate.js';
import { hash } from './io.js';
import { readLedger, currentEffects } from './effects.js';
import { readLearned, activeRules } from './learned.js';

/**
 * Everything that decides what a step does, apart from its inputs. Display text and effect contracts do not change
 * the action, so they do not change the key. Runtime binaries are left out: a Node update does not make a recording
 * stale, but a changed script, prompt, model profile, tool, declared helper file (helpers, the Method's files) of a
 * step that runs a script, or active learned rule of this step (rules) does.
 */
export function stepKey(step, { files = {}, profiles = {}, tools = {}, helpers = [], rules = [] }) {
  const { name, reading, purpose, effects, ...definition } = step;
  const parts = [definition];
  let scripts = false;
  for (const exec of [step.do, step.check]) if (exec?.kind) {
    if (['call', 'agent'].includes(exec.kind)) parts.push(['model', modelName(exec), profiles[modelName(exec)] ?? null]);
    if (exec.kind === 'run') { scripts = true; parts.push(['file', exec.entrypoint, files[exec.entrypoint] ?? null]); }
    for (const tool of executionTools(exec, tools)) {
      parts.push(['tool', tool, tools[tool] ?? null]);
      if (tools[tool]?.run) { scripts = true; parts.push(['file', tools[tool].run.entrypoint, files[tools[tool].run.entrypoint] ?? null]); }
    }
  }
  // The runtime does not trace which helper files a script reads, so every declared one is part of its key.
  if (scripts && helpers.length) parts.push(['helpers', [...new Set(helpers)].sort().map(file => [file, files[file] ?? null])]);
  if (rules.length) parts.push(['learned', hash(rules)]);
  return hash(parts);
}

/** Every key of a Method: the keys of each step with its own learned rules. */
export const stepKeys = (method, { files, profiles, tools, learned }) => Object.fromEntries(Object.entries(method.steps).map(([id, step]) =>
  [id, stepKey(step, { files, profiles, tools, helpers: method.files ?? [], rules: activeRules(learned, id) })]));

const pathEnd = /[A-Za-z0-9._~-]/;
/** Whether path starts in text at i, as a whole path or the start of a path below it, and not inside a longer path. */
const pathAt = (text, path, i) => text.startsWith(path, i) && !pathEnd.test(text[i + path.length] ?? '') && !/[A-Za-z0-9._~/-]/.test(text[i - 1] ?? '');
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
/**
 * Replace each path in map (from -> to) wherever it appears in a value: a whole string, a path below it, or the path
 * inside text. Longer paths are replaced first, so a path inside another copied folder keeps its own copy.
 */
export function rewritePaths(value, map) {
  const pairs = Object.entries(map ?? {}).filter(([from]) => from).sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return value;
  const text = string => {
    let out = '', i = 0;
    outer: while (i < string.length) {
      for (const [from, to] of pairs) if (pathAt(string, from, i)) { out += to; i += from.length; continue outer; }
      out += string[i++];
    }
    return out;
  };
  const visit = v => typeof v === 'string' ? text(v) : Array.isArray(v) ? v.map(visit) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)])) : v;
  return visit(value);
}
/** The first path of the list that a value names (itself or a path below it), or null. */
export function namedPath(value, paths) {
  for (const text of strings(value)) for (const path of paths) for (let i = text.indexOf(path); i >= 0; i = text.indexOf(path, i + 1)) if (pathAt(text, path, i)) return path;
  return null;
}

/**
 * The recorded output for this iteration, when the step and its inputs are unchanged and the step is not forced to run
 * live. A scratch copy stands in for each recorded path: bindings are compared after mapping the copies back
 * (replay.paths), and a served output names the copies (replay.copies).
 */
export function replayedCandidate(replay, { id, step, iteration, bindings, key }) {
  const recording = replay.recording;
  if (replay.live?.includes(id) || recording.keys[id] !== key) return null;
  const saved = recording.iterations[id]?.[iteration];
  if (!saved || !isDeepStrictEqual(saved.inputs, rewritePaths(bindings, replay.paths))) return null;
  return rewritePaths(structuredClone(saved.candidate), replay.copies);
}
export function unverifiable(id, iteration, step) {
  const why = step.ask ? 'it asks a person' : step.do?.kind === 'session' ? 'it is a session that can use a shell or the web' : 'it changes an external system';
  fail('setup', `Cannot replay ${id}:${iteration}: the step or its inputs changed, and ${why}. Record the case again from a new run.`, 'unverifiable');
}

/** The folder in a run folder that keeps each path a script made in the run folder, as the script left it. */
export const keptFolder = runDir => join(pathResolve(runDir), 'kept');
const keptLimit = { files: 5000, bytes: 100_000_000 };
/**
 * Keep a copy of each file or folder in the run folder that a script step's outputs name, as the step left it. A later
 * step can change or remove it before the run ends; a case made from the run copies the kept version, which is what the
 * next step read. The first copy of a path stays. A path larger than the limits is not kept.
 */
export async function keepRunPaths(runDir, outputs) {
  const root = pathResolve(runDir), kept = keptFolder(root);
  for (const text of new Set(strings(outputs))) {
    if (text.length > 4096 || text.includes('\n') || !isAbsolute(text)) continue;
    const path = pathResolve(text), rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel === 'kept' || rel.startsWith(`kept${sep}`)) continue;
    const target = join(kept, rel);
    if (await access(target).then(() => true, () => false) || !await access(path).then(() => true, () => false)) continue;
    if (!await withinLimit(path)) continue;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(path, target, { recursive: true, verbatimSymlinks: true });
  }
}
async function withinLimit(path) {
  const { readdir, stat } = await import('node:fs/promises');
  let files = 0, bytes = 0;
  const visit = async p => {
    const info = await stat(p);
    if (info.isFile()) { files++; bytes += info.size; return files <= keptLimit.files && bytes <= keptLimit.bytes; }
    if (!info.isDirectory()) return true;
    for (const name of await readdir(p)) if (!await visit(join(p, name))) return false;
    return true;
  };
  try { return await visit(path); } catch { return false; }
}

/** Build a recording from a finished run: each accepted iteration's inputs and outputs, plus its effect observations. */
export async function recordRun(runDir) {
  const read = async name => JSON.parse(await readFile(pathResolve(runDir, name), 'utf8'));
  const method = await read('method.json'), manifest = await read('manifest.json');
  const events = (await readFile(pathResolve(runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const started = events.find(event => event.event === 'run.started');
  if (!started) fail('setup', `The run has no run.started event: ${runDir}`, 'case_invalid');
  const iterations = {}, open = {};
  for (const event of events) {
    const at = `${event.step}:${event.iteration}`;
    if (event.event === 'step.started') open[at] = { inputs: event.inputs };
    else if (event.event === 'step.candidate' && open[at]) open[at].candidate = event.candidate;
    // An iteration reused from an earlier run has no candidate event; its accepted outputs are what that run's action returned.
    else if (event.event === 'step.accepted' && open[at] && (open[at].candidate || event.reused_from)) (iterations[event.step] ??= [])[event.iteration] = { inputs: open[at].inputs, candidate: open[at].candidate ?? event.outputs };
  }
  const tools = started.config?.tools ?? {};
  const keys = stepKeys(method, { files: manifest.files, profiles: manifest.models, tools, learned: await readLearned(pathResolve(runDir, 'bundle')) });
  const observations = {};
  for (const entry of currentEffects((await readLedger(runDir)).filter(entry => entry.observations))) {
    observations[entry.effect] = (await read(entry.observations)).observations;
  }
  return {
    format: 'method-recording/1', method_sha256: hash(documentForDigest(method)), execution_id: started.execution_id, source_run_dir: pathResolve(runDir),
    inputs: started.inputs ?? {}, initial_state: started.initial_state ?? {}, environment: started.config?.environment ?? {}, keys, iterations, observations, method,
  };
}
