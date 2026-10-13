import { owners } from './semantics.js';
import { headlineText, nextText, placeText, problemText, validationLine } from './event-text.js';

const lastLines = (text, count) => String(text).trimEnd().split('\n').slice(-count).join('\n');
const limitWords = { timeout: 'time', input_limit: 'request size', output_limit: 'output size', model_limit: 'model requests', tool_limit: 'tool calls', invocation_limit: 'invocations', iteration_limit: 'repeat' };

/**
 * The failure record of a stopped run, written once. The owner comes from where the error happened: the class that
 * its fail() call states, or that the place that caught it set. An error without a class is a bug in Method.
 * @param {any} error
 * @param {{method?: any, step?: string | null, iteration?: number | null, failedIterations?: number[], total?: number | null,
 *   phase?: string | null, effects?: any[], stopped?: boolean}} where
 */
export function failureRecord(error, where = {}) {
  const stopped = where.stopped === true;
  const owner = stopped ? 'setup' : owners.includes(error?.owner) ? error.owner : 'method_platform';
  const code = stopped ? 'stopped' : error?.code ?? 'execution_failed';
  const message = stopped ? 'The run was stopped on this computer.' : String(error?.message ?? error);
  const id = where.step ?? null;
  const step = id ? where.method?.steps?.[id] : null;
  const stepName = id ? step?.name ?? id : null;
  const iteration = id && Number.isInteger(where.iteration) ? where.iteration : null;
  const total = id && Number.isInteger(where.total) ? where.total : null;
  const phase = error?.phase ?? where.phase ?? null;
  const checkName = phase === 'check' ? step?.reading?.check_name ?? null : null;
  const slots = {
    where: id ? placeText({ name: stepName, iteration, total, repeat: step?.repeat?.max_iterations ?? null }) : null,
    producer: error?.producer, code, message: owner === 'outside_service' ? error?.provider_message ?? message : message,
    problem: error?.problem ?? problemText({ validation: error?.validation, exitCode: error?.exit_code, code }),
    check: code === 'check_failed' ? error.check_label : null,
    effect: code === 'effect_contradicted' ? error.effect_name : null,
    attempts: error?.attempts, missing: error?.missing,
    limit: error?.limit ?? limitWords[code] ?? code, value: error?.value,
  };
  const evidence = [...(error?.validation ?? []).map(validationLine), ...(Array.isArray(error?.evidence) ? error.evidence.map(String) : [])];
  return {
    owner, code,
    headline: headlineText(owner, slots),
    step: id, step_name: stepName, iteration,
    failed_iterations: where.failedIterations ?? [],
    total, phase, check_name: checkName,
    next: nextText(owner, slots, where.effects ?? []),
    evidence, details: message,
    ...(error?.diagnostics && (error.code === 'process_failed' || Number.isInteger(error.exit_code)) ? { diagnostics: lastLines(error.diagnostics, 20) } : {}),
  };
}
