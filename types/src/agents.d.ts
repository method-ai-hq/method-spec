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
/**
 * Resolve once. Order: saved profiles (resume), --agent for every model step, the Method's models (hosted or local
 * agent) and model IDs (hosted), configured profiles, a saved package's runtime.json models, then for the default: the host's hosted
 * model, the calling agent, the one installed agent. Caller hints select a provider, never credentials or permissions.
 */
export function resolveModels(method: any, config: any, options?: {}): Promise<any>;
