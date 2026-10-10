import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod, validateMethod, observeRun, readLedger } from '../src/index.js';

const text = { type: 'text', description: 'A test value.' };
const script = entrypoint => ({ kind: 'run', runtime: 'node', entrypoint });
const config = (environment = {}) => ({
  limits: { timeout_ms: 20000, max_model_requests: 5, max_invocations: 20, max_tool_calls: 5, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
  runtimes: { node: { command: process.execPath, version: process.version } }, environment,
});
const effect = (extra = {}) => ({
  intent: 'The recipient mail server accepts the message and does not return it.',
  in: { to: 'inputs.to' }, observe: script('observe.mjs'), judge: script('judge.mjs'), fixtures: 'fixtures/delivery',
  schedule: { first: '0s', horizon: '1h' }, confirm: 'unrefuted_at_horizon', ...extra,
});
const method = (effectExtra = {}, stepExtra = {}) => ({
  format: 'method/3.3', name: 'Send', goal: 'Send a summary.',
  inputs: { to: { type: 'text' } },
  environment: { mail: { type: 'service', description: 'Outgoing mail.' }, mailbox: { type: 'service', description: 'Delivery reports.', role: 'observer' } },
  steps: {
    send: { name: 'Send summary', purpose: 'Send the summary email.', in: { to: 'inputs.to' }, do: script('send.mjs'), out: { receipt: text }, changes: ['environment.mail'],
      effects: { delivered: effect(effectExtra) }, limits: { timeout_ms: 5000 }, ...stepExtra },
  },
  result: 'receipt',
});
// A fake mail server: the action writes to the outbox, and the server reports delivery or a bounce in the mailbox.
const send = `import{readFileSync,writeFileSync,existsSync,mkdirSync,rmSync}from"node:fs";
const a=JSON.parse(readFileSync(0,"utf8"));const env=JSON.parse(process.env.METHOD_ENVIRONMENT);
if(env.mailbox)throw Error("action saw the observer connection");
const t=process.env.METHOD_OPERATION_ID;const out=env.mail;mkdirSync(out+"/box/dsn",{recursive:true});mkdirSync(out+"/box/delivered",{recursive:true});
const again=existsSync(out+"/"+t+".json");writeFileSync(out+"/"+t+".json",JSON.stringify(a));
if(a.to.startsWith("bounce")||(a.to.startsWith("flaky")&&!again))writeFileSync(out+"/box/dsn/"+t+".json",JSON.stringify({status:"5.1.1",to:a.to}));
else{rmSync(out+"/box/dsn/"+t+".json",{force:true});if(a.to.includes("known"))writeFileSync(out+"/box/delivered/"+t+".json","{}");}
if(a.to.startsWith("crash"))process.exit(4);
console.log(JSON.stringify({receipt:"250 OK"}))`;
const observe = `import{readFileSync,readdirSync}from"node:fs";
const a=JSON.parse(readFileSync(0,"utf8"));const env=JSON.parse(process.env.METHOD_ENVIRONMENT);
if(env.mail)throw Error("observer saw the action connection");
if(Object.keys(a).sort().join()!=="action_outcome,attempt,inputs,intent,token")throw Error("observer input: "+Object.keys(a));
if(a.token!==process.env.METHOD_EFFECT_TOKEN)throw Error("token");
const obs=[];for(const kind of["dsn","delivered"])for(const f of readdirSync(env.mailbox+"/"+kind))if(f.startsWith(a.token))obs.push({source:kind,ref:f,data:JSON.parse(readFileSync(env.mailbox+"/"+kind+"/"+f,"utf8"))});
console.log(JSON.stringify({observations:obs}))`;
const judge = `import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));
if(process.env.METHOD_ENVIRONMENT)throw Error("judge saw a connection");
const dsn=a.observations.find(o=>o.source==="dsn");const ok=a.observations.find(o=>o.source==="delivered");
console.log(JSON.stringify(dsn?{verdict:"contradicted",reason:"bounce "+dsn.data.status,evidence:[dsn.ref]}:ok?{verdict:"confirmed",reason:"delivered",evidence:[ok.ref]}:{verdict:"no_evidence",reason:"no report yet",evidence:[]}))`;
const fixtures = {
  'contradicted.json': { observations: [{ source: 'dsn', ref: 'mop_fixture.json', data: { status: '5.1.1' } }], expect: 'contradicted' },
  'empty.json': { observations: [], expect: 'no_evidence' },
  'confirmed.json': { observations: [{ source: 'delivered', ref: 'mop_fixture.json', data: {} }], expect: 'confirmed' },
};

async function setup(t, doc = method(), files = {}, fixtureFiles = fixtures) {
  const dir = await mkdtemp(join(tmpdir(), 'method-effects-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries({ 'send.mjs': send, 'observe.mjs': observe, 'judge.mjs': judge, ...files })) await writeFile(join(dir, name), source);
  await mkdir(join(dir, 'fixtures/delivery'), { recursive: true });
  for (const [name, value] of Object.entries(fixtureFiles)) await writeFile(join(dir, 'fixtures/delivery', name), JSON.stringify(value));
  await mkdir(join(dir, 'outbox/box'), { recursive: true });
  const file = join(dir, 'send.method'); await writeFile(file, JSON.stringify(doc));
  const cfg = config({ mail: join(dir, 'outbox'), mailbox: join(dir, 'outbox/box') });
  let runs = 0;
  const run = (inputs, options = {}) => { const runDir = join(dir, `run-${++runs}`); return runMethod(file, cfg, { runDir, inputs, ...options }).then(result => ({ result, runDir })); };
  const events = async runDir => (await readFile(join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { dir, file, cfg, run, events };
}

test('effects are required for external changes, and observers stay apart from actions', () => {
  // The error names the step it belongs to; its wording is free.
  const rejectedAt = step => error => error.code === 'invalid_method' && error.issue.step === step;
  const invalid = [
    [m => { delete m.steps.send.effects; }],
    [m => { m.steps.send.effects.delivered.in = { receipt: 'receipt' }; }],
    [m => { m.steps.send.in.box = 'environment.mailbox'; }],
    [m => { m.steps.send.changes = ['environment.mailbox']; }],
    [m => { delete m.steps.send.changes; }],
    [m => { m.steps.send.effects.delivered.schedule = { first: '2h', horizon: '1h' }; }],
    [m => { m.steps.send.effects.delivered.schedule = { first: '10x', horizon: '1h' }; }],
  ];
  for (const [edit] of invalid) { const m = method(); edit(m); assert.throws(() => validateMethod(m), rejectedAt('send')); }
  // changes defaults to none, and a files connection needs no effect: the runtime observes it.
  const ok = method(); ok.steps.later = { name: 'Later', purpose: 'Compute.', do: script('later.mjs'), out: { done: text } };
  ok.environment.reports = { type: 'files', description: 'Reports.' };
  ok.steps.save = { name: 'Save', purpose: 'Save.', do: script('save.mjs'), out: { path: text }, changes: ['environment.reports'] };
  assert.doesNotThrow(() => validateMethod(ok));
  // A waiver on a step that changes only files is redundant, and harmless.
  ok.steps.save.no_effect_reason = 'Local.';
  assert.doesNotThrow(() => validateMethod(ok));
  // A built-in observer reads the changed connection by default; with two changed connections it must name one.
  const builtin = method(); const e = builtin.steps.send.effects.delivered; delete e.judge; delete e.fixtures; delete e.schedule; delete e.confirm;
  e.observe = { kind: 'http', path: '/sent/{token}', expect: { fields: { status: 'sent' } } };
  assert.doesNotThrow(() => validateMethod(builtin));
  builtin.environment.crm = { type: 'service', description: 'CRM.' }; builtin.steps.send.changes.push('environment.crm');
  assert.throws(() => validateMethod(builtin), rejectedAt('send'));
  // A browser step must say how its change is observed, or why nothing is observed.
  const reading = method(); reading.environment.web = { type: 'browser', description: 'Browser.' };
  reading.steps.read = { name: 'Read', do: { kind: 'agent', model: 'default', prompt: 'Read.', browser: 'environment.web' }, out: { notes: text }, changes: ['environment.web'] };
  assert.throws(() => validateMethod(reading), rejectedAt('read'));
  reading.steps.read.no_effect_reason = 'Reads pages only; submits and posts nothing.';
  assert.doesNotThrow(() => validateMethod(reading));
  for (const [edit] of [
    [m => { m.steps.send.no_effect_reason = 'x'; }],
    [m => { m.steps.send.effects.delivered.observe = { kind: 'file', connection: 'mailbox', path: 'x' }; }],
    [m => { m.environment.other = { type: 'files', description: 'Other.' }; const e = m.steps.send.effects.delivered; delete e.judge; delete e.fixtures; e.observe = { kind: 'file', connection: 'other', path: 'x' }; }],
    [m => { const e = m.steps.send.effects.delivered; delete e.judge; delete e.fixtures; e.observe = { kind: 'file', connection: 'mailbox', path: 'out/{inputs.missing}.txt' }; m.environment.mailbox.type = 'files'; }],
    [m => { const e = m.steps.send.effects.delivered; delete e.judge; delete e.fixtures; e.observe = { kind: 'sqlite', connection: 'mailbox', database: 'x.db', query: 'select 1', expect: { rows: 1 } }; }],
    [m => { delete m.steps.send.effects.delivered.judge; }],
  ]) { const m = method(); edit(m); assert.throws(() => validateMethod(m), rejectedAt('send')); }
});

test('a judge that cannot report a contradiction fails before any action runs', async t => {
  const { run, dir } = await setup(t, method(), {}, { 'empty.json': fixtures['empty.json'], 'confirmed.json': fixtures['confirmed.json'] });
  const { result } = await run({ to: 'ap@example.com' });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'effect_fixture_failed'); assert.match(result.error, /a contradicted case/);
  assert.deepEqual((await readdir(join(dir, 'outbox'))).filter(f => f.endsWith('.json')), []);
});

test('a judge that disagrees with a fixture fails the run', async t => {
  const wrong = `console.log(JSON.stringify({verdict:"no_evidence",reason:"always",evidence:[]}))`;
  const { run } = await setup(t, method(), { 'judge.mjs': wrong });
  const { result } = await run({ to: 'ap@example.com' });
  assert.equal(result.code, 'effect_fixture_failed'); assert.match(result.error, /but the judge returned no_evidence \(always\)/);
});

test('a bounce that the observer finds makes the run fail, though the action reported success', async t => {
  const { run, events } = await setup(t);
  const { result, runDir } = await run({ to: 'bounce@example.com' });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'effect_contradicted'); assert.match(result.error, /send\/0\/delivered \(bounce 5\.1\.1\)/);
  assert.equal(result.result, undefined);
  await assert.rejects(readFile(join(runDir, 'result.json')));
  const ledger = await readLedger(runDir);
  assert.deepEqual(ledger.map(e => e.verdict), ['pending', 'contradicted']);
  assert.match(ledger[1].token, /^mop_[a-f0-9]{64}$/); assert.equal(ledger[1].final, true);
  assert.ok((await events(runDir)).some(e => e.event === 'effects.fixtures_passed'));
  const saved = JSON.parse(await readFile(join(runDir, ledger[1].observations), 'utf8'));
  assert.equal(saved.observations[0].source, 'dsn');
});

test('no bounce yet leaves the effect pending; at the horizon it is unrefuted, never confirmed', async t => {
  const { run, events } = await setup(t);
  const { result, runDir } = await run({ to: 'ap@example.com' });
  assert.equal(result.status, 'completed'); assert.equal(result.result, '250 OK');
  assert.equal(result.effects.pending, 1); assert.equal(result.effects.effects[0].verdict, 'pending');
  const early = await observeRun(runDir);
  assert.deepEqual(early.observed, []); assert.equal(early.changed, false);
  const late = await observeRun(runDir, { now: new Date(Date.now() + 2 * 3_600_000) });
  assert.equal(late.status, 'completed'); assert.equal(late.observed[0].verdict, 'unrefuted');
  assert.equal(late.effects.pending, 0); assert.equal(late.effects.unrefuted, 1);
  const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'));
  assert.equal(summary.effects.unrefuted, 1);
  assert.ok((await events(runDir)).some(e => e.event === 'effect.observed' && e.attempt === 2));
});

test('a late bounce changes a completed run to failed', async t => {
  const { run, dir } = await setup(t);
  const { result, runDir } = await run({ to: 'ap@example.com' });
  assert.equal(result.status, 'completed');
  const token = (await readLedger(runDir))[0].token;
  await writeFile(join(dir, 'outbox/box/dsn', `${token}.json`), JSON.stringify({ status: '4.4.7' }));
  const later = await observeRun(runDir, { now: new Date(Date.now() + 2 * 3_600_000) });
  assert.equal(later.status, 'failed'); assert.equal(later.changed, true);
  const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'));
  assert.equal(summary.code, 'effect_contradicted');
  const status = (await readFile(join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).find(e => e.event === 'run.status_changed');
  assert.deepEqual([status.from, status.to], ['completed', 'failed']);
});

test('with confirm: positive, no evidence at the horizon makes the run unconfirmed', async t => {
  const { run } = await setup(t, method({ confirm: 'positive' }));
  const { result, runDir } = await run({ to: 'ap@example.com' });
  assert.equal(result.status, 'completed');
  const late = await observeRun(runDir, { now: new Date(Date.now() + 2 * 3_600_000) });
  assert.equal(late.status, 'unconfirmed'); assert.equal(late.effects.unknown, 1);
  const positive = await run({ to: 'known@example.com' });
  assert.equal(positive.result.status, 'completed'); assert.equal(positive.result.effects.confirmed, 1); assert.equal(positive.result.effects.pending, 0);
});

test('a blocking contradicted effect retries an idempotent action once with the same operation ID', async t => {
  const { run, events, dir } = await setup(t, method({ blocking: true, retry: 'idempotent' }));
  const { result, runDir } = await run({ to: 'flaky@example.com' });
  assert.equal(result.status, 'completed');
  const log = await events(runDir);
  assert.equal(log.filter(e => e.event === 'effect.retry').length, 1);
  const tokens = log.filter(e => e.event === 'process.started' && e.phase === 'action').map(e => e.operation_id);
  assert.equal(tokens.length, 2); assert.equal(tokens[0], tokens[1]);
  assert.deepEqual((await readLedger(runDir)).map(e => e.verdict), ['contradicted', 'pending']);
  assert.equal((await readdir(join(dir, 'outbox'))).filter(f => f.endsWith('.json')).length, 1);
});

test('a blocking contradiction without an idempotent retry stops the run before later steps', async t => {
  const doc = method({ blocking: true });
  doc.steps.after = { name: 'After', purpose: 'Run after sending.', in: { receipt: 'receipt' }, do: script('after.mjs'), out: { after: text }, changes: [] };
  doc.result = 'after';
  const { run, events } = await setup(t, doc, { 'after.mjs': 'console.log(JSON.stringify({after:"ran"}))' });
  const { result, runDir } = await run({ to: 'bounce@example.com' });
  assert.equal(result.code, 'effect_contradicted');
  assert.ok(!(await events(runDir)).some(e => e.step === 'after'));
  assert.match(result.recovery, /--retry/);
});

test('after an action fails, the runtime observes its effects before anyone retries it', async t => {
  const { run } = await setup(t, method({ confirm: 'positive' }));
  const { result, runDir } = await run({ to: 'crash-known@example.com' });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'process_failed');
  // crash-known: the fake server delivered the message before the script crashed.
  const ledger = await readLedger(runDir);
  assert.equal(ledger[0].action_outcome, 'indeterminate');
  assert.equal(result.effects.effects[0].action_outcome, 'indeterminate');
  assert.equal(result.effects.effects[0].verdict, 'confirmed');
});

// Built-in observers: shapes taken from real Methods (a SQLite ledger, a local folder, a game API).
async function builtinSetup(t, step, environment, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'method-builtin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source);
  const doc = { format: 'method/3.3', name: 'Builtin', goal: 'Test built-in observers.', inputs: { note: { type: 'text' } },
    environment: { store: { type: 'files', description: 'Writable store.' }, store_reader: { type: 'files', description: 'Same store, read only.', role: 'observer' },
      game: { type: 'service', description: 'Game.' }, game_reader: { type: 'service', description: 'Game, observe only.', role: 'observer' } },
    steps: { act: { name: 'Act', purpose: 'Change the store or the game.', in: { note: 'inputs.note' }, do: script('act.mjs'), out: { receipt: text }, changes: [step.changes], effects: step.effects, limits: { timeout_ms: 5000 } } },
    result: 'receipt' };
  const file = join(dir, 'b.method'); await writeFile(file, JSON.stringify(doc));
  let n = 0;
  return { dir, run: (inputs, extra = {}) => runMethod(file, config({ store: dir, store_reader: dir, game: 'http://127.0.0.1:9/', game_reader: 'http://127.0.0.1:9/', ...environment(dir) }), { runDir: join(dir, `run-${++n}`), inputs, ...extra }).then(result => ({ result, runDir: join(dir, `run-${n}`) })) };
}

test('a sqlite observer finds the written row by business key, and reports a duplicate from a retry', async t => {
  const act = `import{DatabaseSync}from"node:sqlite";import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const env=JSON.parse(process.env.METHOD_ENVIRONMENT);
const db=new DatabaseSync(env.store+"/memory.sqlite");db.exec("create table if not exists memory(id integer primary key, note text)");
const times=a.note.startsWith("twice")?2:a.note.startsWith("none")?0:1;for(let i=0;i<times;i++)db.prepare("insert into memory(note) values (?)").run(a.note);console.log(JSON.stringify({receipt:"row saved"}))`;
  const effects = { stored: { intent: 'One memory row holds the exact words.', in: { note: 'inputs.note' },
    observe: { kind: 'sqlite', connection: 'store_reader', database: 'memory.sqlite', query: 'SELECT id FROM memory WHERE note = :note', params: { note: '{inputs.note}' }, expect: { rows: 1 } },
    schedule: { first: '0s', horizon: '1s' }, confirm: 'positive', blocking: true } };
  const { run } = await builtinSetup(t, { changes: 'environment.store', effects }, dir => ({ store: dir, store_reader: dir }), { 'act.mjs': `process.removeAllListeners("warning");${act}` });
  const first = await run({ note: 'loved it, 4 stars' }); assert.equal(first.result.status, 'completed', JSON.stringify(first.result));
  const twice = await run({ note: 'twice: watched it' });
  assert.equal(twice.result.code, 'effect_contradicted');
  // A row that never appears is unconfirmed: the runtime cannot tell "slow" from "never".
  const none = await run({ note: 'none: never saved' });
  assert.equal(none.result.status, 'unconfirmed');
});

test('a file observer confirms a local write without any script or fixture', async t => {
  const act = `import{readFileSync,writeFileSync,mkdirSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const env=JSON.parse(process.env.METHOD_ENVIRONMENT);
if(!a.note.startsWith("skip")){mkdirSync(env.store+"/reports",{recursive:true});writeFileSync(env.store+"/reports/result.md","# Result\\n"+a.note)}console.log(JSON.stringify({receipt:"saved"}))`;
  const effects = { saved: { intent: 'The report file holds the note.', in: { note: 'inputs.note' },
    observe: { kind: 'file', connection: 'store_reader', path: 'reports/result.md', expect: { contains: '{inputs.note}' } },
    schedule: { first: '0s', horizon: '1s' }, confirm: 'positive', blocking: true } };
  const { run } = await builtinSetup(t, { changes: 'environment.store', effects }, dir => ({ store: dir, store_reader: dir }), { 'act.mjs': act });
  const ok = await run({ note: 'Ada owes a draft' });
  assert.equal(ok.result.status, 'completed'); assert.ok(ok.result.effects.confirmed >= 1);
  // The step reported success but wrote nothing; the file still holds the earlier text.
  const stale = await run({ note: 'skip this' });
  assert.equal(stale.result.code, 'effect_contradicted');
});

test('an http observer judges a trend over several readings, like continued game production', async t => {
  let produced = 0, running = true;
  const server = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (JSON.parse(b || '{}').action === 'observe') { if (running) produced += 5; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, state: { tick: produced * 240, iron_plates_produced: produced } })); }
    else { res.end('{"ok":true}'); }
  }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const effects = { producing: { intent: 'The chain keeps producing iron plates.',
    observe: { kind: 'http', connection: 'game_reader', path: '/', method: 'POST', body: { action: 'observe' }, expect: { fields: { 'state.iron_plates_produced': { increases: true } } } },
    schedule: { first: '0s', then: ['1s'], horizon: '2s' }, confirm: 'positive' } };
  const { run } = await builtinSetup(t, { changes: 'environment.game', effects }, () => ({ game: url, game_reader: url }), { 'act.mjs': 'console.log(JSON.stringify({receipt:"ready"}))' });
  const good = await run({ note: 'x' });
  assert.equal(good.result.status, 'completed'); assert.equal(good.result.effects.confirmed, 1);
  assert.equal((await readLedger(good.runDir)).at(-1).verdict, 'confirmed');
  running = false;
  const stopped = await run({ note: 'x' });
  assert.equal(stopped.result.code, 'effect_contradicted');
});

test('a declared waiver is recorded with the run', async t => {
  const doc = method();
  delete doc.steps.send.effects; doc.steps.send.no_effect_reason = 'The outbox is a local test folder that the next step reads.';
  const { run, events } = await setup(t, doc);
  const { result, runDir } = await run({ to: 'ap@example.com' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.unobserved_changes, [{ step: 'send', reason: 'The outbox is a local test folder that the next step reads.', changes: ['environment.mail'] }]);
  assert.ok((await events(runDir)).some(e => e.event === 'effects.waived'));
});

test('a script judge receives earlier readings and whether this is the last one', async t => {
  const judge = `import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));
if(a.observations.length===0)console.log(JSON.stringify({verdict:"no_evidence",reason:"none",evidence:[]}));
else if(a.observations[0].source==="dsn")console.log(JSON.stringify({verdict:"contradicted",reason:"dsn",evidence:[]}));
else console.log(JSON.stringify({verdict:a.final&&a.previous.length>=1?"confirmed":"no_evidence",reason:"seen "+(a.previous.length+1)+" final "+a.final,evidence:[]}))`;
  const observe = `console.log(JSON.stringify({observations:[{source:"delivered",ref:"r"}]}))`;
  const { run } = await setup(t, method({ confirm: 'positive', schedule: { first: '0s', then: ['1s'], horizon: '2s' } }), { 'judge.mjs': judge, 'observe.mjs': observe },
    { 'contradicted.json': fixtures['contradicted.json'], 'empty.json': fixtures['empty.json'], 'confirmed.json': { ...fixtures['confirmed.json'], previous: [{ observations: [] }], final: true } });
  const { result, runDir } = await run({ to: 'ap@example.com' });
  assert.equal(result.effects.confirmed, 1);
  assert.deepEqual((await readLedger(runDir)).slice(1).map(e => e.reason), ['seen 1 final false', 'seen 2 final false', 'seen 3 final true']);
});

test('a whole-placeholder query parameter keeps its number type', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-param-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, 'm.sqlite'));
  db.exec('create table memory(id integer primary key, recommendation_id integer, note text)'); db.prepare('insert into memory(recommendation_id, note) values (?, ?)').run(92, 'loved it');
  db.close();
  const { execFileSync } = await import('node:child_process');
  const script = new URL('../src/observers/builtin.mjs', import.meta.url).pathname;
  const spec = { kind: 'sqlite', connection: 'r', database: 'm.sqlite', query: 'SELECT id FROM memory WHERE recommendation_id = :rid AND note = :note', params: { rid: '{inputs.rid}', note: '{inputs.note}' }, expect: { rows: 1 } };
  const out = JSON.parse(execFileSync(process.execPath, ['--no-warnings', script, 'fetch'], { input: JSON.stringify({ spec, token: 'mop_x', inputs: { rid: 92, note: 'loved it' } }), env: { PATH: process.env.PATH, METHOD_ENVIRONMENT: JSON.stringify({ r: dir }) } }).toString());
  assert.equal(out.observations[0].data.count, 1);
});

test('the runtime observes files connections itself: a claimed file must change, and no change is allowed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'out'); await mkdir(out);
  await writeFile(join(dir, 'save.mjs'), `import{readFileSync,writeFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const out=JSON.parse(process.env.METHOD_ENVIRONMENT).out;
if(a.mode==="write")writeFileSync(out+"/weekly.md","# Week");
console.log(JSON.stringify({path:a.mode==="nothing"?"No new notes, nothing saved.":out+"/weekly.md"}))`);
  await writeFile(join(dir, 'next.mjs'), 'console.log(JSON.stringify({done:true}))');
  const doc = { format: 'method/3.3', name: 'Files', goal: 'Save a summary.', inputs: { mode: { type: 'text' } },
    environment: { out: { type: 'files', description: 'Output folder.' } },
    steps: { save: { name: 'Save', purpose: 'Save the summary.', in: { mode: 'inputs.mode' }, do: script('save.mjs'), out: { path: text }, changes: ['environment.out'] },
      next: { name: 'Next', purpose: 'Runs after the save.', in: { path: 'path' }, do: script('next.mjs'), out: { done: { type: 'boolean', description: 'Done.' } } } },
    result: 'path' };
  const file = join(dir, 'f.method'); await writeFile(file, JSON.stringify(doc));
  let n = 0;
  const run = mode => runMethod(file, config({ out }), { runDir: join(dir, `run-${++n}`), inputs: { mode } });
  const written = await run('write');
  assert.equal(written.status, 'completed'); assert.equal(written.effects.confirmed, 1);
  // The step says it saved weekly.md again, but did not write it: the run stops before the next step.
  const lied = await run('claim');
  assert.equal(lied.code, 'effect_contradicted');
  const events = (await readFile(join(dir, 'run-2', 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!events.some(e => e.step === 'next'));
  // A step that has nothing to save, and says so, is fine.
  const nothing = await run('nothing');
  assert.equal(nothing.status, 'completed'); assert.equal(nothing.effects.unchanged, 1);
});

test('a returned folder counts as changed when a file inside it changed', async () => {
  const { observeFiles } = await import('../src/effects.js');
  const root = '/data/trials', at = new Date().toISOString();
  const seen = observeFiles({ key: 'k', connection: 'trials', root, before: {}, after: { 't1/report.json': 'a' }, outputs: { trial: '/data/trials/t1' }, completedAt: at });
  assert.equal(seen.verdict, 'confirmed');
  const empty = observeFiles({ key: 'k', connection: 'trials', root, before: {}, after: { 't2/report.json': 'a' }, outputs: { trial: '/data/trials/t1' }, completedAt: at });
  assert.equal(empty.verdict, 'contradicted');
});
