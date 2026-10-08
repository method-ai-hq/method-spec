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
        'Quotes come only from the text, never from the context. The context (for example the sources or the person\'s words) is there so you can check the text against it; do not judge the context.',
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

/** One vote of the model judge on every criterion. */
async function modelVote(text, criteria, config, options, context) {
  const { runMethod } = await import('./runner.js');
  const dir = await mkdtemp(join(tmpdir(), 'method-judge-'));
  try {
    const file = join(dir, 'judge.method');
    await writeFile(file, JSON.stringify(judgeMethod));
    const result = await runMethod(file, { ...config, allow_local_processes: true }, { ...options.runOptions, runDir: join(dir, 'run'),
      inputs: { value: text, criteria: JSON.stringify(criteria.map(({ id, text }) => ({ id, text }))), context: context || '(none)' }, replay: undefined });
    if (result.status !== 'completed') fail(`The rubric judge did not finish: ${result.error ?? result.status}`, 'judge_failed');
    const byId = new Map(result.result.map(v => [v.id, v]));
    const quoted = normalize(text);
    return criteria.map(({ id }) => {
      const verdict = byId.get(id);
      if (!verdict) return { id, pass: false, quote: '', reason: 'The judge gave no verdict for this criterion.' };
      // A judge that invents support is wrong, whatever it decided.
      if (verdict.quote.trim() && !quoted.includes(normalize(verdict.quote))) return { ...verdict, pass: false, reason: `The quote is not in the text: "${verdict.quote.slice(0, 120)}"` };
      return verdict;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
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
  if (Buffer.byteLength(text) > settings.max_value_bytes) fail(`The judged value exceeds ${settings.max_value_bytes} bytes`, 'judge_failed');
  const modelCriteria = criteria.filter(c => judges[c.id] !== 'classify');
  // The agent that resolves the default judge is part of the key, so a different judge does not reuse old answers.
  const profile = config?.models?.judge ?? { agent: options.runOptions?.agent ?? config?.models?.default ?? null };
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
