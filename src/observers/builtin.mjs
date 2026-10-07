// Built-in observers: file, sqlite and http. The runtime runs this script in a separate process,
// with only the observer connections. Mode "fetch" reads; mode "judge" decides from observations.
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';

const mode = process.argv[2];
const input = JSON.parse(readFileSync(0, 'utf8'));
const { spec, token, inputs = {} } = input;
const fill = template => template.replace(/\{(token|inputs\.[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)\}/g, (_, key) => {
  const value = key === 'token' ? token : key.split('.').slice(1).reduce((v, k) => v?.[k], inputs);
  if (value === undefined || value === null || typeof value === 'object') throw Error(`No text or number for {${key}}`);
  return String(value);
});
// A value that is one whole placeholder keeps its type, so a number stays a number in a query.
const whole = /^\{(token|inputs\.[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)\}$/;
const fillAll = value => typeof value === 'string' ? (whole.test(value) && value !== '{token}' ? (() => { const v = value.slice(8, -1).split('.').reduce((x, k) => x?.[k], inputs); if (v === undefined || v === null || typeof v === 'object') throw Error(`No text or number for ${value}`); return v; })() : fill(value)) : Array.isArray(value) ? value.map(fillAll)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillAll(v)])) : value;
const at = (value, path) => path.split('.').reduce((v, k) => v === null || v === undefined ? undefined : v[k], value);
const print = value => process.stdout.write(JSON.stringify(value) + '\n');

function connection() {
  const all = JSON.parse(process.env.METHOD_ENVIRONMENT ?? '{}');
  if (!Object.hasOwn(all, spec.connection)) throw Error(`Observer connection ${spec.connection} is not configured`);
  return all[spec.connection];
}
function inside(root, path) {
  const base = realpathSync(root), full = resolve(base, path);
  const rel = relative(base, full);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('sensitive')) throw Error(`${path} is outside the observer connection`);
  return full;
}

async function fetchObservations() {
  if (spec.kind === 'file') {
    const path = fill(spec.path), full = inside(connection(), path);
    if (!existsSync(full)) return [{ source: 'file', ref: path, data: { exists: false } }];
    if (!statSync(full).isFile()) return [{ source: 'file', ref: path, data: { exists: true, regular: false } }];
    const bytes = readFileSync(full);
    // Keep the text only when a contains test needs it, and never more than 1 MB.
    return [{ source: 'file', ref: path, data: { exists: true, regular: true, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(spec.expect?.contains !== undefined ? { contains: bytes.subarray(0, 1_000_000).toString('utf8').includes(fill(spec.expect.contains)) } : {}) } }];
  }
  if (spec.kind === 'sqlite') {
    if (!/^\s*(select|with)\b/i.test(spec.query)) throw Error('A sqlite observer runs one SELECT query');
    const { DatabaseSync } = await import('node:sqlite');
    const path = inside(connection(), fill(spec.database));
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare(spec.query).all(fillAll(spec.params ?? {}));
      return [{ source: 'sqlite', ref: fill(spec.database), data: { count: rows.length, rows: rows.slice(0, 20).map(row => ({ ...row })) } }];
    } finally { db.close(); }
  }
  if (spec.kind === 'http') {
    const base = connection();
    const url = new URL(fill(spec.path), base.endsWith('/') ? base : base + '/');
    const method = spec.method ?? 'GET';
    const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/json', ...(spec.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(process.env.METHOD_OBSERVER_TOKEN ? { authorization: `Bearer ${process.env.METHOD_OBSERVER_TOKEN}` } : {}) },
      ...(spec.body !== undefined ? { body: JSON.stringify(fillAll(spec.body)) } : {}) });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* reported by status only */ }
    // Keep only the fields the expectation reads, so large states do not fill the ledger.
    const fields = Object.fromEntries(Object.keys(spec.expect?.fields ?? {}).map(path => [path, body === null ? null : at(body, path) ?? null]));
    return [{ source: 'http', ref: `${method} ${url.pathname}${url.search}`, data: { status: response.status, json: body !== null, fields } }];
  }
  throw Error(`Unknown observer kind ${spec.kind}`);
}

function judge({ observations, previous = [], final = false }) {
  const read = observations.at(-1);
  const evidence = read ? [read.ref] : [];
  if (!read) return { verdict: 'no_evidence', reason: 'Nothing was read.', evidence };
  const expect = spec.expect ?? {};
  if (spec.kind === 'file') {
    const d = read.data, wantExists = expect.exists ?? true;
    if (!d.exists) return wantExists ? { verdict: 'no_evidence', reason: `${read.ref} does not exist yet.`, evidence } : { verdict: 'confirmed', reason: `${read.ref} does not exist.`, evidence };
    if (!wantExists) return { verdict: 'contradicted', reason: `${read.ref} still exists.`, evidence };
    if (!d.regular) return { verdict: 'contradicted', reason: `${read.ref} is not a regular file.`, evidence };
    if (expect.sha256 !== undefined && d.sha256 !== fill(expect.sha256)) return { verdict: 'contradicted', reason: `${read.ref} has different contents.`, evidence };
    if (expect.contains !== undefined && !d.contains) return { verdict: 'contradicted', reason: `${read.ref} does not contain the intended text.`, evidence };
    return { verdict: 'confirmed', reason: `${read.ref} exists${expect.sha256 ? ' with the intended contents' : ''}${expect.contains !== undefined ? ' and contains the intended text' : ''}.`, evidence };
  }
  if (spec.kind === 'sqlite') {
    const count = read.data.count, min = expect.rows ?? expect.min_rows ?? 1, max = expect.rows ?? expect.max_rows ?? Infinity;
    if (count > max) return { verdict: 'contradicted', reason: `${count} matching rows; at most ${max} intended${max === 1 ? ' (a duplicate)' : ''}.`, evidence };
    if (count >= min) return { verdict: 'confirmed', reason: `${count} matching row${count === 1 ? '' : 's'}.`, evidence };
    return { verdict: 'no_evidence', reason: `${count} matching rows; ${min} intended.`, evidence };
  }
  const d = read.data;
  if ([404, 410].includes(d.status)) return { verdict: 'no_evidence', reason: `Not there yet (${d.status}).`, evidence };
  const statuses = expect.status ?? [200, 201, 202, 203, 204];
  if (!statuses.includes(d.status) || !d.json) return { verdict: 'unobservable', reason: `The service answered ${d.status}${d.json ? '' : ' without JSON'}.`, evidence };
  const before = previous.at(-1)?.observations?.at(-1)?.data?.fields ?? null;
  let waiting = false;
  for (const [path, want] of Object.entries(expect.fields ?? {})) {
    const value = d.fields[path];
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if (want.at_least !== undefined && !(typeof value === 'number' && value >= want.at_least)) return { verdict: final ? 'contradicted' : 'no_evidence', reason: `${path} is ${JSON.stringify(value)}; at least ${want.at_least} intended.`, evidence };
      if (want.at_most !== undefined && !(typeof value === 'number' && value <= want.at_most)) return { verdict: 'contradicted', reason: `${path} is ${JSON.stringify(value)}; at most ${want.at_most} intended.`, evidence };
      if (want.increases) {
        // A rate needs two readings. Each later reading must be higher than the one before it.
        if (before === null) { waiting = true; continue; }
        if (!(typeof value === 'number' && typeof before[path] === 'number' && value > before[path])) return { verdict: 'contradicted', reason: `${path} stopped increasing (${JSON.stringify(before[path])} → ${JSON.stringify(value)}).`, evidence };
        if (!final) waiting = true;
      }
    } else if (JSON.stringify(value) !== JSON.stringify(fillAll(want))) return { verdict: 'contradicted', reason: `${path} is ${JSON.stringify(value)}; ${JSON.stringify(fillAll(want))} intended.`, evidence };
  }
  if (waiting) return { verdict: 'no_evidence', reason: 'The values so far are as intended; later readings must confirm the trend.', evidence };
  return { verdict: 'confirmed', reason: 'The service shows the intended values.', evidence };
}

if (mode === 'fetch') print({ observations: await fetchObservations() });
else if (mode === 'judge') print(judge(input));
else throw Error('Use fetch or judge');
