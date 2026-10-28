import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile, stat, cp, realpath } from 'node:fs/promises';
import { resolve as pathResolve, dirname, basename, join, relative, isAbsolute, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { recordRun, stepKeys, rewritePaths, keptFolder } from './replay.js';
import { readLearned } from './learned.js';
import { runMethod } from './runner.js';
import { copyOutputFiles } from './cache.js';
import { configuration } from './defaults.js';
import { fail, own, safeData, validateMethod, effectiveOutputs } from './validate.js';
import { executable, executeProcess, hash, writeJSON, containedFile, readDocument, tempFolder, removeTree } from './io.js';
import { readLedger, effectSummary } from './effects.js';
import { judgeRubric, chooseJudges, findConflicts, valueText } from './rubric.js';

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
    if (typeof from !== 'string' || from.length < 2 || typeof to !== 'string') fail('setup', 'Redaction maps text of two or more characters to replacement text', 'case_invalid');
    text = text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
  }
  return JSON.parse(text);
};

function validateExpectations(expect) {
  if (!Array.isArray(expect) || !expect.length) fail('setup', 'A case needs at least one expectation (for example --rubric "sentence")', 'case_invalid');
  for (const item of expect) {
    if (item.kind === 'status') { if (!Array.isArray(item.in) || !item.in.length) fail('setup', 'A status expectation lists the allowed statuses in "in"', 'case_invalid'); }
    else if (item.kind === 'equals') { if (typeof item.ref !== 'string' || !own(item, 'value')) fail('setup', 'An equals expectation needs ref and value', 'case_invalid'); }
    else if (item.kind === 'effect') { if (typeof item.effect !== 'string' || !Array.isArray(item.verdict)) fail('setup', 'An effect expectation needs effect and a verdict list', 'case_invalid'); }
    else if (item.kind === 'predicate') { if (typeof item.runtime !== 'string' || typeof item.entrypoint !== 'string') fail('setup', 'A predicate expectation needs runtime and entrypoint', 'case_invalid'); }
    else if (item.kind === 'rubric') {
      if (typeof item.ref !== 'string') fail('setup', 'A rubric expectation needs ref, the output to judge, such as outputs.report', 'case_invalid');
      if (!Array.isArray(item.criteria) || !item.criteria.length || item.criteria.some(c => typeof c?.text !== 'string' || !c.text.trim() || typeof c.id !== 'string')) fail('setup', 'A rubric lists criteria as plain sentences', 'case_invalid');
      if (item.context !== undefined && (!Array.isArray(item.context) || item.context.some(ref => typeof ref !== 'string'))) fail('setup', 'Rubric context lists references, such as outputs.material or inputs.notes', 'case_invalid');
    } else fail('setup', `Unknown expectation kind: ${item.kind}`, 'case_invalid');
  }
}
/** Turn plain sentences into rubric criteria with stable IDs. */
export const rubricCriteria = sentences => sentences.map((text, i) => typeof text === 'string' ? { id: `c${i + 1}`, text } : text);

const lookup = (root, ref) => {
  let value = root;
  for (const key of ref.split('.')) { if (!own(value, key)) return { missing: true }; value = value[key]; }
  return { value };
};
const inside = (path, dir) => !!dir && (path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep));
/**
 * The text of a file that the run wrote. A relative path is under the run's artifacts. An absolute path is a file in a
 * files connection (the copy that the runtime kept), a file in a folder that the case copied (the attempt's copy), or a
 * file in the run's own folder.
 */
async function fileValue(outcome, path) {
  const read = async file => { try { return { value: await readFile(file, 'utf8') }; } catch { return null; } };
  if (!isAbsolute(path)) {
    // In a replay, the recorded run's artifacts folder can be remapped to the attempt's copy, where live steps wrote.
    const copied = outcome.source_artifacts ? rewritePaths(join(outcome.source_artifacts, path), outcome.copies) : null;
    if (copied && copied !== join(outcome.source_artifacts, path)) { const found = await read(copied); if (found) return found; }
    try { return await read(await containedFile(outcome.artifacts, path)) ?? { missing: true }; } catch { return { missing: true }; }
  }
  const abs = pathResolve(path), copied = rewritePaths(abs, outcome.copies);
  for (const file of [outcome.files?.[abs], copied !== abs ? copied : null, inside(abs, outcome.run_dir) ? abs : null].filter(Boolean)) {
    const found = await read(file);
    if (found) return found;
  }
  return { missing: true };
}
/**
 * The value that a ref names: result (the whole run result), file:PATH (a file the run wrote), effect:NAME (the
 * arguments of each call of a Method tool, stand-ins included, or the inputs of a declared effect, by key or name), or a
 * dotted path such as outputs.report or inputs.notes.
 */
async function refValue(outcome, ref) {
  if (ref === 'result') return { value: outcome.result };
  if (ref.startsWith('file:')) return fileValue(outcome, ref.slice(5));
  if (ref.startsWith('effect:')) {
    const name = ref.slice(7);
    if ((outcome.tools ?? []).includes(name)) return { value: (outcome.tool_calls ?? []).filter(call => call.tool === name).map(call => call.arguments) };
    const effect = (outcome.effect_inputs ?? []).find(e => e.effect === name) ?? (outcome.effect_inputs ?? []).find(e => e.effect.split('/').at(-1) === name);
    return effect ? { value: effect.inputs } : { missing: true };
  }
  return lookup(outcome, ref);
}
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
      const found = await refValue(outcome, item.ref);
      if (found.missing || found.value === null) { status = outcome.status === 'failed' ? 'fail' : 'unverifiable'; reason = `${item.ref} is missing${outcome.failure ? ` (the run ${outcome.status}: ${outcome.failure.headline})` : ''}`; }
      else if (item.kind === 'equals') { status = isDeepStrictEqual(found.value, item.value) ? 'pass' : 'fail'; reason = `${item.ref} = ${JSON.stringify(found.value)}`; }
      else {
        // Context values (sources, the person's words) are read by the judge but not judged.
        const context = item.context?.length ? Object.fromEntries(await Promise.all(item.context.map(async ref => { const c = await refValue(outcome, ref); return [ref, c.missing ? null : await judgedValue(c.value, outcome)]; }))) : undefined;
        detail = await judgeRubric({ value: item.ref.startsWith('file:') ? found.value : await judgedValue(found.value, outcome), criteria: item.criteria, context, judges: item.judges ?? {}, config, options });
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
      if (!profile) fail('setup', `Unknown runtime for predicate: ${item.runtime}`, 'preflight');
      try {
        const { artifacts, files, copies, run_dir, source_artifacts, ...visible } = outcome;
        const result = await executeProcess({ command: await executable(profile.command), args: [...(profile.args ?? []), await containedFile(caseDir, item.entrypoint)], cwd: caseDir,
          input: { ...visible, files: await writtenFiles(outcome) }, env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' }, signal: AbortSignal.timeout(60_000), maxBytes: 1_000_000 });
        const value = JSON.parse(result.output);
        status = value.pass === true ? 'pass' : 'fail'; reason = String(value.reason ?? '');
      } catch (error) { status = 'fail'; reason = `predicate failed: ${error.message}`; }
    }
    results.push({ ...(item.text ? { text: item.text } : {}), kind: item.kind, status, reason, ...(detail ? { criteria: detail.criteria, judge_calls: detail.judge_calls } : {}) });
  }
  const status = results.some(r => r.status === 'fail') ? 'fail' : results.some(r => r.status === 'unverifiable') ? 'unverifiable' : 'pass';
  return { status, results };
}

/**
 * The files a run wrote, for a check script: the name the run gave each one (a path under its artifacts, or the path in
 * a files connection) mapped to an absolute path that the script can read now (the run's file or the kept copy).
 */
async function writtenFiles(outcome) {
  const found = {};
  async function walk(dir, prefix) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (Object.keys(found).length >= 1000) return;
      const path = join(dir, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) found[name] ??= path;
    }
  }
  // In a replay, live steps wrote in the attempt's copy of the recorded run's artifacts; those files come first.
  for (const [original, copy] of Object.entries(outcome.copies ?? {})) if (outcome.source_artifacts && inside(original, outcome.source_artifacts)) await walk(copy, relative(outcome.source_artifacts, original));
  if (outcome.artifacts) await walk(outcome.artifacts, '');
  for (const [path, copy] of Object.entries(outcome.files ?? {})) found[path] ??= copy;
  return found;
}

const outputsFrom = checkpoint => Object.fromEntries(Object.entries(checkpoint?.root ?? {}).filter(([key]) => !reservedRoots.has(key)));
const readEvents = async runDir => (await readFile(join(runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
/**
 * What a finished run produced, as a case sees it: its status, result, inputs and outputs, effects, the files it wrote
 * (files: path -> kept copy), the calls of its Method tools (tool_calls, with each stand-in of a replay) and the
 * inputs of its declared effects (effect_inputs). A replay passes paths (copy -> original), so the outcome names the
 * paths that the recorded run saw, and copies (original -> copy), so a file ref reads the attempt's copy.
 * @param {string} runDir
 * @param {{paths?: Record<string, string>, copies?: Record<string, string>}} [replay]
 */
export async function outcomeOfRun(runDir, { paths = {}, copies = {} } = {}) {
  const summary = await readJSON(join(runDir, 'summary.json'));
  const checkpoint = await readJSON(join(runDir, 'checkpoint.json')).catch(() => null);
  const result = await readJSON(join(runDir, 'result.json')).catch(() => null);
  const ledger = await readLedger(runDir);
  const events = await readEvents(runDir).catch(() => []);
  const started = events.find(event => event.event === 'run.started');
  // Paths in files connections map to the copies that the runtime kept for this run.
  const files = {};
  for (const entry of ledger.filter(e => e.automatic && e.copies)) for (const [path, copy] of Object.entries(entry.copies)) files[rewritePaths(path === '.' ? entry.root : join(entry.root, path), paths)] = join(runDir, copy);
  const tool_calls = events.filter(e => e.event === 'tool.standin' || (e.event === 'tool.dispatched' && own(e, 'arguments')))
    .map(e => ({ tool: e.tool, step: e.step, iteration: e.iteration, arguments: e.arguments, standin: e.event === 'tool.standin' }));
  const effect_inputs = ledger.filter(e => e.effect && e.inputs !== undefined && !e.automatic).map(e => ({ effect: e.effect, inputs: e.inputs }));
  const seen = rewritePaths({ status: summary.status, failure: summary.failure ?? null, result, inputs: checkpoint?.root?.inputs ?? {}, outputs: outputsFrom(checkpoint),
    effects: ledger.length ? effectSummary(ledger).effects : [], tools: Object.keys({ ...started?.config?.tools, ...started?.method?.tools }),
    tool_calls, effect_inputs: [...new Map(effect_inputs.map(e => [e.effect, e])).values()] }, paths);
  return { ...seen, artifacts: join(runDir, 'artifacts'), run_dir: pathResolve(runDir), files, copies };
}

const sha = data => createHash('sha256').update(data).digest('hex');
/** The sha256 of each file under a folder, by path. */
async function fileHashes(dir) {
  const found = new Map();
  async function walk(folder) {
    let entries = [];
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) try { found.set(path, sha(await readFile(path))); } catch { /* unreadable */ }
    }
  }
  await walk(dir);
  return found;
}
/**
 * What a person would have seen from one attempt: its result, and the text of up to 10 files that it wrote (each up
 * to 20,000 characters), by the path that the run would have used. before: the hash of each file in the attempt's
 * copies before the run; a file with the same content was copied, not written.
 */
// The records that the runtime itself writes in an agent step's folder: not what the step made.
const agentRecord = /^(claude|codex|model|session)\/attempt-[^/]+\/(events\.jsonl|mcp\.json|prompt\.md|result\.json|schema\.json|stderr\.log|transcript\.jsonl|last-message\.txt)$/;
export const isAgentRecord = name => agentRecord.test(name);
async function attemptOutput(outcome, before) {
  const files = {};
  for (const [name, path] of Object.entries(await writtenFiles(outcome))) {
    if (Object.keys(files).length >= 10) break;
    if (isAgentRecord(name)) continue;
    try {
      const text = await readFile(path, 'utf8');
      if (before.get(path) === sha(text)) continue;
      if (!text.includes('\u0000')) files[name] = text.length > 20000 ? `${text.slice(0, 20000)}\n[... ${text.length - 20000} more characters]` : text;
    } catch { /* gone or not text */ }
  }
  return { result: outcome.result ?? null, files };
}

const modelKinds = new Set(['call', 'agent', 'classify', 'session']);
const clip = (text, max) => text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters]` : text;
/** The instructions of the model steps of a recorded run, each with the information that the step received. */
function standingInstructions(recorded) {
  const parts = [];
  for (const [id, step] of Object.entries(recorded.method.steps ?? {})) {
    const exec = step.do;
    if (!modelKinds.has(exec?.kind)) continue;
    const told = exec.kind === 'classify' ? [exec.question, exec.options ? JSON.stringify(exec.options) : ''].filter(Boolean).join('\n') : exec.prompt;
    const received = recorded.iterations[id]?.find(Boolean)?.inputs;
    parts.push([`Step ${id} (${step.name ?? id})`, 'Instructions:', told, ...(received ? ['Information it received:', clip(valueText(received), 40_000)] : [])].join('\n'));
  }
  return parts.join('\n\n---\n\n');
}
/** The rules of a case as plain sentences, for the conflict judge. */
const caseRules = expect => expect.flatMap((item, i) => item.kind === 'rubric' ? item.criteria.map(c => ({ id: c.id, text: c.text }))
  : item.kind === 'equals' ? [{ id: `e${i + 1}`, text: `${item.ref} equals ${JSON.stringify(item.value)}` }] : []);

/** The files connections that some step writes. A replay gives each one a scratch copy of the real folder. */
const writtenConnections = method => new Set(Object.values(method.steps).flatMap(step => (step.changes ?? []).filter(x => x.startsWith('environment.')).map(x => x.slice(12)))
  .filter(name => method.environment?.[name]?.type === 'files'));
const absolutePath = value => typeof value === 'string' && value.length < 4096 && !value.includes('\n') && isAbsolute(value);
/**
 * Copy what a recorded run read into the case: each absolute path to an existing file or folder in the run's inputs and
 * in each step iteration's inputs and outputs (a path inside the run folder to snapshot/run/PATH, another to
 * snapshot/ext/N/NAME), and each read-only files connection (snapshot/env/NAME). A path inside a copied folder uses
 * that copy. A folder that holds the run folder (such as the home or temporary folder) is not copied. Paths past the
 * limits are listed as missing; the paths inside them can still have copies of their own.
 */
async function snapshotRun(recorded, dir) {
  const written = writtenConnections(recorded.method);
  const roots = Object.entries(recorded.method.environment ?? {}).filter(([name, def]) => def.type === 'files' && !written.has(name) && typeof recorded.environment?.[name] === 'string')
    .map(([name]) => ({ original: recorded.environment[name], copy: `snapshot/env/${name}`, kind: 'env' }));
  const values = [recorded.inputs, ...Object.values(recorded.iterations).flatMap(list => list.filter(Boolean).flatMap(entry => [entry.inputs, entry.candidate]))];
  const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const found = [...new Set(values.flatMap(strings).filter(absolutePath).map(path => pathResolve(path)))].sort((a, b) => a.length - b.length);
  const run = recorded.source_run_dir;
  let ext = 0;
  const snapshots = [], missing = [], used = { files: 0, bytes: 0 };
  const copy = async root => {
    // A path that a script made in the run folder: the copy kept as the script left it, else the path as it is now.
    const kept = root.kind === 'run' ? join(keptFolder(run), relative(run, pathResolve(root.original))) : null;
    const source = kept && await exists(kept) ? kept : pathResolve(root.original);
    if (!await exists(source)) return;
    const size = await treeSize(source, { files: scratchLimit.files - used.files, bytes: scratchLimit.bytes - used.bytes });
    if (size) try {
      await mkdir(dirname(join(dir, root.copy)), { recursive: true, mode: 0o700 });
      await cp(source, join(dir, root.copy), { recursive: true, filter: file => file === source || !snapshotSkip.has(basename(file)) });
      used.files += size.files; used.bytes += size.bytes;
      snapshots.push(root);
      return;
    } catch { await removeTree(join(dir, root.copy)); }
    missing.push(root.original);
  };
  for (const root of roots) await copy(root);
  for (const path of found) {
    if ((path !== run && inside(run, path)) || snapshots.some(root => inside(path, pathResolve(root.original)))) continue;
    await copy(inside(path, run) ? { original: path, copy: ['snapshot/run', relative(run, path)].filter(Boolean).join('/'), kind: 'run' } : { original: path, copy: `snapshot/ext/${ext++}/${basename(path)}`, kind: 'ext' });
  }
  return { snapshots, missing };
}

/**
 * Record a case from a run that went wrong. The case must fail on that run: otherwise it does not capture the
 * problem, or the note does not match the run. With a passing run (the output the person accepted after the fix),
 * the case must pass on it. A case from a passing run alone pins behaviour that is already right. A rubric's judge
 * is calibrated on the runs it has. A case that can pass only by breaking an instruction of the Method's model steps is
 * refused, unless the person's answer accepts the conflict.
 * @param {{methodFile: string, runDir?: string | undefined, id: string, note: string, author?: string | null | undefined, expect?: any[] | undefined, rubric?: string[] | undefined,
 *   ref?: string | undefined, context?: string[] | undefined, passingRun?: string | undefined, observations?: Record<string, any[]> | undefined, redact?: Record<string, string> | undefined,
 *   runs?: number | undefined, minPass?: number | undefined, retentionDays?: number | undefined, supersedes?: string[] | undefined, casesDir?: string | undefined,
 *   acceptConflict?: string | undefined, config?: any, options?: any}} input
 */
export async function createCase({ methodFile, runDir, id, note, author, expect = [], rubric = [], ref, context = [], passingRun, observations = {}, redact, runs, minPass, retentionDays = 365, supersedes = [], casesDir = defaultCasesDir(methodFile), acceptConflict, config = {}, options = {} }) {
  if (!caseId.test(id ?? '')) fail('setup', 'Case IDs use lowercase letters, digits and hyphens', 'case_invalid');
  if (typeof note !== 'string' || !note.trim()) fail('setup', 'A case records the correction note: --note "the person\'s words"', 'case_invalid');
  if (!runDir && !passingRun) fail('setup', 'Give the run that went wrong (--run), the run that was right (--passing-run), or both', 'case_invalid');
  const method = await readDocument(methodFile);
  if (rubric.length) {
    ref ??= typeof method.result === 'string' ? `outputs.${method.result.split('.')[0]}` : undefined;
    if (!ref) fail('setup', 'Name the output to judge with --ref outputs.NAME; the Method result has several values', 'case_invalid');
    expect = [...expect, { kind: 'rubric', ref, criteria: rubricCriteria(rubric), ...(context.length ? { context } : {}) }];
  }
  validateExpectations(expect);
  // Without runs, a test decides: one run when only scripts run, three when a model step runs live.
  if (runs !== undefined && (!Number.isSafeInteger(runs) || runs < 1 || runs > 20)) fail('setup', 'runs must be between 1 and 20', 'case_invalid');
  if (minPass !== undefined && (!Number.isSafeInteger(minPass) || minPass < 1 || minPass > (runs ?? 20))) fail('setup', 'min_pass must be between 1 and runs', 'case_invalid');
  const dir = join(casesDir, id);
  if (await exists(dir)) fail('setup', `Case already exists: ${id}`, 'case_exists');
  safeData(observations, 'setup');
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
    if (plain.length && (await evaluate(plain, { status: 'completed', failure: null, result: null, outputs: {}, effects: [] }, { caseDir: dir, config, options })).status === 'pass') fail('method_code', 'The expectation passes on an empty result, so it cannot detect the error. Make it specific.', 'case_vacuous');
    const bad = runDir ? await evaluate(expect, await outcomeOfRun(runDir), { caseDir: dir, config, options }) : null;
    if (bad?.status === 'pass') fail('method_code', 'The run that went wrong already meets this case, so the case does not capture the problem. Make the rule more specific, or check that the note matches what this run did.', 'case_not_red');
    if (bad?.status === 'unverifiable') fail('setup', `The case cannot be checked on the run that went wrong: ${bad.results.map(r => r.reason).join('; ')}`, 'case_invalid');
    const examples = [];
    const rubricResult = bad?.results.find(r => r.kind === 'rubric');
    if (rubricResult) {
      const item = expect.find(e => e.kind === 'rubric');
      examples.push({ run: 'failing', labels: Object.fromEntries(rubricResult.criteria.map(c => [c.id, c.pass])), value: valueText((await refValue(await outcomeOfRun(runDir), item.ref)).value) });
    }
    let good = null;
    if (passingRun) {
      good = await evaluate(expect, await outcomeOfRun(passingRun), { caseDir: dir, config, options });
      if (good.status !== 'pass') fail('method_code', `The passing run does not meet this case: ${good.results.filter(r => r.status !== 'pass').map(r => r.reason).join('; ')}`, 'case_not_green');
      const item = expect.find(e => e.kind === 'rubric');
      if (item) examples.push({ run: 'passing', labels: Object.fromEntries(item.criteria.map(c => [c.id, true])), value: valueText((await refValue(await outcomeOfRun(passingRun), item.ref)).value) });
    }
    // A rule that only an invented detail or a broken instruction can meet would make later versions break that instruction.
    const rules = caseRules(expect);
    const judged = expect.some(item => item.kind === 'rubric') || config.models?.judge;
    const instructions = standingInstructions(recorded);
    const conflicts = rules.length && judged && instructions ? await findConflicts({ rules, note, instructions, config, options }) : [];
    if (conflicts.length && !acceptConflict?.trim()) fail('method_code', `This case can pass only by breaking an instruction of the Method: ${conflicts.map(c => `"${c.text}" breaks "${c.instruction}" (${c.reason})`).join('; ')}. Ask the person which one is right before you save the case. When the case is right, change the instruction first; to keep both, add --accept-conflict with the person's answer.`, 'case_conflicts');
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
    for (const [step, iterations] of Object.entries(accepted)) for (const outputs of iterations) await copyOutputFiles(runDir ?? passingRun, recorded.method.steps[step], outputs, join(dir, 'artifacts'));
    // A copy of everything the run read, so that a replay does not depend on files that move, change or are deleted.
    const { snapshots, missing } = await snapshotRun(recorded, dir);
    const created = new Date();
    const value = {
      format: 'method-case/1', id, status: 'active', method_file: basename(methodFile), note: applyRedaction(note, redact), author: author ?? null,
      created: created.toISOString(), source: { run_dir: pathResolve(runDir ?? passingRun), execution_id: recorded.execution_id, method_sha256: recorded.method_sha256, ...(passingRun ? { passing_run_dir: pathResolve(passingRun) } : {}) },
      expect, runs: runs ?? null, min_pass: minPass ?? null, supersedes, superseded_by: null, ...(conflicts.length ? { accepted_conflicts: { answer: applyRedaction(acceptConflict, redact), conflicts: applyRedaction(conflicts, redact) } } : {}), ...(Object.keys(keptFiles).length ? { files: keptFiles } : {}),
      retention_until: new Date(created.getTime() + retentionDays * 86_400_000).toISOString().slice(0, 10), redacted: !!(redact && Object.keys(redact).length),
      snapshots: applyRedaction(snapshots, redact), snapshot_missing: applyRedaction(missing, redact),
    };
    await writeJSON(join(dir, 'recording.json'), recording);
    if (examples.length) await writeJSON(join(dir, 'examples.json'), applyRedaction(examples, redact));
    await writeJSON(join(dir, 'case.json'), value);
    for (const old of supersedes) await retireCase(methodFile, old, { by: id, reason: `Superseded by ${id}: ${value.note}`, casesDir });
    // A criterion that the bad run already meets does not detect the reported problem.
    const weak = (bad?.results ?? []).flatMap(r => (r.criteria ?? []).filter(c => c.pass).map(c => `"${c.text}" already passes on the run that went wrong, so it does not detect this problem. Make it more specific or remove it.`));
    return { ...value, dir, ...(weak.length ? { warnings: weak } : {}), ...(bad ? { on_failing_run: bad.results } : {}), ...(good ? { on_passing_run: good.results } : {}) };
  } catch (error) { await removeTree(dir); throw error; }
}

/**
 * Retire a case whose rule is obsolete. The case stays on disk with its reason, so the history is kept.
 * @param {string} methodFile
 * @param {string} id
 * @param {{by?: string | null | undefined, reason: string, casesDir?: string | undefined}} options
 */
export async function retireCase(methodFile, id, { by = null, reason, casesDir = defaultCasesDir(methodFile) }) {
  if (typeof reason !== 'string' || !reason.trim()) fail('setup', 'Give the reason the case no longer applies', 'case_invalid');
  const file = join(casesDir, id, 'case.json');
  if (!await exists(file)) fail('setup', `No such case: ${id}`, 'case_invalid');
  const value = await readJSON(file);
  if (value.status === 'retired') fail('setup', `Case ${id} is already retired`, 'case_invalid');
  await writeJSON(file, { ...value, status: 'retired', superseded_by: by, retired_at: new Date().toISOString(), retired_reason: reason });
}

/** The steps that the case's expectations need, and the steps forced to run live, or null when the whole Method must run. */
function neededSteps(method, expect, live = []) {
  const producers = {};
  for (const [id, step] of Object.entries(method.steps)) for (const name of Object.keys(effectiveOutputs(step))) producers[name] = id;
  const roots = [...live];
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
 * Replay one case against a Method file. Each attempt has its own scratch folder: it holds a copy of every snapshot
 * of the case and of each files connection that a step writes, and the recorded paths are rewritten to these copies,
 * so attempts never share a folder and a replay never changes the source run or the real folders. Only the steps the
 * expectations need run. A strict case stops at its first failed run.
 * once: one run decides (runs: 1). runs and minPass replace the case's own. live: steps that run live even when they
 * match the recording; target_live says whether they did. judgeCache: false judges again. keepDir: a folder that
 * keeps each attempt's run folder (attempt.run_dir). judges: a list of judge model profiles that must all pass a
 * rubric criterion; a disagreement fails it as unsure.
 * @param {string} methodFile
 * @param {any} config
 * @param {any} testCaseValue
 * @param {any} [runOptions]
 * @param {{once?: boolean, runs?: number | undefined, minPass?: number | undefined, live?: string[] | undefined, judgeCache?: boolean | undefined, keepDir?: string | undefined, judges?: any[] | undefined}} [check]
 */
export async function testCase(methodFile, config, testCaseValue, runOptions = {}, { once = false, runs, minPass, live = [], judgeCache = true, keepDir, judges } = {}) {
  const started = performance.now();
  const recording = await readJSON(join(testCaseValue.dir, 'recording.json'));
  const artifacts = join(testCaseValue.dir, 'artifacts');
  const method = await readDocument(methodFile);
  for (const id of live) if (!own(method.steps, id)) fail('setup', `No step ${id} to run live`, 'case_invalid');
  const only = neededSteps(method, testCaseValue.expect, live);
  const attempts = [];
  const written = writtenConnections(method);
  const snapshots = testCaseValue.snapshots ?? [];
  if (keepDir) await mkdir(keepDir, { recursive: true, mode: 0o700 });
  // A real path: Claude Code compares its permission rules with resolved paths.
  const parent = keepDir ? await realpath(await mkdtemp(join(pathResolve(keepDir), 'c-'))) : await tempFolder('mc-');
  const fixedRuns = runs ?? (once ? 1 : testCaseValue.runs ?? null);
  const fixedMin = minPass ?? (runs !== undefined ? runs : once ? 1 : testCaseValue.min_pass ?? null);
  let total = fixedRuns ?? 1, needed = fixedMin ?? total;
  if (needed > total) fail('setup', 'min_pass must be between 1 and runs', 'case_invalid');
  try {
    for (let n = 0; n < total; n++) {
      const runDir = join(parent, `run-${n + 1}`), scratch = join(parent, `scratch-${n + 1}`);
      const environment = { ...config.environment }, paths = {}, copies = {};
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      for (const snapshot of snapshots) {
        const copy = join(scratch, snapshot.copy);
        await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
        await cp(join(testCaseValue.dir, snapshot.copy), copy, { recursive: true });
        copies[snapshot.original] = copy; paths[copy] = snapshot.original;
        if (snapshot.kind === 'env') environment[basename(snapshot.copy)] = copy;
      }
      for (const name of written) {
        const real = pathResolve(config.environment?.[name] ?? '.'), copy = join(scratch, 'env', name);
        if (await scratchCopy(real, copy)) { environment[name] = copy; paths[copy] = recording.environment?.[name] ?? config.environment?.[name]; }
        else { attempts.push({ status: 'unverifiable', reason: `${name} is too large to copy for a safe replay (more than ${scratchLimit.files} files or ${scratchLimit.bytes / 1e6} MB).` }); break; }
      }
      if (attempts.at(-1)?.status === 'unverifiable') break;
      let result;
      const before = await fileHashes(scratch);
      try {
        result = await runMethod(methodFile, { ...config, environment }, { ...runOptions, runDir, inputs: rewritePaths(recording.inputs, copies), state: rewritePaths(recording.initial_state, copies),
          replay: { recording, paths, copies, missing: testCaseValue.snapshot_missing ?? [], live, scratch, observations: recording.observations ?? {}, artifacts: await exists(artifacts) ? artifacts : undefined, ...(only ? { only } : {}) } });
      } catch (error) { attempts.push({ status: 'unverifiable', reason: error.message }); break; }
      // A usage limit is not a result of the Method: the test stops with it.
      if (result.status === 'failed' && result.failure?.code === 'usage_limit') fail('limit', result.failure.headline ?? result.failure.details, 'usage_limit');
      const events = await readEvents(runDir);
      const kept = keepDir ? { run_dir: runDir } : {};
      if (result.status === 'failed' && result.failure.code === 'unverifiable') {
        const gone = events.find(e => e.event === 'replay.missing_file');
        attempts.push(gone ? { status: 'unverifiable', reason: 'missing_file', path: gone.path, ...kept } : { status: 'unverifiable', reason: result.failure.details, ...kept });
        break;
      }
      const replayed = new Set(events.filter(e => e.event === 'step.replayed').map(e => `${e.step}:${e.iteration}`));
      const liveSteps = [...new Set(events.filter(e => e.event === 'step.candidate' && !replayed.has(`${e.step}:${e.iteration}`)).map(e => e.step))];
      const standins = events.filter(e => e.event === 'tool.standin').map(e => ({ step: e.step, iteration: e.iteration, tool: e.tool, arguments: rewritePaths(e.arguments, paths) }));
      const outcome = await outcomeOfRun(runDir, { paths, copies });
      // A replayed step's path refers to the source run's file; the case kept a copy of it.
      for (const [path, name] of Object.entries(testCaseValue.files ?? {})) outcome.files[path] ??= join(testCaseValue.dir, name);
      if (testCaseValue.source?.run_dir) outcome.source_artifacts = join(pathResolve(testCaseValue.source.run_dir), 'artifacts');
      const evaluation = await evaluate(testCaseValue.expect, outcome, { caseDir: testCaseValue.dir, config, options: { runOptions, classification: runOptions.classification, cacheDir: runOptions.cacheDir, judgeCache, ...(judges?.length ? { judges } : {}) } });
      const liveModel = liveSteps.filter(id => modelKinds.has(method.steps[id]?.do?.kind));
      attempts.push({ ...evaluation, output: await attemptOutput(outcome, before), run_status: result.status, ...(result.failure ? { failure: { code: result.failure.code, headline: result.failure.headline } } : {}), live_steps: liveSteps, live_model_steps: liveModel,
        ...(live.length ? { target_live: live.every(id => liveSteps.includes(id)) } : {}), standins, judge_calls: evaluation.results.reduce((sum, r) => sum + (r.judge_calls ?? 0), 0), ...kept });
      // A model step that runs live can answer differently each time, so it must pass three runs.
      if (fixedRuns === null && n === 0 && liveModel.length) { total = 3; needed = fixedMin ?? 3; }
      const passes = attempts.filter(a => a.status === 'pass').length, failures = attempts.length - passes;
      // Stop as soon as the result is decided.
      if (passes >= needed || failures > total - needed) break;
    }
  } finally { if (!keepDir) await removeTree(parent); }
  const passes = attempts.filter(a => a.status === 'pass').length;
  const status = attempts.some(a => a.status === 'unverifiable') ? 'unverifiable' : passes >= needed ? 'pass' : 'fail';
  // Passing some runs and failing another means the Method does not follow the rule reliably.
  const unreliable = status === 'fail' && passes > 0;
  return { id: testCaseValue.id, status, passes, runs: attempts.length, min_pass: needed, ...(unreliable ? { unreliable: `passed ${passes} of ${attempts.length} runs: the Method does not follow this rule every time` } : {}),
    ...(live.length ? { target_live: attempts.length > 0 && attempts.every(a => a.target_live === true) } : {}), attempts, duration_ms: Math.round(performance.now() - started) };
}

/** Remove a folder that may hold read-only copies; tests call it. */
export async function _removeTree(path) { return removeTree(path); }

const scratchLimit = { files: 5000, bytes: 100_000_000 };
const scratchSkip = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.method-runs', 'cases']);
const snapshotSkip = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
/** The files and bytes of a file or folder (skipping tools' folders), or null when it is larger than the limit. */
async function treeSize(path, limit, skip = snapshotSkip) {
  let files = 0, bytes = 0;
  const info = await stat(path);
  if (info.isFile()) return info.size <= limit.bytes && limit.files >= 1 ? { files: 1, bytes: info.size } : null;
  // A file that disappears or cannot be read while it is counted is left out.
  const quiet = promise => promise.catch(error => { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null; throw error; });
  async function size(dir) {
    for (const entry of await quiet(readdir(dir, { withFileTypes: true })) ?? []) {
      if (skip.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await size(child);
      else if (entry.isFile()) { files++; bytes += (await quiet(stat(child)))?.size ?? 0; if (files > limit.files || bytes > limit.bytes) throw Object.assign(Error('large'), { code: 'too_large' }); }
    }
  }
  try { await size(path); } catch (error) { if (error.code === 'too_large') return null; throw error; }
  return { files, bytes };
}
/** Copy a folder (or one file) into a scratch location, or return false when it is too large. */
async function scratchCopy(real, scratch) {
  if (!await exists(real)) { await mkdir(scratch, { recursive: true }); return true; }
  if (!await treeSize(real, scratchLimit, scratchSkip)) return false;
  await mkdir(dirname(scratch), { recursive: true });
  await cp(real, scratch, { recursive: true, filter: source => source === real || !scratchSkip.has(basename(source)) });
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
  const tools = { ...config.tools, ...method.tools };
  const files = {};
  const scripts = Object.values(method.steps).flatMap(step => [step.do, step.check]).filter(exec => exec?.kind === 'run').map(exec => exec.entrypoint);
  for (const file of new Set([...scripts, ...Object.values(tools).map(tool => tool.run?.entrypoint).filter(Boolean), ...(method.files ?? [])])) {
    try { files[file] = hash(await readFile(join(root, file))); } catch { /* the run reports a missing file */ }
  }
  const keys = stepKeys(method, { files, profiles: config.models ?? {}, tools, learned: await readLearned(root) });
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
 * must fail on the baseline and pass on the candidate. once, runs, minPass, live, judgeCache, keepDir and judges apply to each
 * case run, on both versions, as in testCase.
 * @param {string} methodFile
 * @param {any} config
 * @param {{casesDir?: string | undefined, ids?: string[] | undefined, baseline?: string | undefined, newIds?: string[] | undefined, runOptions?: any, concurrency?: number | undefined, once?: boolean | undefined,
 *   runs?: number | undefined, minPass?: number | undefined, live?: string[] | undefined, judgeCache?: boolean | undefined, keepDir?: string | undefined, judges?: any[] | undefined}} [options]
 */
export async function testSuite(methodFile, config, { casesDir = defaultCasesDir(methodFile), ids, baseline, newIds = [], runOptions = {}, concurrency = 4, once = false, runs, minPass, live, judgeCache, keepDir, judges } = {}) {
  const check = { once, runs, minPass, live, judgeCache, keepDir, judges };
  const suiteStarted = performance.now();
  const today = new Date().toISOString().slice(0, 10);
  const all = await listCases(methodFile, casesDir);
  for (const id of [...(ids ?? []), ...newIds]) if (!all.some(c => c.id === id)) fail('setup', `No case ${id} for ${basename(methodFile)}`, 'case_invalid');
  const selected = await changedFirst(methodFile, config, all.filter(c => c.status === 'active' && (!ids || ids.includes(c.id) || newIds.includes(c.id))));
  const report = await parallel(selected, concurrency, async item => {
    const candidate = await testCase(methodFile, config, item, runOptions, check);
    const before = baseline ? await testCase(baseline, config, item, runOptions, check) : null;
    let verdict;
    if (newIds.includes(item.id)) verdict = before?.status === 'pass' ? 'not_red' : candidate.status === 'pass' ? 'fixed' : candidate.status === 'unverifiable' ? 'unverifiable' : 'not_fixed';
    else if (candidate.status === 'unverifiable') verdict = 'unverifiable';
    else if (candidate.status === 'pass') verdict = before && before.status !== 'pass' ? 'fixed' : 'pass';
    else verdict = before?.status === 'pass' ? 'regression' : 'fail';
    return { id: item.id, verdict, note: item.note, ...(item.retention_until < today ? { expired: item.retention_until } : {}), duration_ms: candidate.duration_ms, candidate, ...(before ? { baseline: before } : {}) };
  });
  const blocking = new Set(['fail', 'regression', 'unverifiable', 'not_fixed', 'not_red']);
  const count = verdict => report.filter(r => r.verdict === verdict).length;
  const everyAttempt = report.flatMap(r => [r.candidate, r.baseline].filter(Boolean).flatMap(c => c.attempts));
  return {
    passed: !report.some(r => blocking.has(r.verdict)),
    // What the check cost: model steps that ran live and judge calls that were not cached.
    totals: { duration_ms: Math.round(performance.now() - suiteStarted), live_model_steps: everyAttempt.reduce((sum, a) => sum + (a.live_model_steps?.length ?? 0), 0), judge_calls: everyAttempt.reduce((sum, a) => sum + (a.judge_calls ?? 0), 0) },
    method: pathResolve(methodFile), ...(baseline ? { baseline: pathResolve(baseline) } : {}),
    counts: Object.fromEntries(['pass', 'fixed', 'regression', 'fail', 'unverifiable', 'not_fixed', 'not_red'].map(v => [v, count(v)])),
    retired: all.filter(c => c.status === 'retired').length,
    expired: report.filter(r => r.expired).map(r => r.id),
    cases: report,
  };
}
