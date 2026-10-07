import { readFile, open, unlink, readdir, stat, appendFile } from 'node:fs/promises';
import { resolve as pathResolve, join } from 'node:path';
import { fail } from './validate.js';
import { hash, containedFile, writeJSON } from './io.js';
import { connectionsFor, observeEffect, readLedger, appendLedger, currentEffects, effectSummary, statusWithEffects, runObserverScript } from './effects.js';

async function lockRun(runDir) {
  const path = pathResolve(runDir, '.lock');
  try { const lock = await open(path, 'wx', 0o600); await lock.writeFile(String(process.pid)); return { close: async () => { await lock.close(); await unlink(path); } }; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fail('The run is active or locked. Observe it after its process stops.', 'run_locked');
  }
}

/**
 * Make the observations that are due for one finished run. Only observers run; no action runs.
 * The run's status changes when the new evidence changes what its effects establish.
 * @param {string} runDir
 * @param {{config?: any, now?: Date, signal?: AbortSignal, processPath?: string}} [options]
 */
export async function observeRun(runDir, options = {}) {
  runDir = pathResolve(runDir);
  const read = async name => JSON.parse(await readFile(pathResolve(runDir, name), 'utf8'));
  const lock = await lockRun(runDir);
  try {
    const summary = await read('summary.json');
    const ledger = await readLedger(runDir);
    const now = options.now ?? new Date();
    const due = currentEffects(ledger).filter(entry => !entry.final && entry.next_observation_at && Date.parse(entry.next_observation_at) <= now.getTime());
    if (!due.length || !['completed', 'unconfirmed'].includes(summary.status)) return { run_dir: runDir, status: summary.status, observed: [], changed: false, effects: ledger.length ? effectSummary(ledger) : null };
    const method = await read('method.json'), manifest = await read('manifest.json');
    const lines = (await readFile(pathResolve(runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    const started = lines.map(line => JSON.parse(line)).find(event => event.event === 'run.started');
    let sequence = JSON.parse(lines.at(-1)).sequence;
    const config = { ...started.config, ...options.config };
    const bundle = pathResolve(runDir, 'bundle');
    const verify = async file => { if (hash(await readFile(await containedFile(bundle, file))) !== manifest.files[file]) fail(`Bundle changed: ${file}`, 'bundle_changed'); };
    const signal = options.signal ?? new AbortController().signal;
    const record = async (event, data) => {
      const entry = { sequence: ++sequence, at: new Date().toISOString(), event, ...data };
      await appendFile(pathResolve(runDir, 'events.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    };
    const observed = [];
    for (const last of due) {
      const [stepId, , name] = last.effect.split('/');
      const spec = method.steps[stepId]?.effects?.[name];
      if (!spec) continue;
      const entry = await observeEffect({
        effect: spec, key: last.effect, token: last.token, inputs: last.inputs ?? {}, attempt: last.attempt + 1, actionOutcome: last.action_outcome, completedAt: last.completed_at, runDir, now,
        run: async (exec, input, role) => { await verify(exec.entrypoint); return runObserverScript({ exec, input, role, token: last.token, bundle, runtimeInfo: manifest.runtime_profiles, connections: connectionsFor(method, config.environment, 'observer'), processPath: options.processPath, signal, maxBytes: config.limits?.max_output_bytes ?? 16_777_216 }); },
      });
      await appendLedger(runDir, entry);
      await record('effect.observed', entry);
      observed.push(entry);
    }
    const { code, error, recovery, effects, status, ...rest } = summary;
    let result = null;
    try { result = await read('result.json'); } catch { /* A failed run has no result. */ }
    const next = statusWithEffects({ ...rest, status: 'completed', result }, effectSummary(await readLedger(runDir)));
    const { result: _, ...saved } = next;
    const changed = next.status !== summary.status;
    if (changed) await record('run.status_changed', { from: summary.status, to: next.status, ...(next.code ? { code: next.code } : {}) });
    await writeJSON(pathResolve(runDir, 'summary.json'), next.status === 'failed' ? saved : next);
    return { run_dir: runDir, status: next.status, observed, changed, effects: next.effects };
  } finally { await lock.close(); }
}

/** Run directories under `root` with effects that are still open. */
export async function pendingRuns(root) {
  const found = [];
  let names;
  try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return found; throw error; }
  for (const name of names) {
    const dir = join(root, name);
    try { if (!(await stat(dir)).isDirectory()) continue; } catch { continue; }
    if (currentEffects(await readLedger(dir).catch(() => [])).some(entry => !entry.final)) found.push(dir);
  }
  return found;
}
