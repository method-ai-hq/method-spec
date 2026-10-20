import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSchema, fail } from './validate.js';
import { learnedSchema } from './schema.js';

/** The file of learned rules beside a Method file. It is part of the bundle and the manifest. */
export const learnedFile = 'learned.json';

/** The learned rules in a folder, validated, or null when the folder has none. */
export async function readLearned(dir) {
  let text;
  try { text = await readFile(join(dir, learnedFile), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(text); } catch { fail('method_code', `${learnedFile} is not valid JSON`, 'invalid_learned', { producer: learnedFile }); }
  assertSchema(learnedSchema, value, learnedFile, { producer: learnedFile, owner: 'method_code' });
  return value;
}

/** The active rules of one step, in file order. Only these change the step's key and reach its prompt. */
export const activeRules = (learned, id) => (learned?.steps?.[id] ?? []).filter(rule => rule.status === 'active').map(({ id, when, then }) => ({ id, when, then }));

/** The rules that the step prompt ends with. */
export const rulesText = rules => ['Rules learned from corrections:', ...rules.map(rule => `- ${rule.then}`)].join('\n');

/** The call that decides which conditional rules apply to one iteration, on the step's own model. */
export const selectionPrompt = [
  'Each condition below belongs to a rule for a step of a Method. Decide from the step inputs which conditions hold for this run of the step.',
  'Return applies: the ids of the conditions that hold. Return an empty list when none holds. Judge only from the step inputs; do not open files, run commands, or do the step itself.',
].join('\n');
export const selectionSchema = { type: 'object', properties: { applies: { type: 'array', items: { type: 'string' } } }, required: ['applies'], additionalProperties: false };
