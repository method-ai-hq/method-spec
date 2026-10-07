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
/**
 * Turn schema errors into a few readable lines. Alternatives that the document did not choose (oneOf branches) are
 * noise; an unknown key that contains a space is almost always a YAML value with a comma inside { }.
 */
export function readableShapeErrors(errors) {
  const where = path => path ? path.slice(1).replaceAll('/', '.') : 'the document';
  const comma = errors.find(e => e.keyword === 'additionalProperties' && /\s/.test(e.params?.additionalProperty ?? ''));
  if (comma) return `${where(comma.instancePath)}: the text "${comma.params.additionalProperty}" became a separate field. A value inside { } that contains a comma must be quoted, for example description: "First part, second part."`;
  const useful = errors.filter(e => !['oneOf', 'anyOf', 'if', 'else', 'not'].includes(e.keyword) && !(e.keyword === 'const' && e.instancePath.endsWith('/kind')));
  const deepest = Math.max(...useful.map(e => e.instancePath.split('/').length));
  const lines = [...new Set(useful.filter(e => e.instancePath.split('/').length === deepest).map(e =>
    e.keyword === 'additionalProperties' ? `${where(e.instancePath)}: unknown field "${e.params.additionalProperty}"`
      : e.keyword === 'required' ? `${where(e.instancePath)}: missing field "${e.params.missingProperty}"`
      : e.keyword === 'enum' ? `${where(e.instancePath)}: use one of ${e.params.allowedValues.join(', ')}`
      : `${where(e.instancePath)}: ${e.message}`))];
  return (lines.length > 4 ? [...lines.slice(0, 4), `(${lines.length - 4} more; method schema step shows the fields)`] : lines).join('; ');
}
export function validateMethod(value) {
  try {
    const method = parseDocumentValue(value);
    if (!['method/3.1', 'method/3.2', 'method/3.3'].includes(method?.format)) throw new MethodValidationError('UNSUPPORTED_FORMAT: use a method/3.1, method/3.2, or method/3.3 document.', 'unsupported_format');
    if (!methodShape(method)) throw Error('Method: ' + readableShapeErrors(methodShape.errors));
    return validateSemantics(method, (def, value) => {
      const errors = shapeErrors(def, value, 'Default');
      if (errors.length) throw Error(errors.join('\n'));
    });
  } catch (error) {
    if (error instanceof MethodValidationError) throw error;
    throw new MethodValidationError(error.message);
  }
}
