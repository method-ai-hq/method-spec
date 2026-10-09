/** Browser-safe document parsing and validation shared by every Method client. */
import YAML from 'yaml';
import { methodShape } from './document-validators.js';
import { safeData, validateSemantics, dataSchema, shape } from './semantics.js';
import { formats } from './schema.js';
import { codeIssues, applyAccepts } from './issues.js';

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
const supported = formats.join(', ');
/** Where the first schema error points: the step and the field inside it. */
function shapeLocation(errors) {
  const path = (errors.find(e => !['oneOf', 'anyOf', 'if', 'else', 'not'].includes(e.keyword)) ?? errors[0])?.instancePath.slice(1).split('/').filter(Boolean) ?? [];
  if (path[0] === 'steps' && path[1]) return { step: path[1], ...(path.length > 2 ? { field: path.slice(2).join('.') } : {}) };
  return path.length ? { field: path.join('.') } : {};
}
const parseFix = 'Correct the YAML at the reported position, then validate again.';
const shapeFix = 'Correct the named field; method schema step shows the fields that a step allows.';
/** Validate once: the first format error as an issue, or the validated Method. */
function inspect(value) {
  let method;
  try { method = parseDocumentValue(value); }
  catch (error) { return { issues: [{ code: 'invalid_method', level: 'error', message: error.message, fix: parseFix }] }; }
  if (!formats.includes(method?.format)) return { method, issues: [{ code: 'unsupported_format', level: 'error', field: 'format',
    message: `UNSUPPORTED_FORMAT: use a ${supported.replace(/, ([^,]+)$/, ', or $1')} document.`, fix: 'Set format to method/3.4.' }] };
  if (!methodShape(method)) return { method, issues: [{ code: 'invalid_method', level: 'error', ...shapeLocation(methodShape.errors),
    message: 'Method: ' + readableShapeErrors(methodShape.errors), fix: shapeFix }] };
  try {
    const validated = validateSemantics(method, (def, value) => {
      const errors = shapeErrors(def, value, 'Default');
      if (errors.length) throw Object.assign(Error(errors.join('\n')), { fix: 'Make the default match the declared type.' });
    });
    return { method, validated, issues: [] };
  } catch (error) {
    const code = !error.code || error.code === 'validation' ? 'invalid_method' : error.code;
    return { method, issues: [{ code, level: 'error', ...(error.step ? { step: error.step } : {}), ...(error.field ? { field: error.field } : {}),
      message: error.message, fix: error.fix ?? 'Change the Method as the message says, then validate again.' }] };
  }
}
/** The line of the deepest key on the path that the text contains. */
function lineOf(text, path) {
  const counter = new YAML.LineCounter();
  let node = YAML.parseDocument(text, { lineCounter: counter }).contents, line;
  for (const key of path) {
    const pair = YAML.isMap(node) ? node.items.find(item => String(item.key?.value ?? item.key) === key) : undefined;
    if (!pair) break;
    if (pair.key?.range) line = counter.linePos(pair.key.range[0]).line;
    node = pair.value;
  }
  return line;
}
/**
 * Every issue in a Method: the first format error, or else the code checks; then accepts are applied.
 * @param {unknown} document Method text or parsed value.
 * @param {import('./api-types.js').IssueOptions} [options]
 * @returns {import('./api-types.js').Issue[]}
 */
export function methodIssues(document, options = {}) {
  const { method, validated, issues } = inspect(document);
  const found = validated ? [...codeIssues(method, options), ...(options.issues ?? [])] : issues;
  const result = applyAccepts(validated ? method : undefined, found, options.notChecked);
  if (typeof document !== 'string') return result;
  return result.map(item => {
    if (item.line !== undefined || item.file || (!item.step && !item.field)) return item;
    const line = lineOf(document, [...(item.step ? ['steps', item.step] : []), ...(item.field ? item.field.split('.') : [])]);
    return line === undefined ? item : { ...item, line };
  });
}
/** Throw the first format error; return the Method, its step order, and its dependencies. */
export function validateMethod(value) {
  const { validated, issues } = inspect(value);
  if (validated) return validated;
  const [first] = issues;
  throw Object.assign(new MethodValidationError(first.message, first.code), { issue: first });
}
/** The document as its content digest sees it: the account Method ID is left out, so a copy keeps its versions. */
export function documentForDigest(document) {
  const { id, ...content } = document;
  return content;
}
