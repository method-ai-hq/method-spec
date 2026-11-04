import { readFile, copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve as pathResolve, dirname, posix, isAbsolute, join, relative, sep } from 'node:path';
import { effectiveOutputs, shape, modelName } from './semantics.js';
import { executionTools } from './tool-connections.js';
import { hash, containedFile, relativeFile } from './io.js';
import { learnedFile } from './learned.js';
import { connectionsFor } from './effects.js';

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
 * because the runtime does not trace which helper files a script imports. learned.json is not such a file: only the
 * step's own active rules (rules) are part of its key. read holds the content of the local files and folders that the
 * iteration can read (readPaths), so a changed file in a bound folder runs the step again. repeat numbers the repeats of the same work: each repeat is a separate run, so a step of one repeat is never
 * reused in another, while unchanged steps of the same repeat are.
 */
export function iterationKey({ method, step, bindings, iteration, profiles, config, runtimeInfo, manifest, rules = [], repeat = 0, read }) {
  const tools = config.tools ?? {};
  const { execs, used, scripts } = stepScripts(step, tools);
  const own = new Set(scripts.map(script => script.entrypoint));
  const others = new Set(Object.values(method.steps).flatMap(other => stepScripts(other, tools).scripts.map(script => script.entrypoint)).filter(file => !own.has(file)));
  return hash({
    key: 'method-step/1', step: executable(step), bindings, iteration: step.each ? null : iteration,
    models: execs.filter(exec => ['call', 'agent'].includes(exec.kind)).map(exec => profiles[modelName(exec)]),
    classification: execs.some(exec => exec.kind === 'classify') ? config.classification ?? null : null,
    tools: used.map(name => [name, tools[name]]),
    runtimes: [...new Set(scripts.map(script => script.runtime))].sort().map(name => runtimeInfo[name] ?? null),
    bundle: scripts.length ? Object.fromEntries(Object.entries(manifest).filter(([file]) => !others.has(file) && file !== learnedFile)) : null,
    ...(rules.length ? { learned: rules } : {}),
    ...(read && Object.keys(read).length ? { read } : {}),
    ...(repeat ? { repeat } : {}),
  });
}

const absolutePath = value => typeof value === 'string' && value.length < 4096 && !value.includes('\n') && isAbsolute(value);
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

/**
 * The local files and folders that an iteration can read: each absolute path among its inputs, each files connection
 * that its inputs name, its session's room folder, and, for a step that runs a script, every files connection, because
 * a script gets them all in METHOD_ENVIRONMENT.
 * @param {{ method: any, step: any, bindings: Record<string, any>, environment?: Record<string, any>, tools: Record<string, any>, room?: string }} options
 */
export function readPaths({ method, step, bindings, environment = {}, tools, room }) {
  const files = name => method.environment?.[name]?.type === 'files' && typeof environment[name] === 'string';
  const named = Object.values(step.in ?? {}).filter(ref => typeof ref === 'string' && ref.startsWith('environment.')).map(ref => ref.slice(12).split('.')[0]);
  const reachable = stepScripts(step, tools).scripts.length ? Object.keys(connectionsFor(method, environment)) : [];
  const paths = [...strings(bindings).filter(absolutePath), ...[...named, ...reachable].filter(files).map(name => environment[name]), ...(room ? [room] : [])];
  return [...new Set(paths.map(path => pathResolve(path)))].sort();
}

// The same limits and skipped folders as the copies of a case.
const readLimit = { files: 5000, bytes: 100_000_000 };
const readSkip = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

/**
 * The content hash of each file under each path, by path, or null when they hold more than the limit, so the iteration
 * is not reused. A path that does not exist is null; a folder lists its files by their path inside it.
 * @param {string[]} paths
 */
export async function pathContents(paths) {
  const used = { files: 0, bytes: 0 };
  const read = async file => {
    used.files++; used.bytes += (await stat(file)).size;
    if (used.files > readLimit.files || used.bytes > readLimit.bytes) throw Object.assign(Error('large'), { code: 'too_large' });
    return hash(await readFile(file));
  };
  const contents = {};
  try {
    for (const path of paths) {
      const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) { contents[path] = null; continue; }
      if (info.isFile()) { contents[path] = await read(path); continue; }
      const tree = contents[path] = {};
      const visit = async dir => {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
          if (readSkip.has(entry.name)) continue;
          const child = join(dir, entry.name);
          if (entry.isDirectory()) await visit(child);
          else if (entry.isFile()) tree[relative(path, child).split(sep).join('/')] = await read(child);
        }
      };
      if (info.isDirectory()) await visit(path);
    }
  } catch (error) {
    if (error.code === 'too_large') return null;
    throw error;
  }
  return contents;
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
      const observed = checkpoint.observed?.[id]?.[iteration];
      if (outputs && !found.has(key)) found.set(key, { dir, outputs, ...(observed ? { observed } : {}) });
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
    } else if (def.type === 'record') for (const [name, child] of Object.entries(def.fields ?? {})) await visit(child, value[name]);
    else if (def.type === 'list') for (const item of value) await visit(def.fields ? { type: 'record', fields: def.fields } : def.items, item);
  }
  for (const [name, def] of Object.entries(effectiveOutputs(step))) await visit(def, outputs[name]);
}
