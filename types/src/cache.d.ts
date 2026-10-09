/**
 * A step iteration can be reused when it asks nobody and changes nothing outside the run.
 * @param {any} step
 * @param {Record<string, any>} tools
 */
export function cacheable(step: any, tools: Record<string, any>): boolean;
/**
 * Everything that determines what an iteration returns: its definition, its resolved inputs, and what it executes.
 * A script step's key covers its own entrypoints and every bundle file that is not another step's entrypoint,
 * because the runtime does not trace which helper files a script imports.
 */
export function iterationKey({ method, step, bindings, iteration, profiles, config, runtimeInfo, manifest }: {
    method: any;
    step: any;
    bindings: any;
    iteration: any;
    profiles: any;
    config: any;
    runtimeInfo: any;
    manifest: any;
}): string;
/**
 * Read the accepted iterations of earlier runs by key. A run that cannot be read is skipped.
 * @param {string[]} dirs
 */
export function readCache(dirs: string[]): Promise<Map<any, any>>;
/** Copy the declared file outputs of reused iterations into this run's artifacts. */
export function copyOutputFiles(fromDir: any, step: any, outputs: any, artifacts: any): Promise<void>;
