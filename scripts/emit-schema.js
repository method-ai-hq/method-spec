import { writeFile, readFile } from 'node:fs/promises';
import { methodSchema, configSchema } from '../src/schema.js';
for (const [name, schema] of [['method-3', methodSchema], ['runtime-config', configSchema]]) {
  const text = JSON.stringify(schema, null, 2) + '\n';
  const file = new URL(`../spec/${name}.schema.json`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (await readFile(file, 'utf8') !== text) throw new Error(`Stale schema: ${name}`);
  } else await writeFile(file, text);
}
