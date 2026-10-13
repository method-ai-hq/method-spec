import { configShape } from './document-validators.js';
import Ajv from 'ajv';
import { methodSchema } from './schema.js';

const ajv = new Ajv({ allErrors: true, strict: false, ownProperties: true });
ajv.addSchema(methodSchema, 'method');
const validateConfiguration = configShape;
export { own, fail, safeData, shape, dataSchema, outputSchema, resolve, typeAt, effectiveOutputs } from './semantics.js';
import { own, fail, safeData, dataSchema } from './semantics.js';
/** The kind of a JSON value, in words, without the value itself. */
export function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return { string: 'text', number: 'a number', boolean: 'true or false', object: 'an object' }[typeof value] ?? typeof value;
}
const typeWords = { string: 'text', number: 'a number', integer: 'a whole number', boolean: 'true or false', object: 'an object', array: 'a list', null: 'null' };
/** "/evidence/0" -> "evidence[0]"; the whole value is "the result". */
function pathOf(pointer, extra) {
  const parts = pointer.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (extra !== undefined) parts.push(extra);
  return parts.reduce((path, part) => /^(0|[1-9][0-9]*)$/.test(part) ? `${path}[${part}]` : path ? `${path}.${part}` : part, '') || 'the result';
}
const at = (value, pointer) => pointer.split('/').slice(1).reduce((v, part) => v?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], value);
/** One {path, expected, found} for each validator error. Found is a kind of value, never the value. */
export function validationErrors(errors, value) {
  return errors.map(error => {
    const found = kindOf(at(value, error.instancePath));
    const p = error.params ?? {};
    switch (error.keyword) {
      case 'required': return { path: pathOf(error.instancePath, p.missingProperty), expected: 'present', found: 'missing' };
      case 'additionalProperties': return { path: pathOf(error.instancePath, p.additionalProperty), expected: 'absent, because it is not declared', found: 'present' };
      case 'type': return { path: pathOf(error.instancePath), expected: String(p.type).split(',').map(t => typeWords[t] ?? t).join(' or '), found };
      case 'enum': return { path: pathOf(error.instancePath), expected: `one of ${p.allowedValues.map(v => JSON.stringify(v)).join(', ')}`, found: typeof at(value, error.instancePath) === 'string' ? 'other text' : found };
      case 'const': return { path: pathOf(error.instancePath), expected: JSON.stringify(p.allowedValue), found };
      default: return { path: pathOf(error.instancePath), expected: `a value that meets "${error.keyword}" (${error.message})`, found };
    }
  });
}
/**
 * Validate a value that someone else produced. A failure carries the validator's errors as data (error.validation),
 * the producer (who returned the value), and its owner class; the raw validator text is the message.
 * @param {any} schema @param {any} value @param {string} label
 * @param {{producer: string, owner: string}} source
 */
export function assertSchema(schema, value, label, { producer, owner }) {
  const validate = ajv.compile(schema);
  if (!validate(value)) fail(owner, `${label}: ${ajv.errorsText(validate.errors)}`, 'invalid_output', { validation: validationErrors(validate.errors, value), producer });
}
function validateDefs(definitions = {}) {
  for (const def of Object.values(definitions)) {
    const schema = dataSchema(def);
    if (own(def, 'default')) assertSchema(schema, def.default, 'Default', { producer: 'the tool configuration', owner: 'setup' });
  }
}
export function validateConfig(config) {
  safeData(config, 'setup');
  if (!validateConfiguration(config)) fail('setup', `Configuration: ${ajv.errorsText(validateConfiguration.errors)}`);
  for (const tool of Object.values(config.tools ?? {})) { validateDefs(tool.in); validateDefs(tool.out); }
  for (const profile of Object.values(config.runtimes ?? {})) if (profile.env?.includes('METHOD_OPERATION_ID')) fail('setup', 'METHOD_OPERATION_ID is reserved for the executor');
  return config;
}
export { validateMethod } from './document.js';
