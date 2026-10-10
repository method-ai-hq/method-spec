import { modelName } from './semantics.js';
import { documentForDigest } from './document.js';
import { readFile } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { executionTools } from './tool-connections.js';
import { fail } from './validate.js';
import { hash } from './io.js';
import { readLedger, currentEffects } from './effects.js';

/**
 * Everything that decides what a step does, apart from its inputs. Display text and effect contracts do not change
 * the action, so they do not change the key. Runtime binaries are left out: a Node update does not make a recording
 * stale, but a changed script, prompt, model profile or tool does.
 */
export function stepKey(step, { files = {}, profiles = {}, tools = {} }) {
  const { name, reading, purpose, effects, ...definition } = step;
  const parts = [definition];
  for (const exec of [step.do, step.check]) if (exec?.kind) {
    if (['call', 'agent'].includes(exec.kind)) parts.push(['model', modelName(exec), profiles[modelName(exec)] ?? null]);
    if (exec.kind === 'run') parts.push(['file', exec.entrypoint, files[exec.entrypoint] ?? null]);
    for (const tool of executionTools(exec, tools)) {
      parts.push(['tool', tool, tools[tool] ?? null]);
      if (tools[tool]?.run) parts.push(['file', tools[tool].run.entrypoint, files[tools[tool].run.entrypoint] ?? null]);
    }
  }
  return hash(parts);
}

/** The recorded output for this iteration, when the step and its inputs are unchanged. */
export function replayedCandidate(replay, { id, step, iteration, bindings, manifest, profiles, tools }) {
  const recording = replay.recording;
  if (recording.keys[id] !== stepKey(step, { files: manifest, profiles, tools })) return null;
  const saved = recording.iterations[id]?.[iteration];
  // A scratch folder stands in for a real one; compare with the path that the recorded run saw.
  const seen = replay.paths ? JSON.parse(JSON.stringify(bindings, (key, value) => typeof value === 'string' && replay.paths[value] ? replay.paths[value] : value)) : bindings;
  if (!saved || !isDeepStrictEqual(saved.inputs, seen)) return null;
  return structuredClone(saved.candidate);
}
export function unverifiable(id, iteration, step) {
  const why = step.ask ? 'it asks a person' : 'it changes an external system';
  fail(`Cannot replay ${id}:${iteration}: the step or its inputs changed, and ${why}. Record the case again from a new run.`, 'unverifiable');
}

/** Build a recording from a finished run: each accepted iteration's inputs and outputs, plus its effect observations. */
export async function recordRun(runDir) {
  const read = async name => JSON.parse(await readFile(pathResolve(runDir, name), 'utf8'));
  const method = await read('method.json'), manifest = await read('manifest.json');
  const events = (await readFile(pathResolve(runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const started = events.find(event => event.event === 'run.started');
  if (!started) fail(`The run has no run.started event: ${runDir}`, 'case_invalid');
  const iterations = {}, open = {};
  for (const event of events) {
    const at = `${event.step}:${event.iteration}`;
    if (event.event === 'step.started') open[at] = { inputs: event.inputs };
    else if (event.event === 'step.candidate' && open[at]) open[at].candidate = event.candidate;
    // An iteration reused from an earlier run has no candidate event; its accepted outputs are what that run's action returned.
    else if (event.event === 'step.accepted' && open[at] && (open[at].candidate || event.reused_from)) (iterations[event.step] ??= [])[event.iteration] = { inputs: open[at].inputs, candidate: open[at].candidate ?? event.outputs };
  }
  const tools = started.config?.tools ?? {};
  const keys = Object.fromEntries(Object.entries(method.steps).map(([id, step]) => [id, stepKey(step, { files: manifest.files, profiles: manifest.models, tools })]));
  const observations = {};
  for (const entry of currentEffects((await readLedger(runDir)).filter(entry => entry.observations))) {
    observations[entry.effect] = (await read(entry.observations)).observations;
  }
  return {
    format: 'method-recording/1', method_sha256: hash(documentForDigest(method)), execution_id: started.execution_id,
    inputs: started.inputs ?? {}, initial_state: started.initial_state ?? {}, environment: started.config?.environment ?? {}, keys, iterations, observations, method,
  };
}
