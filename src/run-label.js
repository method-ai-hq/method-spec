/** Display metadata comes from the current method; values come only from the recorded run. */
export function runLabel(method, inputs) {
  const name = method?.run_label_input;
  if (typeof name !== 'string' || !Object.hasOwn(method.inputs ?? {}, name) || !Object.hasOwn(inputs ?? {}, name)) return null;
  const type = method.inputs[name].type, value = inputs[name];
  if (type === 'text' && typeof value === 'string') return value.replace(/\s+/gu, ' ').trim().slice(0, 160) || null;
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (type === 'boolean' && typeof value === 'boolean') return String(value);
  return null;
}
