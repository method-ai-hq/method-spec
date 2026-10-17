/**
 * Profiles for the Method's own models and for model IDs that steps name directly: hosted (backend method),
 * or a local agent for an entry {agent: codex | claude, model?, reasoning_effort?}.
 */
export function methodProfiles(method: any): {
    [k: string]: any;
};
/**
 * The models of a saved package that still has a runtime.json, used only when the document has no models.
 * New Methods keep models in the document; this keeps earlier saved versions running.
 */
export function packageModels(method: any, sourceRoot: any): Promise<any>;
/** The coding agent that started this run: Claude Code (CLAUDECODE) or Codex (CODEX_THREAD_ID), when only one is set. */
export function callerAgent(env?: NodeJS.ProcessEnv): "codex" | "claude";
/** Whether a local agent is signed in, checked with its own status command; no model request is made. */
export function agentSignedIn(backend: any, command?: any): Promise<boolean>;
/**
 * The local agent for model steps that name no model: the agent that started the run, when it is installed;
 * otherwise an installed, signed-in Claude Code or Codex (Claude Code when both are). Undefined when there is none.
 * env supplies the caller variables and PATH.
 */
export function localAgent(env?: NodeJS.ProcessEnv): Promise<string>;
/**
 * Resolve once. Order: saved profiles (resume); the Method's models (hosted, or a local agent for an agent entry) and
 * the model IDs that steps name (hosted); configured profiles; a saved package's runtime.json models. A step that
 * names no model uses default: the user's own local agent subscription (localAgent) when there is one, and the host's
 * hosted model (hostedModel, on account credit) only when no local agent can run it.
 */
export function resolveModels(method: any, config: any, options?: {}): Promise<any>;
