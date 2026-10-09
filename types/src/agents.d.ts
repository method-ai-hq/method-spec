/**
 * Resolve once. Order: saved profiles, configured profiles, --agent, the host's hosted model, the calling agent,
 * the one installed agent. Caller hints select a provider, never credentials or permissions.
 */
export function resolveModels(method: any, config: any, options?: {}): Promise<any>;
