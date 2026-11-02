import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod } from '../src/index.js';
import { validateMethod } from '../src/validate.js';

// A production output schema: one value of a fixed list, and a field that may be left out.
const invoiceSchema = { type: 'object', required: ['document_type'], additionalProperties: false, properties: {
  document_type: { type: 'string', enum: ['utility_bill', 'ap_invoice', 'unknown'] },
  due_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } };
const config = {
  limits: { timeout_ms: 10000, max_model_requests: 5, max_invocations: 5, max_tool_calls: 5, max_output_bytes: 100000, max_request_bytes: 100000 }, allow_local_processes: true,
  runtimes: { node: { command: process.execPath, version: process.version } },
  models: { model: { backend: 'openrouter-chat', model: 'test-model', api_key_env: 'METHOD_TEST_UNUSED_KEY', max_output_tokens: 100 } },
};
const method = (out = { extraction: { type: 'record', schema: 'invoice.schema.json' } }, extra = {}) => ({ format: 'method/3.1', name: 'Extract', goal: 'Extract an invoice.',
  files: ['invoice.schema.json'], steps: { extract: { do: { kind: 'call', model: 'model', prompt: 'Extract the fields.' }, out } }, result: 'extraction', ...extra });
async function fixture(t, doc) {
  const dir = await mkdtemp(join(tmpdir(), 'method-schema-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'invoice.schema.json'), JSON.stringify(invoiceSchema));
  const file = join(dir, 'test.method'); await writeFile(file, JSON.stringify(doc));
  return transport => runMethod(file, config, { runDir: join(dir, 'run'), transport });
}
const answer = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }], usage: { prompt_tokens: 7, completion_tokens: 2 } });

test('a model step whose one output names a schema file gets that schema itself, and its answer is the output', async t => {
  const run = await fixture(t, method());
  let request;
  const result = await run(async body => { request = body; return answer({ document_type: 'ap_invoice' }); });
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.deepEqual(request.response_format.json_schema.schema, invoiceSchema);
  assert.deepEqual(result.result, { document_type: 'ap_invoice' });
});

test('an answer outside the schema file stops the step', async t => {
  const run = await fixture(t, method());
  const result = await run(async () => answer({ document_type: 'receipt', due_date: '15 Sept' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'invalid_output');
  assert.match(result.failure.details, /document_type/);
});

test('with other outputs beside it, the schema is one field of the answer', async t => {
  const run = await fixture(t, method({ extraction: { type: 'record', schema: 'invoice.schema.json' }, note: { type: 'text' } }));
  let request;
  const result = await run(async body => { request = body; return answer({ extraction: { document_type: 'unknown' }, note: 'Blank page.' }); });
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.deepEqual(request.response_format.json_schema.schema.properties.extraction, invoiceSchema);
});

test('a schema file must be in files, belongs only to a step output, and replaces fields', () => {
  assert.throws(() => validateMethod(method(undefined, { files: [] })), /invoice\.schema\.json is not in files/);
  assert.throws(() => validateMethod(method({ extraction: { type: 'record', fields: { a: 'text' }, schema: 'invoice.schema.json' } })), /fields or a schema, not both/);
  assert.throws(() => validateMethod(method({ wrap: { type: 'record', fields: { extraction: { type: 'record', schema: 'invoice.schema.json' } } } }, { result: 'wrap' })), /only a step output can name a schema file/);
  assert.throws(() => validateMethod(method(undefined, { inputs: { prior: { type: 'record', schema: 'invoice.schema.json' } } })), /only a step output can name a schema file/);
  assert.throws(() => validateMethod(method({ extraction: { type: 'text', schema: 'invoice.schema.json' } })), /schema only applies to a record/);
});
