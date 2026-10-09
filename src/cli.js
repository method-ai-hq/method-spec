#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import packageInfo from '../package.json' with { type: 'json' };
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { formats } from './schema.js';
import { executable } from './io.js';
import { runMethod, validateMethod, methodIssues, methodSchema, configSchema, readDocument, observeRun, pendingRuns, createCase, retireCase, listCases, testSuite } from './index.js';
/** The contributor harness's own settings: local scripts with node and python3 from PATH. */
async function localConfig() {
  const runtimes = { node: { command: process.execPath, version: process.version } };
  try {
    const command = await executable('python3');
    runtimes.python = { command, version: execFileSync(command, ['--version'], { encoding: 'utf8' }).trim() };
  } catch {}
  return { allow_local_processes: true, runtimes };
}
const help = `Method — local executor

node src/cli.js validate METHOD
node src/cli.js run METHOD [--inputs JSON] [--state JSON] [--run-dir DIR]
node src/cli.js schema [method|config]
node src/cli.js observe RUN_DIR... [--pending ROOT]
node src/cli.js test METHOD [--case ID]... [--baseline OLD_METHOD] [--new ID]... [--cases DIR]
node src/cli.js case new METHOD --id ID --note TEXT [--run BAD_RUN] [--passing-run GOOD_RUN] [--rubric SENTENCE]... [--ref outputs.NAME] [--context REF]... [--expect FILE] [--observations FILE] [--redact FILE] [--runs N] [--min-pass N] [--supersedes ID]... [--author TEXT]
node src/cli.js case retire METHOD ID --reason TEXT [--by ID]
node src/cli.js case list METHOD

Resume: --run-dir DIR --resume [--retry STEP:ITERATION] [--human JSON].
Exit codes: 0 completed, 1 failed, 2 needs input, 3 unconfirmed (an external change could not be confirmed).
observe runs the observations that are due for finished runs with open effects. It never repeats an action.
test replays recorded cases: unchanged steps return their recorded outputs, changed steps run, and a changed step that acts on an external system makes the case unverifiable.
run never retries a failed action. This harness reads no configuration file: it runs local scripts with node and python3 from PATH,
hosted models need the SDK, and --agent codex or --agent claude chooses the local agent. Programs pass RuntimeConfig to runMethod.
Use --version for the runtime version. Documentation: spec/method-3.md
`;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    agent: { type: 'string' }, help: { type: 'boolean' }, version: { type: 'boolean' }, inputs: { type: 'string' }, state: { type: 'string' }, resume: { type: 'boolean' }, retry: { type: 'string', multiple: true }, human: { type: 'string' },
    'run-dir': { type: 'string' },
    pending: { type: 'string', multiple: true }, case: { type: 'string', multiple: true }, baseline: { type: 'string' }, new: { type: 'string', multiple: true }, cases: { type: 'string' },
    run: { type: 'string' }, id: { type: 'string' }, note: { type: 'string' }, expect: { type: 'string' }, observations: { type: 'string' }, redact: { type: 'string' },
    runs: { type: 'string' }, 'min-pass': { type: 'string' }, rubric: { type: 'string', multiple: true }, ref: { type: 'string' }, context: { type: 'string', multiple: true }, 'passing-run': { type: 'string' }, supersedes: { type: 'string', multiple: true }, author: { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' },
  } });
  const [command, file, ...extra] = positionals;
  if (extra.length && !['observe', 'case'].includes(command)) throw new Error('Unexpected positional arguments');
  const json = async path => path ? JSON.parse(await readFile(path, 'utf8')) : undefined;
  if (values.version) console.log(`${packageInfo.version} (${formats.join(', ')})`);
  else if (values.help || !command) console.log(help);
  else if (command === 'schema') {
    if (file && !['method', 'config'].includes(file)) throw new Error('Use schema method or schema config');
    console.log(JSON.stringify(file === 'config' ? configSchema : methodSchema, null, 2));
  } else if (command === 'validate') {
    if (!file) throw new Error('Supply a Method file');
    const issues = methodIssues(await readFile(file, 'utf8'));
    const valid = !issues.some(issue => issue.level === 'error');
    console.log(JSON.stringify({ valid, ...(valid ? { order: validateMethod(await readDocument(file)).order } : {}), issues, note: 'Runtime profiles and files are checked again before execution.' }, null, 2));
    if (!valid) process.exitCode = 1;
  } else if (command === 'observe') {
    const dirs = [...(file ? [file, ...extra] : [])];
    for (const root of values.pending ?? []) dirs.push(...await pendingRuns(root));
    if (!dirs.length && !values.pending) throw new Error('Supply run directories or --pending ROOT');
    const results = [];
    for (const dir of dirs) {
      try { results.push(await observeRun(dir)); }
      catch (error) { results.push({ run_dir: resolve(dir), error: error.message, code: error.code ?? 'observe_failed' }); }
    }
    console.log(JSON.stringify({ runs: results.map(({ run_dir, status, changed, observed, error, code, effects }) => ({ run_dir, status, changed, observed: observed?.map(e => ({ effect: e.effect, verdict: e.verdict, reason: e.reason })), next_observation_at: effects?.next_observation_at ?? null, ...(error ? { error, code } : {}) })) }, null, 2));
    if (results.some(r => r.error)) process.exitCode = 1;
  } else if (command === 'test') {
    if (!file) throw new Error('Supply a Method file');
    const report = await testSuite(file, await localConfig(), { casesDir: values.cases, ids: values.case, baseline: values.baseline, newIds: values.new ?? [], runOptions: { agent: values.agent } });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } else if (command === 'case') {
    const [action, target, id] = [file, ...extra];
    if (!target) throw new Error('Use case new|retire|list METHOD');
    if (action === 'new') {
      const integer = (value, name) => { if (value === undefined) return undefined; const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer`); return n; };
      const created = await createCase({ methodFile: target, runDir: values.run, passingRun: values['passing-run'], rubric: values.rubric ?? [], ref: values.ref, context: values.context ?? [], id: values.id, note: values.note, author: values.author, expect: (await json(values.expect)) ?? [],
        observations: await json(values.observations), redact: await json(values.redact), runs: integer(values.runs, '--runs'), minPass: integer(values['min-pass'], '--min-pass'),
        supersedes: values.supersedes ?? [], casesDir: values.cases, config: await localConfig() });
      console.log(JSON.stringify(created, null, 2));
    } else if (action === 'retire') {
      await retireCase(target, id, { by: values.by, reason: values.reason, casesDir: values.cases });
      console.log(JSON.stringify({ retired: id }));
    } else if (action === 'list') {
      console.log(JSON.stringify((await listCases(target, values.cases)).map(({ id, status, note, created, superseded_by, retention_until }) => ({ id, status, note, created, superseded_by, retention_until })), null, 2));
    } else throw new Error('Use case new|retire|list METHOD');
  } else if (command === 'run') {
    if (!file) throw new Error('Supply a Method file');
    const config = await localConfig();
    const controller = new AbortController();
    const stop = () => controller.abort(Object.assign(new Error('Interrupted by operator'), { code: 'interrupted' }));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const result = await runMethod(file, config, {
      agent: values.agent, inputs: await json(values.inputs), state: await json(values.state), runDir: values['run-dir'], resume: values.resume, retry: values.retry, human: await json(values.human), signal: controller.signal,
    });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    console.log(JSON.stringify({ status: result.status, code: result.code, run_dir: result.run_dir, elapsed_ms: result.elapsed_ms, model_requests: result.model_requests, ...(result.effects ? { effects: { pending: result.effects.pending, confirmed: result.effects.confirmed, unrefuted: result.effects.unrefuted, contradicted: result.effects.contradicted, unknown: result.effects.unknown, next_observation_at: result.effects.next_observation_at } } : {}) }));
    process.exitCode = { completed: 0, needs_input: 2, unconfirmed: 3 }[result.status] ?? 1;
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
