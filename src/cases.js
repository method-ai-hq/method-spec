import { readFile, readdir, mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { resolve as pathResolve, dirname, basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { recordRun } from './replay.js';
import { runMethod } from './runner.js';
import { copyForkFiles } from './fork.js';
import { configuration } from './defaults.js';
import { fail, own, safeData } from './validate.js';
import { executable, executeProcess, hash, writeJSON, containedFile } from './io.js';

const caseId = /^[a-z0-9][a-z0-9-]{0,79}$/;
const reservedRoots = new Set(['inputs', 'state', 'environment', 'run']);
export const defaultCasesDir = methodFile => pathResolve(dirname(pathResolve(methodFile)), 'cases');

async function readJSON(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }

/** A digest of every file under the cases directory. The learn gate compares it before and after a repair. */
export async function casesDigest(casesDir) {
  const files = [];
  async function visit(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push([relative(casesDir, path), hash(await readFile(path))]);
    }
  }
  await visit(casesDir);
  return { sha256: hash(files), files: files.length };
}

/** Cases recorded from runs of this Method file. */
export async function listCases(methodFile, casesDir = defaultCasesDir(methodFile)) {
  let names;
  try { names = await readdir(casesDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const cases = [];
  for (const name of names.sort()) {
    const file = join(casesDir, name, 'case.json');
    if (!await exists(file)) continue;
    const value = await readJSON(file);
    if (value.method_file === basename(methodFile)) cases.push({ ...value, dir: join(casesDir, name) });
  }
  return cases;
}

const applyRedaction = (value, redact) => {
  if (!redact || !Object.keys(redact).length) return value;
  let text = JSON.stringify(value);
  for (const [from, to] of Object.entries(redact)) {
    if (typeof from !== 'string' || from.length < 2 || typeof to !== 'string') fail('Redaction maps text of two or more characters to replacement text', 'case_invalid');
    text = text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
  }
  return JSON.parse(text);
};

function validateExpectations(expect) {
  if (!Array.isArray(expect) || !expect.length) fail('A case needs at least one expectation', 'case_invalid');
  for (const item of expect) {
    if (item.kind === 'status') { if (!Array.isArray(item.in) || !item.in.length) fail('A status expectation lists the allowed statuses in "in"', 'case_invalid'); }
    else if (item.kind === 'equals') { if (typeof item.ref !== 'string' || !own(item, 'value')) fail('An equals expectation needs ref and value', 'case_invalid'); }
    else if (item.kind === 'effect') { if (typeof item.effect !== 'string' || !Array.isArray(item.verdict)) fail('An effect expectation needs effect and a verdict list', 'case_invalid'); }
    else if (item.kind === 'predicate') { if (typeof item.runtime !== 'string' || typeof item.entrypoint !== 'string') fail('A predicate expectation needs runtime and entrypoint', 'case_invalid'); }
    else fail(`Unknown expectation kind: ${item.kind}`, 'case_invalid');
  }
}

const lookup = (root, ref) => {
  let value = root;
  for (const key of ref.split('.')) { if (!own(value, key)) return { missing: true }; value = value[key]; }
  return { value };
};
/**
 * Evaluate the expectations against one outcome. A missing value or an effect that was not replayed makes the
 * result unverifiable: the case cannot say whether the version is right.
 */
export async function evaluate(expect, outcome, { caseDir, config }) {
  const results = [];
  for (const item of expect) {
    let status, reason;
    if (item.kind === 'status') { status = item.in.includes(outcome.status) ? 'pass' : 'fail'; reason = `run status ${outcome.status}`; }
    else if (item.kind === 'equals') {
      const found = lookup(outcome, item.ref);
      if (found.missing) { status = outcome.status === 'failed' ? 'fail' : 'unverifiable'; reason = `${item.ref} is missing`; }
      else { status = isDeepStrictEqual(found.value, item.value) ? 'pass' : 'fail'; reason = `${item.ref} = ${JSON.stringify(found.value)}`; }
    } else if (item.kind === 'effect') {
      const effect = outcome.effects.find(e => e.effect === item.effect);
      if (!effect) { status = outcome.status === 'failed' ? 'fail' : 'unverifiable'; reason = `effect ${item.effect} was not observed`; }
      else if (effect.verdict === 'not_replayed') { status = 'unverifiable'; reason = `the case has no observations for ${item.effect}`; }
      else { status = item.verdict.includes(effect.verdict) ? 'pass' : 'fail'; reason = `${item.effect} ${effect.verdict}`; }
    } else {
      const profile = configuration(config).runtimes?.[item.runtime];
      if (!profile) fail(`Unknown runtime for predicate: ${item.runtime}`, 'preflight');
      try {
        const result = await executeProcess({ command: await executable(profile.command), args: [...(profile.args ?? []), await containedFile(caseDir, item.entrypoint)], cwd: caseDir,
          input: outcome, env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' }, signal: AbortSignal.timeout(60_000), maxBytes: 1_000_000 });
        const value = JSON.parse(result.output);
        status = value.pass === true ? 'pass' : 'fail'; reason = String(value.reason ?? '');
      } catch (error) { status = 'fail'; reason = `predicate failed: ${error.message}`; }
    }
    results.push({ ...(item.text ? { text: item.text } : {}), kind: item.kind, status, reason });
  }
  const status = results.some(r => r.status === 'fail') ? 'fail' : results.some(r => r.status === 'unverifiable') ? 'unverifiable' : 'pass';
  return { status, results };
}

/**
 * Record a case from a finished run. The expectation must not pass on an empty outcome; a case that cannot fail
 * tests nothing.
 */
export async function createCase({ methodFile, runDir, id, note, author, expect, observations = {}, redact, runs = 1, minPass, retentionDays = 365, locate, supersedes = [], casesDir = defaultCasesDir(methodFile), config = {} }) {
  if (!caseId.test(id ?? '')) fail('Case IDs use lowercase letters, digits and hyphens', 'case_invalid');
  if (typeof note !== 'string' || !note.trim()) fail('A case records the correction note', 'case_invalid');
  if (pathResolve(runDir).split(/[\\/]/).includes('sensitive')) fail('Do not build cases from runs under sensitive/. Use a redacted run.', 'case_invalid');
  validateExpectations(expect);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) fail('runs must be between 1 and 20', 'case_invalid');
  minPass ??= runs;
  if (!Number.isSafeInteger(minPass) || minPass < 1 || minPass > runs) fail('min_pass must be between 1 and runs', 'case_invalid');
  const dir = join(casesDir, id);
  if (await exists(dir)) fail(`Case already exists: ${id}`, 'case_exists');
  safeData(observations);
  const recorded = await recordRun(runDir);
  const recording = applyRedaction({ ...recorded, observations: { ...recorded.observations, ...observations } }, redact);
  // A vacuous expectation passes even when the Method returns nothing.
  const empty = { status: 'completed', code: null, result: null, outputs: {}, effects: [] };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    for (const item of expect) if (item.kind === 'predicate' && !await exists(join(dir, item.entrypoint))) {
      const source = pathResolve(dirname(pathResolve(methodFile)), item.entrypoint);
      await writeFile(join(dir, item.entrypoint), await readFile(source), { mode: 0o600 });
    }
    if ((await evaluate(expect, empty, { caseDir: dir, config })).status === 'pass') fail('The expectation passes on an empty result, so it cannot detect the error. Make it specific.', 'case_vacuous');
    const accepted = Object.fromEntries(Object.entries(recorded.iterations).map(([step, list]) => [step, list.filter(Boolean).map(entry => entry.candidate)]));
    await mkdir(join(dir, 'artifacts'), { recursive: true, mode: 0o700 });
    await copyForkFiles({ dir: runDir }, recorded.method, accepted, join(dir, 'artifacts'));
    const created = new Date();
    const value = {
      format: 'method-case/1', id, status: 'active', method_file: basename(methodFile), note: applyRedaction(note, redact), author: author ?? null,
      created: created.toISOString(), source: { run_dir: pathResolve(runDir), execution_id: recorded.execution_id, method_sha256: recorded.method_sha256 },
      ...(locate ? { locate } : {}), expect, runs, min_pass: minPass, supersedes, superseded_by: null,
      retention_until: new Date(created.getTime() + retentionDays * 86_400_000).toISOString().slice(0, 10), redacted: !!(redact && Object.keys(redact).length),
    };
    await writeJSON(join(dir, 'recording.json'), recording);
    await writeJSON(join(dir, 'case.json'), value);
    for (const old of supersedes) await retireCase(methodFile, old, { by: id, reason: `Superseded by ${id}: ${value.note}`, casesDir });
    return { ...value, dir };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

/** Retire a case whose rule is obsolete. The case stays on disk with its reason, so the history is kept. */
export async function retireCase(methodFile, id, { by = null, reason, casesDir = defaultCasesDir(methodFile) }) {
  if (typeof reason !== 'string' || !reason.trim()) fail('Give the reason the case no longer applies', 'case_invalid');
  const file = join(casesDir, id, 'case.json');
  if (!await exists(file)) fail(`No such case: ${id}`, 'case_invalid');
  const value = await readJSON(file);
  if (value.status === 'retired') fail(`Case ${id} is already retired`, 'case_invalid');
  await writeJSON(file, { ...value, status: 'retired', superseded_by: by, retired_at: new Date().toISOString(), retired_reason: reason });
}

function outputsFrom(checkpoint) {
  return Object.fromEntries(Object.entries(checkpoint?.root ?? {}).filter(([key]) => !reservedRoots.has(key)));
}
/** Replay one case against a Method file `runs` times. */
export async function testCase(methodFile, config, testCaseValue, runOptions = {}) {
  const recording = await readJSON(join(testCaseValue.dir, 'recording.json'));
  const artifacts = join(testCaseValue.dir, 'artifacts');
  const attempts = [];
  const parent = await mkdtemp(join(tmpdir(), 'method-case-'));
  try {
    for (let n = 0; n < testCaseValue.runs; n++) {
      const runDir = join(parent, `run-${n + 1}`);
      let result;
      try {
        result = await runMethod(methodFile, config, { ...runOptions, runDir, inputs: recording.inputs, state: recording.initial_state,
          replay: { recording, observations: recording.observations ?? {}, artifacts: await exists(artifacts) ? artifacts : undefined } });
      } catch (error) { attempts.push({ status: 'unverifiable', reason: error.message }); continue; }
      if (result.status === 'failed' && result.code === 'unverifiable') { attempts.push({ status: 'unverifiable', reason: result.error }); continue; }
      const checkpoint = await readJSON(join(runDir, 'checkpoint.json')).catch(() => null);
      const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      const replayed = new Set(events.filter(e => e.event === 'step.replayed').map(e => `${e.step}:${e.iteration}`));
      const live = [...new Set(events.filter(e => e.event === 'step.candidate' && !replayed.has(`${e.step}:${e.iteration}`)).map(e => e.step))];
      const outcome = { status: result.status, code: result.code ?? null, result: result.result ?? null, outputs: outputsFrom(checkpoint), effects: result.effects?.effects ?? [] };
      if (result.status === 'failed' && !['effect_contradicted', 'check_failed'].includes(result.code)) outcome.error = result.error;
      const evaluation = await evaluate(testCaseValue.expect, outcome, { caseDir: testCaseValue.dir, config });
      attempts.push({ ...evaluation, run_status: result.status, ...(result.code ? { code: result.code } : {}), live_steps: live });
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
  const passes = attempts.filter(a => a.status === 'pass').length;
  const status = attempts.some(a => a.status === 'unverifiable') ? 'unverifiable' : passes >= testCaseValue.min_pass ? 'pass' : 'fail';
  return { id: testCaseValue.id, status, passes, runs: testCaseValue.runs, min_pass: testCaseValue.min_pass, attempts };
}

/**
 * Test a Method version against its active cases. With a baseline (the version before a change), each case is
 * compared on both versions. A case that fails on both is already failing, not a regression. New cases must fail on
 * the baseline and pass on the candidate.
 */
export async function testSuite(methodFile, config, { casesDir = defaultCasesDir(methodFile), ids, baseline, newIds = [], runOptions = {} } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const all = await listCases(methodFile, casesDir);
  for (const id of [...(ids ?? []), ...newIds]) if (!all.some(c => c.id === id)) fail(`No case ${id} for ${basename(methodFile)}`, 'case_invalid');
  const selected = all.filter(c => c.status === 'active' && (!ids || ids.includes(c.id) || newIds.includes(c.id)));
  const report = [];
  for (const item of selected) {
    const candidate = await testCase(methodFile, config, item, runOptions);
    const before = baseline ? await testCase(baseline, config, item, runOptions) : null;
    let verdict;
    if (newIds.includes(item.id)) verdict = before?.status === 'pass' ? 'not_red' : candidate.status === 'pass' ? 'fixed' : candidate.status === 'unverifiable' ? 'unverifiable' : 'not_fixed';
    else if (candidate.status === 'unverifiable') verdict = 'unverifiable';
    else if (candidate.status === 'pass') verdict = before && before.status !== 'pass' ? 'fixed' : 'pass';
    else verdict = !before ? 'fail' : before.status === 'pass' ? 'regression' : 'already_failing';
    report.push({ id: item.id, verdict, note: item.note, ...(item.retention_until < today ? { expired: item.retention_until } : {}), candidate, ...(before ? { baseline: before } : {}) });
  }
  const blocking = new Set(['fail', 'regression', 'unverifiable', 'not_fixed', 'not_red']);
  const count = verdict => report.filter(r => r.verdict === verdict).length;
  return {
    passed: !report.some(r => blocking.has(r.verdict)),
    method: pathResolve(methodFile), ...(baseline ? { baseline: pathResolve(baseline) } : {}),
    counts: Object.fromEntries(['pass', 'fixed', 'already_failing', 'regression', 'fail', 'unverifiable', 'not_fixed', 'not_red'].map(v => [v, count(v)])),
    retired: all.filter(c => c.status === 'retired').length,
    expired: report.filter(r => r.expired).map(r => r.id),
    cases: report,
  };
}
