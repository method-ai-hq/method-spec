import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
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

test('method/3.3 requires effects for external changes and keeps observers apart from actions', () => {
  const invalid = [
    [m => { delete m.steps.send.effects; }, /external changes require effects/],
    [m => { m.steps.send.effects.delivered.in = { receipt: 'receipt' }; }, /cannot read this step's outputs/],
    [m => { m.steps.send.in.box = 'environment.mailbox'; }, /only effect observers can use environment.mailbox/],
    [m => { m.steps.send.changes = ['environment.mailbox']; }, /only effect observers/],
    [m => { delete m.steps.send.changes; }, /state the changes this step can make|effects describe external changes/],
    [m => { m.steps.send.effects.delivered.schedule = { first: '2h', horizon: '1h' }; }, /horizon last/],
    [m => { m.steps.send.effects.delivered.schedule = { first: '10x', horizon: '1h' }; }, /must match pattern/],
    [m => { m.format = 'method/3.2'; }, /effects require method\/3.3/],
    [m => { m.steps.later = { name: 'Later', purpose: 'Compute.', do: script('later.mjs'), out: { done: text } }; }, /state the changes this step can make/],
  ];
  for (const [edit, pattern] of invalid) { const m = method(); edit(m); assert.throws(() => validateMethod(m), pattern); }
  const ok = method(); ok.steps.later = { name: 'Later', purpose: 'Compute.', do: script('later.mjs'), out: { done: text }, changes: [] };
  assert.doesNotThrow(() => validateMethod(ok));
  // Reading with a browser needs its controls but changes nothing to observe.
  const reading = method(); reading.environment.web = { type: 'browser', description: 'Browser.' };
  reading.steps.read = { name: 'Read', do: { kind: 'agent', model: 'default', prompt: 'Read.', browser: 'environment.web' }, out: { notes: text }, changes: ['environment.web'] };
  assert.doesNotThrow(() => validateMethod(reading));
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
  assert.match(result.recovery, /Observed after the failed action: send\/0\/delivered confirmed \(the change happened; do not retry it\)/);
});
