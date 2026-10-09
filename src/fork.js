import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve as pathResolve, dirname, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { effectiveOutputs, resolve, own, fail, shape } from './semantics.js';
import { executionTools } from './tool-connections.js';
import { hash, containedFile, relativeFile } from './io.js';

const external = new Set(['inputs', 'state', 'environment', 'run']);
// Display text does not change execution, so it does not block reuse.
const executable = ({ name, reading, ...definition }) => definition;
const lookup = (root, reference) => { try { return { value: resolve(root, reference) }; } catch { return { missing: true }; } };

/**
 * Read the saved records of a parent run without changing it.
 * @param {string} dir
 */
export async function readParentRun(dir) {
  const read = async name => {
    try { return JSON.parse(await readFile(pathResolve(dir, name), 'utf8')); }
    catch { return fail(`The parent run has no readable ${name}: ${dir}`, 'fork_mismatch'); }
  };
  try {
    const owner = Number(await readFile(pathResolve(dir, '.lock'), 'utf8'));
    try { process.kill(owner, 0); fail('The parent run is still active. Fork it after its process stops.', 'fork_mismatch'); }
    catch (error) { if (error.code === 'fork_mismatch') throw error; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const checkpoint = await read('checkpoint.json'), manifest = await read('manifest.json'), method = await read('method.json');
  let started;
  try {
    for (const line of (await readFile(pathResolve(dir, 'events.jsonl'), 'utf8')).split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (entry.event === 'run.started') { started = entry; break; }
    }
  } catch { /* reported below */ }
  if (!started) fail(`The parent run has no run.started event: ${dir}`, 'fork_mismatch');
  return { dir, checkpoint, manifest, method, config: started.config ?? {}, initialState: started.initial_state ?? {} };
}

/**
 * Select the parent's accepted outputs that a new run may reuse.
 * A step is reusable only when everything that determines its execution is unchanged.
 */
export function planFork({ parent, method, dependencies, steps, root, profiles, config, runtimeInfo, manifest }) {
  const reuse = new Set(steps);
  if (!reuse.size) fail('Name the accepted steps to reuse with --reuse STEP.', 'fork_mismatch');
  const saved = parent.checkpoint, tools = config.tools ?? {}, parentFiles = parent.manifest.files ?? {};
  const parentRoot = { inputs: saved.root?.inputs, state: parent.initialState, environment: saved.root?.environment, run: saved.root?.run };
  const changesState = Object.values(method.steps).some(s => (s.changes ?? []).some(x => x.startsWith('state.')));
  const accepted = {}, skipped = [], collections = {}, imported = [];
  for (const id of reuse) {
    const step = method.steps[id], before = parent.method.steps?.[id];
    const refuse = reason => fail(`Cannot reuse ${id}: ${reason}.`, 'fork_mismatch');
    if (!step) refuse('this Method has no such step');
    if (!before) refuse('the parent run has no such step');
    for (const dependency of dependencies[id]) if (!reuse.has(dependency)) refuse(`it depends on ${dependency}; reuse ${dependency} as well`);
    if (hash(executable(step)) !== hash(executable(before))) refuse('its definition changed');
    if (step.changes?.length) refuse('it changes state or an external system');
    for (const ref of [...Object.values(step.in ?? {}), ...Object.values(step.each ?? {}), ...(step.when ? [step.when] : [])]) {
      const head = ref.split('.')[0];
      if (!external.has(head)) continue;
      if (head === 'state' && changesState) refuse(`it reads ${ref}, which another step can change`);
      if (!isDeepStrictEqual(lookup(parentRoot, ref), lookup(root, ref))) refuse(`${ref} differs from the parent run`);
    }
    for (const exec of [step.do, step.check]) if (exec?.kind) {
      if (exec.model && !isDeepStrictEqual(profiles[exec.model], saved.models?.[exec.model])) refuse(`model profile ${exec.model} changed`);
      if (exec.kind === 'classify' && !isDeepStrictEqual(config.classification, parent.config.classification)) refuse('the classification setup changed');
      const scripts = exec.kind === 'run' ? [exec] : [];
      for (const name of executionTools(exec, tools)) {
        if (!isDeepStrictEqual(tools[name], parent.config.tools?.[name])) refuse(`tool ${name} changed`);
        if (tools[name].run) scripts.push(tools[name].run);
      }
      for (const script of scripts) {
        if (manifest[script.entrypoint] !== parentFiles[script.entrypoint]) refuse(`${script.entrypoint} changed`);
        if (!isDeepStrictEqual(runtimeInfo[script.runtime], parent.manifest.runtime_profiles?.[script.runtime])) refuse(`runtime ${script.runtime} changed`);
      }
    }
    if (saved.skipped?.includes(id)) { skipped.push(id); imported.push({ step: id, skipped: true }); continue; }
    const iterations = saved.accepted?.[id] ?? [];
    const each = Object.keys(step.each ?? {}).length > 0;
    const complete = each ? own(saved.collections ?? {}, id) && iterations.length === saved.collections[id].length && iterations.every(Boolean)
      : step.repeat?.until ? iterations.length > 0 && lookup(iterations.at(-1), step.repeat.until).value === true
      : iterations.length === (step.repeat?.max_iterations ?? 1);
    if (!complete) refuse('the parent run did not accept all of its iterations');
    accepted[id] = structuredClone(iterations);
    if (each) collections[id] = structuredClone(saved.collections[id]);
    imported.push({ step: id, iterations: iterations.length, outputs_sha256: hash(iterations) });
  }
  const changedFiles = [...new Set([...Object.keys(manifest), ...Object.keys(parentFiles)])].sort()
    .filter(file => manifest[file] !== parentFiles[file])
    .map(file => ({ file, change: !own(parentFiles, file) ? 'added' : !own(manifest, file) ? 'removed' : 'changed' }));
  return {
    accepted, skipped, collections,
    provenance: {
      run_dir: parent.dir, execution_id: saved.execution_id, executor_version: saved.executor_version, method_sha256: saved.method_sha256,
      steps: imported, changed_files: changedFiles,
      // Entrypoints are traced to steps; helper files they import are not.
      file_evidence: changedFiles.length ? 'entrypoints' : 'bundle',
    },
  };
}

/** Copy the declared file outputs of reused steps into the new run's artifacts. */
export async function copyForkFiles(parent, method, accepted, artifacts) {
  const from = pathResolve(parent.dir, 'artifacts');
  const copy = async path => {
    const target = pathResolve(artifacts, relativeFile(path));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(await containedFile(from, path), target);
  };
  async function visit(definition, value) {
    const def = shape(definition);
    if (def.type === 'file') {
      await copy(value.path);
      // A website result lists its assets beside its own file.
      if (def.format === 'method-website') {
        const site = JSON.parse(await readFile(pathResolve(artifacts, value.path), 'utf8'));
        for (const asset of site.files ?? []) await copy(posix.join(posix.dirname(value.path), asset.path));
      }
    } else if (def.type === 'record') for (const [name, child] of Object.entries(def.fields)) await visit(child, value[name]);
    else if (def.type === 'list') for (const item of value) await visit(def.fields ? { type: 'record', fields: def.fields } : def.items, item);
  }
  for (const [id, iterations] of Object.entries(accepted)) for (const outputs of iterations)
    for (const [name, def] of Object.entries(effectiveOutputs(method.steps[id]))) await visit(def, outputs[name]);
}
