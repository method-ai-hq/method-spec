import { executable } from './io.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fail, own, validateConfig } from './validate.js';
import { modelName, isModelId } from './semantics.js';

/**
 * Profiles for the Method's own models and for model IDs that steps name directly: hosted (backend method),
 * or a local agent for an entry {agent: codex | claude, model?, reasoning_effort?}.
 */
export function methodProfiles(method) {
  const hosted = spec => typeof spec === 'string' ? { backend: 'method', model: spec }
    : spec.agent ? (({ agent, ...rest }) => ({ backend: agent, ...rest }))(spec) : { backend: 'method', ...spec };
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

const execFileAsync = promisify(execFile);

/** The coding agent that started this run: Claude Code (CLAUDECODE) or Codex (CODEX_THREAD_ID), when only one is set. */
export function callerAgent(env = process.env) {
  return env.CLAUDECODE && !env.CODEX_THREAD_ID ? 'claude' : env.CODEX_THREAD_ID && !env.CLAUDECODE ? 'codex' : undefined;
}

/** The path of a command on env.PATH, or undefined. */
async function onPath(name, env) {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try { await access(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

/** Whether a local agent is signed in, checked with its own status command; no model request is made. */
export async function agentSignedIn(backend, command = backend) {
  try {
    const { stdout } = await execFileAsync(await executable(command), backend === 'codex' ? ['login', 'status'] : ['auth', 'status'], { timeout: 20_000 });
    return backend === 'codex' || JSON.parse(stdout).loggedIn === true;
  } catch { return false; }
}

/**
 * The local agent for model steps that name no model: the agent that started the run, when it is installed and
 * signed in; otherwise an installed, signed-in Claude Code or Codex (Claude Code when both are). Undefined when there is none.
 * env supplies the caller variables and PATH.
 */
export async function localAgent(env = process.env) {
  const caller = callerAgent(env);
  for (const name of [...new Set([caller, 'claude', 'codex'].filter(Boolean))]) {
    const path = await onPath(name, env);
    if (path && await agentSignedIn(name, path)) return name;
  }
  return undefined;
}

/**
 * Resolve once. Order: saved profiles (resume); the Method's models (hosted, or a local agent for an agent entry) and
 * the model IDs that steps name (hosted); configured profiles; a saved package's runtime.json models. A step that
 * names no model uses default: the user's own local agent subscription (localAgent) when there is one, and the host's
 * hosted model (hostedModel, on account credit) only when no local agent can run it.
 */
export async function resolveModels(method, config, options = {}) {
  const names = modelNames(method);
  if (options.savedModels) {
    if (names.some(name => !options.savedModels[name])) fail('setup', 'The checkpoint is missing its selected model profiles. Resume needs the original run records.', 'resume_mismatch');
    return options.savedModels;
  }
  if (!names.length) return {};
  const profiles = { ...(method.models ? {} : options.packageModels), ...(config.models ?? {}), ...methodProfiles(method) };
  // When every step names a profile, no default is chosen, so an unused local agent is never checked.
  if (names.every(name => name !== 'default' && profiles[name])) return profiles;
  // A generic local-agent default ({backend: codex|claude} with no command) is no choice: the same rule applies.
  const generic = profile => ['codex', 'claude'].includes(profile?.backend) && !profile.command && !profile.model && !profile.reasoning_effort;
  if (!profiles.default || generic(profiles.default)) {
    const agent = await localAgent(options.env ?? process.env);
    if (agent) profiles.default = { backend: agent };
    else if (options.hostedModel) profiles.default = { backend: 'method', model: options.hostedModel };
    else fail('setup', 'No model can run this step. Sign in to Claude Code or Codex on this computer, or sign in to Method with method login to use hosted models, then run again.', 'needs_input');
  }
  for (const name of names) profiles[name] ??= { ...profiles.default };
  return profiles;
}
