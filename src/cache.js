import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve as pathResolve, dirname, posix } from 'node:path';
import { effectiveOutputs, shape } from './semantics.js';
import { executionTools } from './tool-connections.js';
import { hash, containedFile, relativeFile } from './io.js';

// Display text does not change execution, so it does not change the key.
const executable = ({ name, purpose, reading, ...definition }) => definition;

/**
 * A step iteration can be reused when it asks nobody and changes nothing outside the run.
 * @param {any} step
 * @param {Record<string, any>} tools
 */
export function cacheable(step, tools) {
  if (step.ask || step.effects || step.changes?.length) return false;
  return [step.do, step.check].filter(exec => exec?.kind).every(exec => executionTools(exec, tools).every(name => !tools[name]?.effects?.length));
}

/** Scripts that a step executes: its own run actions and checks, and the scripts of the tools it uses. */
function stepScripts(step, tools) {
  const execs = [step.do, step.check].filter(exec => exec?.kind);
  const used = [...new Set(execs.flatMap(exec => executionTools(exec, tools)))].sort();
  return { execs, used, scripts: [...execs.filter(exec => exec.kind === 'run'), ...used.map(name => tools[name].run).filter(Boolean)] };
}

/**
 * Everything that determines what an iteration returns: its definition, its resolved inputs, and what it executes.
 * A script step's key covers its own entrypoints and every bundle file that is not another step's entrypoint,
 * because the runtime does not trace which helper files a script imports.
 */
export function iterationKey({ method, step, bindings, iteration, profiles, config, runtimeInfo, manifest }) {
  const tools = config.tools ?? {};
  const { execs, used, scripts } = stepScripts(step, tools);
  const own = new Set(scripts.map(script => script.entrypoint));
  const others = new Set(Object.values(method.steps).flatMap(other => stepScripts(other, tools).scripts.map(script => script.entrypoint)).filter(file => !own.has(file)));
  return hash({
    key: 'method-step/1', step: executable(step), bindings, iteration: step.each ? null : iteration,
    models: execs.filter(exec => exec.model).map(exec => profiles[exec.model]),
    classification: execs.some(exec => exec.kind === 'classify') ? config.classification ?? null : null,
    tools: used.map(name => [name, tools[name]]),
    runtimes: [...new Set(scripts.map(script => script.runtime))].sort().map(name => runtimeInfo[name] ?? null),
    bundle: scripts.length ? Object.fromEntries(Object.entries(manifest).filter(([file]) => !others.has(file))) : null,
  });
}

/**
 * Read the accepted iterations of earlier runs by key. A run that cannot be read is skipped.
 * @param {string[]} dirs
 */
export async function readCache(dirs) {
  const found = new Map();
  for (const dir of dirs) {
    let checkpoint;
    try { checkpoint = JSON.parse(await readFile(pathResolve(dir, 'checkpoint.json'), 'utf8')); } catch { continue; }
    for (const [key, [id, iteration]] of Object.entries(checkpoint.cache ?? {})) {
      const outputs = checkpoint.accepted?.[id]?.[iteration];
      if (outputs && !found.has(key)) found.set(key, { dir, outputs });
    }
  }
  return found;
}

/** Copy the declared file outputs of reused iterations into this run's artifacts. */
export async function copyOutputFiles(fromDir, step, outputs, artifacts) {
  const from = pathResolve(fromDir, 'artifacts');
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
  for (const [name, def] of Object.entries(effectiveOutputs(step))) await visit(def, outputs[name]);
}
