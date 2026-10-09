import { executable } from './io.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, own, validateConfig } from './validate.js';
import { modelName, isModelId } from './semantics.js';

/** Hosted profiles for the Method's own models and for model IDs that steps name directly. */
export function methodProfiles(method) {
  const hosted = spec => typeof spec === 'string' ? { backend: 'method', model: spec } : { backend: 'method', ...spec };
  const profiles = Object.fromEntries(Object.entries(method.models ?? {}).map(([name, spec]) => [name, hosted(spec)]));
  for (const name of modelNames(method)) if (isModelId(name) && !own(profiles, name)) profiles[name] = hosted(name);
  return profiles;
}
const modelNames = method => [...new Set(Object.values(method.steps).flatMap(step => [step.do, step.check])
  .filter(exec => ['call', 'agent'].includes(exec?.kind)).map(modelName))];

/**
 * The models of a saved package that still has a runtime.json, used only when the document has no models.
 * New Methods keep models in the document; this keeps earlier saved versions running.
 */
export async function packageModels(method, sourceRoot) {
  if (method.models || !sourceRoot) return undefined;
  let text;
  try { text = await readFile(join(sourceRoot, 'runtime.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const models = JSON.parse(text)?.models;
  return models ? validateConfig({ models }).models : undefined;
}

/**
 * Resolve once. Order: saved profiles (resume), --agent for every model step, the Method's models and model IDs
 * (hosted), configured profiles, a saved package's runtime.json models, then for the default: the host's hosted
 * model, the calling agent, the one installed agent. Caller hints select a provider, never credentials or permissions.
 */
export async function resolveModels(method, config, options = {}) {
  const names = modelNames(method);
  if (options.savedModels) {
    if (names.some(name => !options.savedModels[name])) fail('The checkpoint is missing its selected model profiles. Resume needs the original run records.', 'resume_mismatch');
    return options.savedModels;
  }
  if (!names.length) return {};
  if (options.agent && !['codex', 'claude'].includes(options.agent)) fail('Choose codex or claude.', 'needs_input');
  const profiles = { ...(method.models ? {} : options.packageModels), ...(config.models ?? {}), ...methodProfiles(method) };
  // A local agent runs every model step; a configured profile for the same agent keeps its command and model.
  if (options.agent) return Object.fromEntries(names.map(name => [name, profiles[name]?.backend === options.agent ? { ...profiles[name] } : { backend: options.agent }]));
  const env = options.env ?? process.env;
  const caller = env.CLAUDECODE && !env.CODEX_THREAD_ID ? 'claude'
    : env.CODEX_THREAD_ID && !env.CLAUDECODE ? 'codex' : undefined;
  const backend = caller;
  // When every step names a configured profile, no default is chosen, so an unused local agent is never checked.
  if (names.every(name => name !== 'default' && profiles[name])) return profiles;
  // The generic local-agent default follows the caller. Named profiles and custom
  // executables are explicit configuration; resumed runs were returned above.
  const genericDefault = !profiles.default ||
    (['codex', 'claude'].includes(profiles.default.backend) && !profiles.default.command);
  // A signed-in host supplies a hosted model; it is used before a local agent that happens to be calling.
  if (options.hostedModel && !profiles.default) profiles.default = { backend: 'method', model: options.hostedModel };
  else if (backend && genericDefault) profiles.default = profiles.default?.backend === backend ? { ...profiles.default } : { backend };
  const missing = names.filter(name => !profiles[name]);
  if (!missing.length) return profiles;
  let selected = profiles.default;
  if (!selected) {
    let backend = caller;
    if (!backend) {
      const found = [];
      for (const name of ['codex', 'claude']) { try { await executable(name); found.push(name); } catch {} }
      if (found.length !== 1) fail(found.length ? 'Both Codex and Claude are available. Supply --agent codex or --agent claude.' : 'Sign in to Method with method login to use hosted models, or sign in to Codex or Claude Code on this computer, then run again.', 'needs_input');
      backend = found[0];
    }
    selected = { backend };
  }
  for (const name of missing) profiles[name] = { ...selected };
  return profiles;
}
