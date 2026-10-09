import { readFile, readdir, appendFile, mkdir } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { resolve as pathResolve, posix, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertSchema, fail, safeData } from './validate.js';
import { observationSchema, judgmentSchema } from './schema.js';
import { effectSchedule, effectConfirm } from './semantics.js';
import { containedFile, executeProcess, hash, writeJSON } from './io.js';

/** One effect of one accepted iteration. */
export const effectKey = (step, iteration, name) => `${step}/${iteration}/${name}`;
const builtinScript = fileURLToPath(new URL('./observers/builtin.mjs', import.meta.url));
export const isBuiltin = exec => exec.kind !== 'run';
export const effectEntries = method => Object.entries(method.steps).flatMap(([id, step]) => Object.entries(step.effects ?? {}).map(([name, effect]) => ({ id, step, name, effect })));
/** Connections an action may see; observer credentials and endpoints go only to observers. */
export function connectionsFor(method, environment = {}, role) {
  const observer = name => method.environment?.[name]?.role === 'observer';
  return Object.fromEntries(Object.entries(environment).filter(([name]) => role === 'observer' ? observer(name) : !observer(name)));
}

/** Fixture files are part of the bundle, so every run tests the judge that it will use. */
export async function fixtureFiles(method, sourceRoot) {
  const files = [];
  for (const { effect } of effectEntries(method)) {
    if (!effect.fixtures) continue;
    let names;
    try { names = await readdir(await containedFile(sourceRoot, effect.fixtures)); }
    catch (error) { fail(`Cannot read effect fixtures ${effect.fixtures}: ${error.message}`, 'preflight'); }
    files.push(...names.filter(name => name.endsWith('.json')).sort().map(name => posix.join(effect.fixtures, name)));
  }
  return files;
}

/**
 * Run each judge on its fixtures. A judge must give the expected verdict for each fixture, and must be able to
 * report a contradiction and an absence of evidence. A judge that cannot fail proves nothing.
 */
export async function testFixtures(method, bundle, manifest, judge) {
  const results = [];
  for (const { id, name, effect } of effectEntries(method)) {
    if (!effect.fixtures) continue;
    const files = Object.keys(manifest).filter(file => posix.dirname(file) === posix.normalize(effect.fixtures) && file.endsWith('.json'));
    const where = `${id}.effects.${name}`;
    const expected = new Set();
    for (const file of files) {
      const fixture = JSON.parse(await readFile(await containedFile(bundle, file), 'utf8'));
      safeData(fixture);
      if (!['confirmed', 'contradicted', 'no_evidence', 'unobservable'].includes(fixture.expect)) fail(`${file}: expect must be confirmed, contradicted, no_evidence or unobservable`, 'effect_fixture_failed');
      assertSchema(observationSchema, { observations: fixture.observations }, `${file} observations`);
      const judgment = await judge(effect, { token: fixture.token ?? 'mop_fixture', intent: effect.intent, inputs: fixture.inputs ?? {}, observations: fixture.observations, previous: fixture.previous ?? [], final: fixture.final ?? false });
      if (judgment.verdict !== fixture.expect) fail(`${where}: fixture ${file} expects ${fixture.expect}, but the judge returned ${judgment.verdict} (${judgment.reason})`, 'effect_fixture_failed');
      expected.add(fixture.observations.length ? fixture.expect : 'empty:' + fixture.expect);
      results.push({ effect: `${id}/${name}`, fixture: file, verdict: judgment.verdict });
    }
    const missing = [];
    if (!expected.has('contradicted')) missing.push('a contradicted case');
    if (!expected.has('empty:no_evidence')) missing.push('an empty case (observations: []) that gives no_evidence');
    if (effectConfirm(effect) === 'positive' && !expected.has('confirmed')) missing.push('a confirmed case');
    if (missing.length) fail(`${where}: fixtures in ${effect.fixtures} need ${missing.join(', ')}`, 'effect_fixture_failed');
  }
  return results;
}

/** Run an observer script. Observers get observer connections and the token; judges get no connections. */
export async function runObserverScript({ exec, input, role, token, bundle, runtimeInfo, connections, processPath, signal, maxBytes }) {
  const env = { PATH: processPath ?? process.env.PATH ?? '', LANG: 'C.UTF-8' };
  if (role === 'fetch') { env.METHOD_ENVIRONMENT = JSON.stringify(connections); env.METHOD_EFFECT_TOKEN = token; }
  let command, args;
  if (isBuiltin(exec)) {
    // A built-in observer runs in its own Node process, like a script observer.
    command = process.execPath; args = ['--no-warnings', builtinScript, role]; input = { ...input, spec: exec };
    if (role === 'fetch' && process.env.METHOD_OBSERVER_TOKEN) env.METHOD_OBSERVER_TOKEN = process.env.METHOD_OBSERVER_TOKEN;
  } else {
    const profile = runtimeInfo[exec.runtime];
    if (!profile) fail(`Unknown runtime: ${exec.runtime}`, 'preflight');
    if (role === 'fetch') for (const key of profile.env ?? []) {
      if (!process.env[key]) fail(`Missing runtime environment variable: ${key}`, 'preflight');
      env[key] = process.env[key];
    }
    command = profile.command; args = [...(profile.args ?? []), await containedFile(bundle, exec.entrypoint), ...(exec.args ?? [])];
  }
  const result = await executeProcess({ command, args, cwd: bundle, input, env, signal, maxBytes });
  let output;
  try { output = JSON.parse(result.output); } catch { fail(`${exec.entrypoint} must return one JSON object`, 'invalid_output'); }
  safeData(output);
  assertSchema(role === 'fetch' ? observationSchema : judgmentSchema, output, role === 'fetch' ? 'Observer output' : 'Judge output');
  return { output, diagnostics: result.diagnostics };
}

/** The next scheduled observation after `after`, or null when the horizon has passed. */
export function nextObservation(effect, completedAt, after) {
  const start = Date.parse(completedAt);
  for (const offset of effectSchedule(effect)) if (start + offset > Date.parse(after)) return new Date(start + offset).toISOString();
  return null;
}
export const horizonAt = (effect, completedAt) => new Date(Date.parse(completedAt) + effectSchedule(effect).at(-1)).toISOString();

/** Map a judgment to a verdict. Absence of evidence never confirms an effect. */
export function verdictFor(judgment, final, effect) {
  if (judgment.verdict === 'confirmed' || judgment.verdict === 'contradicted') return judgment.verdict;
  if (judgment.verdict === 'no_evidence') return final ? (effect.confirm === 'unrefuted_at_horizon' ? 'unrefuted' : 'unknown') : 'pending';
  return 'unknown';
}
export const isFinal = entry => entry.final === true;

/**
 * Observe one effect once and return its ledger entry. With replay observations, only the judge runs.
 * @param {{effect: any, key: string, token: string, inputs: any, attempt: number, actionOutcome: string, completedAt: string, run: (exec: any, input: any, role: string) => Promise<{output: any}>, replay?: any[] | undefined, final?: boolean, runDir?: string, now?: Date, previous?: any[]}} options
 */
export async function observeEffect({ effect, key, token, inputs, attempt, actionOutcome, completedAt, run, replay, final, runDir, now, previous = [] }) {
  const observedAt = (now ?? new Date()).toISOString();
  const atHorizon = final ?? Date.parse(observedAt) >= Date.parse(horizonAt(effect, completedAt));
  let observations, judgment, error;
  try {
    observations = replay ?? (await run(effect.observe, { token, intent: effect.intent, inputs, attempt, action_outcome: actionOutcome }, 'fetch')).output.observations;
    // The judge sees earlier readings too, so it can judge a trend such as continued production.
    judgment = (await run(effect.judge ?? effect.observe, { token, intent: effect.intent, inputs, observations, previous, final: atHorizon }, 'judge')).output;
  } catch (failure) {
    error = { code: failure.code ?? 'observer_failed', message: failure.message };
    judgment = { verdict: 'unobservable', reason: failure.message, evidence: [] };
  }
  const verdict = verdictFor(judgment, atHorizon, effect);
  const finalVerdict = ['confirmed', 'contradicted', 'unrefuted'].includes(verdict) || atHorizon;
  let observationsFile = null;
  if (observations && runDir) {
    // Raw observations can hold message text; keep them beside the ledger, private to the run.
    observationsFile = `effects/${key.replaceAll('/', '.')}.${attempt}.json`;
    await mkdir(pathResolve(runDir, 'effects'), { recursive: true, mode: 0o700 });
    await writeJSON(pathResolve(runDir, observationsFile), { observations });
  }
  return {
    effect: key, token, inputs, action_outcome: actionOutcome, attempt, observed_at: observedAt, verdict,
    reason: judgment.reason, evidence: judgment.evidence ?? [], observations: observationsFile, observations_sha256: observations ? hash(observations) : null,
    observer: isBuiltin(effect.observe) ? { builtin: effect.observe.kind, source: replay ? 'replay' : 'live' } : { observe: effect.observe.entrypoint, judge: effect.judge.entrypoint, source: replay ? 'replay' : 'live' },
    ...(error ? { error } : {}),
    final: finalVerdict, completed_at: completedAt, horizon_at: horizonAt(effect, completedAt),
    next_observation_at: finalVerdict ? null : nextObservation(effect, completedAt, observedAt),
  };
}

// Automatic observation of files connections: the runtime reads the folder itself, before and after the step.
const skippedFolders = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'sensitive', '.method-runs']);
// Listing must stay cheap: a step that writes to a large repository should not wait for it.
export const folderLimit = { files: 20_000, ms: 3_000 };
/**
 * Size and modification time of every file under a folder (synchronous reads are about ten times faster than one
 * awaited stat per file), or null when the folder is larger than the limit or the listing takes longer than the budget.
 */
export async function listFolder(root, exclude = []) {
  const files = {};
  const started = performance.now();
  let info;
  try { info = statSync(root); } catch (error) { if (error.code === 'ENOENT') return files; throw error; }
  // A files connection can also name one file, such as a ledger.
  if (info.isFile()) return { '.': `${info.size}:${info.mtimeMs}` };
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error; }
    for (const entry of entries) {
      const path = pathResolve(dir, entry.name);
      if (exclude.includes(path)) continue;
      if (entry.isDirectory()) { if (!skippedFolders.has(entry.name)) stack.push(path); continue; }
      if (!entry.isFile()) continue;
      if (++count > folderLimit.files || performance.now() - started > folderLimit.ms) return null;
      const stats = statSync(path, { throwIfNoEntry: false });
      if (stats) files[relative(root, path).split(sep).join('/')] = `${stats.size}:${stats.mtimeMs}`;
    }
  }
  return files;
}
/**
 * Compare a folder before and after a step. A path that the step returns inside the folder must have changed:
 * "it said it saved the report, but the report did not change" is a contradiction. No change at all is allowed.
 */
export function observeFiles({ key, connection, root, before, after, outputs, completedAt }) {
  const base = { effect: key, automatic: true, connection, action_outcome: 'ok', attempt: 1, observed_at: new Date().toISOString(), final: true, completed_at: completedAt, horizon_at: completedAt, next_observation_at: null, evidence: [] };
  if (!before || !after) return { ...base, verdict: 'unobserved', reason: `${connection} is too large to observe (more than ${folderLimit.files} files, or longer than ${folderLimit.ms / 1000} s to list); it is not observed in this run. Point the connection at a smaller folder, or declare an effect.` };
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(file => before[file] !== after[file]).map(file => ({ path: file, change: !before[file] ? 'added' : !after[file] ? 'removed' : 'modified' }));
  const touched = new Set(changed.filter(c => c.change !== 'removed').map(c => c.path));
  const claimed = [];
  for (const value of Object.values(outputs ?? {})) {
    if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\n')) continue;
    // An absolute path is a claim. A relative value counts only when it looks like a path: no spaces, and a / or an extension.
    if (!isAbsolute(value) && (/\s/.test(value) || !(/[\/]/.test(value) || /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(value)))) continue;
    for (const candidate of isAbsolute(value) ? [value] : [pathResolve(value), pathResolve(root, value)]) {
      const rel = relative(root, candidate);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) { claimed.push(rel.split(sep).join('/')); break; }
    }
  }
  // A returned folder counts as changed when a file inside it changed.
  const missing = [...new Set(claimed)].filter(file => !touched.has(file) && ![...touched].some(path => path.startsWith(file + '/')));
  const list = changed.slice(0, 50);
  if (missing.length) return { ...base, verdict: 'contradicted', changed: list, evidence: missing,
    reason: `The step returned ${missing.join(', ')}, but ${missing.length === 1 ? 'that file' : 'those files'} did not change in ${connection}.` };
  if (!changed.length) return { ...base, verdict: 'unchanged', changed: [], reason: `No file in ${connection} changed.` };
  return { ...base, verdict: 'confirmed', changed: list, evidence: list.map(c => c.path),
    reason: `${changed.length} file${changed.length === 1 ? '' : 's'} changed in ${connection}: ${list.slice(0, 5).map(c => `${c.path} (${c.change})`).join(', ')}${changed.length > 5 ? ', …' : ''}.` };
}

/** Earlier readings of one effect, oldest first. */
export async function previousObservations(runDir, key) {
  const out = [];
  for (const entry of (await readLedger(runDir)).filter(entry => entry.effect === key && entry.observations)) {
    try { out.push({ observed_at: entry.observed_at, observations: JSON.parse(await readFile(pathResolve(runDir, entry.observations), 'utf8')).observations }); }
    catch { /* A missing file leaves a gap; the judge sees the readings that remain. */ }
  }
  return out;
}
export async function readLedger(runDir) {
  let text;
  try { text = await readFile(pathResolve(runDir, 'effects.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export const appendLedger = (runDir, entry) => appendFile(pathResolve(runDir, 'effects.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
/** The current entry of each effect is its last entry. */
export function currentEffects(entries) {
  const current = new Map();
  for (const entry of entries) current.set(entry.effect, entry);
  return [...current.values()];
}

/**
 * The runtime, not the Method, decides what a finished run's effects establish.
 * Worst verdict wins: contradicted > final unknown > pending > confirmed or unrefuted.
 */
export function effectSummary(entries) {
  const current = currentEffects(entries);
  const count = verdict => current.filter(entry => entry.verdict === verdict).length;
  const unknown = current.filter(entry => entry.verdict === 'unknown' && entry.final).length;
  const pending = current.filter(entry => !entry.final).length;
  const due = current.map(entry => entry.next_observation_at).filter(Boolean).sort()[0] ?? null;
  return {
    total: current.length, confirmed: count('confirmed'), unrefuted: count('unrefuted'), contradicted: count('contradicted'), unknown, pending, unchanged: count('unchanged'),
    next_observation_at: due,
    effects: current.map(({ effect, verdict, final, reason, observed_at, next_observation_at, horizon_at, action_outcome }) => ({ effect, verdict, final, reason, observed_at, next_observation_at, horizon_at, action_outcome })),
  };
}
/** Apply the effect summary to a completed run's status. */
export function statusWithEffects(base, summary) {
  if (base.status !== 'completed' || !summary.total) return base;
  if (summary.contradicted) {
    const effects = summary.effects.filter(e => e.verdict === 'contradicted').map(e => `${e.effect} (${e.reason})`).join('; ');
    const { result, ...rest } = base;
    return { ...rest, status: 'failed', code: 'effect_contradicted', error: `An observer found evidence that an intended external change did not happen: ${effects}`,
      recovery: 'Inspect effects.jsonl and the external system. The external action is not repeated automatically; correct it, then start a new run.', effects: summary };
  }
  if (summary.unknown) {
    const { result, ...rest } = base;
    return { ...rest, status: 'unconfirmed', code: 'effect_unconfirmed', result,
      error: `No observer could confirm these external changes: ${summary.effects.filter(e => e.verdict === 'unknown' && e.final).map(e => e.effect).join(', ')}`,
      recovery: 'Inspect effects.jsonl and the external system before relying on this result.', effects: summary };
  }
  return { ...base, effects: summary };
}

/** Wait until an ISO time, within a deadline. Returns false when the wait does not fit. */
export async function waitUntil(time, deadline, signal) {
  const ms = Date.parse(time) - Date.now();
  if (ms <= 0) return true;
  if (performance.now() + ms >= deadline) return false;
  await delay(ms, undefined, { signal });
  return true;
}
