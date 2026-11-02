import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMethod } from '../src/runner.js';
import { codexArgs } from '../src/codex.js';

// A script step that writes one file and returns it as the output named file.
const writer = (name, bytes) => `import{writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{join}from'node:path';
for await(const _ of process.stdin);const b=Buffer.from(${JSON.stringify([...bytes])});writeFileSync(join(process.env.METHOD_OUTPUT_DIR,${JSON.stringify(name)}),b);
console.log(JSON.stringify({file:{path:${JSON.stringify(name)},sha256:createHash('sha256').update(b).digest('hex')}}))`;
const method = model => ({ format: 'method/3.1', name: 'Files', goal: 'Read a file.', steps: {
  make: { purpose: 'Write a file.', do: { kind: 'run', runtime: 'node', entrypoint: 'make.mjs' }, out: { file: { type: 'file', description: 'A file.' } } },
  read: { in: { file: 'file' }, do: { kind: 'agent', model, prompt: 'Return the text of the file.', tools: [] }, out: { text: { type: 'text' } } },
}, result: 'text' });

async function fixture(t, name, bytes, model) {
  const root = await mkdtemp(join(tmpdir(), 'method-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'make.mjs'), writer(name, bytes));
  const file = join(root, 'task.method');
  await writeFile(file, JSON.stringify(method(model)));
  return { root, file };
}
const runtimes = { node: { command: process.execPath, version: process.version } };

test('a Claude Code step is told where each input file is, and can open it', async t => {
  const f = await fixture(t, 'notes.txt', Buffer.from('Net 30 for this vendor.'), 'writer');
  const command = join(f.root, 'claude');
  // The fake Claude Code opens the absolute path that the prompt lists, from its own working folder.
  await writeFile(command, `#!/usr/bin/env node
const fs=require('node:fs');let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{
const m=/- file: (\\S+) \\(text\\/plain\\)/.exec(p);
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{text:m?fs.readFileSync(m[1],'utf8'):'no file listed'}}));});
`, { mode: 0o700 });
  const result = await runMethod(f.file, { allow_local_processes: true, runtimes, models: { writer: { backend: 'claude', command } } }, { runDir: join(f.root, 'run') });
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.equal(result.result, 'Net 30 for this vendor.');
});

test('a Codex step stops on a PDF before Codex starts', async t => {
  const f = await fixture(t, 'bill.pdf', Buffer.from('%PDF-1.4 bill'), 'writer');
  const command = join(f.root, 'codex'), marker = join(f.root, 'started');
  await writeFile(command, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'');\n`, { mode: 0o700 });
  const result = await runMethod(f.file, { allow_local_processes: true, runtimes, models: { writer: { backend: 'codex', command } } }, { runDir: join(f.root, 'run') });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'unreadable_file');
  assert.match(result.failure.details, /file \(bill\.pdf\) is a PDF, and Codex does not read PDF files/);
  assert.equal(existsSync(marker), false);
});

test('Codex gets each image with the prompt, before its other options', () => {
  const args = codexArgs({ schemaFile: 's.json', output: 'o.json', url: 'http://x', artifacts: '/a', images: ['/a/one.png', '/a/two.jpg'] });
  assert.deepEqual(args.slice(0, 5), ['exec', '--image', '/a/one.png', '/a/two.jpg', '--ephemeral']);
  assert.equal(args.at(-1), '-');
  assert.ok(!codexArgs({ schemaFile: 's.json', output: 'o.json', url: 'http://x', artifacts: '/a' }).includes('--image'));
});
