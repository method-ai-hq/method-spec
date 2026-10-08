import { readFile, readdir, mkdir, mkdtemp, rm, writeFile, stat, cp } from 'node:fs/promises';
import { resolve as pathResolve, dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { recordRun, stepKey } from './replay.js';
import { runMethod } from './runner.js';
import { copyForkFiles } from './fork.js';
import { configuration } from './defaults.js';
import { fail, own, safeData, validateMethod, effectiveOutputs } from './validate.js';
import { executable, executeProcess, hash, writeJSON, containedFile, readDocument } from './io.js';
import { readLedger, effectSummary } from './effects.js';
import { judgeRubric, chooseJudges, valueText } from './rubric.js';

const caseId = /^[a-z0-9][a-z0-9-]{0,79}$/;
const reservedRoots = new Set(['inputs', 'state', 'environment', 'run']);
export const defaultCasesDir = methodFile => pathResolve(dirname(pathResolve(methodFile)), 'cases');

async function readJSON(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }

/**
 * Cases recorded from runs of this Method file.
 * @param {string} methodFile
 * @param {string | undefined} [casesDir]
 * @returns {Promise<any[]>}
 */
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
  if (!Array.isArray(expect) || !expect.length) fail('A case needs at least one expectation (for example --rubric "sentence")', 'case_invalid');
  for (const item of expect) {
    if (item.kind === 'status') { if (!Array.isArray(item.in) || !item.in.length) fail('A status expectation lists the allowed statuses in "in"', 'case_invalid'); }
    else if (item.kind === 'equals') { if (typeof item.ref !== 'string' || !own(item, 'value')) fail('An equals expectation needs ref and value', 'case_invalid'); }
    else if (item.kind === 'effect') { if (typeof item.effect !== 'string' || !Array.isArray(item.verdict)) fail('An effect expectation needs effect and a verdict list', 'case_invalid'); }
    else if (item.kind === 'predicate') { if (typeof item.runtime !== 'string' || typeof item.entrypoint !== 'string') fail('A predicate expectation needs runtime and entrypoint', 'case_invalid'); }
    else if (item.kind === 'rubric') {
      if (typeof item.ref !== 'string') fail('A rubric expectation needs ref, the output to judge, such as outputs.report', 'case_invalid');
      if (!Array.isArray(item.criteria) || !item.criteria.length || item.criteria.some(c => typeof c?.text !== 'string' || !c.text.trim() || typeof c.id !== 'string')) fail('A rubric lists criteria as plain sentences', 'case_invalid');
      if (item.context !== undefined && (!Array.isArray(item.context) || item.context.some(ref => typeof ref !== 'string'))) fail('Rubric context lists references, such as outputs.material or inputs.notes', 'case_invalid');
    } else fail(`Unknown expectation kind: ${item.kind}`, 'case_invalid');
  }
}
/** Turn plain sentences into rubric criteria with stable IDs. */
export const rubricCriteria = sentences => sentences.map((text, i) => typeof text === 'string' ? { id: `c${i + 1}`, text } : text);

const lookup = (root, ref) => {
  let value = root;
  for (const key of ref.split('.')) { if (!own(value, key)) return { missing: true }; value = value[key]; }
  return { value };
};
/**
 * A file is judged by its contents as the run wrote them: a declared file output from the run's artifacts, or a
 * path inside a files connection from the copy that the runtime kept when it observed the folder.
 */
async function judgedValue(value, outcome) {
  if (value && typeof value === 'object' && typeof value.path === 'string' && typeof value.sha256 === 'string' && outcome.artifacts) {
    try { return await readFile(await containedFile(outcome.artifacts, value.path), 'utf8'); } catch { return value; }
  }
  if (typeof value === 'string' && outcome.files) {
    const copy = outcome.files[pathResolve(value)];
    if (copy) { try { return await readFile(copy, 'utf8'); } catch { /* judge the text itself */ } }
  }
  return value;
}
/**
 * Evaluate the expectations against one outcome. A missing value or an effect that was not replayed makes the
 * result unverifiable: the case cannot say whether the version is right.
 */
export async function evaluate(expect, outcome, { caseDir, config, options = {} }) {
  const results = [];
  for (const item of expect) {
    let status, reason, detail;
    if (item.kind === 'status') { status = item.in.includes(outcome.status) ? 'pass' : 'fail'; reason = `run status ${outcome.status}`; }
    else if (item.kind === 'equals' || item.kind === 'rubric') {
      const found = lookup(outcome, item.ref);
      if (found.missing || found.value === null) { status = outcome.status === 'failed' ? 'fail' : 'unverifiable'; reason = `${item.ref} is missing${outcome.error ? ` (the run ${outcome.status}: ${outcome.error})` : ''}`; }
      else if (item.kind === 'equals') { status = isDeepStrictEqual(found.value, item.value) ? 'pass' : 'fail'; reason = `${item.ref} = ${JSON.stringify(found.value)}`; }
      else {
        // Context values (sources, the person's words) are read by the judge but not judged.
        const context = item.context?.length ? Object.fromEntries(await Promise.all(item.context.map(async ref => { const c = lookup(outcome, ref); return [ref, c.missing ? null : await judgedValue(c.value, outcome)]; }))) : undefined;
        detail = await judgeRubric({ value: await judgedValue(found.value, outcome), criteria: item.criteria, context, judges: item.judges ?? {}, config, options });
        status = detail.status;
        reason = detail.criteria.filter(c => !c.pass).map(c => `${c.text} — ${c.reason}`).join('; ') || `all ${detail.criteria.length} criteria pass`;
      }
    } else if (item.kind === 'effect') {
      const effect = outcome.effects.find(e => e.effect === item.effect);
      if (!effect) { status = outcome.status === 'failed' ? 'fail' : 'unverifiable'; reason = `effect ${item.effect} was not observed`; }
      else if (effect.verdict === 'not_replayed') { status = 'unverifiable'; reason = `the case has no observations for ${item.effect}`; }
      else { status = item.verdict.includes(effect.verdict) ? 'pass' : 'fail'; reason = `${item.effect} ${effect.verdict}`; }
    } else {
      const profile = configuration(config).runtimes?.[item.runtime];
      if (!profile) fail(`Unknown runtime for predicate: ${item.runtime}`, 'preflight');
      try {
        const { artifacts, files, ...visible } = outcome;
        const result = await executeProcess({ command: await executable(profile.command), args: [...(profile.args ?? []), await containedFile(caseDir, item.entrypoint)], cwd: caseDir,
          input: visible, env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' }, signal: AbortSignal.timeout(60_000), maxBytes: 1_000_000 });
        const value = JSON.parse(result.output);
        status = value.pass === true ? 'pass' : 'fail'; reason = String(value.reason ?? '');
      } catch (error) { status = 'fail'; reason = `predicate failed: ${error.message}`; }
    }
    results.push({ ...(item.text ? { text: item.text } : {}), kind: item.kind, status, reason, ...(detail ? { criteria: detail.criteria } : {}) });
  }
  const status = results.some(r => r.status === 'fail') ? 'fail' : results.some(r => r.status === 'unverifiable') ? 'unverifiable' : 'pass';
  return { status, results };
}

const outputsFrom = checkpoint => Object.fromEntries(Object.entries(checkpoint?.root ?? {}).filter(([key]) => !reservedRoots.has(key)));
/** What a finished run produced, as a case sees it. */
export async function outcomeOfRun(runDir) {
  const summary = await readJSON(join(runDir, 'summary.json'));
  const checkpoint = await readJSON(join(runDir, 'checkpoint.json')).catch(() => null);
  const result = await readJSON(join(runDir, 'result.json')).catch(() => null);
  const ledger = await readLedger(runDir);
  // Paths in files connections map to the copies that the runtime kept for this run.
  const files = {};
  for (const entry of ledger.filter(e => e.automatic && e.copies)) for (const [path, copy] of Object.entries(entry.copies)) files[path === '.' ? entry.root : join(entry.root, path)] = join(runDir, copy);
  return { status: summary.status, code: summary.code ?? null, ...(summary.error ? { error: summary.error } : {}), result, inputs: checkpoint?.root?.inputs ?? {},
    outputs: outputsFrom(checkpoint), effects: ledger.length ? effectSummary(ledger).effects : [], artifacts: join(runDir, 'artifacts'), files };
}

/**
 * Record a case from a run that went wrong. The case must fail on that run: otherwise it does not capture the
 * problem, or the note does not match the run. With a passing run (the output the person accepted after the fix),
 * the case must pass on it. A case from a passing run alone pins behaviour that is already right. A rubric's judge
 * is calibrated on the runs it has.
 * @param {{methodFile: string, runDir?: string | undefined, id: string, note: string, author?: string | null | undefined, expect?: any[] | undefined, rubric?: string[] | undefined,
 *   ref?: string | undefined, context?: string[] | undefined, passingRun?: string | undefined, observations?: Record<string, any[]> | undefined, redact?: Record<string, string> | undefined,
 *   runs?: number | undefined, minPass?: number | undefined, retentionDays?: number | undefined, supersedes?: string[] | undefined, casesDir?: string | undefined,
 *   config?: any, options?: any}} input
 */
export async function createCase({ methodFile, runDir, id, note, author, expect = [], rubric = [], ref, context = [], passingRun, observations = {}, redact, runs = 1, minPass, retentionDays = 365, supersedes = [], casesDir = defaultCasesDir(methodFile), config = {}, options = {} }) {
  if (!caseId.test(id ?? '')) fail('Case IDs use lowercase letters, digits and hyphens', 'case_invalid');
  if (typeof note !== 'string' || !note.trim()) fail('A case records the correction note: --note "the person\'s words"', 'case_invalid');
  if (!runDir && !passingRun) fail('Give the run that went wrong (--run), the run that was right (--passing-run), or both', 'case_invalid');
  for (const dir of [runDir, passingRun].filter(Boolean)) if (pathResolve(dir).split(/[\\/]/).includes('sensitive')) fail('Do not build cases from runs under sensitive/. Use a redacted run.', 'case_invalid');
  const method = await readDocument(methodFile);
  if (rubric.length) {
    ref ??= typeof method.result === 'string' ? `outputs.${method.result.split('.')[0]}` : undefined;
    if (!ref) fail('Name the output to judge with --ref outputs.NAME; the Method result has several values', 'case_invalid');
    expect = [...expect, { kind: 'rubric', ref, criteria: rubricCriteria(rubric), ...(context.length ? { context } : {}) }];
  }
  validateExpectations(expect);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) fail('runs must be between 1 and 20', 'case_invalid');
  minPass ??= runs;
  if (!Number.isSafeInteger(minPass) || minPass < 1 || minPass > runs) fail('min_pass must be between 1 and runs', 'case_invalid');
  const dir = join(casesDir, id);
  if (await exists(dir)) fail(`Case already exists: ${id}`, 'case_exists');
  safeData(observations);
  const recorded = await recordRun(runDir ?? passingRun);
  const recording = applyRedaction({ ...recorded, observations: { ...recorded.observations, ...observations } }, redact);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    for (const item of expect) if (item.kind === 'predicate' && !await exists(join(dir, item.entrypoint))) {
      const source = pathResolve(dirname(pathResolve(methodFile)), item.entrypoint);
      await writeFile(join(dir, item.entrypoint), await readFile(source), { mode: 0o600 });
    }
    const plain = expect.filter(item => item.kind !== 'rubric');
    // A vacuous expectation passes even when the Method returns nothing.
    if (plain.length && (await evaluate(plain, { status: 'completed', code: null, result: null, outputs: {}, effects: [] }, { caseDir: dir, config, options })).status === 'pass') fail('The expectation passes on an empty result, so it cannot detect the error. Make it specific.', 'case_vacuous');
    const bad = runDir ? await evaluate(expect, await outcomeOfRun(runDir), { caseDir: dir, config, options }) : null;
    if (bad?.status === 'pass') fail('The run that went wrong already meets this case, so the case does not capture the problem. Make the rule more specific, or check that the note matches what this run did.', 'case_not_red');
    if (bad?.status === 'unverifiable') fail(`The case cannot be checked on the run that went wrong: ${bad.results.map(r => r.reason).join('; ')}`, 'case_invalid');
    const examples = [];
    const rubricResult = bad?.results.find(r => r.kind === 'rubric');
    if (rubricResult) {
      const item = expect.find(e => e.kind === 'rubric');
      examples.push({ run: 'failing', labels: Object.fromEntries(rubricResult.criteria.map(c => [c.id, c.pass])), value: valueText(lookup(await outcomeOfRun(runDir), item.ref).value) });
    }
    let good = null;
    if (passingRun) {
      good = await evaluate(expect, await outcomeOfRun(passingRun), { caseDir: dir, config, options });
      if (good.status !== 'pass') fail(`The passing run does not meet this case: ${good.results.filter(r => r.status !== 'pass').map(r => r.reason).join('; ')}`, 'case_not_green');
      const item = expect.find(e => e.kind === 'rubric');
      if (item) examples.push({ run: 'passing', labels: Object.fromEntries(item.criteria.map(c => [c.id, true])), value: valueText(lookup(await outcomeOfRun(passingRun), item.ref).value) });
    }
    // The fast judge is used for a criterion only when it agrees with these examples.
    for (const item of expect.filter(e => e.kind === 'rubric')) {
      const judges = await chooseJudges({ criteria: item.criteria, examples, config, options });
      if (Object.keys(judges).length) item.judges = judges;
    }
    // Keep the files that the source run wrote, so a replayed step's path is judged by what it wrote then.
    const source = await outcomeOfRun(runDir ?? passingRun);
    const keptFiles = {};
    for (const [path, copy] of Object.entries(source.files)) {
      const name = `files/${Object.keys(keptFiles).length}`;
      await mkdir(join(dir, 'files'), { recursive: true, mode: 0o700 });
      await cp(copy, join(dir, name));
      keptFiles[path] = name;
    }
    const accepted = Object.fromEntries(Object.entries(recorded.iterations).map(([step, list]) => [step, list.filter(Boolean).map(entry => entry.candidate)]));
    await mkdir(join(dir, 'artifacts'), { recursive: true, mode: 0o700 });
    await copyForkFiles({ dir: runDir ?? passingRun }, recorded.method, accepted, join(dir, 'artifacts'));
    const created = new Date();
    const value = {
      format: 'method-case/1', id, status: 'active', method_file: basename(methodFile), note: applyRedaction(note, redact), author: author ?? null,
      created: created.toISOString(), source: { run_dir: pathResolve(runDir ?? passingRun), execution_id: recorded.execution_id, method_sha256: recorded.method_sha256, ...(passingRun ? { passing_run_dir: pathResolve(passingRun) } : {}) },
      expect, runs, min_pass: minPass, supersedes, superseded_by: null, ...(Object.keys(keptFiles).length ? { files: keptFiles } : {}),
      retention_until: new Date(created.getTime() + retentionDays * 86_400_000).toISOString().slice(0, 10), redacted: !!(redact && Object.keys(redact).length),
    };
    await writeJSON(join(dir, 'recording.json'), recording);
    if (examples.length) await writeJSON(join(dir, 'examples.json'), applyRedaction(examples, redact));
    await writeJSON(join(dir, 'case.json'), value);
    for (const old of supersedes) await retireCase(methodFile, old, { by: id, reason: `Superseded by ${id}: ${value.note}`, casesDir });
    return { ...value, dir, ...(bad ? { on_failing_run: bad.results } : {}), ...(good ? { on_passing_run: good.results } : {}) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

/**
 * Retire a case whose rule is obsolete. The case stays on disk with its reason, so the history is kept.
 * @param {string} methodFile
 * @param {string} id
 * @param {{by?: string | null | undefined, reason: string, casesDir?: string | undefined}} options
 */
export async function retireCase(methodFile, id, { by = null, reason, casesDir = defaultCasesDir(methodFile) }) {
  if (typeof reason !== 'string' || !reason.trim()) fail('Give the reason the case no longer applies', 'case_invalid');
  const file = join(casesDir, id, 'case.json');
  if (!await exists(file)) fail(`No such case: ${id}`, 'case_invalid');
  const value = await readJSON(file);
  if (value.status === 'retired') fail(`Case ${id} is already retired`, 'case_invalid');
  await writeJSON(file, { ...value, status: 'retired', superseded_by: by, retired_at: new Date().toISOString(), retired_reason: reason });
}

/** The steps that the case's expectations need, or null when the whole Method must run. */
function neededSteps(method, expect) {
  const producers = {};
  for (const [id, step] of Object.entries(method.steps)) for (const name of Object.keys(effectiveOutputs(step))) producers[name] = id;
  const roots = [];
  for (const item of expect) {
    if (!['equals', 'rubric'].includes(item.kind)) return null;
    for (const ref of [item.ref, ...(item.context ?? [])]) {
      if (ref.startsWith('inputs.')) continue;
      if (!ref.startsWith('outputs.')) return null;
      const producer = producers[ref.split('.')[1]];
      if (!producer) return null;
      roots.push(producer);
    }
  }
  const { dependencies } = validateMethod(method);
  const needed = new Set();
  const add = id => { if (needed.has(id)) return; needed.add(id); for (const dep of dependencies[id] ?? []) add(dep); };
  roots.forEach(add);
  return [...needed];
}

/**
 * Replay one case against a Method file. Files connections are bound to fresh scratch folders, so a changed step
 * that writes files can run safely. Only the steps the expectations need run. A strict case stops at its first
 * failed run.
 * @param {string} methodFile
 * @param {any} config
 * @param {any} testCaseValue
 * @param {any} [runOptions]
 */
export async function testCase(methodFile, config, testCaseValue, runOptions = {}) {
  const started = performance.now();
  const recording = await readJSON(join(testCaseValue.dir, 'recording.json'));
  const artifacts = join(testCaseValue.dir, 'artifacts');
  const method = await readDocument(methodFile);
  const only = neededSteps(method, testCaseValue.expect);
  const attempts = [];
  // Folders that a step writes become scratch copies; folders that are only read stay as they are.
  const written = new Set(Object.values(method.steps).flatMap(step => (step.changes ?? []).filter(x => x.startsWith('environment.')).map(x => x.slice(12)))
    .filter(name => method.environment?.[name]?.type === 'files'));
  const parent = await mkdtemp(join(tmpdir(), 'method-case-'));
  try {
    for (let n = 0; n < testCaseValue.runs; n++) {
      const runDir = join(parent, `run-${n + 1}`);
      const environment = { ...config.environment }, paths = {};
      for (const name of written) {
        const real = pathResolve(config.environment?.[name] ?? '.'), scratch = join(parent, `scratch-${n + 1}`, name);
        if (await scratchCopy(real, scratch)) { environment[name] = scratch; paths[scratch] = recording.environment?.[name] ?? config.environment?.[name]; }
        else { attempts.push({ status: 'unverifiable', reason: `${name} is too large to copy for a safe replay (more than ${scratchLimit.files} files or ${scratchLimit.bytes / 1e6} MB).` }); break; }
      }
      if (attempts.at(-1)?.status === 'unverifiable') break;
      let result;
      try {
        result = await runMethod(methodFile, { ...config, environment }, { ...runOptions, runDir, inputs: recording.inputs, state: recording.initial_state,
          replay: { recording, paths, observations: recording.observations ?? {}, artifacts: await exists(artifacts) ? artifacts : undefined, ...(only ? { only } : {}) } });
      } catch (error) { attempts.push({ status: 'unverifiable', reason: error.message }); break; }
      if (result.status === 'failed' && result.code === 'unverifiable') { attempts.push({ status: 'unverifiable', reason: result.error }); break; }
      const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      const replayed = new Set(events.filter(e => e.event === 'step.replayed').map(e => `${e.step}:${e.iteration}`));
      const live = [...new Set(events.filter(e => e.event === 'step.candidate' && !replayed.has(`${e.step}:${e.iteration}`)).map(e => e.step))];
      const outcome = await outcomeOfRun(runDir);
      // A replayed step's path refers to the source run's file; the case kept a copy of it.
      for (const [path, name] of Object.entries(testCaseValue.files ?? {})) outcome.files[path] ??= join(testCaseValue.dir, name);
      const evaluation = await evaluate(testCaseValue.expect, outcome, { caseDir: testCaseValue.dir, config, options: { runOptions, classification: runOptions.classification, cacheDir: runOptions.cacheDir } });
      attempts.push({ ...evaluation, run_status: result.status, ...(result.code ? { code: result.code } : {}), ...(result.status === 'failed' ? { error: result.error } : {}), live_steps: live });
      const passes = attempts.filter(a => a.status === 'pass').length, failures = attempts.length - passes;
      // Stop as soon as the result is decided.
      if (passes >= testCaseValue.min_pass || failures > testCaseValue.runs - testCaseValue.min_pass) break;
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
  const passes = attempts.filter(a => a.status === 'pass').length;
  const status = attempts.some(a => a.status === 'unverifiable') ? 'unverifiable' : passes >= testCaseValue.min_pass ? 'pass' : 'fail';
  return { id: testCaseValue.id, status, passes, runs: attempts.length, min_pass: testCaseValue.min_pass, attempts, duration_ms: Math.round(performance.now() - started) };
}

const scratchLimit = { files: 5000, bytes: 100_000_000 };
const scratchSkip = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'sensitive', '.method-runs', 'cases']);
/** Copy a folder (or one file) into a scratch location, or return false when it is too large. */
async function scratchCopy(real, scratch) {
  let files = 0, bytes = 0, info;
  try { info = await stat(real); } catch { await mkdir(scratch, { recursive: true }); return true; }
  if (info.isFile()) { await mkdir(dirname(scratch), { recursive: true }); await cp(real, scratch); return true; }
  async function size(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (scratchSkip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await size(path);
      else if (entry.isFile()) { files++; bytes += (await stat(path)).size; if (files > scratchLimit.files || bytes > scratchLimit.bytes) throw Object.assign(Error('large'), { code: 'too_large' }); }
    }
  }
  try { await size(real); } catch (error) { if (error.code === 'too_large') return false; throw error; }
  await cp(real, scratch, { recursive: true, filter: source => !scratchSkip.has(source.split(/[\\/]/).pop()) });
  return true;
}
async function parallel(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i]); }
  }));
  return results;
}
/** Cases whose recorded steps differ from this version run first, because they answer fastest whether a change works. */
async function changedFirst(methodFile, config, cases) {
  const method = await readDocument(methodFile), root = dirname(pathResolve(methodFile));
  const files = {};
  for (const step of Object.values(method.steps)) for (const exec of [step.do, step.check]) if (exec?.kind === 'run') {
    try { files[exec.entrypoint] = hash(await readFile(join(root, exec.entrypoint))); } catch { /* the run reports a missing file */ }
  }
  const keys = Object.fromEntries(Object.entries(method.steps).map(([id, step]) => [id, stepKey(step, { files, profiles: config.models ?? {}, tools: config.tools ?? {} })]));
  const touched = [];
  for (const item of cases) {
    const recorded = (await readJSON(join(item.dir, 'recording.json'))).keys;
    touched.push(Object.entries(keys).some(([id, key]) => recorded[id] !== key) ? 0 : 1);
  }
  return cases.map((item, i) => [touched[i], i, item]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , item]) => item);
}

/**
 * Test a Method version against its active cases. Every active case must pass. With a baseline (the version
 * before a change), each case also runs on the old version, to show what the change fixed or broke. New cases
 * must fail on the baseline and pass on the candidate.
 * @param {string} methodFile
 * @param {any} config
 * @param {{casesDir?: string | undefined, ids?: string[] | undefined, baseline?: string | undefined, newIds?: string[] | undefined, runOptions?: any, concurrency?: number | undefined}} [options]
 */
export async function testSuite(methodFile, config, { casesDir = defaultCasesDir(methodFile), ids, baseline, newIds = [], runOptions = {}, concurrency = 4 } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const all = await listCases(methodFile, casesDir);
  for (const id of [...(ids ?? []), ...newIds]) if (!all.some(c => c.id === id)) fail(`No case ${id} for ${basename(methodFile)}`, 'case_invalid');
  const selected = await changedFirst(methodFile, config, all.filter(c => c.status === 'active' && (!ids || ids.includes(c.id) || newIds.includes(c.id))));
  const report = await parallel(selected, concurrency, async item => {
    const candidate = await testCase(methodFile, config, item, runOptions);
    const before = baseline ? await testCase(baseline, config, item, runOptions) : null;
    let verdict;
    if (newIds.includes(item.id)) verdict = before?.status === 'pass' ? 'not_red' : candidate.status === 'pass' ? 'fixed' : candidate.status === 'unverifiable' ? 'unverifiable' : 'not_fixed';
    else if (candidate.status === 'unverifiable') verdict = 'unverifiable';
    else if (candidate.status === 'pass') verdict = before && before.status !== 'pass' ? 'fixed' : 'pass';
    else verdict = before?.status === 'pass' ? 'regression' : 'fail';
    return { id: item.id, verdict, note: item.note, ...(item.retention_until < today ? { expired: item.retention_until } : {}), duration_ms: candidate.duration_ms, candidate, ...(before ? { baseline: before } : {}) };
  });
  const blocking = new Set(['fail', 'regression', 'unverifiable', 'not_fixed', 'not_red']);
  const count = verdict => report.filter(r => r.verdict === verdict).length;
  return {
    passed: !report.some(r => blocking.has(r.verdict)),
    method: pathResolve(methodFile), ...(baseline ? { baseline: pathResolve(baseline) } : {}),
    counts: Object.fromEntries(['pass', 'fixed', 'regression', 'fail', 'unverifiable', 'not_fixed', 'not_red'].map(v => [v, count(v)])),
    retired: all.filter(c => c.status === 'retired').length,
    expired: report.filter(r => r.expired).map(r => r.id),
    cases: report,
  };
}
