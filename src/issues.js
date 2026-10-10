/** Deterministic code checks on a valid Method. Browser-safe: no file system, no network. */
import { effectiveOutputs } from './semantics.js';

const head = ref => ref.split('.')[0];
const issue = (code, level, message, fix, where = {}) => ({ code, level, ...where, message, fix });
/** Every place where a string value sits in the document, with its dotted path. */
function* strings(value, path = []) {
  if (typeof value === 'string') yield [path, value];
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) yield* strings(child, [...path, key]);
}
const where = path => path[0] === 'steps' && path.length > 1 ? { step: path[1], ...(path.length > 2 ? { field: path.slice(2).join('.') } : {}) } : { field: path.join('.') };
const decode = bytes => typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: false }).decode(bytes);

/**
 * A known secret value (exact match) in the document or in a file that will be uploaded. Values shorter than 8
 * characters are not checked, because they match ordinary text. The message never contains the value.
 */
function secretValueIssues(method, options) {
  const supplied = options.secretValues;
  if (!supplied) return [];
  const entries = (Array.isArray(supplied) ? supplied.map(value => [null, value]) : Object.entries(supplied))
    .filter(([, value]) => typeof value === 'string' && value.length >= 8);
  const named = name => name ? `the value of secret ${name}` : 'a secret value';
  const found = [];
  for (const [path, text] of strings(method)) for (const [name, value] of entries) if (text.includes(value)) {
    found.push(issue('secret_value', 'error', `${path.join('.')} contains ${named(name)}.`,
      'Remove the value, declare the secret by name in secrets, and let the host supply it at run time.', where(path)));
  }
  for (const [file, content] of Object.entries(options.files ?? {})) {
    const lines = decode(content).split('\n');
    for (const [name, value] of entries) {
      const index = lines.findIndex(line => line.includes(value));
      const anywhere = index < 0 && lines.join('\n').includes(value);
      if (index >= 0 || anywhere) found.push(issue('secret_value', 'error', `${file} contains ${named(name)}.`,
        `Remove the value from ${file} and read it from a declared secret's environment variable.`, { file, ...(index >= 0 ? { line: index + 1 } : {}) }));
    }
  }
  return found;
}

/** A declared secret with no value. A run refuses it (preflight); validate warns. */
function missingSecretIssues(method, options) {
  if (!options.availableSecrets) return [];
  const available = new Set(options.availableSecrets);
  return Object.keys(method.secrets ?? {}).filter(name => !available.has(name)).map(name =>
    issue('missing_secret', options.phase === 'run' ? 'error' : 'warning', `Secret ${name} has no value on this computer.`,
      `Run method secret find to look for ${name} on this computer, or method secret set ${name} to enter it.`, { field: `secrets.${name}` }));
}

/** A classifier's most likely answer gates a step or feeds a change, with no step that applies a threshold. */
function thresholdIssues(method) {
  const classified = {};
  for (const [id, step] of Object.entries(method.steps)) if (step.do?.kind === 'classify') classified[step.out] = id;
  const found = [];
  for (const [id, step] of Object.entries(method.steps)) {
    const uses = [];
    if (step.when && classified[head(step.when)]) uses.push(['when', step.when]);
    if (step.changes?.length) for (const [kind, refs] of [['in', step.in], ['each', step.each]])
      for (const [alias, ref] of Object.entries(refs ?? {})) if (classified[head(ref)]) uses.push([`${kind}.${alias}`, ref]);
    for (const [field, ref] of uses) found.push(issue('classify_without_threshold', 'warning',
      `${id} ${field === 'when' ? 'runs only when' : 'changes something from'} ${ref}, the unthresholded result of classify step ${classified[head(ref)]}.`,
      'Add a step that compares the probability with a threshold you choose, and use that step\'s result here.', { step: id, field }));
  }
  return found;
}

/**
 * An agent with a browser (untrusted content) that can also change a connection other than files: through its
 * own changes, or through a tool whose declaration has effects. Only declarations count, never names.
 */
function untrustedAgentIssues(method, options) {
  const found = [];
  const tools = options.tools ?? {};
  for (const [id, step] of Object.entries(method.steps)) {
    const exec = step.do;
    if (exec?.kind !== 'agent' || !exec.browser) continue;
    const changed = (step.changes ?? []).filter(ref => ref.startsWith('environment.') && method.environment?.[ref.slice(12)]?.type !== 'files');
    const acting = (exec.tools ?? []).filter(name => tools[name]?.effects?.length);
    const actors = [...changed, ...acting];
    if (!actors.length) continue;
    found.push(issue('untrusted_content_can_act', 'warning',
      `${id} reads untrusted content (${exec.browser}) and can also change things (${actors.join(', ')}).`,
      'Split the step: one agent reads the content and returns data, and a later step without a browser makes the change.',
      { step: id, field: 'do' }));
  }
  return found;
}

/** An output that no step, result, run label, or check uses. */
function unusedOutputIssues(method) {
  const used = new Set();
  const add = ref => { if (typeof ref === 'string') used.add(head(ref)); };
  for (const step of Object.values(method.steps)) {
    const own = Object.keys(effectiveOutputs(step));
    for (const ref of [...Object.values(step.in ?? {}), ...Object.values(step.each ?? {}), step.when]) add(ref);
    for (const effect of Object.values(step.effects ?? {})) Object.values(effect.in ?? {}).forEach(add);
    if (step.repeat?.until) add(step.repeat.until);
    // A script or agent check receives every output of its step.
    if (step.check?.kind) own.forEach(name => used.add(name));
    else if (step.check) for (const ref of [step.check.present, step.check.file, step.check.count?.value, step.check.equals?.actual, step.check.equals?.expected]) add(ref);
  }
  for (const ref of typeof method.result === 'string' ? [method.result] : Object.values(method.result ?? {})) add(ref);
  if (typeof method.run_label === 'string' && method.run_label.startsWith('steps.')) used.add(method.run_label.split('.')[3]);
  const found = [];
  for (const [id, step] of Object.entries(method.steps)) for (const name of Object.keys(effectiveOutputs(step))) if (!used.has(name)) {
    found.push(issue('unused_output', 'warning', `Output ${name} of ${id} is not used by any step, check, or the result.`,
      `Use ${name} in a later step or the result, or remove it from out.`, { step: id, field: step.do?.kind === 'classify' ? 'out' : `out.${name}` }));
  }
  return found;
}

/** An agent step with no tools and no browser does what a call step does. */
function toollessAgentIssues(method) {
  return Object.entries(method.steps).filter(([, step]) => step.do?.kind === 'agent' && !step.do.tools?.length && !step.do.browser)
    .map(([id]) => issue('agent_without_tools', 'note', `${id} is an agent step with no tools and no browser.`,
      'Use a call step, or give the agent the tools that it needs.', { step: id, field: 'do' }));
}

/** A check that only confirms what the declared output types already guarantee. */
function repeatedTypeIssues(method) {
  const found = [];
  for (const [id, step] of Object.entries(method.steps)) {
    const check = step.check;
    if (!check || check.kind) continue;
    // A list index can be absent, so a present check on one says more than the type.
    const indexed = ref => ref.split('.').some(part => /^[0-9]+$/.test(part));
    const repeats = check.present !== undefined ? !indexed(check.present)
      : check.count ? !check.count.min && check.count.max === undefined : false;
    if (repeats) found.push(issue('check_repeats_output_type', 'note',
      `${id}.check only confirms what the declared types already guarantee.`,
      'Remove the check, or check something that the type does not say, such as a minimum count or an expected value.', { step: id, field: 'check' }));
  }
  return found;
}

/** Code checks on a Method that passed validation. */
export function codeIssues(method, options = {}) {
  return [
    ...secretValueIssues(method, options), ...missingSecretIssues(method, options), ...thresholdIssues(method),
    ...untrustedAgentIssues(method, options), ...unusedOutputIssues(method), ...toollessAgentIssues(method), ...repeatedTypeIssues(method),
  ];
}

const levels = { error: 0, warning: 1, note: 2 };
/**
 * Mark the warnings and notes that a step accepts, and give a note for an accept whose code no longer fires.
 * Errors cannot be accepted. Codes in notChecked were not computed this time, so their accepts are not reported.
 */
export function applyAccepts(method, issues, notChecked = []) {
  const skipped = new Set(notChecked);
  const result = issues.map(found => {
    const reason = found.step && found.level !== 'error' ? method?.steps?.[found.step]?.accept?.[found.code] : undefined;
    return reason === undefined ? found : { ...found, accepted: reason };
  });
  for (const [id, step] of Object.entries(method?.steps ?? {})) for (const code of Object.keys(step.accept ?? {})) {
    if (skipped.has(code) || issues.some(found => found.step === id && found.code === code)) continue;
    result.push(issue('accept_unused', 'note', `${id} accepts ${code}, which no longer fires.`, `Remove ${code} from ${id}.accept.`, { step: id, field: `accept.${code}` }));
  }
  return result.sort((a, b) => levels[a.level] - levels[b.level]);
}
