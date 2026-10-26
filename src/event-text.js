// Every sentence that the runtime shows to a person comes from this file: event messages, notices, and the headline
// and next step of a failure. Sentences use names from the Method file and numbers. Headlines and next steps never
// contain run content (inputs, outputs, prompts, URLs); evidence and details carry that.

const capital = text => text ? text[0].toUpperCase() + text.slice(1) : text;
const quoted = name => `"${name}"`;

/**
 * Where an event or a failure happened, in words: `step "Search the web" (task 5 of 12)`.
 * Tasks are 1-based in text. A repeat step counts rounds.
 * @param {{name: string, iteration?: number | null, total?: number | null, repeat?: number | null}} place
 */
export function placeText({ name, iteration, total, repeat }) {
  const task = iteration === null || iteration === undefined ? '' : total ? ` (task ${iteration + 1} of ${total})` : repeat ? ` (round ${iteration + 1} of up to ${repeat})` : '';
  return `step ${quoted(name)}${task}`;
}

// ---- Failures: one headline template and one next step for each owner class. ----

/**
 * Slots: where (place text or null), producer (who returned or did the thing), problem (from the validator's data,
 * an exit code, or the error code), check (check name), effect, service, message (the service's own message),
 * attempts, limit, value.
 */
const headlines = {
  method_code: s => `${s.where ? `In ${s.where}, ` : ''}${s.producer ?? 'the Method'} ${s.problem}.`,
  agent_work: s => s.check ? `${s.where ? `In ${s.where}, ` : ''}the check ${quoted(s.check)} did not pass${s.attempts > 1 ? ` after ${s.attempts} attempts` : ''}.`
    : s.effect ? `${s.where ? `In ${s.where}, ` : ''}an observer found that the change ${quoted(s.effect)} did not happen.`
      : `${s.where ? `In ${s.where}, ` : ''}${s.producer ?? 'the agent'} ${s.problem}.`,
  outside_service: s => `${s.where ? `In ${s.where}, ` : ''}${s.producer ?? 'a service outside Method'} failed${s.attempts > 1 ? ` after ${s.attempts} attempts` : ''}${s.message ? `: ${s.message.replace(/[.\s]+$/, '')}` : ''}.`,
  limit: s => s.code === 'usage_limit'
    ? `${s.where ? `In ${s.where}, ` : ''}${s.producer ?? 'the agent'} reached the usage limit of your plan${s.message ? `: ${s.message.replace(/[.\s]+$/, '')}` : ''}.`
    : `${s.where ? `In ${s.where}, ` : ''}the run reached its ${s.limit} limit${s.value !== undefined && s.value !== null ? ` (${s.value})` : ''}.`,
  setup: s => `${s.message.replace(/[.\s]+$/, '')}${s.where ? ` (in ${s.where})` : ''}.`,
  needs_you: s => `${s.where ? capital(s.where) : 'The run'} waits for your answer.`,
  method_platform: s => `Method stopped because of an error in Method itself (${s.code}).`,
};
/** The headline of a failure: one sentence from its owner's template. */
export const headlineText = (owner, slots) => capital(headlines[owner](slots).replace(/\.\.$/, '.'));

const nextSteps = {
  method_code: s => ({ action: 'fix_method', text: `Change ${s.producer ?? 'the Method'} as the headline says, then run again. Steps that did not change are reused.` }),
  agent_work: s => ({ action: 'run_again', text: s.effect ? 'Look at the changed system and correct it by hand if needed, then run again. Method does not repeat an external change by itself.' : s.check ? 'Run again. If the check fails again, make the step\'s prompt or its check clearer.' : 'Run again. If it fails again, make the step\'s prompt clearer or its outputs simpler.' }),
  outside_service: () => ({ action: 'run_again', text: 'Wait a few minutes and run again. Steps that finished are reused.' }),
  limit: s => s.code === 'usage_limit'
    ? { action: 'run_again', text: 'This is a usage limit, not a problem in the Method. Run again after the limit resets. Steps that finished are reused.' }
    : { action: 'raise_limit', text: `Raise the ${s.limit} limit in the Method's limits, or make the step do less, then run again.` },
  setup: s => s.missing?.length
    ? { action: 'fix_setup', text: `Run method secret find to look for ${s.missing.join(', ')} on this computer, or method secret set to enter it. Then run again. No step ran. Never open or print a key file, and never paste a key into a chat.`, command: `method secret set ${s.missing[0]}` }
    : { action: 'fix_setup', text: 'Fix the setup that the headline names, then run again.' },
  needs_you: () => ({ action: 'answer', text: 'Answer the question, then continue the run.' }),
  method_platform: () => ({ action: 'report_bug', text: 'This is a bug in Method. Report it with the run folder; your Method does not need a change.' }),
};
/** The next step of a failure, with the effects that a failed action may have made. */
export function nextText(owner, slots, effects = []) {
  const next = nextSteps[owner](slots);
  if (effects.length) next.text += ` After the failed action, observers found: ${effects.map(e => `${e.name} ${e.verdict}${e.verdict === 'confirmed' ? ' (the change happened; do not repeat it)' : ''}`).join('; ')}.`;
  return next;
}

/** The problem phrase of a failure, from structured data only. */
export function problemText({ validation, exitCode, code }) {
  if (validation?.length) {
    const [first] = validation;
    const more = validation.length - 1;
    return `returned ${first.path} as ${first.found}, but it must be ${first.expected}${more ? ` (and ${more} more problem${more === 1 ? '' : 's'})` : ''}`;
  }
  if (Number.isInteger(exitCode)) return `exited with code ${exitCode}`;
  return `stopped with the error ${code}`;
}
/** One evidence line for each validator error. */
export const validationLine = ({ path, expected, found }) => `${path}: found ${found}, expected ${expected}`;

// ---- Notices ----

const classWords = { rate_limit: 'rate limit', server_error: 'server error', unavailable: 'unavailable', timeout: 'timeout' };
/** A retry of a transient failure. */
export const retryNotice = ({ service, kind, status, attempt, attempts }) =>
  `${capital(service)} did not answer (${classWords[kind]}${status ? `, HTTP ${status}` : ''}). Method tries again: attempt ${attempt} of ${attempts}.`;
/** An error or warning event from an agent's own event stream. */
export const agentNotice = ({ agent, level, message }) => `${agent} reported ${level === 'warning' ? 'a warning' : 'an error'}: ${message}`;
/** A run or step limit that is 80% used. */
export function limitNotice({ where, limit, used, max }) {
  const time = () => max < 120_000 ? `${Math.round(used / 1000)} of ${Math.round(max / 1000)} seconds` : `${Math.round(used / 60_000)} of ${Math.round(max / 60_000)} minutes`;
  const amount = limit === 'time' ? time() : `${used} of ${max} ${limit}`;
  return `${where ? capital(where) : 'This run'} has used ${amount}.`;
}

// ---- Events ----

const verdictWords = { confirmed: 'is confirmed', contradicted: 'did not happen', unrefuted: 'is not refuted', unknown: 'could not be confirmed', pending: 'is not confirmed yet', unobservable: 'could not be observed', unchanged: 'changed nothing', unobserved: 'was not observed', not_replayed: 'was not judged in this replay' };
const checkWords = { pass: 'passed', fail: 'did not pass', unknown: 'could not decide' };

/**
 * The message of a user-facing event, or undefined for other events.
 * @param {string} event
 * @param {any} data
 * @param {{place: (step: string, iteration?: number) => string, checkName: (step: string) => string, methodName: string}} names
 */
export function eventText(event, data, { place, checkName, methodName }) {
  const where = data.step !== undefined ? place(data.step, data.iteration) : null;
  switch (event) {
    case 'run.started': return `Method ${quoted(methodName)} started.`;
    case 'run.resumed': return `Method ${quoted(methodName)} continues.`;
    case 'run.completed': return data.status === 'unconfirmed' ? 'The run finished, but an observer could not confirm an external change.' : 'The run finished.';
    case 'run.failed': return data.failure?.headline;
    case 'step.started': return data.reused_from ? `${capital(where)} reuses the result of an earlier run.` : `${capital(where)} started.`;
    case 'step.accepted': return data.reused_from ? `${capital(where)} reused an earlier result.` : `${capital(where)} finished.`;
    case 'step.retry': return `The check ${quoted(checkName(data.step))} did not pass. ${capital(where)} runs again: attempt ${data.attempt} of ${data.attempts}.`;
    case 'check.completed': return `The check ${quoted(checkName(data.step))} ${checkWords[data.check?.status] ?? 'finished'}.`;
    case 'tool.dispatched': return `${capital(where)} calls the tool ${data.tool}.`;
    case 'tool.completed': return data.isError ? `The tool ${data.tool} returned an error.` : `The tool ${data.tool} finished.`;
    case 'tool.failed': return `The tool ${data.tool} failed.`;
    case 'tool.standin': return `In this replay, the tool ${data.tool} did not run; it returned a stand-in.`;
    case 'learned.applied': return `${capital(where)} uses ${data.applied.length} of ${data.considered.length} learned rule${data.considered.length === 1 ? '' : 's'}.`;
    case 'model.used': return `${capital(where)} runs on ${{ claude: 'Claude Code', codex: 'Codex' }[data.backend] ?? (data.backend === 'method' ? `the hosted model ${data.model} (account credit)` : `${data.backend} ${data.model ?? ''}`.trim())}${data.model && ['claude', 'codex'].includes(data.backend) ? ` (${data.model})` : ''}.`;
    case 'human.required': return `${capital(where)} waits for your answer.`;
    case 'effect.observed': {
      const [step, iteration, name] = String(data.effect ?? '').split('/');
      return `The change ${quoted(name ?? data.effect)} of ${place(step, Number(iteration))} ${verdictWords[data.verdict] ?? data.verdict}.`;
    }
    default: return undefined;
  }
}
