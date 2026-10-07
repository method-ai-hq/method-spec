import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod, createCase, retireCase, listCases, testSuite, casesDigest } from '../src/index.js';

const text = { type: 'text', description: 'A test value.' };
const number = { type: 'number', description: 'A test number.' };
const script = entrypoint => ({ kind: 'run', runtime: 'node', entrypoint });
const config = environment => ({
  limits: { timeout_ms: 20000, max_model_requests: 5, max_invocations: 20, max_tool_calls: 5, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
  runtimes: { node: { command: process.execPath, version: process.version } }, environment,
});
const version = ({ compute = 'compute.mjs', send = 'send.mjs', report = 'report.mjs' } = {}) => ({
  format: 'method/3.3', name: 'Invoices', goal: 'Pay invoices and report.',
  inputs: { amounts: { type: 'list', items: 'number' }, to: { type: 'text' } },
  environment: { mail: { type: 'service', description: 'Outgoing mail.' }, mailbox: { type: 'service', description: 'Delivery reports.', role: 'observer' } },
  steps: {
    compute: { name: 'Total', purpose: 'Add the amounts.', in: { amounts: 'inputs.amounts' }, do: script(compute), out: { total: number }, changes: [] },
    send: { name: 'Send', purpose: 'Send the summary.', in: { to: 'inputs.to', total: 'total' }, do: script(send), out: { receipt: text }, changes: ['environment.mail'],
      effects: { delivered: { intent: 'The summary is not returned.', in: { to: 'inputs.to' }, observe: script('observe.mjs'), judge: script('judge.mjs'), fixtures: 'fixtures', schedule: { first: '0s', horizon: '1h' }, confirm: 'unrefuted_at_horizon' } } },
    report: { name: 'Report', purpose: 'Write the report.', in: { total: 'total', receipt: 'receipt' }, do: script(report), out: { report: text }, changes: [] },
  },
  result: 'report',
});
const sources = {
  'compute.mjs': 'import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({total:a.amounts.reduce((x,y)=>x+y,0)}))',
  'compute-bad.mjs': 'import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({total:a.amounts.reduce((x,y)=>x+y,1)}))',
  'send.mjs': 'import{readFileSync,writeFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const env=JSON.parse(process.env.METHOD_ENVIRONMENT);writeFileSync(env.mail+"/"+process.env.METHOD_OPERATION_ID+".json",JSON.stringify(a));console.log(JSON.stringify({receipt:"250 OK"}))',
  'send-v2.mjs': 'import{readFileSync,writeFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const env=JSON.parse(process.env.METHOD_ENVIRONMENT);writeFileSync(env.mail+"/v2-"+process.env.METHOD_OPERATION_ID+".json",JSON.stringify(a));console.log(JSON.stringify({receipt:"250 OK"}))',
  'observe.mjs': 'console.log(JSON.stringify({observations:[]}))',
  'judge.mjs': 'import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const d=a.observations.find(o=>o.source==="dsn");console.log(JSON.stringify(d?{verdict:"contradicted",reason:"bounce",evidence:[d.ref]}:{verdict:"no_evidence",reason:"none",evidence:[]}))',
  'report.mjs': 'import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({report:"Paid "+a.total+"; summary sent"}))',
  'report-v2.mjs': 'import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({report:"Paid "+a.total+"; summary sent, delivery not yet confirmed"}))',
  'mentions-delivery.mjs': 'import{readFileSync}from"node:fs";const o=JSON.parse(readFileSync(0,"utf8"));const r=o.outputs.report??"";console.log(JSON.stringify({pass:r.includes("not yet confirmed"),reason:r}))',
};
const fixtures = { 'bounce.json': { observations: [{ source: 'dsn', ref: 'x' }], expect: 'contradicted' }, 'empty.json': { observations: [], expect: 'no_evidence' } };

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'method-cases-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(sources)) await writeFile(join(dir, name), source);
  await mkdir(join(dir, 'fixtures')); await mkdir(join(dir, 'outbox'));
  for (const [name, value] of Object.entries(fixtures)) await writeFile(join(dir, 'fixtures', name), JSON.stringify(value));
  const cfg = config({ mail: join(dir, 'outbox'), mailbox: join(dir, 'outbox') });
  const write = async (name, doc) => { const file = join(dir, name); await writeFile(file, JSON.stringify(doc)); return file; };
  const current = await write('invoices.method', version());
  const source = await runMethod(current, cfg, { runDir: join(dir, 'run'), inputs: { amounts: [4, 6], to: 'ap@example.com' } });
  assert.equal(source.status, 'completed'); assert.equal(source.result, 'Paid 10; summary sent');
  const make = (id, expect, extra = {}) => createCase({ methodFile: current, runDir: join(dir, 'run'), id, note: 'The report must say that delivery is not yet confirmed.', expect, config: cfg, ...extra });
  return { dir, cfg, current, write, make };
}

test('a case proves red on the current version without running any step', async t => {
  const { cfg, current, make } = await setup(t);
  await make('delivery-pending', [{ kind: 'equals', ref: 'outputs.report', value: 'Paid 10; summary sent, delivery not yet confirmed', text: 'The report says delivery is not yet confirmed.' }]);
  const report = await testSuite(current, cfg);
  assert.equal(report.passed, false);
  assert.equal(report.cases[0].verdict, 'fail');
  assert.deepEqual(report.cases[0].candidate.attempts[0].live_steps, []);
});

test('a repair is accepted when the new case turns green and earlier cases still pass', async t => {
  const { cfg, current, write, make } = await setup(t);
  await make('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]);
  await make('delivery-pending', [{ kind: 'predicate', runtime: 'node', entrypoint: 'mentions-delivery.mjs' }]);
  const unrepaired = await testSuite(current, cfg, { baseline: current, newIds: ['delivery-pending'] });
  assert.equal(unrepaired.cases.find(c => c.id === 'delivery-pending').verdict, 'not_fixed');
  await writeFile(current, JSON.stringify(version({ report: 'report-v2.mjs' })));
  const baseline = await write('invoices-before.method', version());
  const gate = await testSuite(current, cfg, { baseline, newIds: ['delivery-pending'] });
  assert.equal(gate.passed, true, JSON.stringify(gate.counts));
  assert.deepEqual(gate.cases.map(c => [c.id, c.verdict]), [['delivery-pending', 'fixed'], ['total', 'pass']]);
  assert.deepEqual(gate.cases[0].candidate.attempts[0].live_steps, ['report']);
});

test('a change that breaks an earlier case is a regression', async t => {
  const { cfg, current, write, make } = await setup(t);
  await make('report-text', [{ kind: 'equals', ref: 'outputs.report', value: 'Paid 10; summary sent' }]);
  const baseline = await write('invoices-before.method', version());
  await writeFile(current, JSON.stringify(version({ report: 'report-v2.mjs' })));
  const gate = await testSuite(current, cfg, { baseline });
  assert.equal(gate.passed, false); assert.equal(gate.counts.regression, 1);
  // A changed input to a step that acts on the world cannot be replayed: the recording does not show what it would do.
  await writeFile(current, JSON.stringify(version({ compute: 'compute-bad.mjs' })));
  assert.equal((await testSuite(current, cfg, { baseline })).cases[0].verdict, 'unverifiable');
});

test('a changed step that acts on an external system makes the case unverifiable', async t => {
  const { cfg, current, make } = await setup(t);
  await make('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]);
  await writeFile(current, JSON.stringify(version({ send: 'send-v2.mjs' })));
  const gate = await testSuite(current, cfg);
  assert.equal(gate.cases[0].verdict, 'unverifiable'); assert.equal(gate.passed, false);
  assert.match(gate.cases[0].candidate.attempts[0].reason, /Cannot replay send:0/);
});

test('recorded observations replay the bounce, and the run then fails', async t => {
  const { cfg, current, make } = await setup(t);
  await make('bounce', [{ kind: 'effect', effect: 'send/0/delivered', verdict: ['contradicted'] }, { kind: 'status', in: ['failed'] }],
    { observations: { 'send/0/delivered': [{ source: 'dsn', ref: 'dsn-1', data: { status: '5.1.1' } }] } });
  await make('no-observations', [{ kind: 'effect', effect: 'send/0/delivered', verdict: ['contradicted'] }]);
  const report = await testSuite(current, cfg);
  assert.deepEqual(report.cases.map(c => [c.id, c.verdict]), [['bounce', 'pass'], ['no-observations', 'fail']]);
  // The source run observed no bounce yet. In a replay that stays pending; it does not become unrefuted.
  assert.match(report.cases[1].candidate.attempts[0].results[0].reason, /send\/0\/delivered pending/);
});

test('vacuous expectations, sensitive runs and duplicate IDs are refused', async t => {
  const { dir, current, make, cfg } = await setup(t);
  await assert.rejects(make('vacuous', [{ kind: 'status', in: ['completed'] }]), /passes on an empty result/);
  await assert.rejects(createCase({ methodFile: current, runDir: join(dir, 'sensitive', 'run'), id: 'x', note: 'n', expect: [{ kind: 'equals', ref: 'outputs.total', value: 1 }], config: cfg }), /sensitive/);
  await make('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]);
  await assert.rejects(make('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]), /already exists/);
  assert.deepEqual((await listCases(current)).map(c => c.id), ['total']);
});

test('superseding a case retires it with its reason, and the digest shows any change', async t => {
  const { dir, cfg, current, make } = await setup(t);
  await make('old-rule', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]);
  const before = await casesDigest(join(dir, 'cases'));
  await make('new-rule', [{ kind: 'equals', ref: 'outputs.total', value: 10 }], { supersedes: ['old-rule'] });
  const cases = await listCases(current);
  assert.equal(cases.find(c => c.id === 'old-rule').status, 'retired');
  assert.equal(cases.find(c => c.id === 'old-rule').superseded_by, 'new-rule');
  const report = await testSuite(current, cfg);
  assert.deepEqual(report.cases.map(c => c.id), ['new-rule']); assert.equal(report.retired, 1);
  assert.notEqual((await casesDigest(join(dir, 'cases'))).sha256, before.sha256);
  await assert.rejects(retireCase(current, 'old-rule', { reason: 'again' }), /already retired/);
});

test('redaction replaces recorded values everywhere, and the case still replays', async t => {
  const { dir, cfg, current, make } = await setup(t);
  await make('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }], { redact: { 'ap@example.com': 'person@example.test' } });
  const recording = await readFile(join(dir, 'cases/total/recording.json'), 'utf8');
  assert.ok(!recording.includes('ap@example.com')); assert.ok(recording.includes('person@example.test'));
  const report = await testSuite(current, cfg);
  assert.equal(report.cases[0].verdict, 'pass');
  assert.deepEqual(report.cases[0].candidate.attempts[0].live_steps, []);
});
