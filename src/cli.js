#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { runMethod, validateMethod, validateConfig, methodSchema, configSchema, readDocument, migrateMethod2 } from './index.js';
const help = `Method 3 — public reference executor

method3 validate METHOD [--config CONFIG]
method3 run METHOD --config CONFIG [--inputs JSON] [--state JSON] [--run-dir DIR]
method3 schema [method|config]
method3 migrate METHOD2 --model PROFILE --timeout-ms N --max-agent-turns N --max-model-requests N [--output FILE]

run never retries a failed action. Local scripts require allow_local_processes in CONFIG.
Model execution uses the configured API key environment variable and request limits.
Use --version for the runtime version. Documentation: spec/method-3.md
`;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, version: { type: 'boolean' }, config: { type: 'string' }, inputs: { type: 'string' }, state: { type: 'string' },
    'run-dir': { type: 'string' }, model: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'max-agent-turns': { type: 'string' }, 'max-model-requests': { type: 'string' }, output: { type: 'string' },
  } });
  const [command, file, ...extra] = positionals;
  if (extra.length) throw new Error('Unexpected positional arguments');
  if (values.version) console.log('0.1.0 (method/3)');
  else if (values.help || !command) console.log(help);
  else if (command === 'schema') {
    if (file && !['method', 'config'].includes(file)) throw new Error('Use schema method or schema config');
    console.log(JSON.stringify(file === 'config' ? configSchema : methodSchema, null, 2));
  } else if (command === 'validate') {
    if (!file) throw new Error('Supply a Method file');
    const { order } = validateMethod(await readDocument(file));
    if (values.config) validateConfig(await readDocument(values.config));
    console.log(JSON.stringify({ valid: true, order, note: 'Runtime profiles and files are checked again before execution.' }));
  } else if (command === 'run') {
    if (!file || !values.config) throw new Error('Supply a Method file and --config');
    const controller = new AbortController();
    const stop = () => controller.abort(Object.assign(new Error('Interrupted by operator'), { code: 'interrupted' }));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const json = async path => path ? JSON.parse(await readFile(path, 'utf8')) : undefined;
    const result = await runMethod(file, await readDocument(values.config), {
      inputs: await json(values.inputs), state: await json(values.state), runDir: values['run-dir'], signal: controller.signal,
    });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    console.log(JSON.stringify({ status: result.status, code: result.code, run_dir: result.run_dir, elapsed_ms: result.elapsed_ms, model_requests: result.model_requests }));
    process.exitCode = result.status === 'completed' ? 0 : result.status === 'needs_input' ? 2 : 1;
  } else if (command === 'migrate') {
    if (!file) throw new Error('Supply a Method 2 file');
    const { method, warnings } = migrateMethod2(await readDocument(file), { model: values.model, timeout_ms: Number(values['timeout-ms']), max_agent_turns: Number(values['max-agent-turns']), max_model_requests: Number(values['max-model-requests']) });
    warnings.forEach(warning => console.error(warning));
    const text = YAML.stringify(method);
    if (values.output) await writeFile(values.output, text, { flag: 'wx' }); else process.stdout.write(text);
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
