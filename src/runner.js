import { resolveModels } from './agents.js';
import { executorVersion, assertCheckpointExecutor } from './executor-version.js';
import { executeClaude } from './claude.js';
import { configuration } from './defaults.js';
import { mkdir, readFile, appendFile, realpath, open, unlink }  from 'node:fs/promises';
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
  return { signal: controller.signal, close: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
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
  const { order } = validateMethod(method);
  validateConfig(config);
  const suppliedConfig = config;
  config = configuration(config);
  const sourceRoot = await realpath(options.sourceRoot ?? dirname(pathResolve(file)));
  if (saved && (saved.method_sha256 !== hash(method) || saved.config_sha256 !== hash(suppliedConfig))) fail('Method or configuration changed. Resume needs the original version.', 'resume_mismatch');
  if (saved && (options.inputs || options.state)) fail('Resume uses saved inputs and state; omit --inputs and --state.', 'resume_mismatch');
  const inputs = saved?.root.inputs ?? initialValues(method.inputs, options.inputs);
  let state = saved?.root.state ?? initialValues(method.state, options.state);
  if (saved && !saved.models) fail('The checkpoint is missing its selected model profiles. Resume needs the original run records.', 'resume_mismatch');
  config.models = await resolveModels(method, config, { ...options, savedModels: saved?.models });
  const profiles = config.models, runtimeProfiles = config.runtimes ?? {}, tools = config.tools ?? {};
  const { scripts, runtimeInfo } = await preflight(method, config, sourceRoot, { ...options, checkFiles: !saved });
  const bundle = pathResolve(runDir, 'bundle');
  if (!saved) await mkdir(bundle, { mode: 0o700 });
  const artifacts = pathResolve(runDir, 'artifacts');
  if (!saved) await mkdir(artifacts, { mode: 0o700 });
  if (saved && hash(runtimeInfo) !== saved.runtime_sha256) fail('Runtime executable changed', 'resume_mismatch');
  let sequence = saved?.sequence ?? 0, invocations = saved?.invocations ?? 0, requests = saved?.requests ?? 0, toolCalls = saved?.toolCalls ?? 0, knownUsage = saved?.knownUsage ?? 0, inputTokens = saved?.inputTokens ?? 0, outputTokens = saved?.outputTokens ?? 0;
  let started = performance.now() - (saved?.elapsed_ms ?? 0), deadline = started + config.limits.timeout_ms;
  let codexProcesses = saved?.codexProcesses ?? 0, codexInputTokens = saved?.codexInputTokens ?? 0, codexOutputTokens = saved?.codexOutputTokens ?? 0, codexUsageReports = saved?.codexUsageReports ?? 0;
  const startedAt = saved?.started_at ?? new Date().toISOString();
  const root = saved?.root ?? { inputs, state, environment: config.environment ?? {}, run: { started_at: startedAt } };
  const accepted = saved?.accepted ?? {}, skipped = saved?.skipped ?? [];
  const collections = saved?.collections ?? {};
  let active = saved?.active ?? null;
  if (active && !(options.retry ?? []).includes(active) && !(method.steps[active.split(':')[0]]?.ask && options.human?.steps?.[active])) fail(`Inspect the trace and external state, then use --retry ${active} to authorize another attempt.`, 'recovery_required');
  const checkpoint = () => writeJSON(pathResolve(runDir, 'checkpoint.json'), {
    executor_version: executorVersion,
    models: profiles, method_sha256: hash(method), config_sha256: hash(suppliedConfig), runtime_sha256: hash(runtimeInfo),
    started_at: startedAt, elapsed_ms: performance.now() - started, sequence, invocations, requests, toolCalls, knownUsage, inputTokens, outputTokens,
    root, accepted, skipped, active, collections, codexProcesses, codexInputTokens, codexOutputTokens, codexUsageReports,
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
  const summary = () => ({ run_dir: runDir, elapsed_ms: performance.now() - started, invocations, model_requests: requests, tool_calls: toolCalls,
    ...(codexProcesses ? { codex: { processes: codexProcesses, input_tokens: codexUsageReports ? codexInputTokens : null, output_tokens: codexUsageReports ? codexOutputTokens : null, scope: 'Codex-reported usage; internal requests and built-in tools are managed by Codex' } } : {}),
    usage: { responses_with_usage: knownUsage, responses_without_usage: requests - knownUsage, input_tokens: knownUsage ? inputTokens : null, output_tokens: knownUsage ? outputTokens : null, cost_usd: null, scope: 'executor-managed model requests only' } });
  let manifest;
  try {
    manifest = saved ? JSON.parse(await readFile(pathResolve(runDir, 'manifest.json'), 'utf8')).files : await snapshotBundle(sourceRoot, [...(method.files ?? []), ...scripts.map(x => x.entrypoint)], bundle);
    await writeJSON(pathResolve(runDir, 'manifest.json'), { executor_version: executorVersion, method_sha256: hash(method), config_sha256: hash(suppliedConfig), files: manifest, runtime_profiles: runtimeInfo, models: profiles });
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
      if (prior.status === 'completed') {
        for (const [id, iterations] of Object.entries(accepted)) for (const outputs of iterations) await checkFiles(method.steps[id].out, outputs);
        return prior;
      }
    }
    await writeJSON(pathResolve(runDir, 'summary.json'), { status: 'running', started_at: startedAt });
    await record(saved ? 'run.resumed' : 'run.started', { executor_version: executorVersion, method, config, inputs, initial_state: state, runtime_profiles: runtimeInfo, isolation: 'trusted-local-processes; not an OS sandbox' });
    await options.onStart?.({ method, inputs, state, runDir });
    const executeScript = async (exec, input, signal, scopedRecord) => {
      await verifyBundle();
      const profile = runtimeInfo[exec.runtime];
      const environment = { PATH: options.processPath ?? process.env.PATH ?? '', LANG: 'C.UTF-8', METHOD_OUTPUT_DIR: artifacts, METHOD_ENVIRONMENT: JSON.stringify(config.environment ?? {}) };
      for (const key of profile.env ?? []) {
        if (!process.env[key]) fail(`Missing runtime environment variable: ${key}`, 'preflight');
        environment[key] = process.env[key];
      }
      if (Buffer.byteLength(JSON.stringify(input)) > config.limits.max_request_bytes) fail('Script input exceeds request limit', 'input_limit');
      await scopedRecord('process.started', { entrypoint: exec.entrypoint, runtime: exec.runtime, args: exec.args ?? [] });
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
    await verifyBundle();
    for (const id of order) {
      const step = method.steps[id];
    const limits = { ...config.step_defaults, ...step.limits };
      if (skipped.includes(id)) continue;
      if (!accepted[id]?.length && step.when && resolve(root, step.when) === false) { skipped.push(id); await record('step.skipped', { step: id }); continue; }
      const eachEntry = Object.entries(step.each ?? {})[0];
      if (eachEntry && !own(collections, id)) collections[id] = structuredClone(resolve(root, eachEntry[1]));
      const collection = eachEntry ? collections[id] : null;
      const count = collection ? collection.length : (step.repeat?.max_iterations ?? 1);
      if (!step.repeat?.until && count - (accepted[id]?.length ?? 0) > config.limits.max_invocations - invocations) fail('Loop exceeds remaining invocation cap', 'invocation_limit');
      const collected = Object.fromEntries(Object.keys(step.out ?? {}).map(k => [k, []]));
      let untilReached = false;
      for (let iteration = 0; iteration < count; iteration++) {
        const previous = accepted[id]?.[iteration];
        if (previous) {
          await checkFiles(step.out, previous);
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
        const outputDefs = { ...(step.out ?? {}) };
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
          toolDefinition(name) { return { type: 'function', name, description: tools[name].description, parameters: outputSchema(tools[name].in), strict: true }; },
          async invokeTool(name, args, callId) {
            guard();
            if (++toolCalls > config.limits.max_tool_calls) fail('Tool-call cap reached', 'tool_limit');
            const tool = tools[name];
            assertSchema(outputSchema(tool.in), args, 'Tool arguments');
            await this.record('tool.dispatched', { tool: name, call_id: callId, arguments: args, effects: tool.effects });
            const output = await executeScript(tool.run, args, bound.signal, (event, data) => this.record(event, { ...data, tool: name, call_id: callId }));
            assertSchema(outputSchema(tool.out), output, 'Tool output');
            await this.record('tool.completed', { tool: name, call_id: callId, output });
            return output;
          },
        };
        const execute = async (exec, input, schema, phase) => {
          guard();
          if (exec.kind !== 'run') {
            const template = exec.prompt;
            let rendered;
            try { rendered = renderPrompt(template, input); }
            catch (error) { fail(`${id}.${phase}.prompt: ${error.message}`, 'invalid_prompt'); }
            if (Buffer.byteLength(rendered) + Buffer.byteLength(JSON.stringify(input)) > config.limits.max_request_bytes) fail('Expanded prompt exceeds request limit', 'input_limit');
            await scopedRecord('prompt.rendered', { phase, template, rendered });
            exec = { ...exec, prompt: rendered };
          }
          const phaseContext = { ...context, record: (event, data) => scopedRecord(event, { phase, ...data }) };
          const result = exec.kind === 'run' ? await executeScript(exec, input, bound.signal, phaseContext.record)
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
          if (step.ask) {
            const prompt = renderPrompt(step.ask, bindings);
            if (Buffer.byteLength(prompt) + Buffer.byteLength(JSON.stringify(bindings)) > config.limits.max_request_bytes) fail('Expanded prompt exceeds request limit', 'input_limit');
            await scopedRecord('prompt.rendered', { phase: 'action', template: step.ask, rendered: prompt });
            if (!answer) {
              await scopedRecord('human.required', { prompt, inputs: bindings });
              fail('Human input required; this runner does not auto-answer ask', 'needs_input');
            }
          }
          const candidate = step.ask ? answer.outputs : await execute(step.do, bindings, schema, 'action');
          assertSchema(schema, candidate, 'Action output');
          await scopedRecord('step.candidate', { candidate });
          const { state: updates, ...outputs } = candidate;
          await checkFiles(outputDefs, candidate);
          const nextState = { ...state, ...(updates ?? {}) };
          let check = { status: 'unchecked', reason: 'No task check requested', evidence: [] };
          if (step.check) {
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
            if (check.status !== 'pass') fail(`Step check returned ${check.status}`, 'check_failed');
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
    const completed = { ...summary(), status: 'completed', result };
    await record('run.completed', completed);
    await writeJSON(pathResolve(runDir, 'result.json'), redact(result));
    await writeJSON(pathResolve(runDir, 'summary.json'), redact(completed));
    return completed;
  } catch (error) {
    const failed = { ...summary(), status: error.code === 'needs_input' ? 'needs_input' : 'failed', code: error.code ?? 'execution_failed', error: error.message, recovery: 'Resume with --run-dir and --resume. Inspect unfinished actions before authorizing --retry STEP:ITERATION. Accepted iterations are not repeated.' };
    await record('run.failed', failed);
    await writeJSON(pathResolve(runDir, 'summary.json'), redact(failed));
    return failed;
  }
}
