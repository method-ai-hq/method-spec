import { hostname } from 'node:os';
import { executeClassification } from './classification.js';
import { effectiveOutputs } from './semantics.js';
import { executionTools, validateToolResult } from './tool-connections.js';
import { resolveModels } from './agents.js';
import { executorVersion, assertCheckpointExecutor } from './executor-version.js';
import { executeClaude } from './claude.js';
import { configuration } from './defaults.js';
import { mkdir, readFile, appendFile, realpath, open, unlink, cp }  from 'node:fs/promises';
import { resolve as pathResolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateMethod, validateConfig, assertSchema, outputSchema, dataSchema, resolve, own, fail, safeData, shape } from './validate.js';
import { checkResultSchema, object } from './schema.js';
import { readDocument, hash, snapshotBundle, writeJSON, executeProcess, containedFile } from './io.js';
import { executeModel } from './model.js';
import { executeCodex } from './codex.js';
import { renderPrompt } from './prompt.js';
import { preflight } from './preflight.js';
import { progressMessage } from './progress.js';
import { readParentRun, planFork, copyForkFiles } from './fork.js';
import { effectKey, connectionsFor, testFixtures, runObserverScript, observeEffect, readLedger, appendLedger, currentEffects, effectSummary, statusWithEffects, waitUntil, nextObservation, horizonAt } from './effects.js';
import { replayedCandidate, unverifiable } from './replay.js';

function initialValues(defs = {}, supplied = {}) {
  const result = {};
  for (const [key, def] of Object.entries(defs)) {
    if (own(supplied, key)) result[key] = supplied[key];
    else if (own(def, 'default')) result[key] = structuredClone(def.default);
    else fail(`Missing required initial value: ${key}`, 'preflight');
  }
  for (const key of Object.keys(supplied)) if (!own(defs, key)) fail(`Unknown initial value: ${key}`, 'preflight');
  safeData(result); assertSchema(outputSchema(defs), result, 'Initial data');
  return result;
}
const timeoutError = () => Object.assign(new Error('Execution deadline exceeded'), { code: 'timeout' });
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
  const runDir = pathResolve(options.runDir ?? pathResolve('.method-runs', randomUUID()));
  if (options.resume && !options.runDir) fail('Resume needs an explicit run directory', 'preflight');
  if (options.fromRun && options.resume) fail('A fork starts a new run. Resume the fork with --resume alone.', 'preflight');
  if (options.fromRun && !options.reuse?.length) fail('Name the accepted steps to reuse with --reuse STEP.', 'preflight');
  if (options.reuse?.length && !options.fromRun) fail('Reuse needs --from-run with the parent run directory.', 'preflight');
  await mkdir(dirname(runDir), { recursive: true, mode: 0o700 });
  if (!options.resume) {
    try { await readFile(pathResolve(runDir, 'checkpoint.json')); fail('Run already exists. Use resume.', 'run_exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await mkdir(runDir, { recursive: true, mode: 0o700 });
  }
  const lockPath = pathResolve(runDir, '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch {
    if (!options.resume) fail('Run is locked. Use resume after its process stops.', 'run_locked');
    const owner = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(owner) || owner <= 0) fail('The run lock has no valid process ID. Inspect the run before removing it.', 'run_locked');
    try { process.kill(owner, 0); fail('Run is locked. The process is still active.', 'run_locked'); }
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
  const { order, dependencies } = validateMethod(method);
  validateConfig(config);
  const suppliedConfig = config;
  config = configuration(config);
  const sourceRoot = await realpath(options.sourceRoot ?? dirname(pathResolve(file)));
  if (saved && (saved.method_sha256 !== hash(method) || saved.config_sha256 !== hash(suppliedConfig))) fail('Method or configuration changed. Resume needs the original version.', 'resume_mismatch');
  if (saved && (options.inputs || options.state)) fail('Resume uses saved inputs and state; omit --inputs and --state.', 'resume_mismatch');
  const parent = options.fromRun ? await readParentRun(pathResolve(options.fromRun)) : null;
  // A fork keeps the parent's inputs and initial state unless new values are supplied.
  const inputs = saved?.root.inputs ?? initialValues(method.inputs, options.inputs ?? parent?.checkpoint.root?.inputs);
  let state = saved?.root.state ?? initialValues(method.state, options.state ?? parent?.initialState);
  if (saved && !saved.models) fail('The checkpoint is missing its selected model profiles. Resume needs the original run records.', 'resume_mismatch');
  config.models = await resolveModels(method, config, { ...options, savedModels: saved?.models });
  const profiles = config.models, runtimeProfiles = config.runtimes ?? {}, tools = config.tools ?? {};
  const { runtimeInfo, files } = await preflight(method, config, sourceRoot, { ...options, checkFiles: !saved });
  const bundle = pathResolve(runDir, 'bundle');
  if (!saved) await mkdir(bundle, { mode: 0o700 });
  const artifacts = pathResolve(runDir, 'artifacts');
  if (!saved) await mkdir(artifacts, { mode: 0o700 });
  if (!saved && options.replay?.artifacts) await cp(options.replay.artifacts, artifacts, { recursive: true });
  if (saved && hash(runtimeInfo) !== saved.runtime_sha256) fail('Runtime executable changed', 'resume_mismatch');
  let sequence = saved?.sequence ?? 0, invocations = saved?.invocations ?? 0, requests = saved?.requests ?? 0, toolCalls = saved?.toolCalls ?? 0, knownUsage = saved?.knownUsage ?? 0, inputTokens = saved?.inputTokens ?? 0, outputTokens = saved?.outputTokens ?? 0;
  let started = performance.now() - (saved?.elapsed_ms ?? 0), deadline = started + config.limits.timeout_ms;
  let codexProcesses = saved?.codexProcesses ?? 0, codexInputTokens = saved?.codexInputTokens ?? 0, codexOutputTokens = saved?.codexOutputTokens ?? 0, codexUsageReports = saved?.codexUsageReports ?? 0;
  const executionId = saved?.execution_id ?? randomUUID();
  const deviceName = saved?.device_name ?? options.deviceName ?? hostname();
  const startedAt = saved?.started_at ?? new Date().toISOString();
  const root = saved?.root ?? { inputs, state, environment: config.environment ?? {}, run: { started_at: startedAt } };
  const accepted = saved?.accepted ?? {}, skipped = saved?.skipped ?? [];
  const collections = saved?.collections ?? {};
  let active = saved?.active ?? null;
  let forkedFrom = saved?.forked_from ?? null;
  if (active && !(options.retry ?? []).includes(active) && !(method.steps[active.split(':')[0]]?.ask && options.human?.steps?.[active])) fail(`Inspect the trace and external state, then use --retry ${active} to authorize another attempt.`, 'recovery_required');
  const checkpoint = () => writeJSON(pathResolve(runDir, 'checkpoint.json'), {
    executor_version: executorVersion, execution_id: executionId, device_name: deviceName,
    models: profiles, method_sha256: hash(method), config_sha256: hash(suppliedConfig), runtime_sha256: hash(runtimeInfo),
    started_at: startedAt, elapsed_ms: performance.now() - started, sequence, invocations, requests, toolCalls, knownUsage, inputTokens, outputTokens,
    root, accepted, skipped, active, collections, codexProcesses, codexInputTokens, codexOutputTokens, codexUsageReports,
    ...(forkedFrom ? { forked_from: forkedFrom } : {}),
  });
  const secrets = [...new Set([
    ...Object.values(profiles).map(p => process.env[p.api_key_env]),
    ...Object.values(runtimeProfiles).flatMap(p => (p.env ?? []).map(key => process.env[key])),
  ].filter(x => x && x.length >= 4))];
  const redact = value => {
    if (typeof value === 'string') return secrets.reduce((s, secret) => s.split(secret).join('[REDACTED]'), value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    return value;
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
    const entry = redact({ sequence: ++sequence, at: new Date().toISOString(), elapsed_ms: performance.now() - started, event, ...data });
    await checkpoint();
    await appendFile(pathResolve(runDir, 'events.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    await options.onEvent?.(entry);
    });
    journal = write.catch(() => {});
    return write;
  };
  const summary = () => ({ run_dir: runDir, started_at: startedAt, device_name: deviceName, elapsed_ms: performance.now() - started, invocations, model_requests: requests, tool_calls: toolCalls,
    ...(codexProcesses ? { codex: { processes: codexProcesses, input_tokens: codexUsageReports ? codexInputTokens : null, output_tokens: codexUsageReports ? codexOutputTokens : null, scope: 'Codex-reported usage; internal requests and built-in tools are managed by Codex' } } : {}),
    ...(forkedFrom ? { forked_from: forkedFrom } : {}),
    usage: { responses_with_usage: knownUsage, responses_without_usage: requests - knownUsage, input_tokens: knownUsage ? inputTokens : null, output_tokens: knownUsage ? outputTokens : null, cost_usd: null, scope: 'executor-managed model requests only' } });
  let manifest;
  try {
    manifest = saved ? JSON.parse(await readFile(pathResolve(runDir, 'manifest.json'), 'utf8')).files : await snapshotBundle(sourceRoot, files, bundle);
    if (parent) {
      const fork = planFork({ parent, method, dependencies, steps: options.reuse, root, profiles, config, runtimeInfo, manifest });
      Object.assign(accepted, fork.accepted); skipped.push(...fork.skipped); Object.assign(collections, fork.collections);
      forkedFrom = fork.provenance;
      await copyForkFiles(parent, method, fork.accepted, artifacts);
    }
    await writeJSON(pathResolve(runDir, 'manifest.json'), { executor_version: executorVersion, method_sha256: hash(method), config_sha256: hash(suppliedConfig), files: manifest, runtime_profiles: runtimeInfo, models: profiles, ...(forkedFrom ? { forked_from: forkedFrom } : {}) });
    await writeJSON(pathResolve(runDir, 'method.json'), method);
    await writeJSON(pathResolve(runDir, 'state.json'), state);
    const verifyBundle = async () => {
      for (const [file, expected] of Object.entries(manifest)) {
        if (hash(await readFile(await containedFile(bundle, file))) !== expected) fail(`Bundle changed during execution: ${file}`, 'bundle_changed');
      }
    };
    const checkFiles = async (defs, values) => {
      async function visit(definition, value) {
        const def = shape(definition);
        if (def.type === 'file') {
          const actual = hash(await readFile(await containedFile(artifacts, value.path)));
          if (actual !== value.sha256) fail('File hash mismatch', 'file_mismatch');
        } else if (def.type === 'record') for (const [name, child] of Object.entries(def.fields)) await visit(child, value[name]);
        else if (def.type === 'list') for (const item of value) await visit(def.fields ? { type: 'record', fields: def.fields } : def.items, item);
      }
      for (const [name, def] of Object.entries(defs ?? {})) await visit(def, values[name]);
    };
    await options.prepareBundle?.(bundle);
    await verifyBundle();
    if (saved) {
      const prior = JSON.parse(await readFile(pathResolve(runDir, 'summary.json'), 'utf8'));
      if (['completed', 'unconfirmed'].includes(prior.status)) {
        for (const [id, iterations] of Object.entries(accepted)) for (const outputs of iterations) await checkFiles(effectiveOutputs(method.steps[id]), outputs);
        return prior;
      }
    }
    await writeJSON(pathResolve(runDir, 'summary.json'), { status: 'running', started_at: startedAt });
    await record(saved ? 'run.resumed' : 'run.started', { executor_version: executorVersion, execution_id: executionId, device_name: deviceName, method, config, inputs, initial_state: state, runtime_profiles: runtimeInfo, isolation: 'trusted-local-processes; not an OS sandbox', ...(forkedFrom ? { forked_from: forkedFrom } : {}) });
    if (parent) for (const entry of forkedFrom.steps) await record('step.imported', { ...entry, outputs: accepted[entry.step] ?? null, parent_execution_id: forkedFrom.execution_id, parent_run_dir: forkedFrom.run_dir });
    await options.onStart?.({ method, inputs, state, runDir });
    const executeScript = async (exec, input, signal, scopedRecord, operationId) => {
      await verifyBundle();
      const profile = runtimeInfo[exec.runtime];
      const environment = { PATH: options.processPath ?? process.env.PATH ?? '', LANG: 'C.UTF-8', METHOD_OUTPUT_DIR: artifacts, METHOD_ENVIRONMENT: JSON.stringify(connectionsFor(method, config.environment)) };
      if (operationId) environment.METHOD_OPERATION_ID = operationId;
      for (const key of profile.env ?? []) {
        if (!process.env[key]) fail(`Missing runtime environment variable: ${key}`, 'preflight');
        environment[key] = process.env[key];
      }
      if (Buffer.byteLength(JSON.stringify(input)) > config.limits.max_request_bytes) fail('Script input exceeds request limit', 'input_limit');
      await scopedRecord('process.started', { ...(operationId ? {operation_id: operationId} : {}), entrypoint: exec.entrypoint, runtime: exec.runtime, args: exec.args ?? [] });
      let result;
      try {
        result = await executeProcess({ command: profile.command, args: [...(profile.args ?? []), await containedFile(bundle, exec.entrypoint), ...(exec.args ?? [])], cwd: bundle, input, env: environment, signal, maxBytes: config.limits.max_output_bytes,
          onProgress: async value => { const progress = progressMessage(value); if (progress && !signal.aborted) await scopedRecord('progress', progress); },
        });
      } catch (error) {
        await scopedRecord('process.failed', { code: error.code ?? 'process_failed', exit_code: error.exit_code ?? null, diagnostics: error.diagnostics ?? '', output: error.output ?? '' });
        throw error;
      }
      await scopedRecord('process.completed', { exit_code: 0, diagnostics: result.diagnostics, output: result.output, internal_model_usage: 'not observable by executor' });
      let output;
      try { output = JSON.parse(result.output); } catch { fail('Script must return one JSON object', 'invalid_output'); }
      safeData(output);
      return output;
    };
    const observerScript = async (exec, input, role, token, signal) => {
      await verifyBundle();
      const { output, diagnostics } = await runObserverScript({ exec, input, role, token, bundle, runtimeInfo, connections: connectionsFor(method, config.environment, 'observer'), processPath: options.processPath, signal, maxBytes: config.limits.max_output_bytes });
      return { output, diagnostics };
    };
    const fixtures = await testFixtures(method, bundle, manifest, async (effect, input) => (await observerScript(effect.judge, input, 'judge', input.token, options.signal ?? new AbortController().signal)).output);
    if (fixtures.length) await record('effects.fixtures_passed', { fixtures });
    // Observe one effect, write the ledger, and record the verdict in the run's events.
    const observe = async (spec, data) => {
      const signal = options.signal ?? new AbortController().signal;
      const replay = options.replay ? options.replay.observations?.[data.key] : undefined;
      // A replay never reads the live system. Without recorded observations the effect is not judged; with them, an
      // absence of evidence stays pending, because the recording does not show that the horizon passed.
      const entry = options.replay && !replay
        ? { effect: data.key, token: data.token, inputs: data.inputs, action_outcome: data.actionOutcome, attempt: data.attempt, observed_at: new Date().toISOString(), verdict: 'not_replayed', reason: 'The case supplies no observations for this effect.', evidence: [], final: true, completed_at: data.completedAt, horizon_at: horizonAt(spec, data.completedAt), next_observation_at: null }
        : await observeEffect({ ...data, effect: spec, runDir, replay, final: options.replay ? false : undefined, run: (exec, input, role) => observerScript(exec, input, role, data.token, signal) });
      await appendLedger(runDir, entry);
      await record('effect.observed', entry);
      return entry;
    };
    const effectInputs = (step, scope) => Object.fromEntries(Object.entries(step ?? {}).map(([alias, ref]) => [alias, structuredClone(resolve(scope, ref))]));
    await verifyBundle();
    for (const id of order) {
      const step = method.steps[id];
      const stepOutputs = effectiveOutputs(step);
    const limits = { ...config.step_defaults, ...step.limits };
      if (skipped.includes(id)) continue;
      if (!accepted[id]?.length && step.when && resolve(root, step.when) === false) { skipped.push(id); await record('step.skipped', { step: id }); continue; }
      const eachEntry = Object.entries(step.each ?? {})[0];
      if (eachEntry && !own(collections, id)) collections[id] = structuredClone(resolve(root, eachEntry[1]));
      const collection = eachEntry ? collections[id] : null;
      const count = collection ? collection.length : (step.repeat?.max_iterations ?? 1);
      if (!step.repeat?.until && count - (accepted[id]?.length ?? 0) > config.limits.max_invocations - invocations) fail('Loop exceeds remaining invocation cap', 'invocation_limit');
      const collected = Object.fromEntries(Object.keys(stepOutputs).map(k => [k, []]));
      let untilReached = false;
      for (let iteration = 0; iteration < count; iteration++) {
        const previous = accepted[id]?.[iteration];
        if (previous) {
          await checkFiles(stepOutputs, previous);
          if (eachEntry) for (const key of Object.keys(collected)) collected[key].push(previous[key]);
          else Object.assign(root, previous);
          if (step.repeat?.until && resolve(previous, step.repeat.until) === true) { untilReached = true; break; }
          continue;
        }
        if (invocations >= config.limits.max_invocations) fail('Invocation cap reached', 'invocation_limit');
        invocations++;
        const bindings = Object.fromEntries(Object.entries(step.in ?? {}).map(([k, ref]) => [k, structuredClone(resolve(root, ref))]));
        if (eachEntry) bindings[eachEntry[0]] = collection[iteration];
        const remaining = Math.min(limits.timeout_ms, deadline - performance.now());
        if (remaining <= 0) throw timeoutError();
        const bound = boundedSignal(remaining, options.signal);
        let localRequests = 0, localAgentTurns = 0;
        const scopedRecord = (event, data) => record(event, { step: id, iteration, ...data });
        const guard = () => { if (bound.signal.aborted) throw bound.signal.reason; if (performance.now() >= deadline) throw timeoutError(); };
        const stateNames = (step.changes ?? []).filter(x => x.startsWith('state.')).map(x => x.slice(6));
        const outputDefs = { ...stepOutputs };
        if (stateNames.length) outputDefs.state = { type: 'record', fields: Object.fromEntries(stateNames.map(k => [k, method.state[k]])) };
        const schema = outputSchema(outputDefs);
        const context = {
          models: profiles, artifacts, signal: bound.signal, maxAgentTurns: limits.max_agent_turns,
          maxRequestBytes: config.limits.max_request_bytes, maxOutputBytes: config.limits.max_output_bytes,
          transport: options.transport, record: scopedRecord, guard,
          canRequest: () => requests < config.limits.max_model_requests && localRequests < (limits.max_model_requests ?? 0),
          canAgentTurn: () => localAgentTurns < limits.max_agent_turns,
          reserveRequest() { guard(); if (!this.canRequest()) fail('Model request cap reached', 'model_limit'); requests++; localRequests++; },
          reserveAgentTurn() { if (++localAgentTurns > limits.max_agent_turns) fail('Agent turn cap reached', 'model_limit'); },
          usage(value) {
            if (Number.isSafeInteger(value?.input_tokens) && value.input_tokens >= 0 && Number.isSafeInteger(value?.output_tokens) && value.output_tokens >= 0) {
              knownUsage++; inputTokens += value.input_tokens; outputTokens += value.output_tokens;
            }
          },
          isConnectionTool(name) { return !!tools[name].connection; },
          toolDefinition(name) { return { type: 'function', name, description: tools[name].description, parameters: tools[name].parameters ?? outputSchema(tools[name].in), strict: !tools[name].connection }; },
          async invokeTool(name, args, callId) {
            guard();
            if (++toolCalls > config.limits.max_tool_calls) fail('Tool-call cap reached', 'tool_limit');
            const tool = tools[name];
            assertSchema(tool.parameters ?? outputSchema(tool.in), args, 'Tool arguments');
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
                if(Buffer.byteLength(JSON.stringify(output))>config.limits.max_output_bytes)fail('Tool output exceeds limit','output_limit');
                await this.record('tool.completed',{tool:name,call_id:callId,isError:!!output.isError});
                return output;
              } catch (error) {
                bound.abort(error);
                await this.record('tool.failed', {tool:name,call_id:callId,connection:tool.connection,code:error.code ?? 'connection_failed',message:error.message});
                throw error;
              }
            }
            await this.record('tool.dispatched', { tool: name, call_id: callId, arguments: args, effects: tool.effects });
            const output = await executeScript(tool.run, args, bound.signal, (event, data) => this.record(event, { ...data, tool: name, call_id: callId }));
            assertSchema(outputSchema(tool.out), output, 'Tool output');
            await this.record('tool.completed', { tool: name, call_id: callId, output });
            return output;
          },
        };
        const operationId = phase => 'mop_' + hash([executionId, id, iteration, phase]);
        const token = operationId('action');
        const execute = async (exec, input, schema, phase) => {
          guard();
          if (['call', 'agent'].includes(exec.kind)) {
            exec = exec.kind === 'agent' ? {...exec, tools:executionTools(exec, tools)} : exec;
            const template = exec.prompt;
            let rendered;
            try { rendered = renderPrompt(template, input); }
            catch (error) { fail(`${id}.${phase}.prompt: ${error.message}`, 'invalid_prompt'); }
            if (Buffer.byteLength(rendered) + Buffer.byteLength(JSON.stringify(input)) > config.limits.max_request_bytes) fail('Expanded prompt exceeds request limit', 'input_limit');
            await scopedRecord('prompt.rendered', { phase, template, rendered });
            // An agent action has no operation ID of its own; give it the token that its observers will search for.
            if (phase === 'action' && exec.kind === 'agent' && step.effects) rendered += `\n\nCorrelation token for this action: ${token}. Put it where the changed system keeps a reference (for example a message header, an idempotency key, or a note field), so that an observer can find this change.`;
            exec = { ...exec, prompt: rendered };
          }
          const phaseContext = { ...context, record: (event, data) => scopedRecord(event, { phase, ...data }) };
          const result = exec.kind === 'classify' ? {[step.out]: await executeClassification(exec, input, config.classification, options.classification, phaseContext)}
            : exec.kind === 'run' ? await executeScript(exec, input, bound.signal, phaseContext.record, operationId(phase))
            : profiles[exec.model].backend === 'codex' ? await executeCodex(exec, input, schema, phaseContext)
            : profiles[exec.model].backend === 'claude' ? await executeClaude(exec, input, schema, phaseContext)
            : await executeModel(exec, input, schema, phaseContext);
          guard(); assertSchema(schema, result, `${phase} output`);
          return result;
        };
        try {
          guard();
          active = `${id}:${iteration}`;
          await scopedRecord('step.started', { inputs: bindings, state_before: state, external_effects_possible: (step.changes ?? []).some(x => x.startsWith('environment.')) });
          const answer = options.human?.steps?.[active];
          // A replay serves recorded outputs for unchanged steps; a changed step that acts on the world cannot be replayed.
          const replayed = options.replay ? replayedCandidate(options.replay, { id, step, iteration, bindings, manifest, profiles, tools }) : null;
          if (options.replay && !replayed && (step.ask || (step.changes ?? []).some(x => x.startsWith('environment.')))) unverifiable(id, iteration, step);
          if (step.ask && !replayed) {
            const prompt = renderPrompt(step.ask, bindings);
            if (Buffer.byteLength(prompt) + Buffer.byteLength(JSON.stringify(bindings)) > config.limits.max_request_bytes) fail('Expanded prompt exceeds request limit', 'input_limit');
            await scopedRecord('prompt.rendered', { phase: 'action', template: step.ask, rendered: prompt });
            if (!answer) {
              await scopedRecord('human.required', { prompt, inputs: bindings });
              fail('Human input required; this runner does not auto-answer ask', 'needs_input');
            }
          }
          const act = async () => {
            if (replayed) { await scopedRecord('step.replayed', { candidate: replayed }); return replayed; }
            try {
              const value = step.ask ? answer.outputs : await execute(step.do, bindings, schema, 'action');
              assertSchema(schema, value, 'Action output');
              return value;
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
          const accept = async (value, retry) => {
            candidate = value;
            await scopedRecord('step.candidate', { candidate, ...(retry ? { retry: true } : {}) });
            const { state: updates, ...rest } = candidate;
            outputs = rest;
            await checkFiles(outputDefs, candidate);
            nextState = { ...state, ...(updates ?? {}) };
            check = { status: 'unchecked', reason: 'No task check requested', evidence: [] };
            if (step.check && !replayed) {
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
              if (check.status !== 'pass') fail(`Declared check returned ${check.status}`, 'check_failed');
            }
          };
          await accept(await act());
          // Blocking effects are observed before later steps start. Other effects are observed when the run ends.
          const completedAt = new Date().toISOString();
          const registered = [];
          for (const [name, spec] of Object.entries(step.effects ?? {})) {
            const data = { key: effectKey(id, iteration, name), token, inputs: effectInputs(spec.in, root), attempt: 1, actionOutcome: 'ok', completedAt };
            if (!spec.blocking) { registered.push({ data, spec }); continue; }
            if (!options.replay && !await waitUntil(nextObservation(spec, completedAt, new Date(0).toISOString()), deadline, bound.signal)) throw timeoutError();
            let entry = await observe(spec, data);
            if (entry.verdict === 'contradicted' && spec.retry === 'idempotent' && !options.replay) {
              // The same operation ID lets the service drop a duplicate if the first attempt did succeed.
              await scopedRecord('effect.retry', { effect: data.key, token });
              await accept(await act(), true);
              const again = { ...data, attempt: 2, completedAt: new Date().toISOString() };
              if (!await waitUntil(nextObservation(spec, again.completedAt, new Date(0).toISOString()), deadline, bound.signal)) throw timeoutError();
              entry = await observe(spec, again);
            }
            if (entry.verdict === 'contradicted') fail(`Effect ${data.key} was contradicted: ${entry.reason}`, 'effect_contradicted');
          }
          for (const { data, spec } of registered) {
            const entry = { effect: data.key, token, inputs: data.inputs, action_outcome: 'ok', attempt: 0, registered_at: completedAt, verdict: 'pending', reason: 'Not yet observed.', final: false,
              completed_at: completedAt, horizon_at: horizonAt(spec, completedAt), next_observation_at: nextObservation(spec, completedAt, new Date(0).toISOString()) };
            await appendLedger(runDir, entry);
          }
          guard();
          await writeJSON(pathResolve(runDir, 'state.json'), nextState);
          state = nextState; root.state = state;
          (accepted[id] ??= []).push(outputs);
          active = null;
          await scopedRecord('step.accepted', { outputs, state, check });
          if (eachEntry) for (const key of Object.keys(collected)) collected[key].push(outputs[key]);
          else Object.assign(root, outputs);
          if (step.repeat?.until && resolve(outputs, step.repeat.until) === true) { untilReached = true; break; }
        } finally { bound.close(); }
      }
      if (eachEntry) Object.assign(root, collected);
      if (step.repeat?.until && !untilReached) fail(`Repeat condition not reached: ${id}`, 'iteration_limit');
    }
    if (performance.now() >= deadline) throw timeoutError();
    const result = typeof method.result === 'string' ? resolve(root, method.result) : Object.fromEntries(Object.entries(method.result).map(([k, ref]) => [k, resolve(root, ref)]));
    // Each effect gets its first observation before the run reports. Later ones come from method observe.
    const unobserved = currentEffects(await readLedger(runDir)).filter(entry => entry.attempt === 0).sort((a, b) => a.next_observation_at.localeCompare(b.next_observation_at));
    for (const entry of unobserved) {
      const [stepId, , name] = entry.effect.split('/');
      const spec = method.steps[stepId].effects[name];
      if (!options.replay && !await waitUntil(entry.next_observation_at, deadline, options.signal)) continue;
      await observe(spec, { key: entry.effect, token: entry.token, inputs: entry.inputs, attempt: 1, actionOutcome: 'ok', completedAt: entry.completed_at });
    }
    const completed = statusWithEffects({ ...summary(), status: 'completed', result }, effectSummary(await readLedger(runDir)));
    await record(completed.status === 'failed' ? 'run.failed' : 'run.completed', completed);
    if (completed.status !== 'failed') await writeJSON(pathResolve(runDir, 'result.json'), redact(result));
    await writeJSON(pathResolve(runDir, 'summary.json'), redact(completed));
    return completed;
  } catch (error) {
    const unfinished = active?.split(':')[0];
    const reusable = order.filter(id => skipped.includes(id) || (accepted[id]?.length && id !== unfinished));
    // Resume keeps the run's bundle, so a code fix needs a fork that reuses the accepted steps.
    const fork = reusable.length ? ` To fix a step that was not accepted, edit it, then start a new run with --from-run ${runDir} --reuse ${reusable.join(',')}. The fork refuses a listed step that changed.` : '';
    // Observations after a failed action tell the operator whether a retry could repeat a change that did happen.
    const observed = error.effects?.length ? ' Observed after the failed action: ' + error.effects.map(e => `${e.effect} ${e.verdict}${e.verdict === 'confirmed' ? ' (the change happened; do not retry it)' : ''}`).join('; ') + '.' : '';
    const ledger = await readLedger(runDir).catch(() => []);
    const failed = { ...summary(), status: error.code === 'needs_input' ? 'needs_input' : 'failed', code: error.code ?? 'execution_failed', error: error.message, recovery: 'Resume with --run-dir and --resume. Inspect unfinished actions before authorizing --retry STEP:ITERATION. Accepted iterations are not repeated.' + observed + fork,
      ...(ledger.length ? { effects: effectSummary(ledger) } : {}) };
    await record('run.failed', failed);
    await writeJSON(pathResolve(runDir, 'summary.json'), redact(failed));
    return failed;
  }
}
