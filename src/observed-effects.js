import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = fileURLToPath(new URL('./observe-hooks/', import.meta.url));
const KINDS = ['network', 'reads', 'writes', 'env', 'runs'];
export const OBSERVED_LIMIT = 200;
// Source files that an interpreter loads are not reads by the script's logic.
const CODE = /\.(py|pyc|pyo|pth|so|dylib|js|mjs|cjs|node)$/;

/** The language whose process the runtime can observe, from the runtime profile's executable. */
function language(command) {
  const name = basename(String(command)).toLowerCase().replace(/\.exe$/, '');
  if (/^python(\d+(\.\d+)*)?$/.test(name)) return 'python';
  if (name === 'node' || name === 'nodejs') return 'node';
  return null;
}

const inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
async function real(path) {
  try { return await realpath(path); } catch { /* The file may be gone; resolve its folder. */ }
  try { return join(await realpath(dirname(path)), basename(path)); } catch { return path; }
}

/**
 * Prepare to observe one script process. The result adds arguments before the profile's own arguments and
 * variables to its environment; `finish` reads what the process recorded. Observation never fails the step:
 * a problem gives `{unavailable: reason}`.
 * @param {{command: string}} profile
 * @param {{runDir: string, bundle: string, artifacts: string, env: Record<string, string>}} where
 * @returns {Promise<{args: string[], env: Record<string, string>, finish: () => Promise<any>}>}
 */
export async function prepareObservation(profile, { runDir, bundle, artifacts, env }) {
  const kind = language(profile.command);
  if (!kind) return { args: [], env: {}, finish: async () => ({ unavailable: 'runtime_not_observed' }) };
  let folder;
  try { folder = await mkdtemp(join(tmpdir(), 'method-observe-')); }
  catch (error) { return { args: [], env: {}, finish: async () => ({ unavailable: `observe_setup_failed: ${error.code ?? 'error'}` }) }; }
  const file = join(folder, 'observed.json');
  const added = { METHOD_OBSERVE_FILE: file };
  if (kind === 'python') {
    added.PYTHONPATH = env.PYTHONPATH ? hooks + delimiter + env.PYTHONPATH : hooks;
    if (env.PYTHONPATH !== undefined) added.METHOD_OBSERVE_PYTHONPATH = env.PYTHONPATH;
  }
  const finish = async () => {
    try {
      let raw;
      try { raw = JSON.parse(await readFile(file, 'utf8')); }
      catch { return { unavailable: kind === 'python' ? 'no_observations (the process ended without exit handlers, or Python ignored PYTHONPATH)' : 'no_observations (the process ended without exit handlers)' }; }
      return await summarize(raw, { runDir, bundle, artifacts, folder });
    } catch (error) {
      return { unavailable: `observe_failed: ${error.message}` };
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  };
  return { args: kind === 'node' ? ['--require', join(hooks, 'preload.cjs')] : [], env: added, finish };
}

/** Turn a process's raw observations into the recorded shape: sorted, unique, bounded, without the runtime's own files. */
async function summarize(raw, { runDir, bundle, artifacts, folder }) {
  const [run, code, out, own, observe] = await Promise.all([runDir, bundle, artifacts, hooks, folder].map(real));
  const placePath = async (path, write) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return null;
    const at = await real(path);
    if (at.startsWith('/dev/') || at.startsWith('/proc/') || inside(own, at) || inside(observe, at)) return null;
    if (/[\\/](node_modules|site-packages|dist-packages|__pycache__)([\\/]|$)/.test(at)) return null;
    if (inside(out, at)) return write && at !== out ? `$METHOD_OUTPUT_DIR/${relative(out, at).split(sep).join('/')}` : null;
    if (inside(code, at)) return at === code || (!write && CODE.test(at)) ? null : relative(code, at).split(sep).join('/');
    if (inside(run, at)) return null;
    return at;
  };
  const list = async (values, map) => [...new Set((await Promise.all((Array.isArray(values) ? values : []).map(map))).filter(v => typeof v === 'string' && v))].sort();
  const lists = {
    network: await list(raw.network, async host => typeof host === 'string' ? host.toLowerCase() : null),
    reads: await list(raw.reads, path => placePath(path, false)),
    writes: await list(raw.writes, path => placePath(path, true)),
    // Names that the runtime itself sets are not the script's own inputs.
    env: await list(raw.env, async name => typeof name === 'string' && !name.startsWith('METHOD_') ? name : null),
    runs: await list(raw.runs, async name => typeof name === 'string' ? name : null),
  };
  let truncated = raw.dropped === true;
  const result = {};
  for (const kind of KINDS) {
    if (lists[kind].length > OBSERVED_LIMIT) truncated = true;
    result[kind] = lists[kind].slice(0, OBSERVED_LIMIT);
  }
  if (truncated) result.truncated = true;
  return result;
}
