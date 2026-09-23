import { resolve, runLabelType } from './semantics.js';

/** The current method selects the value; the saved inspection supplies it. */
export function runLabel(method, inspection) {
  if (!method?.run_label) return null;
  try {
    const type = runLabelType(method);
    let value;
    if (method.run_label.startsWith('inputs.')) {
      value = resolve(inspection?.inputs, method.run_label.slice(7));
    } else {
      const [, id, , ...path] = method.run_label.split('.');
      // A past version may have repeated a step that is now a single step.
      // Do not choose an arbitrary invocation from that run.
      const invocations = Object.values(inspection?.invocations ?? {}).filter(row => row?.step_id === id);
      if (invocations.length !== 1) return null;
      value = resolve(invocations[0].outputs, path.join('.'));
    }
    if (type === 'text' && typeof value === 'string') return value.replace(/\s+/gu, ' ').trim().slice(0, 160) || null;
    if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (type === 'boolean' && typeof value === 'boolean') return String(value);
  } catch { /* A missing or invalid saved value keeps the timestamp. */ }
  return null;
}
