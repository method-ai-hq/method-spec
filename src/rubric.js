import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, writeJSON } from './io.js';
import { fail } from './validate.js';

/**
 * A rubric judges a value against plain-sentence criteria. A model judge decides each criterion and quotes the text
 * that decides it; a quote that is not in the value counts as a failed vote. A criterion passes only when every vote
 * passes. A fast classification judge is used for a criterion only when it agreed with the examples at case creation.
 */
const defaults = { judge_runs: 3, classify_threshold: 0.9, max_value_bytes: 200_000 };
export const rubricSettings = config => ({ ...defaults, ...config?.rubric });
const judgeMethod = {
  format: 'method/3.3', name: 'Rubric judge', goal: 'Decide whether a value meets each criterion, with quotes.',
  inputs: { value: { type: 'text' }, criteria: { type: 'text' }, context: { type: 'text', default: '' } },
  steps: {
    judge: {
      name: 'Judge the criteria',
      in: { value: 'inputs.value', criteria: 'inputs.criteria', context: 'inputs.context' },
      do: { kind: 'call', model: 'judge', prompt: [
        'Decide whether the text below meets each criterion. Judge only from the text below: do not open files, run commands, or use outside knowledge, and do not assume what the text does not say.',
        'For each criterion, return its id, pass (true or false), quote, and reason.',
        'quote: words copied exactly from the text that decide the criterion. When no single passage decides it (for example, when the criterion is about something the text must not contain, and the text does not contain it), use an empty quote.',
        'The context (for example the sources or the person\'s words) is for checking the text against. Do not judge the context, and do not quote from it.',
        'reason: one short sentence.', '', 'Criteria (JSON):', '{{criteria}}', '', 'Context:', '{{context}}', '', 'Text:', '{{value}}',
      ].join('\n') },
      out: { verdicts: { type: 'list', fields: { id: 'text', pass: 'boolean', quote: 'text', reason: 'text' } } },
    },
  },
  result: 'verdicts',
};
const normalize = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
export const valueText = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

async function cached(key, compute, cacheDir) {
  const dir = join(cacheDir ?? process.env.METHOD_CACHE_DIR ?? join(homedir(), '.cache', 'method'), 'judgments');
  const file = join(dir, `${key}.json`);
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* not cached */ }
  const value = await compute();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeJSON(file, value);
  return value;
}

/** Run a one-step judge Method with the judge model and return its result. */
async function runJudge(method, inputs, config, options) {
  const { runMethod } = await import('./runner.js');
  const dir = await mkdtemp(join(tmpdir(), 'method-judge-'));
  try {
    const file = join(dir, 'judge.method');
    await writeFile(file, JSON.stringify(method));
    const result = await runMethod(file, { ...config, allow_local_processes: true }, { ...options.runOptions, runDir: join(dir, 'run'), inputs, replay: undefined });
    if (result.status !== 'completed') fail('outside_service', `The ${method.name.toLowerCase()} did not finish: ${result.failure?.headline ?? result.status}`, 'judge_failed');
    return result.result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** One vote of the model judge on every criterion. */
async function modelVote(text, criteria, config, options, context) {
  const verdicts = await runJudge(judgeMethod, { value: text, criteria: JSON.stringify(criteria.map(({ id, text }) => ({ id, text }))), context: context || '(none)' }, config, options);
  const byId = new Map(verdicts.map(v => [v.id, v]));
  const quoted = normalize(text);
  return criteria.map(({ id }) => {
    const verdict = byId.get(id);
    if (!verdict) return { id, pass: false, quote: '', reason: 'The judge gave no verdict for this criterion.' };
    // A judge that invents support is wrong, whatever it decided.
    if (verdict.quote.trim() && !quoted.includes(normalize(verdict.quote))) return { ...verdict, pass: false, reason: `The quote is not in the text: "${verdict.quote.slice(0, 120)}"` };
    return verdict;
  });
}

/** The classification judge's probability that a value meets one criterion. */
async function classifyPass(text, criterion, options) {
  const provider = options.classification;
  const resolved = await provider.resolve(options.signal ?? new AbortController().signal);
  const answer = await provider.evaluate({ request_id: randomUUID(), model: resolved.model, question: `Does this text meet the criterion? Criterion: ${criterion.text}`,
    options: { pass: 'The text meets the criterion.', fail: 'The text does not meet the criterion.' }, inputs: { text } }, options.signal ?? new AbortController().signal);
  return answer.probabilities.pass;
}

/**
 * Judge a value. Returns {status: pass|fail, criteria: [{id, text, pass, judge, votes|probability, reason}]}.
 * @param {{value: any, criteria: Array<{id: string, text: string}>, context?: any, judges?: Record<string, string>, config: any, options?: any}} input
 */
export async function judgeRubric({ value, criteria, context, judges = {}, config, options = {} }) {
  const settings = rubricSettings(config);
  const text = valueText(value ?? '');
  if (Buffer.byteLength(text) > settings.max_value_bytes) fail('limit', `The judged value exceeds ${settings.max_value_bytes} bytes`, 'judge_failed');
  const modelCriteria = criteria.filter(c => judges[c.id] !== 'classify');
  // The agent that resolves the default judge is part of the key, so a different judge does not reuse old answers.
  const profile = config?.models?.judge ?? { agent: config?.models?.default ?? null };
  const contextText = context === undefined || context === null ? '' : valueText(context);
  const key = hash(['rubric/2', text, contextText, modelCriteria, profile, settings.judge_runs]);
  let calls = 0;
  const votes = modelCriteria.length ? await cached(key, async () => {
    calls = settings.judge_runs;
    const all = await Promise.all(Array.from({ length: settings.judge_runs }, () => modelVote(text, modelCriteria, config, options, contextText)));
    return modelCriteria.map((c, i) => all.map(run => run[i]));
  }, options.cacheDir) : [];
  const results = [];
  for (const c of criteria) {
    if (judges[c.id] === 'classify') {
      const probability = await classifyPass(text, c, options);
      results.push({ id: c.id, text: c.text, judge: 'classify', probability, pass: probability >= settings.classify_threshold,
        reason: `Classification probability ${probability.toFixed(2)}; at least ${settings.classify_threshold} needed.` });
    } else {
      const own = votes[modelCriteria.indexOf(c)];
      const failed = own.find(v => !v.pass);
      results.push({ id: c.id, text: c.text, judge: 'model', votes: own, pass: !failed,
        reason: failed ? failed.reason : `${own.length} of ${own.length} votes pass${own.find(v => v.quote) ? `: "${own.find(v => v.quote).quote.slice(0, 120)}"` : ''}.` });
    }
  }
  return { status: results.every(r => r.pass) ? 'pass' : 'fail', criteria: results, judge_calls: calls };
}

const conflictMethod = {
  format: 'method/3.3', name: 'Case conflict judge', goal: 'Find the rules of a new case that can be met only by breaking an instruction of the Method.',
  inputs: { rules: { type: 'text' }, note: { type: 'text' }, instructions: { type: 'text' } },
  steps: {
    judge: {
      name: 'Find conflicts',
      in: { rules: 'inputs.rules', note: 'inputs.note', instructions: 'inputs.instructions' },
      do: { kind: 'call', model: 'judge', prompt: [
        'A person corrected a run of a Method. The rules below will become a case: every later version of the Method must meet them on the same inputs.',
        'Below the rules are the instructions of the Method\'s model steps and the information that each step received on that run.',
        'For each rule, decide whether an output can meet it while it follows every instruction and uses only the information received.',
        'Report a conflict only when the rule cannot be met without breaking an instruction. Two common kinds: the rule needs a fact that the information does not give, and an instruction forbids inventing or assuming facts; or the rule requires an action, a content, or a form that an instruction forbids or limits.',
        'For each conflict, return rule (the rule id), instruction (words copied exactly from the instructions that the rule would break), and reason (one sentence that names what is missing or what the rule forces).',
        'Return an empty list when no rule conflicts. Do not report a conflict that depends on information you cannot see. Do not open files, run commands, or use outside knowledge.',
        '', 'The person\'s words:', '{{note}}', '', 'Rules (JSON):', '{{rules}}', '', 'Instructions and information:', '{{instructions}}',
      ].join('\n') },
      out: { conflicts: { type: 'list', fields: { rule: 'text', instruction: 'text', reason: 'text' } } },
    },
  },
  result: 'conflicts',
};

/**
 * Find the rules of a new case that can be met only by breaking a standing instruction: a rule that needs a fact the
 * inputs do not give when an instruction forbids inventing it, or a rule that requires what an instruction forbids. A
 * rule conflicts when most judge votes report it with an instruction that is copied exactly from the instructions.
 * @param {{rules: Array<{id: string, text: string}>, note: string, instructions: string, config: any, options?: any}} input
 */
export async function findConflicts({ rules, note, instructions, config, options = {} }) {
  const runs = rubricSettings(config).judge_runs;
  const inputs = { rules: JSON.stringify(rules), note, instructions };
  const votes = await Promise.all(Array.from({ length: runs }, () => runJudge(conflictMethod, inputs, config, options)));
  const given = normalize(instructions);
  const conflicts = [];
  for (const rule of rules) {
    const found = votes.map(vote => vote.find(c => c.rule === rule.id && c.instruction.trim() && given.includes(normalize(c.instruction)))).filter(Boolean);
    if (found.length * 2 > runs) conflicts.push({ rule: rule.id, text: rule.text, instruction: found[0].instruction, reason: found[0].reason });
  }
  return conflicts;
}

/**
 * Choose the fast judge for a criterion only when it agrees with every example: the model judge's verdicts on the
 * failing example, and pass on the passing example.
 */
export async function chooseJudges({ criteria, examples, config, options = {} }) {
  const judges = {};
  if (!options.classification || !config?.classification) return judges;
  const settings = rubricSettings(config);
  for (const c of criteria) {
    // Agreement must include at least one passing and one failing label for this criterion.
    const labels = examples.map(e => e.labels[c.id]).filter(l => l !== undefined);
    if (!labels.includes(true) || !labels.includes(false)) continue;
    let agrees = true;
    for (const example of examples) {
      const want = example.labels[c.id];
      if (want === undefined) continue;
      const probability = await classifyPass(valueText(example.value), c, options);
      if ((probability >= settings.classify_threshold) !== want) { agrees = false; break; }
    }
    if (agrees) judges[c.id] = 'classify';
  }
  return judges;
}
