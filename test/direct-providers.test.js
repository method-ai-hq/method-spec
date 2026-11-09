import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMethod, methodIssues, runMethod } from '../src/index.js';
import { resolveModels } from '../src/agents.js';

// An invoice Method whose model steps call Anthropic and OpenAI directly with the operator's own keys.
const invoices = (change = () => {}) => {
  const method = {
    format: 'method/3.4', name: 'Invoice coding', goal: 'Read a bill and code it.',
    secrets: { ANTHROPIC_API_KEY: 'Anthropic API key for the extractor.', OPENAI_API_KEY: 'OpenAI API key for the reviewer.' },
    models: {
      extractor: { provider: 'anthropic', model: 'claude-sonnet-4-6', key: 'ANTHROPIC_API_KEY', max_output_tokens: 16000, reasoning_effort: 'high' },
      reviewer: { provider: 'openai', model: 'gpt-5.2', key: 'OPENAI_API_KEY', reasoning_effort: 'low' },
    },
    inputs: { notes: { type: 'text', description: 'Notes about the vendor.' } },
    steps: {
      extract: { in: { notes: 'inputs.notes' }, do: { kind: 'call', model: 'extractor', prompt: 'Read the vendor from {{notes}}.' }, out: { vendor: { type: 'text' } } },
      review: { in: { vendor: 'vendor' }, do: { kind: 'call', model: 'reviewer', prompt: 'Check {{vendor}}.' }, out: { ok: { type: 'boolean' } } },
    },
    result: { vendor: 'vendor', ok: 'ok' },
  };
  change(method);
  return method;
};

test('a models entry can name a direct provider with a declared key', () => {
  validateMethod(invoices());
  assert.deepEqual(methodIssues(invoices()).filter(issue => issue.level === 'error'), []);
  // max_output_tokens and reasoning_effort are optional.
  validateMethod(invoices(m => { m.models.extractor = { provider: 'anthropic', model: 'claude-sonnet-4-6', key: 'ANTHROPIC_API_KEY' }; }));
});

test('a direct provider entry refuses a provider prefix, another provider, another effort, an endpoint, and a reserved key name', () => {
  const refused = change => assert.throws(() => validateMethod(invoices(change)), /models/);
  refused(m => { m.models.extractor.model = 'anthropic/claude-sonnet-4-6'; });
  refused(m => { m.models.extractor.provider = 'openrouter'; });
  refused(m => { m.models.extractor.reasoning_effort = 'minimal'; });
  refused(m => { m.models.reviewer.reasoning_effort = 'max'; });
  refused(m => { m.models.extractor.url = 'https://example.com/v1/messages'; });
  refused(m => { m.models.extractor.api_key_env = 'ANTHROPIC_API_KEY'; });
  refused(m => { m.models.extractor.key = 'anthropic_key'; });
  refused(m => { m.models.extractor.key = 'METHOD_API_KEY'; });
  refused(m => { delete m.models.extractor.key; });
  // A local-agent field is not a direct-provider field.
  refused(m => { m.models.extractor.agent = 'claude'; });
});

test('the key of a direct provider must be a declared secret', () => {
  const [issue] = methodIssues(invoices(m => { delete m.secrets.ANTHROPIC_API_KEY; }));
  assert.equal(issue.code, 'undeclared_model_key');
  assert.equal(issue.level, 'error');
  assert.equal(issue.field, 'models.extractor.key');
  assert.match(issue.fix, /Declare ANTHROPIC_API_KEY under secrets:/);
});

test('model resolution: a direct provider entry is the profile of its backend, with its key', async () => {
  const profiles = await resolveModels(invoices(), {}, { env: {} });
  assert.deepEqual(profiles.extractor, { backend: 'anthropic-messages', model: 'claude-sonnet-4-6', api_key_env: 'ANTHROPIC_API_KEY', max_output_tokens: 16000, effort: 'high' });
  assert.deepEqual(profiles.reviewer, { backend: 'openai-responses', model: 'gpt-5.2', api_key_env: 'OPENAI_API_KEY', max_output_tokens: 16000, reasoning_effort: 'low' });
  // A configured profile with the same name does not replace the Method's own entry.
  const configured = await resolveModels(invoices(), { models: { extractor: { backend: 'method', model: 'anthropic/claude-sonnet-4.6' } } }, { env: {} });
  assert.equal(configured.extractor.backend, 'anthropic-messages');
});

// A PDF written by a script step, then read by a call step on the direct Anthropic entry.
const pdfMethod = () => ({
  format: 'method/3.4', name: 'Bill reader', goal: 'Read a bill.',
  secrets: { ANTHROPIC_API_KEY: 'Anthropic API key for the reader.' },
  models: { reader: { provider: 'anthropic', model: 'claude-sonnet-4-6', key: 'ANTHROPIC_API_KEY' } },
  steps: {
    make: { purpose: 'Write the bill.', do: { kind: 'run', runtime: 'node', entrypoint: 'make.mjs' }, out: { bill: { type: 'file', description: 'The bill.' } } },
    read: { in: { bill: 'bill' }, do: { kind: 'call', model: 'reader', prompt: 'Read the vendor of the bill.' }, out: { vendor: { type: 'text' } } },
  },
  result: 'vendor',
});
const makeBill = `import{writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{join}from'node:path';
for await(const _ of process.stdin);const b=Buffer.from('%PDF-1.4 bill');writeFileSync(join(process.env.METHOD_OUTPUT_DIR,'bill.pdf'),b);
console.log(JSON.stringify({bill:{path:'bill.pdf',sha256:createHash('sha256').update(b).digest('hex')}}))`;
const runConfig = { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } } };
const key = 'sk-ant-test-direct-provider-0123456789';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'method-direct-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'make.mjs'), makeBill);
  const file = join(root, 'bill.method');
  await writeFile(file, JSON.stringify(pdfMethod()));
  return { root, file };
}
/** Replace fetch for one test: record each request and answer as Anthropic would. */
function stubFetch(t) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ vendor: 'Acme Supply' }) }], usage: { input_tokens: 12, output_tokens: 5 } }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  return sent;
}
async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { recursive: true })) if ((await stat(join(dir, entry))).isFile()) found.push(join(dir, entry));
  return found;
}

test('a direct Anthropic step calls api.anthropic.com with the declared key and sends a PDF as a document block', async t => {
  const f = await fixture(t);
  const sent = stubFetch(t);
  // No hostedModels and no transport: a hosted request would fail the run, so every request here is direct.
  const result = await runMethod(f.file, runConfig, { runDir: join(f.root, 'run'), secrets: { ANTHROPIC_API_KEY: key }, env: {} });
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.equal(result.result, 'Acme Supply');
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], key);
  assert.equal(request.body.model, 'claude-sonnet-4-6');
  assert.equal(request.body.max_tokens, 16000);
  assert.equal(request.body.output_config.format.type, 'json_schema');
  const content = request.body.messages[0].content;
  assert.deepEqual(content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 bill').toString('base64') } });
  // The key never reaches the run records.
  for (const file of await files(join(f.root, 'run'))) assert.ok(!(await readFile(file, 'utf8')).includes(key), file);
  const events = (await readFile(join(f.root, 'run', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.event === 'model.used' && event.backend === 'anthropic-messages' && event.model === 'claude-sonnet-4-6'));
});

test('without a host store, the direct key comes from the process environment', async t => {
  const f = await fixture(t);
  const sent = stubFetch(t);
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = key;
  t.after(() => { if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before; });
  const result = await runMethod(f.file, runConfig, { runDir: join(f.root, 'run'), env: {} });
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.equal(sent[0].headers['x-api-key'], key);
});

test('a missing direct key stops the run before any step, and no request is sent', async t => {
  const f = await fixture(t);
  const sent = stubFetch(t);
  const before = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (before !== undefined) process.env.ANTHROPIC_API_KEY = before; });
  await assert.rejects(runMethod(f.file, runConfig, { runDir: join(f.root, 'run'), secrets: {}, env: {} }), error => error.code === 'missing_secret' && error.missing?.includes('ANTHROPIC_API_KEY'));
  assert.equal(sent.length, 0);
});
