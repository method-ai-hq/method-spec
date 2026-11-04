/**
 * A step iteration can be reused when it asks nobody and changes nothing outside the run.
 * @param {any} step
 * @param {Record<string, any>} tools
 */
export function cacheable(step: any, tools: Record<string, any>): boolean;
/**
 * Everything that determines what an iteration returns: its definition, its resolved inputs, and what it executes.
 * A script step's key covers its own entrypoints and every bundle file that is not another step's entrypoint,
 * because the runtime does not trace which helper files a script imports. learned.json is not such a file: only the
 * step's own active rules (rules) are part of its key. read holds the content of the local files and folders that the
 * iteration can read (readPaths), so a changed file in a bound folder runs the step again. repeat numbers the repeats of the same work: each repeat is a separate run, so a step of one repeat is never
 * reused in another, while unchanged steps of the same repeat are.
 */
export function iterationKey({ method, step, bindings, iteration, profiles, config, runtimeInfo, manifest, rules, repeat, read }: {
    method: any;
    step: any;
    bindings: any;
    iteration: any;
    profiles: any;
    config: any;
    runtimeInfo: any;
    manifest: any;
    rules?: any[];
    repeat?: number;
    read: any;
}): string;
/**
 * The local files and folders that an iteration can read: each absolute path among its inputs, each files connection
 * that its inputs name, its session's room folder, and, for a step that runs a script, every files connection, because
 * a script gets them all in METHOD_ENVIRONMENT.
 * @param {{ method: any, step: any, bindings: Record<string, any>, environment?: Record<string, any>, tools: Record<string, any>, room?: string }} options
 */
export function readPaths({ method, step, bindings, environment, tools, room }: {
    method: any;
    step: any;
    bindings: Record<string, any>;
    environment?: Record<string, any>;
    tools: Record<string, any>;
    room?: string;
}): string[];
/**
 * The content hash of each file under each path, by path, or null when they hold more than the limit, so the iteration
 * is not reused. A path that does not exist is null; a folder lists its files by their path inside it.
 * @param {string[]} paths
 */
export function pathContents(paths: string[]): Promise<{}>;
/**
 * Read the accepted iterations of earlier runs by key. A run that cannot be read is skipped.
 * @param {string[]} dirs
 */
export function readCache(dirs: string[]): Promise<Map<any, any>>;
/** Copy the declared file outputs of reused iterations into this run's artifacts. */
export function copyOutputFiles(fromDir: any, step: any, outputs: any, artifacts: any): Promise<void>;
