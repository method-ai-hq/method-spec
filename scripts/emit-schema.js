import { writeFile, readFile } from 'node:fs/promises';
import { methodSchema, configSchema } from '../src/schema.js';
for (const [name, schema] of [['method-3', methodSchema], ['runtime-config', configSchema]]) {
  const text = JSON.stringify(schema, null, 2) + '\n';
  const file = new URL(`../spec/${name}.schema.json`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (await readFile(file, 'utf8') !== text) throw new Error(`Stale schema: ${name}`);
  } else await writeFile(file, text);
}

// Compile shape checks once for both Node and environments that disallow eval.
const { default: Ajv } = await import('ajv');
const { default: standalone } = await import('ajv/dist/standalone/index.js');
const ajv = new Ajv({ inlineRefs: false, allErrors: true, strict: false, ownProperties: true, code: { source: true, esm: true } });
ajv.addSchema(methodSchema, 'method'); ajv.addSchema(configSchema, 'config');
for (const [name, path] of Object.entries({step:'#/$defs/step', check:'#/$defs/check', data:'#/$defs/data', environment:'#/properties/environment/additionalProperties'})) ajv.addSchema({$ref: methodSchema.$id + path}, name);
const text = "// Generated from schema.js. Do not edit.\nimport unicodeLengthModule from 'ajv/dist/runtime/ucs2length.js';\nconst unicodeLength = unicodeLengthModule.default ?? unicodeLengthModule;\n"
  + standalone(ajv, {methodShape:'method', configShape:'config', stepShape:'step', checkShape:'check', dataShape:'data', environmentShape:'environment'}).replaceAll('require("ajv/dist/runtime/ucs2length").default', 'unicodeLength');
const file = new URL('../src/document-validators.js', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== text) throw Error('Stale document validators');
} else await writeFile(file, text);
