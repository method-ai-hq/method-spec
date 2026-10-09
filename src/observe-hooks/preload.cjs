'use strict';
// Method runtime: record what a `run` step's Node process did, for observed_effects.
// The runtime loads this file with --require and names an output file in METHOD_OBSERVE_FILE.
// The variable is removed before the script starts. Observations go to the file at exit, never to
// stdout. Values of environment variables, URLs, and command arguments are never recorded: only
// names, hosts, paths, and program names.
const target = process.env.METHOD_OBSERVE_FILE;
if (target) {
  delete process.env.METHOD_OBSERVE_FILE;
  const fs = require('node:fs');
  const path = require('node:path');
  const { fileURLToPath } = require('node:url');
  const dc = require('node:diagnostics_channel');
  const childProcess = require('node:child_process');
  const custom = require('node:util').promisify.custom;
  const writeFileSync = fs.writeFileSync;
  const cap = 2000;
  const sets = { network: new Set(), reads: new Set(), writes: new Set(), env: new Set(), runs: new Set() };
  let dropped = false, active = true, envQuiet = 0;
  const note = (kind, value) => {
    if (!active || typeof value !== 'string' || !value) return;
    const found = sets[kind];
    if (found.size < cap) found.add(value);
    else if (!found.has(value)) dropped = true;
  };
  const hostOf = value => typeof value === 'string' ? value.replace(/^\[|\]$/g, '').replace(/:\d+$/, '') : null;
  const pathOf = value => {
    if (typeof value === 'string') return path.resolve(value);
    if (Buffer.isBuffer(value)) return path.resolve(value.toString());
    if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
    return null; // A file descriptor names no path.
  };
  const { O_WRONLY, O_RDWR, O_CREAT, O_APPEND, O_TRUNC } = fs.constants;
  const writing = flags => typeof flags === 'number' ? (flags & (O_WRONLY | O_RDWR | O_CREAT | O_APPEND | O_TRUNC)) !== 0 : typeof flags === 'string' && /[wax+]/.test(flags);
  const shells = new Set(['sh', 'bash', 'zsh', 'dash']);
  const program = (file, args, shell) => {
    const text = String(file ?? '');
    if (shell) return path.basename(text.trim().split(/\s+/)[0] ?? '');
    const name = path.basename(text);
    if (shells.has(name) && Array.isArray(args) && args[0] === '-c' && typeof args[1] === 'string') return path.basename(args[1].trim().split(/\s+/)[0] ?? name);
    return name;
  };
  const wrap = (object, name, observe) => {
    const original = object[name];
    if (typeof original !== 'function') return;
    const wrapped = function (...args) { try { observe(args); } catch { /* Observation never changes the call. */ } return original.apply(this, args); };
    Object.defineProperty(wrapped, 'name', { value: original.name });
    Object.defineProperty(wrapped, 'length', { value: original.length });
    for (const key of Reflect.ownKeys(original)) if (!['name', 'length', 'prototype'].includes(String(key))) try { wrapped[key] = original[key]; } catch { /* read-only */ }
    object[name] = wrapped;
  };
  const read = a => note('reads', pathOf(a[0]));
  const write = a => note('writes', pathOf(a[0]));
  const both = a => { note('reads', pathOf(a[0])); note('writes', pathOf(a[1])); };
  const moved = a => { note('writes', pathOf(a[0])); note('writes', pathOf(a[1])); };
  const opened = a => note(writing(a[1] ?? 'r') ? 'writes' : 'reads', pathOf(a[0]));
  const fileHooks = { open: opened, readFile: read, readdir: read, opendir: read, writeFile: write, appendFile: write, truncate: write, mkdir: write, rm: write, rmdir: write, unlink: write, copyFile: both, cp: both, rename: moved };
  for (const [name, observe] of Object.entries(fileHooks)) {
    wrap(fs, name, observe);
    wrap(fs, `${name}Sync`, observe);
    wrap(fs.promises, name, observe);
  }
  // Spawning with the default environment copies every variable; that is not a read by the script.
  const spawnHook = (name, describe) => {
    const original = childProcess[name];
    if (typeof original !== 'function') return;
    childProcess[name] = Object.defineProperty(function (...args) {
      try { note('runs', describe(args)); } catch { /* Observation never changes the call. */ }
      envQuiet++;
      try { return original.apply(this, args); } finally { envQuiet--; }
    }, 'name', { value: original.name });
    if (original[custom]) childProcess[name][custom] = original[custom];
  };
  const options = args => args.find(a => a && typeof a === 'object' && !Array.isArray(a)) ?? {};
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) spawnHook(name, a => program(a[0], Array.isArray(a[1]) ? a[1] : [], options(a.slice(1)).shell));
  for (const name of ['exec', 'execSync']) spawnHook(name, a => program(a[0], [], true));
  spawnHook('fork', () => 'node');
  require('node:module').syncBuiltinESMExports();

  dc.subscribe('undici:request:create', message => { try { note('network', hostOf(new URL(message.request.origin).hostname)); } catch { /* no origin */ } });
  dc.subscribe('http.client.request.start', message => { try { note('network', hostOf(message.request.host)); } catch { /* no host */ } });
  dc.subscribe('net.client.socket', message => {
    const socket = message.socket;
    let looked = false;
    socket.once('lookup', (error, address, family, host) => { looked = true; note('network', hostOf(host)); });
    socket.once('connect', () => { if (!looked) note('network', hostOf(socket.remoteAddress)); });
  });

  // Node's own modules (node:internal/..., including its bundled fetch) read variables too; those are not the script's.
  const fromScript = () => {
    const prepare = Error.prepareStackTrace, limit = Error.stackTraceLimit;
    let frames;
    try {
      Error.stackTraceLimit = 3;
      Error.prepareStackTrace = (error, sites) => sites;
      const holder = {};
      Error.captureStackTrace(holder, fromScript);
      frames = holder.stack;
    } finally { Error.prepareStackTrace = prepare; Error.stackTraceLimit = limit; }
    const caller = Array.isArray(frames) ? frames[1]?.getFileName?.() : undefined;
    return typeof caller === 'string' && !caller.startsWith('node:');
  };
  const env = process.env;
  process.env = new Proxy(env, {
    get(object, key) { if (typeof key === 'string' && !envQuiet && active && fromScript()) note('env', key); return Reflect.get(object, key); },
    set(object, key, value) { if (typeof key === 'string') note('env', key); object[key] = value; return true; },
    deleteProperty(object, key) { if (typeof key === 'string') note('env', key); return delete object[key]; },
  });

  process.on('exit', () => {
    active = false;
    const data = Object.fromEntries(Object.entries(sets).map(([kind, values]) => [kind, [...values].sort()]));
    if (dropped) data.dropped = true;
    try { writeFileSync(target, JSON.stringify(data)); } catch { /* The runtime reports observations as unavailable. */ }
  });
}
