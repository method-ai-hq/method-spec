/** Browser-safe document parsing and validation shared by every Method client. */
import YAML from 'yaml';
import { methodShape } from './document-validators.js';
import { safeData, validateSemantics, dataSchema, shape } from './semantics.js';

export class MethodValidationError extends Error {
  constructor(message, code = 'invalid_method') { super(message); this.name = 'MethodValidationError'; this.code = code; }
}
export function parseDocumentValue(value) {
  try {
    if (typeof value === 'string') {
      if (new TextEncoder().encode(value).length > 2_000_000) throw Error('Document exceeds 2 MB');
      const document = YAML.parseDocument(value, { uniqueKeys: true, strict: true });
      if (document.errors.length) throw Error(document.errors.map(error => error.message).join('; '));
      value = document.toJS({ maxAliasCount: 20 });
    }
    safeData(value);
    return value;
  } catch (error) { throw new MethodValidationError(error.message); }
}
/** Validate values without dynamic code generation, including in browsers and Workers. */
export function shapeErrors(definition, value, label = 'value') {
  dataSchema(definition);
  const def = shape(definition);
  if (def.type === 'text') return typeof value === 'string' ? [] : [`${label}: expected text.`];
  if (def.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? [] : [`${label}: expected a number.`];
  if (def.type === 'boolean') return typeof value === 'boolean' ? [] : [`${label}: expected true or false.`];
  if (def.type === 'list') return Array.isArray(value) ? value.flatMap((item, i) => shapeErrors(def.fields ? {type:'record',fields:def.fields} : def.items, item, `${label}[${i}]`)) : [`${label}: expected a list.`];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label}: expected a ${def.type}.`];
  if (def.type === 'file') return [
    ...(typeof value.path === 'string' ? [] : [`${label}.path: expected text.`]),
    ...(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) ? [] : [`${label}.sha256: expected a SHA-256 digest.`]),
    ...Object.keys(value).filter(key => !['path','sha256'].includes(key)).map(key => `${label}.${key}: unexpected field.`),
  ];
  return [...Object.entries(def.fields).flatMap(([key, child]) => shapeErrors(child, value[key], `${label}.${key}`)),
    ...Object.keys(value).filter(key => !Object.hasOwn(def.fields, key)).map(key => `${label}.${key}: unexpected field.`)];
}
export function validateMethod(value) {
  try {
    const method = parseDocumentValue(value);
    if (!['method/3', 'method/3.1'].includes(method?.format)) throw new MethodValidationError('UNSUPPORTED_FORMAT: use a method/3 or method/3.1 document. Legacy execution is removed.', 'unsupported_format');
    if (!methodShape(method)) throw Error('Method: ' + methodShape.errors.map(error => `${error.instancePath}: ${error.message}`).join('; '));
    return validateSemantics(method, (def, value) => {
      const errors = shapeErrors(def, value, 'Default');
      if (errors.length) throw Error(errors.join('\n'));
    });
  } catch (error) {
    if (error instanceof MethodValidationError) throw error;
    throw new MethodValidationError(error.message);
  }
}
