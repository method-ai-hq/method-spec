import { readFile, realpath, mkdir, writeFile, rename, access } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import YAML from 'yaml';
import { fail, safeData } from './validate.js';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export async function readDocument(file) {
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > 2_000_000) fail('Document exceeds 2 MB');
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) fail(doc.errors.map(x => x.message).join('; '));
  const value = doc.toJS({ maxAliasCount: 20 });
  safeData(value);
  return value;
}
export function relativeFile(path) {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(x => !x || x === '..' || x === '.' || x === 'sensitive' || x === '.git' || x === 'node_modules' || x.startsWith('.env') || x === 'secrets.env')) fail(`Invalid bundle path: ${path}`);
  return path;
}
export async function containedFile(root, file) {
  const base = await realpath(root);
  const path = await realpath(resolve(base, file));
  const rel = relative(base, path);
  if (rel.startsWith('..') || isAbsolute(rel)) fail('File escapes its allowed directory');
  return path;
}
export async function snapshotBundle(root, paths, destination) {
  const manifest = {};
  for (const name of [...new Set(paths)].sort()) {
    relativeFile(name);
    const source = await containedFile(root, name);
    const bytes = await readFile(source);
    if (bytes.length > 20_000_000) fail(`Bundle file exceeds 20 MB: ${name}`);
    manifest[name] = hash(bytes);
    await mkdir(dirname(resolve(destination, name)), { recursive: true, mode: 0o700 });
    await writeFile(resolve(destination, name), bytes, { mode: 0o600 });
  }
  return manifest;
}
export async function writeJSON(file, data) {
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
export async function executable(command) {
  const choices = command.includes('/') ? [resolve(command)] : (process.env.PATH ?? '').split(delimiter).map(p => resolve(p, command));
  for (const candidate of choices) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next PATH entry. */ }
  }
  fail(`Runtime executable not found: ${command}`, 'preflight');
}
export function executeProcess({ command, args, cwd, input, env, signal, maxBytes }) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    let stdout = [], stderr = [], bytes = 0, failure;
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: false });
    const kill = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Process group already ended. */ }
    };
    const abort = () => { failure = signal.reason ?? new Error('Aborted'); kill(); };
    signal.addEventListener('abort', abort, { once: true });
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = Object.assign(new Error('Process output limit exceeded'), { code: 'output_limit' }); kill(); }
      else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => {});
    child.on('error', error => { failure = error; });
    // Do not permit a successful script to leave background workers running.
    child.on('exit', kill);
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      const diagnostics = Buffer.concat(stderr).toString('utf8');
      const output = Buffer.concat(stdout).toString('utf8');
      if (failure || code !== 0) {
        const error = failure ?? Object.assign(new Error(`Process exited with code ${code}`), { code: 'process_failed' });
        error.diagnostics = diagnostics; error.output = output;
        reject(error);
      } else resolvePromise({ output, diagnostics });
    });
    child.stdin.end(JSON.stringify(input));
    if (signal.aborted) abort();
  });
}
