import { hostname } from 'node:os';
import { callerVariables } from './schema.js';
import { executeClassification, typesafeClassification } from './classification.js';
import { effectiveOutputs, modelName } from './semantics.js';
import { executionTools, validateToolResult } from './tool-connections.js';
import { resolveModels, packageModels } from './agents.js';
import { documentForDigest } from './document.js';
import { executorVersion, assertCheckpointExecutor } from './executor-version.js';
import { executeClaude } from './claude.js';
import { configuration } from './defaults.js';
import { mkdir, readFile, appendFile, realpath, open, unlink, cp, copyFile, rm, stat as statFile }  from 'node:fs/promises';
import { resolve as pathResolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateMethod, validateConfig, assertSchema, outputSchema, dataSchema, resolve, own, fail, safeData, shape } from './validate.js';
import { checkResultSchema, object } from './schema.js';
import { readDocument, hash, snapshotBundle, writeJSON, executeProcess, containedFile, tempFolder } from './io.js';
import { executeModel } from './model.js';
import { executeCodex } from './codex.js';
import { executeSession } from './session.js';
import { folderHashes } from './clean-room.js';
import { renderPrompt } from './prompt.js';
import { preflight } from './preflight.js';
import { progressMessage } from './progress.js';
import { cacheable, iterationKey, readCache, copyOutputFiles } from './cache.js';
import { effectKey, connectionsFor, testFixtures, runObserverScript, observeEffect, readLedger, appendLedger, currentEffects, effectSummary, statusWithEffects, waitUntil, nextObservation, horizonAt, previousObservations, listFolder, observeFiles, isBuiltin } from './effects.js';
import { observerConnection } from './semantics.js';
import { replayedCandidate, unverifiable, stepKey, namedPath } from './replay.js';
import { readLearned, activeRules, rulesText, selectionPrompt, selectionSchema } from './learned.js';
import { prepareObservation } from './observed-effects.js';
import { failureRecord } from './failure.js';
import { eventText, placeText, retryNotice, agentNotice, limitNotice } from './event-text.js';
import { transientClass, attempts as retryAttempts } from './retry.js';
import { displayText } from './schema.js';

/** The name of a step's check in text: its reading name, else its script, else its kind. */
const checkLabel = step => step?.reading?.check_name ?? step?.check?.entrypoint ?? (step?.check ? step.check.kind ?? Object.keys(step.check)[0] : 'check');

function initialValues(defs = {}, supplied = {}) {
  const result = {};
  for (const [key, def] of Object.entries(defs)) {
    if (own(supplied, key)) result[key] = supplied[key];
    else if (own(def, 'default')) result[key] = structuredClone(def.default);
    else fail('setup', `Missing required initial value: ${key}`, 'preflight');
  }
  for (const key of Object.keys(supplied)) if (!own(defs, key)) fail('setup', `Unknown initial value: ${key}`, 'preflight');
  safeData(result, 'setup'); assertSchema(outputSchema(defs), result, 'Initial data', { producer: 'the run inputs', owner: 'setup' });
  return result;
}
/** A declared secret comes from the host's secret store, or else the process environment. */
const secretValue = (options, name) => name ? (options.secrets && own(options.secrets, name) ? options.secrets[name] : process.env[name]) : undefined;
const timeoutError = (limit = 'time', value) => Object.assign(new Error('Execution deadline exceeded'), { code: 'timeout', owner: 'limit', limit, value });
function boundedSignal(ms, parent) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(() => controller.abort(timeoutError()), Math.max(1, ms));
  return { signal: controller.signal, abort: reason => controller.abort(reason), close: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

/**
 * @param {string} file
 * @param {import('./api-types.js').RuntimeConfig} config
 * @param {import('./api-types.js').RunOptions} [options]
 * @returns {Promise<import('./api-types.js').RunResult>}
 */
export async function runMethod(file, config, options = {}) {
  try { return await startRun(file, config, options); }
  catch (error) {
    // A run that cannot start has no summary. Its error carries the same failure record, for the caller to show.
    if (error && typeof error === 'object' && !error.failure) error.failure = failureRecord(error, { phase: 'setup' });
    throw error;
  }
}
async function startRun(file, config, options) {
  const runDir = pathResolve(options.runDir ?? pathResolve('.method-runs', randomUUID()));
  if (options.resume && !options.runDir) fail('setup', 'Resume needs an explicit run directory', 'preflight');
  await mkdir(dirname(runDir), { recursive: true, mode: 0o700 });
  if (!options.resume) {
    try { await readFile(pathResolve(runDir, 'checkpoint.json')); fail('setup', 'Run already exists. Use resume.', 'run_exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await mkdir(runDir, { recursive: true, mode: 0o700 });
  }
  const lockPath = pathResolve(runDir, '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch {
    if (!options.resume) fail('setup', 'Run is locked. Use resume after its process stops.', 'run_locked');
    const owner = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(owner) || owner <= 0) fail('setup', 'The run lock has no valid process ID. Inspect the run before removing it.', 'run_locked');
    try { process.kill(owner, 0); fail('setup', 'Run is locked. The process is still active.', 'run_locked'); }
    catch(error) { if(error.code !== 'ESRCH') throw error; }
    await unlink(lockPath);
    lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid));
  try { return await executeRun(file, config, { ...options, runDir }); }
  finally { await lock.close(); await unlink(lockPath); }
}


async function executeRun(file, config, options) {
  const runDir = options.runDir;
  const saved = options.resume ? JSON.parse(await readFile(pathResolve(runDir, 'checkpoint.json'), 'utf8')) : null;
  if (saved) assertCheckpointExecutor(saved);
  const method = await readDocument(file);
  const { order } = validateMethod(method);
  validateConfig(config);
  const suppliedConfig = config;
  config = configuration(config, method);
  const sourceRoot = await realpath(options.sourceRoot ?? dirname(pathResolve(file)));
  if (saved && (saved.method_sha256 !== hash(documentForDigest(method)) || saved.config_sha256 !== hash(suppliedConfig))) fail('setup', 'Method or configuration changed. Resume needs the original version.', 'resume_mismatch');
  if (saved && (options.inputs || options.state)) fail('setup', 'Resume uses saved inputs and state; omit --inputs and --state.', 'resume_mismatch');
  const inputs = saved?.root.inputs ?? initialValues(method.inputs, options.inputs);
  let state = saved?.root.state ?? initialValues(method.state, options.state);
  if (saved && !saved.models) fail('setup', 'The checkpoint is missing its selected model profiles. Resume needs the original run records.', 'resume_mismatch');
  const packaged = await packageModels(method, sourceRoot);
  config.models = await resolveModels(method, config, { ...options, packageModels: packaged, savedModels: saved?.models });
  const profiles = config.models, runtimeProfiles = config.runtimes ?? {}, tools = config.tools ?? {};
  const { runtimeInfo, files } = await preflight(method, config, sourceRoot, { ...options, packageModels: packaged, checkFiles: !saved });
  const bundle = pathResolve(runDir, 'bundle');
  if (!saved) await mkdir(bundle, { mode: 0o700 });
  const artifacts = pathResolve(runDir, 'artifacts');
  if (!saved) await mkdir(artifacts, { mode: 0o700 });
  if (!saved && options.replay?.artifacts) await cp(options.replay.artifacts, artifacts, { recursive: true });
  if (saved && hash(runtimeInfo) !== saved.runtime_sha256) fail('setup', 'Runtime executable changed', 'resume_mismatch');
  let sequence = saved?.sequence ?? 0, invocations = saved?.invocations ?? 0, requests = saved?.requests ?? 0, toolCalls = saved?.toolCalls ?? 0, knownUsage = saved?.knownUsage ?? 0, inputTokens = saved?.inputTokens ?? 0, outputTokens = saved?.outputTokens ?? 0;
  let started = performance.now() - (saved?.elapsed_ms ?? 0), deadline = started + config.limits.timeout_ms;
  let costUsd = saved?.costUsd ?? null;
  let codexProcesses = saved?.codexProcesses ?? 0, codexInputTokens = saved?.codexInputTokens ?? 0, codexOutputTokens = saved?.codexOutputTokens ?? 0, codexUsageReports = saved?.codexUsageReports ?? 0;
  const executionId = saved?.execution_id ?? randomUUID();
  // Which repeat of the same work this run is: repeats are separate runs, so they never reuse each other's steps.
  const repeat = saved?.repeat ?? options.repeat ?? 0;
  if (!Number.isSafeInteger(repeat) || repeat < 0) fail('setup', 'repeat must be a whole number, 0 or more', 'preflight');
  const deviceName = saved?.device_name ?? options.deviceName ?? hostname();
  const startedAt = saved?.started_at ?? new Date().toISOString();
  const root = saved?.root ?? { inputs, state, environment: config.environment ?? {}, run: { started_at: startedAt } };
  const accepted = saved?.accepted ?? {}, skipped = saved?.skipped ?? [];
  const collections = saved?.collections ?? {};
  let active = saved?.active ?? null;
  // Accepted iterations by key, so that a later run can reuse them.
  const keys = saved?.cache ?? {}, reused = saved?.reused ?? {};
  // What each accepted action process was seen to do, so that a reused iteration keeps it.
  const observed = saved?.observed ?? {};
  const cache = options.replay || options.fresh === true ? new Map() : await readCache(options.cacheFrom ?? []);
  const fresh = new Set(Array.isArray(options.fresh) ? options.fresh : []);
  if (active && !(options.retry ?? []).includes(active) && !(method.steps[active.split(':')[0]]?.ask && options.human?.steps?.[active])) fail('setup', `Inspect the trace and external state, then use --retry ${active} to authorize another attempt.`, 'recovery_required');
  // Every run file is redacted: a secret value never reaches the run folder, so a resumed run sees [REDACTED] in its place.
  const checkpoint = () => writeJSON(pathResolve(runDir, 'checkpoint.json'), redact({
    executor_version: executorVersion, execution_id: executionId, device_name: deviceName,
    models: profiles, method_sha256: hash(documentForDigest(method)), config_sha256: hash(suppliedConfig), runtime_sha256: hash(runtimeInfo),
    started_at: startedAt, elapsed_ms: performance.now() - started, sequence, invocations, requests, toolCalls, knownUsage, inputTokens, outputTokens,
    root, accepted, skipped, active, collections, cache: keys, reused, observed, repeat, costUsd, codexProcesses, codexInputTokens, codexOutputTokens, codexUsageReports,
  }));
  // An operator's own classification key takes precedence over a provider supplied by the host.
  const classifier = config.classification?.api_key_env ? typesafeClassification(config.classification.api_key_env, name => secretValue(options, name)) : options.classification;
  const secrets = [...new Set([
    ...Object.values(profiles).map(p => secretValue(options, p.api_key_env)),
    secretValue(options, config.classification?.api_key_env),
    ...Object.keys(method.secrets ?? {}).map(name => secretValue(options, name)),
  ].filter(x => x && x.length >= 4))];
  const redact = value => {
    if (typeof value === 'string') return secrets.reduce((s, secret) => s.split(secret).join('[REDACTED]'), value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    return value;
  };
  // Names for event sentences: the step's name from the Method file, and the task number of an each step.
  const tasksOf = id => method.steps[id]?.each ? collections[id]?.length ?? null : null;
  const names = {
    methodName: method.name,
    place: (id, iteration) => placeText({ name: method.steps[id]?.name ?? id, iteration, total: tasksOf(id), repeat: method.steps[id]?.repeat?.max_iterations ?? null }),
    checkName: id => checkLabel(method.steps[id]),
  };
  let journal = Promise.resolve();
  const record = (event, data = {}) => {
    const write = journal.then(async () => {
    if (event === 'codex.started') codexProcesses++;
    if (event === 'codex.completed') for (const usage of data.usage ?? []) {
      if (Number.isSafeInteger(usage?.input_tokens) && Number.isSafeInteger(usage?.output_tokens)) {
        codexInputTokens += usage.input_tokens; codexOutputTokens += usage.output_tokens; codexUsageReports++;
      }
    }
    // A user-facing event carries one plain sentence; progress and notice events bring their own.
    const message = data.message === undefined ? eventText(event, data, names) : undefined;
    const entry = redact({ sequence: ++sequence, at: new Date().toISOString(), elapsed_ms: performance.now() - started, event, ...data, ...(message ? { message } : {}) });
    await checkpoint();
    await appendFile(pathResolve(runDir, 'events.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    await options.onEvent?.(entry);
    return entry.sequence;
    });
    journal = write.catch(() => {});
    return write;
  };
  // A notice is a problem that the run handles itself, such as a retry. Its key is the same for each repeat of the
  // same problem, so a reader shows the newest one.
  const notice = ({ sub, ...data }) => record('notice', { ...data, key: `${data.step ?? ''}:${data.iteration ?? ''}:${data.kind}:${sub}` });
  // One notice when 80% of a run or step limit is used.
  const limitsNoticed = new Set();
  const watchLimit = ({ step: id, iteration, limit, used, max }) => {
    const key = `${id ?? ''}:${iteration ?? ''}:${limit}`;
    if (!(max > 0) || used < 0.8 * max || limitsNoticed.has(key)) return;
    limitsNoticed.add(key);
    const where = id === undefined ? null : names.place(id, iteration);
    notice({ ...(id === undefined ? {} : { step: id, iteration }), kind: 'limit', sub: limit.replaceAll(' ', '_'), message: limitNotice({ where, limit, used, max }) }).catch(() => {});
  };
  const watchRunLimits = () => {
    watchLimit({ limit: 'model requests', used: requests, max: config.limits.max_model_requests });
    watchLimit({ limit: 'tool calls', used: toolCalls, max: config.limits.max_tool_calls });
    watchLimit({ limit: 'invocations', used: invocations, max: config.limits.max_invocations });
  };
  /** A timer that records the time notice at 80% of a time limit. */
  const timeWatch = (place, ms, alreadyUsed = 0) => {
    const at = 0.8 * ms - alreadyUsed;
    if (!(ms > 0) || at <= 0) return () => {};
    const timer = setTimeout(() => watchLimit({ ...place, limit: 'time', used: 0.8 * ms, max: ms }), at);
    timer.unref?.();
    return () => clearTimeout(timer);
  };
  let stopRunWatch = () => {};
  const summary = () => ({ run_dir: runDir, execution_id: executionId, started_at: startedAt, device_name: deviceName, elapsed_ms: performance.now() - started, invocations, model_requests: requests, tool_calls: toolCalls,
    ...(codexProcesses ? { codex: { processes: codexProcesses, input_tokens: codexUsageReports ? codexInputTokens : null, output_tokens: codexUsageReports ? codexOutputTokens : null, scope: 'Codex-reported usage; internal requests and built-in tools are managed by Codex' } } : {}),
    ...(Object.keys(reused).length ? { reused } : {}),
    usage: { responses_with_usage: knownUsage, responses_without_usage: requests - knownUsage, input_tokens: knownUsage ? inputTokens : null, output_tokens: knownUsage ? outputTokens : null, cost_usd: costUsd, scope: 'executor-managed model requests only' } });
  let manifest;
  // Where the run is: setup until the first step starts, then the step that runs.
  let stage = 'setup', current = null, replayTmp = null;
  try {
    manifest = saved ? JSON.parse(await readFile(pathResolve(runDir, 'manifest.json'), 'utf8')).files : await snapshotBundle(sourceRoot, files, bundle);
    await writeJSON(pathResolve(runDir, 'manifest.json'), { executor_version: executorVersion, method_sha256: hash(documentForDigest(method)), config_sha256: hash(suppliedConfig), files: manifest, runtime_profiles: runtimeInfo, models: profiles });
    await writeJSON(pathResolve(runDir, 'method.json'), method);
    await writeJSON(pathResolve(runDir, 'state.json'), redact(state));
    const verifyBundle = async () => {
      for (const [file, expected] of Object.entries(manifest)) {
        if (hash(await readFile(await containedFile(bundle, file))) !== expected) fail('setup', `Bundle changed during execution: ${file}`, 'bundle_changed');
      }
    };
    const checkFiles = async (defs, values) => {
      async function visit(definition, value) {
        const def = shape(definition);
        if (def.type === 'file') {
          const actual = hash(await readFile(await containedFile(artifacts, value.path)));
          if (actual !== value.sha256) fail('setup', 'File hash mismatch', 'file_mismatch');
        } else if (def.type === 'record') for (const [name, child] of Object.entries(def.fields)) await visit(child, value[name]);
        else if (def.type === 'list') for (const item of value) await visit(def.fields ? { type: 'record', fields: def.fields } : def.items, item);
      }
      for (const [name, def] of Object.entries(defs ?? {})) await visit(def, values[name]);
    };
    await options.prepareBundle?.(bundle);
    await verifyBundle();
    const learned = await readLearned(bundle);
    // A replay's own folder: scripts that run live get their HOME here, and agents may write only here and in artifacts.
    // Their TMPDIR is a short folder of its own: the scratch folder can be deep, and tools put sockets in TMPDIR.
    const scratch = options.replay ? pathResolve(options.replay.scratch ?? pathResolve(runDir, 'scratch')) : null;
    if (scratch) { await mkdir(pathResolve(scratch, 'home'), { recursive: true, mode: 0o700 }); replayTmp = await tempFolder('mt-'); }
    if (saved) {
      const prior = JSON.parse(await readFile(pathResolve(runDir, 'summary.json'), 'utf8'));
      if (['completed', 'unconfirmed'].includes(prior.status)) {
        for (const [id, iterations] of Object.entries(accepted)) for (const outputs of iterations.filter(Boolean)) await checkFiles(effectiveOutputs(method.steps[id]), outputs);
        return prior;
      }
    }
    await writeJSON(pathResolve(runDir, 'summary.json'), { status: 'running', execution_id: executionId, started_at: startedAt });
    await record(saved ? 'run.resumed' : 'run.started', { executor_version: executorVersion, execution_id: executionId, device_name: deviceName, method, config, inputs, initial_state: state, runtime_profiles: runtimeInfo, isolation: 'trusted-local-processes; not an OS sandbox' });
    await options.onStart?.({ method, inputs, state, runDir });
    stopRunWatch = timeWatch({}, config.limits.timeout_ms, performance.now() - started);
    const executeScript = async (exec, input, signal, scopedRecord, operationId, onObserved) => {
      const owner = 'method_code', producer = `the script ${exec.entrypoint}`;
      await verifyBundle();
      const profile = runtimeInfo[exec.runtime];
      // Scripts are the user's own processes: they get the basic environment that tools such as git, npx or wrangler need
      // to find the user's own sign-ins, and nothing else of the caller's environment.
      const basic = Object.fromEntries(callerVariables.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
      const environment = { ...basic, PATH: options.processPath ?? process.env.PATH ?? '', LANG: 'C.UTF-8', METHOD_OUTPUT_DIR: artifacts, METHOD_ENVIRONMENT: JSON.stringify(connectionsFor(method, config.environment)) };
      if (operationId) environment.METHOD_OPERATION_ID = operationId;
      if (scratch) Object.assign(environment, { HOME: pathResolve(scratch, 'home'), TMPDIR: replayTmp, METHOD_REPLAY: '1' });
      // Preflight checked that every declared secret has a value.
      for (const name of Object.keys(method.secrets ?? {})) environment[name] = secretValue(options, name);
      if (Buffer.byteLength(JSON.stringify(input)) > config.limits.max_request_bytes) fail('limit', 'Script input exceeds request limit', 'input_limit', { limit: 'request size', value: config.limits.max_request_bytes });
      await scopedRecord('process.started', { ...(operationId ? {operation_id: operationId} : {}), entrypoint: exec.entrypoint, runtime: exec.runtime, args: exec.args ?? [] });
      let result;
      // The process records the hosts, files, variables, and programs it used (observed_effects); the script is unchanged.
      const observation = await prepareObservation(profile, { runDir, bundle, artifacts, env: environment });
      const observedEffects = async () => { const value = await observation.finish(); onObserved?.(value); return value; };
      try {
        result = await executeProcess({ command: profile.command, args: [...observation.args, ...(profile.args ?? []), await containedFile(bundle, exec.entrypoint), ...(exec.args ?? [])], cwd: bundle, input, env: { ...environment, ...observation.env }, signal, maxBytes: config.limits.max_output_bytes,
          onProgress: async value => { const progress = progressMessage(value); if (progress && !signal.aborted) await scopedRecord('progress', progress); },
        });
      } catch (error) {
        // A script is the Method's own code: its exit with an error is a problem in the Method's code.
        if (error.code === 'process_failed') Object.assign(error, { owner, producer });
        await scopedRecord('process.failed', { code: error.code ?? 'process_failed', exit_code: error.exit_code ?? null, diagnostics: error.diagnostics ?? '', output: error.output ?? '', observed_effects: await observedEffects() });
        throw error;
      }
      await scopedRecord('process.completed', { exit_code: 0, diagnostics: result.diagnostics, output: result.output, internal_model_usage: 'not observable by executor', observed_effects: await observedEffects() });
      let output;
      try { output = JSON.parse(result.output); } catch { fail(owner, 'Script must return one JSON object', 'invalid_output', { producer }); }
      safeData(output, owner);
      return output;
    };
    const observerScript = async (exec, input, role, token, signal) => {
      await verifyBundle();
      // A built-in observer may read the connection that its step changed; it opens it read-only.
      const connections = { ...connectionsFor(method, config.environment, 'observer'), ...(isBuiltin(exec) && exec.connection ? { [exec.connection]: config.environment?.[exec.connection] } : {}) };
      const { output, diagnostics } = await runObserverScript({ exec, input, role, token, bundle, runtimeInfo, connections, processPath: options.processPath, signal, maxBytes: config.limits.max_output_bytes });
      return { output, diagnostics };
    };
    const fixtures = await testFixtures(method, bundle, manifest, async (effect, input) => (await observerScript(effect.judge, input, 'judge', input.token, options.signal ?? new AbortController().signal)).output);
    if (fixtures.length) await record('effects.fixtures_passed', { fixtures });
    // Declared waivers are part of the record, so a reader sees which external changes nobody observes.
    const waived = Object.entries(method.steps).filter(([, step]) => step.no_effect_reason !== undefined).map(([step, { no_effect_reason, changes = [] }]) => ({ step, reason: no_effect_reason, changes: changes.filter(c => c.startsWith('environment.')) }));
    if (waived.length && !saved) await record('effects.waived', { waived });
    // Observe one effect, write the ledger, and record the verdict in the run's events.
    const observe = async (effect, data) => {
      const signal = options.signal ?? new AbortController().signal;
      const spec = isBuiltin(effect.observe) ? { ...effect, observe: { ...effect.observe, connection: observerConnection(effect, method.steps[data.key.split('/')[0]]) } } : effect;
      const replay = options.replay ? options.replay.observations?.[data.key] : undefined;
      // A replay never reads the live system. Without recorded observations the effect is not judged; with them, an
      // absence of evidence stays pending, because the recording does not show that the horizon passed.
      const entry = options.replay && !replay
        ? { effect: data.key, token: data.token, inputs: data.inputs, action_outcome: data.actionOutcome, attempt: data.attempt, observed_at: new Date().toISOString(), verdict: 'not_replayed', reason: 'The case supplies no observations for this effect.', evidence: [], final: true, completed_at: data.completedAt, horizon_at: horizonAt(spec, data.completedAt), next_observation_at: null }
        : await observeEffect({ ...data, effect: spec, runDir, replay, final: options.replay ? false : undefined, previous: options.replay ? [] : await previousObservations(runDir, data.key), run: (exec, input, role) => observerScript(exec, input, role, data.token, signal) });
      await appendLedger(runDir, redact(entry));
      await record('effect.observed', entry);
      return entry;
    };
    // A wait for an effect reading is visible, so a quiet run does not look stuck.
    const announceWait = async (at, key, write) => {
      const seconds = Math.round((Date.parse(at) - Date.now()) / 1000);
      if (seconds >= 2) await write('progress', { message: `Waiting ${seconds} s to check ${key}.` });
    };
    const tooLarge = new Set();
    const effectInputs = (step, scope) => Object.fromEntries(Object.entries(step ?? {}).map(([alias, ref]) => [alias, structuredClone(resolve(scope, ref))]));
    await verifyBundle();
    stage = 'steps';
    for (const id of order) {
      // A replay for a case runs only the steps that its expectations need.
      if (options.replay?.only && !options.replay.only.includes(id)) continue;
      current = id;
      const step = method.steps[id];
      const stepOutputs = effectiveOutputs(step);
      const limits = { ...config.step_defaults, ...step.limits };
      const rules = activeRules(learned, id);
      const replayKey = options.replay ? stepKey(step, { files: manifest, profiles, tools, helpers: method.files ?? [], rules }) : null;
      if (skipped.includes(id)) continue;
      if (!accepted[id]?.length && step.when && resolve(root, step.when) === false) { skipped.push(id); await record('step.skipped', { step: id }); continue; }
      const eachEntry = Object.entries(step.each ?? {})[0];
      if (eachEntry && !own(collections, id)) collections[id] = structuredClone(resolve(root, eachEntry[1]));
      const collection = eachEntry ? collections[id] : null;
      const count = collection ? collection.length : (step.repeat?.max_iterations ?? 1);
      if (!step.repeat?.until && count - (accepted[id]?.filter(Boolean).length ?? 0) > config.limits.max_invocations - invocations) fail('limit', 'Loop exceeds remaining invocation cap', 'invocation_limit', { limit: 'invocations', value: config.limits.max_invocations });
      const collected = Object.fromEntries(Object.keys(stepOutputs).map(k => [k, []]));
      let untilReached = false;
      // Items of an each step may run at once. A failed item does not stop the others; the step fails when all have ended.
      const width = eachEntry ? Math.min(step.concurrency ?? 1, config.limits.max_concurrency) : 1;
      const stepSignal = options.signal;
      /** Run one iteration. Returns true when the repeat condition is reached. */
      const runIteration = async iteration => {
        const previous = accepted[id]?.[iteration];
        if (previous) {
          await checkFiles(stepOutputs, previous);
          if (eachEntry) for (const key of Object.keys(collected)) collected[key][iteration] = previous[key];
          else Object.assign(root, previous);
          return !!step.repeat?.until && resolve(previous, step.repeat.until) === true;
        }
        const bindings = Object.fromEntries(Object.entries(step.in ?? {}).map(([k, ref]) => [k, structuredClone(resolve(root, ref))]));
        if (eachEntry) bindings[eachEntry[0]] = collection[iteration];
        // A session's key covers what its room folder holds, not only the folder's name.
        const room = step.do?.kind === 'session' && step.do.room ? await folderHashes(resolve(bindings, step.do.room)).catch(() => null) : undefined;
        const key = cacheable(step, tools) ? iterationKey({ method, step, bindings, iteration, profiles, config, runtimeInfo, manifest, rules, repeat, room }) : null;
        const hit = key && !fresh.has(id) ? cache.get(key) : undefined;
        if (hit) {
          // An earlier run accepted this exact iteration. Its outputs and files are reused; nothing executes.
          await copyOutputFiles(hit.dir, step, hit.outputs, artifacts);
          await checkFiles(stepOutputs, hit.outputs);
          (accepted[id] ??= [])[iteration] = hit.outputs;
          if (hit.observed) (observed[id] ??= [])[iteration] = hit.observed;
          keys[key] = [id, iteration]; reused[id] = (reused[id] ?? 0) + 1;
          await record('step.started', { step: id, iteration, ...(eachEntry ? { total: count } : {}), inputs: bindings, state_before: state, external_effects_possible: false, reused_from: hit.dir });
          // The key covers the step and its inputs, so the prompt is the one that the earlier run sent. The run record shows it.
          if (['call', 'agent', 'session'].includes(step.do?.kind)) await record('prompt.rendered', { step: id, iteration, phase: 'action', template: step.do.prompt, rendered: renderPrompt(step.do.prompt, bindings), reused_from: hit.dir });
          await record('step.accepted', { step: id, iteration, outputs: hit.outputs, state, check: { status: 'unchecked', reason: 'Reused from an earlier run', evidence: [] }, reused_from: hit.dir, ...(hit.observed ? { observed_effects: hit.observed } : {}) });
          if (eachEntry) for (const name of Object.keys(collected)) collected[name][iteration] = hit.outputs[name];
          else Object.assign(root, hit.outputs);
          return !!step.repeat?.until && resolve(hit.outputs, step.repeat.until) === true;
        }
        if (invocations >= config.limits.max_invocations) fail('limit', 'Invocation cap reached', 'invocation_limit', { limit: 'invocations', value: config.limits.max_invocations });
        invocations++; watchRunLimits();
        const remaining = Math.min(limits.timeout_ms, deadline - performance.now());
        if (remaining <= 0) throw timeoutError();
        const bound = boundedSignal(remaining, stepSignal);
        const stopStepWatch = limits.timeout_ms < config.limits.timeout_ms ? timeWatch({ step: id, iteration }, Math.min(limits.timeout_ms, remaining)) : () => {};
        let localRequests = 0, localAgentTurns = 0, actionObserved;
        const scopedRecord = (event, data) => record(event, { step: id, iteration, ...data });
        const guard = () => { if (bound.signal.aborted) throw bound.signal.reason; if (performance.now() >= deadline) throw timeoutError(); };
        const stateNames = (step.changes ?? []).filter(x => x.startsWith('state.')).map(x => x.slice(6));
        const outputDefs = { ...stepOutputs };
        if (stateNames.length) outputDefs.state = { type: 'record', fields: Object.fromEntries(stateNames.map(k => [k, method.state[k]])) };
        const schema = outputSchema(outputDefs);
        const context = {
          models: profiles, artifacts, signal: bound.signal, maxAgentTurns: limits.max_agent_turns, replay: scratch ? { scratch, runDir } : null,
          maxRequestBytes: config.limits.max_request_bytes, maxOutputBytes: config.limits.max_output_bytes,
          transport: options.transport, hosted: options.hostedModels, secret: name => secretValue(options, name), record: scopedRecord, guard, redact,
          cost(value) { if (Number.isFinite(value) && value >= 0) costUsd = (costUsd ?? 0) + value; },
          canRequest: () => requests < config.limits.max_model_requests && localRequests < (limits.max_model_requests ?? 0),
          canAgentTurn: () => localAgentTurns < limits.max_agent_turns,
          reserveRequest() {
            guard();
            if (!this.canRequest()) fail('limit', 'Model request cap reached', 'model_limit', requests >= config.limits.max_model_requests ? { limit: 'model requests', value: config.limits.max_model_requests } : { limit: 'model requests of a step', value: limits.max_model_requests ?? 0 });
            requests++; localRequests++;
            watchRunLimits(); watchLimit({ step: id, iteration, limit: 'model requests', used: localRequests, max: limits.max_model_requests ?? 0 });
          },
          notice: data => notice({ step: id, iteration, ...data }),
          reserveAgentTurn() { if (++localAgentTurns > limits.max_agent_turns) fail('limit', 'Agent turn cap reached', 'model_limit', { limit: 'agent turns', value: limits.max_agent_turns }); },
          usage(value) {
            if (Number.isSafeInteger(value?.input_tokens) && value.input_tokens >= 0 && Number.isSafeInteger(value?.output_tokens) && value.output_tokens >= 0) {
              knownUsage++; inputTokens += value.input_tokens; outputTokens += value.output_tokens;
            }
          },
          isConnectionTool(name) { return !!tools[name].connection; },
          toolDefinition(name) { return { type: 'function', name, description: tools[name].description, parameters: tools[name].parameters ?? outputSchema(tools[name].in), strict: !tools[name].connection }; },
          async invokeTool(name, args, callId) {
            try { return await this.callTool(name, args, callId); }
            catch (error) {
              // A tool's error happened in the tool phase. A connection is a service outside Method; a script tool is the Method's code.
              if (error && typeof error === 'object') {
                error.phase ??= 'tool';
                if (error.phase === 'tool') { error.producer ??= `the tool ${name}`; if (tools[name]?.connection) error.owner ??= 'outside_service'; }
              }
              throw error;
            }
          },
          async callTool(name, args, callId) {
            guard();
            if (++toolCalls > config.limits.max_tool_calls) fail('limit', 'Tool-call cap reached', 'tool_limit', { limit: 'tool calls', value: config.limits.max_tool_calls });
            watchRunLimits();
            const tool = tools[name];
            assertSchema(tool.parameters ?? outputSchema(tool.in), args, 'Tool arguments', { producer: `the agent's call of the tool ${name}`, owner: 'agent_work' });
            // A replay never changes the outside world: a tool with effects does not run, and the record keeps what it was asked to do.
            if (options.replay && tool.effects?.length) {
              await this.record('tool.standin', { tool: name, call_id: callId, arguments: args, effects: tool.effects });
              const standin = { replayed: true };
              return tool.connection ? { content: [{ type: 'text', text: JSON.stringify(standin) }] } : standin;
            }
            if (tool.connection) {
              // Page content is returned to the agent, never session secrets or raw provider logs.
              await this.record('tool.dispatched', {tool:name,call_id:callId,effects:tool.effects});
              try {
                const call = options.connections[tool.connection].call(tool.tool, args, bound.signal);
                const output = await new Promise((resolve,reject) => {
                  const abort=()=>reject(bound.signal.reason);
                  bound.signal.addEventListener('abort',abort,{once:true});
                  Promise.resolve(call).then(resolve,reject).finally(()=>bound.signal.removeEventListener('abort',abort));
                  if(bound.signal.aborted)abort();
                });
                guard(); validateToolResult(output);
                if(Buffer.byteLength(JSON.stringify(output))>config.limits.max_output_bytes)fail('limit', 'Tool output exceeds limit', 'output_limit', { limit: 'output size', value: config.limits.max_output_bytes });
                await this.record('tool.completed',{tool:name,call_id:callId,isError:!!output.isError});
                return output;
              } catch (error) {
                bound.abort(error);
                await this.record('tool.failed', {tool:name,call_id:callId,connection:tool.connection,code:error.code ?? 'connection_failed',message:error.message});
                throw error;
              }
            }
            await this.record('tool.dispatched', { tool: name, call_id: callId, arguments: args, effects: tool.effects });
            let output;
            try {
              output = await executeScript(tool.run, args, bound.signal, (event, data) => this.record(event, { ...data, tool: name, call_id: callId }));
              assertSchema(outputSchema(tool.out), output, 'Tool output', { producer: `the tool ${name}`, owner: 'method_code' });
            } catch (error) {
              if (error?.code === 'process_failed' || error?.code === 'invalid_output') error.producer = `the tool ${name}`;
              await this.record('tool.failed', { tool: name, call_id: callId, code: error?.code ?? 'tool_failed', message: String(error?.message ?? error) });
              throw error;
            }
            await this.record('tool.completed', { tool: name, call_id: callId, output });
            return output;
          },
        };
        const operationId = phase => 'mop_' + hash([executionId, id, iteration, phase]);
        const token = operationId('action');
        // Who produced a phase's value, in words from the Method file.
        const producerOf = (exec, phase) => {
          const by = exec.kind === 'run' ? exec.entrypoint : exec.kind === 'classify' ? 'the classification service'
            : { codex: 'Codex', claude: 'Claude Code' }[exec.kind === 'session' ? exec.agent : profiles[modelName(exec)]?.backend] ?? `the model ${profiles[modelName(exec)]?.model ?? modelName(exec)}`;
          if (phase === 'check') return step.reading?.check_name ? `the check "${step.reading.check_name}" (${by})` : exec.kind === 'run' ? `the check script ${by}` : `the check by ${by}`;
          return exec.kind === 'run' ? `the script ${by}` : by;
        };
        // The owner of a wrong value: a script is the Method's code; a model, an agent, or a classification is the agent's work.
        const ownerOf = exec => exec.kind === 'run' ? 'method_code' : 'agent_work';
        // The learned rules that apply to this iteration end the action prompt.
        let learnedText = '';
        /** Run one phase. feedback is appended to the rendered prompt of a second attempt. */
        const execute = async (exec, input, schema, phase, feedback) => {
          const producer = producerOf(exec, phase);
          try {
            guard();
            if (['call', 'agent', 'session'].includes(exec.kind)) {
              exec = exec.kind === 'agent' ? {...exec, tools:executionTools(exec, tools)} : exec;
              const template = exec.prompt;
              let rendered;
              try { rendered = renderPrompt(template, input); }
              catch (error) { fail('method_code', `${id}.${phase}.prompt: ${error.message}`, 'invalid_prompt', { producer: `the prompt of the ${phase}`, problem: 'refers to a value that the step does not receive' }); }
              if (phase === 'action' && learnedText) rendered += `\n\n${learnedText}`;
              if (feedback) rendered += `\n\n${feedback}`;
              if (Buffer.byteLength(rendered) + Buffer.byteLength(JSON.stringify(input)) > config.limits.max_request_bytes) fail('limit', 'Expanded prompt exceeds request limit', 'input_limit', { limit: 'request size', value: config.limits.max_request_bytes });
              await scopedRecord('prompt.rendered', { phase, template, rendered });
              // An agent action has no operation ID of its own; give it the token that its observers will search for.
              if (phase === 'action' && exec.kind === 'agent' && step.effects) rendered += `\n\nCorrelation token for this action: ${token}. Put it where the changed system keeps a reference (for example a message header, an idempotency key, or a note field), so that an observer can find this change.`;
              exec = { ...exec, prompt: rendered };
            }
            const phaseContext = { ...context, record: (event, data) => scopedRecord(event, { phase, ...data }) };
            // The run record names the backend and model that ran each model phase.
            if (['call', 'agent'].includes(exec.kind)) { const used = profiles[modelName(exec)]; await phaseContext.record('model.used', { model_name: modelName(exec), backend: used.backend, model: used.model ?? null }); }
            if (exec.kind === 'session') await phaseContext.record('model.used', { model_name: null, backend: exec.agent, model: exec.model ?? null });
            let result = exec.kind === 'classify' ? {[step.out]: await executeClassification(exec, input, config.classification, classifier, phaseContext)}
              : exec.kind === 'session' ? {[step.out]: await executeSession(exec, input, phaseContext)}
              : exec.kind === 'run' ? await executeScript(exec, input, bound.signal, phaseContext.record, operationId(phase), phase === 'action' ? value => { actionObserved = value; } : undefined)
              : profiles[modelName(exec)].backend === 'codex' ? await executeCodex(exec, input, schema, phaseContext)
              : profiles[modelName(exec)].backend === 'claude' ? await executeClaude(exec, input, schema, phaseContext)
              : await executeModel(exec, input, schema, phaseContext);
            // A check result's reason and evidence are display text; status is never converted.
            if (phase === 'check') result = displayText(result);
            guard(); assertSchema(schema, result, `${phase} output`, { producer, owner: ownerOf(exec) });
            return result;
          } catch (error) {
            // The phase and the producer of the value are set where the error is caught, once.
            if (error && typeof error === 'object') {
              error.phase ??= phase;
              if (error.phase === phase) error.producer = phase === 'check' || !error.producer ? producer : error.producer;
            }
            throw error;
          }
        };
        try {
          guard();
          active = `${id}:${iteration}`;
          await scopedRecord('step.started', { ...(eachEntry ? { total: count } : {}), inputs: bindings, state_before: state, external_effects_possible: (step.changes ?? []).some(x => x.startsWith('environment.')) });
          const answer = options.human?.steps?.[active];
          // A replay serves recorded outputs for unchanged steps; a changed step that acts on the world cannot be replayed.
          const replayed = options.replay ? replayedCandidate(options.replay, { id, step, iteration, bindings, key: replayKey }) : null;
          // A live step that names a path that the case could not keep would read a file that is gone or has changed.
          const missing = options.replay && !replayed ? namedPath(bindings, options.replay.missing ?? []) : null;
          if (missing) {
            await scopedRecord('replay.missing_file', { path: missing });
            fail('setup', `Cannot replay ${id}:${iteration}: its inputs name ${missing}, which the case could not keep.`, 'unverifiable');
          }
          // In a replay, files connections are scratch folders and Method tools with effects return stand-ins, so a changed
          // agent step can run. A script that changes another kind of connection, a step that asks a person, or a session
          // that can use a shell or the web (outside its room's copy) cannot.
          if (options.replay && !replayed && (step.ask || (step.do?.kind === 'session' && step.do.tools.some(tool => ['shell', 'web'].includes(tool))) || (step.do?.kind === 'run' && (step.changes ?? []).some(x => x.startsWith('environment.') && method.environment?.[x.slice(12)]?.type !== 'files')))) unverifiable(id, iteration, step);
          const folders = (step.changes ?? []).filter(x => x.startsWith('environment.') && method.environment?.[x.slice(12)]?.type === 'files').map(x => x.slice(12));
          const before = {};
          for (const name of folders) before[name] = tooLarge.has(name) ? null : await listFolder(pathResolve(config.environment[name]), [runDir]);
          if (step.ask && !replayed) {
            const prompt = renderPrompt(step.ask, bindings);
            if (Buffer.byteLength(prompt) + Buffer.byteLength(JSON.stringify(bindings)) > config.limits.max_request_bytes) fail('limit', 'Expanded prompt exceeds request limit', 'input_limit', { limit: 'request size', value: config.limits.max_request_bytes });
            await scopedRecord('prompt.rendered', { phase: 'action', template: step.ask, rendered: prompt });
            if (!answer) {
              // The answer form: what the answer must hold, so a worker can ask someone and check the reply.
              await scopedRecord('human.required', { prompt, inputs: bindings, schema });
              fail('needs_you', 'Human input required; this runner does not auto-answer ask', 'needs_input');
            }
          }
          const act = async feedback => {
            if (replayed) { await scopedRecord('step.replayed', { candidate: replayed }); return replayed; }
            try {
              if (!step.ask) return await execute(step.do, bindings, schema, 'action', feedback);
              assertSchema(schema, answer.outputs, 'Answer', { producer: 'your answer', owner: 'needs_you' });
              return answer.outputs;
            } catch (error) {
              // The action may have changed the outside world before it failed. Look before anyone retries it.
              if (step.effects && !options.signal?.aborted) {
                error.effects = [];
                for (const [name, spec] of Object.entries(step.effects)) error.effects.push(await observe(spec, { key: effectKey(id, iteration, name), token, inputs: effectInputs(spec.in, root), attempt: 1, actionOutcome: 'indeterminate', completedAt: new Date().toISOString() }));
              }
              throw error;
            }
          };
          let candidate, outputs, nextState, check;
          /** Record a candidate and run the step's check. Returns true when the check passes or there is none. */
          const accept = async (value, retry) => {
            candidate = value;
            await scopedRecord('step.candidate', { candidate, ...(retry ? { retry: true } : {}) });
            const { state: updates, ...rest } = candidate;
            outputs = rest;
            await checkFiles(outputDefs, candidate);
            nextState = { ...state, ...(updates ?? {}) };
            check = { status: 'unchecked', reason: 'No task check requested', evidence: [] };
            if (!step.check || replayed) return true;
            const spec = step.check, scope = { ...bindings, ...outputs };
            if (spec.kind) check = await execute(spec, { inputs: bindings, outputs, state_before: state, state_after: nextState, evidence: [] }, checkResultSchema, 'check');
            else {
              let pass;
              if (spec.equals) pass = isDeepStrictEqual(resolve(scope, spec.equals.actual), resolve(scope, spec.equals.expected));
              else if (spec.count) { const n = resolve(scope, spec.count.value).length; pass = n >= (spec.count.min ?? 0) && n <= (spec.count.max ?? Infinity); }
              else if (spec.file) { const artifact = resolve(scope, spec.file); pass = hash(await readFile(await containedFile(artifacts, artifact.path))) === artifact.sha256; }
              else { const value = resolve(scope, spec.present); pass = value !== null && value !== undefined; }
              check = { status: pass ? 'pass' : 'fail', reason: `Exact ${Object.keys(spec)[0]} check`, evidence: [] };
            }
            await scopedRecord('check.completed', { check });
            return check.status === 'pass';
          };
          const checkFailed = attempts => fail('agent_work', `Declared check returned ${check.status}${check.reason ? `: ${check.reason}` : ''}`, 'check_failed',
            { phase: 'check', check_label: checkLabel(step), evidence: check.evidence, attempts });
          // A model or an agent gets one more attempt when its work does not pass the check: it sees the check's reason
          // and evidence. A step that changes the outside world is not run twice.
          const retryable = ['agent', 'call'].includes(step.do?.kind) && !replayed && !step.effects && !(step.changes ?? []).some(x => x.startsWith('environment.'));
          // Learned rules: a rule without a condition always applies; one call on the step's own model decides the others.
          if (rules.length && !replayed && ['agent', 'call'].includes(step.do?.kind)) {
            const conditional = rules.filter(rule => rule.when !== null);
            let chosen = [];
            if (conditional.length) {
              try { chosen = (await execute({ kind: 'call', model: modelName(step.do), prompt: selectionPrompt }, { inputs: bindings, conditions: conditional.map(({ id, when }) => ({ id, when })) }, selectionSchema, 'rules')).applies; }
              catch (error) { if (error?.phase === 'rules') error.phase = 'action'; throw error; }
            }
            const applied = rules.filter(rule => rule.when === null || chosen.includes(rule.id));
            await scopedRecord('learned.applied', { considered: rules.map(rule => rule.id), applied: applied.map(rule => rule.id) });
            if (applied.length) learnedText = rulesText(applied);
          }
          if (!await accept(await act())) {
            if (!retryable) checkFailed(1);
            await scopedRecord('step.retry', { attempt: 2, attempts: 2, reason: check.reason ?? '', evidence: check.evidence ?? [] });
            const feedback = [`Your previous result did not pass the check "${checkLabel(step)}" (${check.status}). Do the step again and correct this.`,
              `Reason: ${check.reason ?? ''}`, ...(check.evidence?.length ? ['Evidence:', ...check.evidence.map(item => `- ${item}`)] : [])].join('\n');
            if (!await accept(await act(feedback), true)) checkFailed(2);
          }
          // The runtime reads each changed folder itself; a file that the step claims to have written must have changed.
          for (const name of folders) {
            const folder = pathResolve(config.environment[name]);
            // A folder that was too large once is not listed again in this run, and is reported once.
            if (tooLarge.has(name)) continue;
            if (!before[name]) tooLarge.add(name);
            const entry = observeFiles({ key: effectKey(id, iteration, `files:${name}`), connection: name, root: folder, before: before[name],
              after: before[name] ? await listFolder(folder, [runDir]) : null, outputs, completedAt: new Date().toISOString() });
            // Keep a copy of what the step wrote, so the run record shows it even after a later run overwrites it.
            entry.root = folder; entry.copies = {};
            for (const change of (entry.changed ?? []).filter(c => c.change !== 'removed').slice(0, 20)) {
              const source = change.path === '.' ? folder : pathResolve(folder, change.path);
              try {
                if ((await statFile(source)).size > 1_000_000) continue;
                const copy = `effects/files/${iteration}/${id}/${name}/${change.path === '.' ? 'file' : change.path}`;
                await mkdir(dirname(pathResolve(runDir, copy)), { recursive: true, mode: 0o700 });
                await copyFile(source, pathResolve(runDir, copy));
                entry.copies[change.path] = copy;
              } catch { /* A file that disappeared again has no copy. */ }
            }
            await appendLedger(runDir, redact(entry));
            await record('effect.observed', entry);
            if (entry.verdict === 'contradicted') fail('agent_work', `Effect ${entry.effect} was contradicted: ${entry.reason}`, 'effect_contradicted', { phase: 'effect', effect_name: `files:${name}`, evidence: entry.evidence });
          }
          // Blocking effects are observed before later steps start. Other effects are observed when the run ends.
          const completedAt = new Date().toISOString();
          const registered = [];
          for (const [name, spec] of Object.entries(step.effects ?? {})) {
            const data = { key: effectKey(id, iteration, name), token, inputs: effectInputs(spec.in, root), attempt: 1, actionOutcome: 'ok', completedAt };
            if (!spec.blocking) { registered.push({ data, spec }); continue; }
            if (!options.replay) await announceWait(nextObservation(spec, completedAt, new Date(0).toISOString()), data.key, scopedRecord);
            if (!options.replay && !await waitUntil(nextObservation(spec, completedAt, new Date(0).toISOString()), deadline, bound.signal)) throw timeoutError();
            let entry = await observe(spec, data);
            if (entry.verdict === 'contradicted' && spec.retry === 'idempotent' && !options.replay) {
              // The same operation ID lets the service drop a duplicate if the first attempt did succeed.
              await scopedRecord('effect.retry', { effect: data.key, token });
              if (!await accept(await act(), true)) checkFailed(1);
              const again = { ...data, attempt: 2, completedAt: new Date().toISOString() };
              if (!await waitUntil(nextObservation(spec, again.completedAt, new Date(0).toISOString()), deadline, bound.signal)) throw timeoutError();
              entry = await observe(spec, again);
            }
            if (entry.verdict === 'contradicted') fail('agent_work', `Effect ${data.key} was contradicted: ${entry.reason}`, 'effect_contradicted', { phase: 'effect', effect_name: name, evidence: entry.evidence });
          }
          for (const { data, spec } of registered) {
            const entry = { effect: data.key, token, inputs: data.inputs, action_outcome: 'ok', attempt: 0, registered_at: completedAt, verdict: 'pending', reason: 'Not yet observed.', final: false,
              completed_at: completedAt, horizon_at: horizonAt(spec, completedAt), next_observation_at: nextObservation(spec, completedAt, new Date(0).toISOString()) };
            await appendLedger(runDir, redact(entry));
          }
          guard();
          await writeJSON(pathResolve(runDir, 'state.json'), redact(nextState));
          state = nextState; root.state = state;
          (accepted[id] ??= [])[iteration] = outputs;
          if (actionObserved) (observed[id] ??= [])[iteration] = actionObserved;
          if (key) keys[key] = [id, iteration];
          active = null;
          await scopedRecord('step.accepted', { outputs, state, check, ...(actionObserved ? { observed_effects: actionObserved } : {}) });
          if (eachEntry) for (const key of Object.keys(collected)) collected[key][iteration] = outputs[key];
          else Object.assign(root, outputs);
          return !!step.repeat?.until && resolve(outputs, step.repeat.until) === true;
        } finally { bound.close(); stopStepWatch(); }
      };
      // An error names the task where it happened.
      const runTask = async iteration => {
        try { return await runIteration(iteration); }
        catch (error) { if (error && typeof error === 'object') { error.step ??= id; error.iteration ??= iteration; } throw error; }
      };
      if (width === 1) {
        for (let iteration = 0; iteration < count; iteration++) if (await runTask(iteration)) { untilReached = true; break; }
      } else {
        // Each worker is the same for-each loop; it takes the next item that no other worker has taken.
        let next = 0;
        const failures = [];
        const worker = async () => {
          while (next < count && !options.signal?.aborted) {
            const iteration = next++;
            try { await runTask(iteration); }
            catch (error) { failures.push({ error, iteration }); }
          }
        };
        await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
        // The step changes nothing outside the run, so resume runs only the failed and unfinished items again.
        if (failures.length) {
          failures.sort((a, b) => a.iteration - b.iteration);
          const [first] = failures;
          active = `${id}:${first.iteration}`;
          if (first.error && typeof first.error === 'object') first.error.failedIterations = failures.map(f => f.iteration);
          throw first.error;
        }
      }
      if (eachEntry) Object.assign(root, collected);
      if (step.repeat?.until && !untilReached) fail('limit', `Repeat condition not reached: ${id}`, 'iteration_limit', { limit: 'repeat', value: step.repeat.max_iterations });
      current = null;
    }
    if (performance.now() >= deadline) throw timeoutError();
    const resultOf = () => typeof method.result === 'string' ? resolve(root, method.result) : Object.fromEntries(Object.entries(method.result).map(([k, ref]) => [k, resolve(root, ref)]));
    let result;
    try { result = resultOf(); } catch (error) { if (!options.replay?.only) throw error; result = null; }
    // Before the run reports, it makes the observations that are due within effect_wait_ms (and the run deadline).
    // Later ones come from method observe. A replay judges each effect once, on its recorded observations.
    const until = Math.min(deadline, performance.now() + config.limits.effect_wait_ms);
    const specOf = key => { const [stepId, , name] = key.split('/'); return method.steps[stepId].effects[name]; };
    if (options.replay) {
      for (const entry of currentEffects(await readLedger(runDir)).filter(entry => entry.attempt === 0))
        await observe(specOf(entry.effect), { key: entry.effect, token: entry.token, inputs: entry.inputs, attempt: 1, actionOutcome: 'ok', completedAt: entry.completed_at });
    } else for (;;) {
      const next = currentEffects(await readLedger(runDir)).filter(entry => !entry.final && entry.next_observation_at)
        .sort((a, b) => a.next_observation_at.localeCompare(b.next_observation_at))[0];
      if (!next) break;
      if (Date.parse(next.next_observation_at) - Date.now() > until - performance.now()) break;
      await announceWait(next.next_observation_at, next.effect, record);
      if (!await waitUntil(next.next_observation_at, until, options.signal)) break;
      await observe(specOf(next.effect), { key: next.effect, token: next.token, inputs: next.inputs, attempt: next.attempt + 1, actionOutcome: next.action_outcome, completedAt: next.completed_at });
    }
    const completed = statusWithEffects({ status: 'completed', ...summary(), result }, effectSummary(await readLedger(runDir)), { method, total: tasksOf });
    if (waived.length) completed.unobserved_changes = waived;
    await record(completed.status === 'failed' ? 'run.failed' : 'run.completed', completed);
    if (completed.status !== 'failed') await writeJSON(pathResolve(runDir, 'result.json'), redact(result));
    await writeJSON(pathResolve(runDir, 'summary.json'), redact(completed));
    return completed;
  } catch (error) {
    // The failure record is written once, here. Its owner is the class that the error states.
    const id = typeof error?.step === 'string' && method.steps[error.step] ? error.step : current;
    const iteration = Number.isInteger(error?.iteration) ? error.iteration : id && active?.startsWith(`${id}:`) ? Number(active.split(':')[1]) : null;
    const ledger = await readLedger(runDir).catch(() => []);
    const failure = failureRecord(error, {
      method, step: id, iteration, total: id ? tasksOf(id) : null, failedIterations: error?.failedIterations ?? [],
      phase: stage === 'setup' ? 'setup' : null, stopped: !!options.signal?.aborted,
      // Observations after a failed action tell whether a new run could repeat a change that did happen.
      effects: (error?.effects ?? []).map(e => ({ name: e.effect.split('/').at(-1), verdict: e.verdict })),
    });
    const failed = { status: error?.code === 'needs_input' && !options.signal?.aborted ? 'needs_input' : 'failed', ...summary(), ...(ledger.length ? { effects: effectSummary(ledger) } : {}), failure };
    await record('run.failed', failed);
    await writeJSON(pathResolve(runDir, 'summary.json'), redact(failed));
    return failed;
  } finally { stopRunWatch(); if (replayTmp) await rm(replayTmp, { recursive: true, force: true }); }
}
