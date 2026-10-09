#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import packageInfo from '../package.json' with { type: 'json' };
import {dirname,resolve} from 'node:path';
import { runMethod, validateMethod, validateConfig, methodSchema, configSchema, readDocument, observeRun, pendingRuns, createCase, retireCase, listCases, testSuite } from './index.js';
const help = `Method — local executor

node src/cli.js validate METHOD [--config CONFIG]
node src/cli.js run METHOD [--config CONFIG] [--inputs JSON] [--state JSON] [--run-dir DIR]
node src/cli.js schema [method|config]
node src/cli.js observe RUN_DIR... [--pending ROOT] [--config CONFIG]
node src/cli.js test METHOD [--config CONFIG] [--case ID]... [--baseline OLD_METHOD] [--new ID]... [--cases DIR]
node src/cli.js case new METHOD --id ID --note TEXT [--run BAD_RUN] [--passing-run GOOD_RUN] [--rubric SENTENCE]... [--ref outputs.NAME] [--context REF]... [--expect FILE] [--observations FILE] [--redact FILE] [--runs N] [--min-pass N] [--supersedes ID]... [--author TEXT]
node src/cli.js case retire METHOD ID --reason TEXT [--by ID]
node src/cli.js case list METHOD

Resume: --run-dir DIR --resume [--retry STEP:ITERATION] [--human JSON].
Exit codes: 0 completed, 1 failed, 2 needs input, 3 unconfirmed (an external change could not be confirmed).
observe runs the observations that are due for finished runs with open effects. It never repeats an action.
test replays recorded cases: unchanged steps return their recorded outputs, changed steps run, and a changed step that acts on an external system makes the case unverifiable.
run never retries a failed action. Local scripts require allow_local_processes in CONFIG.
A supported local agent needs no config file. Use --agent codex or --agent claude to choose. Custom scripts, tools, and API models need configuration.
Use --version for the runtime version. Documentation: spec/method-3.md
`;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    agent: { type: 'string' }, help: { type: 'boolean' }, version: { type: 'boolean' }, config: { type: 'string' }, inputs: { type: 'string' }, state: { type: 'string' }, resume: { type: 'boolean' }, retry: { type: 'string', multiple: true }, human: { type: 'string' },
    'run-dir': { type: 'string' },
    pending: { type: 'string', multiple: true }, case: { type: 'string', multiple: true }, baseline: { type: 'string' }, new: { type: 'string', multiple: true }, cases: { type: 'string' },
    run: { type: 'string' }, id: { type: 'string' }, note: { type: 'string' }, expect: { type: 'string' }, observations: { type: 'string' }, redact: { type: 'string' },
    runs: { type: 'string' }, 'min-pass': { type: 'string' }, rubric: { type: 'string', multiple: true }, ref: { type: 'string' }, context: { type: 'string', multiple: true }, 'passing-run': { type: 'string' }, supersedes: { type: 'string', multiple: true }, author: { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' },
  } });
  const [command, file, ...extra] = positionals;
  if (extra.length && !['observe', 'case'].includes(command)) throw new Error('Unexpected positional arguments');
  const json = async path => path ? JSON.parse(await readFile(path, 'utf8')) : undefined;
  const optionalConfig = async () => values.config ? validateConfig(await readDocument(values.config)) : undefined;
  const runConfig = async target => {
    try { return await readDocument(values.config ?? resolve(dirname(target), 'runtime.json')); }
    catch (error) { if (values.config || error.code !== 'ENOENT') throw error; return { allow_local_processes: true }; }
  };
  if (values.version) console.log(`${packageInfo.version} (method/3.1, method/3.2, method/3.3)`);
  else if (values.help || !command) console.log(help);
  else if (command === 'schema') {
    if (file && !['method', 'config'].includes(file)) throw new Error('Use schema method or schema config');
    console.log(JSON.stringify(file === 'config' ? configSchema : methodSchema, null, 2));
  } else if (command === 'validate') {
    if (!file) throw new Error('Supply a Method file');
    const { order } = validateMethod(await readDocument(file));
    if (values.config) validateConfig(await readDocument(values.config));
    console.log(JSON.stringify({ valid: true, order, note: 'Runtime profiles and files are checked again before execution.' }));
  } else if (command === 'observe') {
    const dirs = [...(file ? [file, ...extra] : [])];
    for (const root of values.pending ?? []) dirs.push(...await pendingRuns(root));
    if (!dirs.length && !values.pending) throw new Error('Supply run directories or --pending ROOT');
    const config = await optionalConfig();
    const results = [];
    for (const dir of dirs) {
      try { results.push(await observeRun(dir, { config })); }
      catch (error) { results.push({ run_dir: resolve(dir), error: error.message, code: error.code ?? 'observe_failed' }); }
    }
    console.log(JSON.stringify({ runs: results.map(({ run_dir, status, changed, observed, error, code, effects }) => ({ run_dir, status, changed, observed: observed?.map(e => ({ effect: e.effect, verdict: e.verdict, reason: e.reason })), next_observation_at: effects?.next_observation_at ?? null, ...(error ? { error, code } : {}) })) }, null, 2));
    if (results.some(r => r.error)) process.exitCode = 1;
  } else if (command === 'test') {
    if (!file) throw new Error('Supply a Method file');
    const report = await testSuite(file, await runConfig(file), { casesDir: values.cases, ids: values.case, baseline: values.baseline, newIds: values.new ?? [], runOptions: { agent: values.agent } });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } else if (command === 'case') {
    const [action, target, id] = [file, ...extra];
    if (!target) throw new Error('Use case new|retire|list METHOD');
    if (action === 'new') {
      const integer = (value, name) => { if (value === undefined) return undefined; const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer`); return n; };
      const created = await createCase({ methodFile: target, runDir: values.run, passingRun: values['passing-run'], rubric: values.rubric ?? [], ref: values.ref, context: values.context ?? [], id: values.id, note: values.note, author: values.author, expect: (await json(values.expect)) ?? [],
        observations: await json(values.observations), redact: await json(values.redact), runs: integer(values.runs, '--runs'), minPass: integer(values['min-pass'], '--min-pass'),
        supersedes: values.supersedes ?? [], casesDir: values.cases, config: await runConfig(target) });
      console.log(JSON.stringify(created, null, 2));
    } else if (action === 'retire') {
      await retireCase(target, id, { by: values.by, reason: values.reason, casesDir: values.cases });
      console.log(JSON.stringify({ retired: id }));
    } else if (action === 'list') {
      console.log(JSON.stringify((await listCases(target, values.cases)).map(({ id, status, note, created, superseded_by, retention_until }) => ({ id, status, note, created, superseded_by, retention_until })), null, 2));
    } else throw new Error('Use case new|retire|list METHOD');
  } else if (command === 'run') {
    if (!file) throw new Error('Supply a Method file');
    const config = await runConfig(file);
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
