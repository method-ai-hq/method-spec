import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod, createCase, retireCase, listCases, testSuite } from '../src/index.js';

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
  // A case from a run that was right pins behaviour that must stay.
  const pin = (id, expect, extra = {}) => createCase({ methodFile: current, passingRun: join(dir, 'run'), id, note: 'Keep this right.', expect, config: cfg, ...extra });
  return { dir, cfg, current, write, make, pin };
}


test('a case must fail on the run that went wrong; it then fails on the current version without running a step', async t => {
  const { cfg, current, make } = await setup(t);
  await assert.rejects(make('already-right', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]), /already meets this case/);
  const created = await make('delivery-pending', [{ kind: 'equals', ref: 'outputs.report', value: 'Paid 10; summary sent, delivery not yet confirmed' }]);
  assert.equal(created.on_failing_run[0].status, 'fail');
  const report = await testSuite(current, cfg);
  assert.equal(report.passed, false); assert.equal(report.cases[0].verdict, 'fail');
  assert.deepEqual(report.cases[0].candidate.attempts[0].live_steps, []);
});

test('a fix turns the new case green, and pinned cases must keep passing', async t => {
  const { cfg, current, write, make, pin } = await setup(t);
  await pin('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]);
  await make('delivery-pending', [{ kind: 'predicate', runtime: 'node', entrypoint: 'mentions-delivery.mjs' }]);
  const baseline = await write('invoices-before.method', version());
  await writeFile(current, JSON.stringify(version({ report: 'report-v2.mjs' })));
  const gate = await testSuite(current, cfg, { baseline, newIds: ['delivery-pending'] });
  assert.equal(gate.passed, true, JSON.stringify(gate.counts));
  const byId = Object.fromEntries(gate.cases.map(c => [c.id, c]));
  assert.equal(byId['delivery-pending'].verdict, 'fixed'); assert.equal(byId.total.verdict, 'pass');
  assert.deepEqual(byId['delivery-pending'].candidate.attempts[0].live_steps, ['report']);
});

test('every approved case must pass: a failing one blocks, and a regression is named as one', async t => {
  const { cfg, current, write, pin } = await setup(t);
  await pin('report-text', [{ kind: 'equals', ref: 'outputs.report', value: 'Paid 10; summary sent' }]);
  const baseline = await write('invoices-before.method', version());
  await writeFile(current, JSON.stringify(version({ report: 'report-v2.mjs' })));
  assert.equal((await testSuite(current, cfg)).cases[0].verdict, 'fail');
  const gate = await testSuite(current, cfg, { baseline });
  assert.equal(gate.passed, false); assert.equal(gate.counts.regression, 1);
});

test('a case runs only the steps it needs, so a change elsewhere does not block it', async t => {
  const { cfg, current, pin } = await setup(t);
  await pin('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]);
  await pin('report-text', [{ kind: 'equals', ref: 'outputs.report', value: 'Paid 10; summary sent' }]);
  // The send step changes. The total case does not need it; the report case does, and send acts on a service.
  await writeFile(current, JSON.stringify(version({ send: 'send-v2.mjs' })));
  const report = await testSuite(current, cfg);
  assert.deepEqual(report.cases.map(c => [c.id, c.verdict]).sort(), [['report-text', 'unverifiable'], ['total', 'pass']]);
  assert.match(report.cases.find(c => c.id === 'report-text').candidate.attempts[0].reason, /Cannot replay send:0/);
});

test('a changed step that writes files runs in a scratch folder during a replay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-scratch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'reports'); await mkdir(out);
  const save = v => `import{readFileSync,writeFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));const o=JSON.parse(process.env.METHOD_ENVIRONMENT).reports;writeFileSync(o+"/report.md",a.text+"${v}");console.log(JSON.stringify({saved:"Saved "+(a.text.length+${v.length})+" characters."}))`;
  await writeFile(join(dir, 'make.mjs'), 'console.log(JSON.stringify({text:"Total 10"}))');
  await writeFile(join(dir, 'save.mjs'), save(''));
  const doc = { format: 'method/3.3', name: 'Save', goal: 'Save a report.', environment: { reports: { type: 'files', description: 'Reports.' } },
    steps: { make: { name: 'Make', purpose: 'Make text.', do: script('make.mjs'), out: { text } },
      save: { name: 'Save', purpose: 'Save the report.', in: { text: 'text' }, do: script('save.mjs'), out: { saved: text }, changes: ['environment.reports'] } }, result: 'saved' };
  const file = join(dir, 's.method'); await writeFile(file, JSON.stringify(doc));
  const cfg = config({ reports: out });
  assert.equal((await runMethod(file, cfg, { runDir: join(dir, 'run') })).status, 'completed');
  await createCase({ methodFile: file, runDir: join(dir, 'run'), id: 'mentions-eur', note: 'Say the currency.', expect: [{ kind: 'equals', ref: 'outputs.saved', value: 'Saved 12 characters.' }], config: cfg });
  await writeFile(join(dir, 'save.mjs'), save(' EUR'));
  const report = await testSuite(file, cfg);
  assert.equal(report.cases[0].verdict, 'pass', JSON.stringify(report.cases[0].candidate.attempts));
  assert.deepEqual(report.cases[0].candidate.attempts[0].live_steps, ['save']);
  // The real folder was not touched by the replay.
  assert.equal(await readFile(join(out, 'report.md'), 'utf8'), 'Total 10');
});

test('recorded observations replay the bounce, and the run then fails', async t => {
  const { cfg, current, make } = await setup(t);
  await make('bounce', [{ kind: 'effect', effect: 'send/0/delivered', verdict: ['contradicted'] }, { kind: 'status', in: ['failed'] }],
    { observations: { 'send/0/delivered': [{ source: 'dsn', ref: 'dsn-1', data: { status: '5.1.1' } }] } });
  const report = await testSuite(current, cfg);
  assert.deepEqual(report.cases.map(c => [c.id, c.verdict]), [['bounce', 'pass']]);
});

test('vacuous expectations and duplicate IDs are refused', async t => {
  const { current, pin } = await setup(t);
  await assert.rejects(pin('vacuous', [{ kind: 'status', in: ['completed'] }]), /passes on an empty result/);
  await pin('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]);
  await assert.rejects(pin('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]), /already exists/);
  assert.deepEqual((await listCases(current)).map(c => c.id), ['total']);
});

test('superseding a case retires it with its reason', async t => {
  const { cfg, current, pin } = await setup(t);
  await pin('old-rule', [{ kind: 'equals', ref: 'outputs.total', value: 10 }]);
  await pin('new-rule', [{ kind: 'equals', ref: 'outputs.total', value: 10 }], { supersedes: ['old-rule'] });
  const cases = await listCases(current);
  assert.equal(cases.find(c => c.id === 'old-rule').status, 'retired');
  assert.equal(cases.find(c => c.id === 'old-rule').superseded_by, 'new-rule');
  const report = await testSuite(current, cfg);
  assert.deepEqual(report.cases.map(c => c.id), ['new-rule']); assert.equal(report.retired, 1);
  await assert.rejects(retireCase(current, 'old-rule', { reason: 'again' }), /already retired/);
});

test('redaction replaces recorded values everywhere, and the case still replays', async t => {
  const { dir, cfg, current, pin } = await setup(t);
  await pin('total', [{ kind: 'equals', ref: 'outputs.total', value: 10 }], { redact: { 'ap@example.com': 'person@example.test' } });
  const recording = await readFile(join(dir, 'cases/total/recording.json'), 'utf8');
  assert.ok(!recording.includes('ap@example.com')); assert.ok(recording.includes('person@example.test'));
  const report = await testSuite(current, cfg);
  assert.equal(report.cases[0].verdict, 'pass');
  assert.deepEqual(report.cases[0].candidate.attempts[0].live_steps, []);
});

// A fake judge model: a criterion about delivery passes when the text says "delivery"; it can also invent a quote.
function judge(options = {}) {
  let calls = 0;
  const transport = async body => {
    calls++;
    const prompt = JSON.stringify(body);
    const text = prompt.slice(prompt.indexOf('Text:')).replace(/\\n/g, '\n');
    const pass = text.includes('delivery');
    const verdicts = [{ id: 'c1', pass, quote: options.invent ? 'delivery was confirmed by the courier' : pass ? 'delivery not yet confirmed' : '', reason: pass ? 'It says so.' : 'It does not mention delivery.' }];
    return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ verdicts }) }] }], usage: { input_tokens: 1, output_tokens: 1 } };
  };
  return { transport, calls: () => calls };
}
const withJudge = cfg => ({ ...cfg, limits: { ...cfg.limits, max_model_requests: 20 }, models: { judge: { backend: 'openai-responses', model: 'judge-test', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100 } } });

test('a rubric case: plain sentences, judged with quotes, calibrated on the bad and the accepted runs', async t => {
  const { dir, cfg, current, write } = await setup(t);
  const judged = withJudge(cfg), fake = judge(), cacheDir = join(dir, 'cache');
  const options = { runOptions: { transport: fake.transport }, cacheDir };
  // The run that went wrong, and the run the person accepted after the fix.
  await writeFile(current, JSON.stringify(version({ report: 'report-v2.mjs' })));
  assert.equal((await runMethod(current, cfg, { runDir: join(dir, 'fixed'), inputs: { amounts: [4, 6], to: 'ap@example.com' } })).status, 'completed');
  const created = await createCase({ methodFile: current, runDir: join(dir, 'run'), passingRun: join(dir, 'fixed'), id: 'delivery-stated', note: 'Say whether delivery is confirmed.',
    rubric: ['The report says whether delivery of the summary is confirmed.'], config: judged, options });
  assert.equal(created.expect[0].kind, 'rubric'); assert.equal(created.expect[0].ref, 'outputs.report');
  assert.equal(created.on_failing_run[0].criteria[0].pass, false); assert.equal(created.on_passing_run[0].criteria[0].pass, true);
  assert.equal(created.warnings, undefined);
  const calls = fake.calls();
  const report = await testSuite(current, judged, { runOptions: { transport: fake.transport, cacheDir } });
  assert.equal(report.cases[0].verdict, 'pass');
  // The accepted output was judged before, so the cache answers.
  assert.equal(fake.calls(), calls);
  // An invented quote fails the criterion, whatever the judge decided.
  const liar = judge({ invent: true });
  const bad = await testSuite(current, judged, { runOptions: { transport: liar.transport, cacheDir: join(dir, 'cache-2') } });
  assert.equal(bad.cases[0].verdict, 'fail'); assert.match(bad.cases[0].candidate.attempts[0].results[0].reason, /quote is not in the text/);
  // A rubric that the bad run already meets is refused.
  await assert.rejects(createCase({ methodFile: current, runDir: join(dir, 'fixed'), id: 'x', note: 'n', rubric: ['The report says whether delivery of the summary is confirmed.'], config: judged, options }), /already meets this case/);
});

test('the fast judge is used for a criterion only when it agrees with the examples', async t => {
  const { dir, cfg, current } = await setup(t);
  await writeFile(current, JSON.stringify(version({ report: 'report-v2.mjs' })));
  await runMethod(current, cfg, { runDir: join(dir, 'fixed'), inputs: { amounts: [4, 6], to: 'ap@example.com' } });
  const fake = judge();
  const identity = { provider: 'typesafe', model: 'jev-test' };
  const classifier = good => ({ resolve: async () => identity, evaluate: async request => {
    const pass = good ? JSON.stringify(request.inputs).includes('delivery') : true;
    return { ...identity, choice: pass ? 'pass' : 'fail', probabilities: { pass: pass ? 0.97 : 0.03, fail: pass ? 0.03 : 0.97 }, confidence: 0.9, usage: null };
  } });
  const judged = { ...withJudge(cfg), classification: identity };
  const make = (id, good) => createCase({ methodFile: current, runDir: join(dir, 'run'), passingRun: join(dir, 'fixed'), id, note: 'Say whether delivery is confirmed.',
    rubric: ['The report says whether delivery of the summary is confirmed.'], config: judged, options: { runOptions: { transport: fake.transport }, classification: classifier(good), cacheDir: join(dir, 'cache') } });
  assert.deepEqual((await make('agrees', true)).expect[0].judges, { c1: 'classify' });
  assert.equal((await make('disagrees', false)).expect[0].judges, undefined);
});

test('a replay reads real folders, writes to scratch copies, and judges a saved path by what that run wrote', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const notes = join(dir, 'notes'), out = join(dir, 'out');
  await mkdir(notes); await mkdir(out);
  await writeFile(join(notes, 'a.md'), 'delivery not yet confirmed');
  await writeFile(join(dir, 'read.mjs'), 'import{readFileSync,readdirSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({material:readdirSync(a.notes).map(f=>readFileSync(a.notes+"/"+f,"utf8")).join("\\n")}))');
  const save = extra => `import{readFileSync,writeFileSync}from"node:fs";const a=JSON.parse(readFileSync(0,"utf8"));writeFileSync(a.out+"/report.md","Report: "+a.material${extra});console.log(JSON.stringify({path:a.out+"/report.md"}))`;
  await writeFile(join(dir, 'save.mjs'), save(''));
  const doc = { format: 'method/3.3', name: 'Paths', goal: 'Save a report.', environment: { notes: { type: 'files', description: 'Notes.' }, out: { type: 'files', description: 'Out.' } },
    steps: { read: { name: 'Read', purpose: 'Read notes.', in: { notes: 'environment.notes' }, do: script('read.mjs'), out: { material: text } },
      save: { name: 'Save', purpose: 'Save the report.', in: { material: 'material', out: 'environment.out' }, do: script('save.mjs'), out: { path: text }, changes: ['environment.out'] } }, result: 'path' };
  const file = join(dir, 'p.method'); await writeFile(file, JSON.stringify(doc));
  const cfg = withJudge(config({ notes, out }));
  assert.equal((await runMethod(file, cfg, { runDir: join(dir, 'run') })).status, 'completed');
  const fake = judge(), options = { runOptions: { transport: fake.transport }, cacheDir: join(dir, 'cache') };
  await createCase({ methodFile: file, passingRun: join(dir, 'run'), id: 'mentions-delivery', note: 'Keep the delivery status.', rubric: ['The report says whether delivery is confirmed.'], config: cfg, options });
  // A later run overwrites the real file; the case still judges what its source run wrote.
  await writeFile(join(out, 'report.md'), 'something else');
  const unchanged = await testSuite(file, cfg, { runOptions: options.runOptions });
  assert.equal(unchanged.cases[0].verdict, 'pass'); assert.deepEqual(unchanged.cases[0].candidate.attempts[0].live_steps, []);
  // A changed save step runs against a scratch copy; the read step is still replayed.
  await writeFile(join(dir, 'save.mjs'), save('+"!"'));
  const changed = await testSuite(file, cfg, { runOptions: options.runOptions });
  assert.equal(changed.cases[0].verdict, 'pass'); assert.deepEqual(changed.cases[0].candidate.attempts[0].live_steps, ['save']);
  assert.equal(await readFile(join(out, 'report.md'), 'utf8'), 'something else');
});

test('a rubric reads context, such as the sources, without judging it', async t => {
  const { dir, cfg, current, write } = await setup(t);
  let prompt = '';
  const fake = judge();
  const transport = async body => { prompt = JSON.stringify(body); return fake.transport(body); };
  await writeFile(current, JSON.stringify(version({ report: 'report-v2.mjs' })));
  await runMethod(current, cfg, { runDir: join(dir, 'fixed'), inputs: { amounts: [4, 6], to: 'ap@example.com' } });
  const created = await createCase({ methodFile: current, runDir: join(dir, 'run'), passingRun: join(dir, 'fixed'), id: 'with-context', note: 'Say whether delivery is confirmed.',
    rubric: ['The report says whether delivery of the summary is confirmed.'], context: ['outputs.total', 'inputs.to'], config: withJudge(cfg), options: { runOptions: { transport }, cacheDir: join(dir, 'cache') } });
  assert.deepEqual(created.expect[0].context, ['outputs.total', 'inputs.to']);
  assert.ok(prompt.includes('ap@example.com') && prompt.includes('10'), 'the context values reach the judge');
  const report = await testSuite(current, withJudge(cfg), { runOptions: { transport, cacheDir: join(dir, 'cache') } });
  assert.equal(report.cases[0].verdict, 'pass');
});

test('a case with a live model step runs more than once, stops at a failed run, and a rule kept only sometimes is unreliable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doc = prompt => ({ format: 'method/3.3', name: 'Model', goal: 'Write a line.', steps: { write: { name: 'Write', do: { kind: 'call', model: 'model', prompt }, out: { line: { type: 'text' } } } }, result: 'line' });
  const file = join(dir, 'm.method');
  const cfg = { ...config({}), models: { model: { backend: 'openai-responses', model: 'test-model', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100 } } };
  const answer = line => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ line }) }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  await writeFile(file, JSON.stringify(doc('Say hello.')));
  await runMethod(file, cfg, { runDir: join(dir, 'run'), transport: async () => answer('hello') });
  await createCase({ methodFile: file, passingRun: join(dir, 'run'), id: 'says-hello', note: 'Keep the greeting.', expect: [{ kind: 'equals', ref: 'outputs.line', value: 'hello' }], config: cfg });
  // The prompt changes, so the model step runs live in the test.
  await writeFile(file, JSON.stringify(doc('Say hello, please.')));
  const steady = await testSuite(file, cfg, { runOptions: { transport: async () => answer('hello') } });
  assert.ok(steady.cases[0].candidate.runs > 1); assert.equal(steady.cases[0].verdict, 'pass');
  assert.equal(steady.totals.live_model_steps, steady.cases[0].candidate.runs);
  let n = 0;
  const flaky = await testSuite(file, cfg, { runOptions: { transport: async () => answer(++n === 2 ? 'hi' : 'hello') } });
  assert.equal(flaky.cases[0].verdict, 'fail');
  assert.ok(flaky.cases[0].candidate.unreliable);
  // The case stops at its first failed run.
  assert.equal(flaky.cases[0].candidate.runs, n);
  assert.equal(flaky.cases[0].candidate.attempts.at(-1).status, 'fail');
});
