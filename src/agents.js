import { executable } from './io.js';
import { fail } from './validate.js';

/** Resolve once. Caller hints select a provider, never credentials or permissions. */
export async function resolveModels(method, config, options = {}) {
  const profiles = { ...(config.models ?? {}) };
  const names = [...new Set(Object.values(method.steps).flatMap(step => [step.do, step.check])
    .filter(exec => exec?.kind && exec.kind !== 'run').map(exec => exec.model))];
  if (options.savedModels) {
    if (names.some(name => !options.savedModels[name])) fail('The checkpoint is missing its selected model profiles. Resume needs the original run records.', 'resume_mismatch');
    return options.savedModels;
  }
  if (options.agent && !['codex', 'claude'].includes(options.agent)) fail('Choose codex or claude.', 'needs_input');
  const env = options.env ?? process.env;
  const caller = env.CLAUDECODE && !env.CODEX_THREAD_ID ? 'claude'
    : env.CODEX_THREAD_ID && !env.CLAUDECODE ? 'codex' : undefined;
  const backend = options.agent ?? caller;
  // The generic local-agent default follows the caller. Named profiles and custom
  // executables are explicit configuration; resumed runs were returned above.
  const genericDefault = !profiles.default ||
    (['codex', 'claude'].includes(profiles.default.backend) && !profiles.default.command);
  if (backend && (options.agent || genericDefault)) {
    profiles.default = profiles.default?.backend === backend
      ? { ...profiles.default } : { backend };
  }
  const missing = names.filter(name => !profiles[name]);
  if (!missing.length) return profiles;
  let selected = profiles.default;
  if (!selected) {
    let backend = caller;
    if (!backend) {
      const found = [];
      for (const name of ['codex', 'claude']) { try { await executable(name); found.push(name); } catch {} }
      if (found.length !== 1) fail(found.length ? 'Both Codex and Claude are available. Supply --agent codex or --agent claude.' : 'Sign in to Codex or Claude Code on this computer, then run again.', 'needs_input');
      backend = found[0];
    }
    selected = { backend };
  }
  for (const name of missing) profiles[name] = { ...selected };
  return profiles;
}
