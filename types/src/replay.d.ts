/**
 * Everything that decides what a step does, apart from its inputs. Display text and effect contracts do not change
 * the action, so they do not change the key. Runtime binaries are left out: a Node update does not make a recording
 * stale, but a changed script, prompt, model profile, tool, declared helper file (helpers, the Method's files) of a
 * step that runs a script, or active learned rule of this step (rules) does.
 */
export function stepKey(step: any, { files, profiles, tools, helpers, rules }: {
    files?: {};
    profiles?: {};
    tools?: {};
    helpers?: any[];
    rules?: any[];
}): string;
/**
 * Replace each path in map (from -> to) wherever it appears in a value: a whole string, a path below it, or the path
 * inside text. Longer paths are replaced first, so a path inside another copied folder keeps its own copy.
 */
export function rewritePaths(value: any, map: any): any;
/** The first path of the list that a value names (itself or a path below it), or null. */
export function namedPath(value: any, paths: any): any;
/**
 * The recorded output for this iteration, when the step and its inputs are unchanged and the step is not forced to run
 * live. A scratch copy stands in for each recorded path: bindings are compared after mapping the copies back
 * (replay.paths), and a served output names the copies (replay.copies).
 */
export function replayedCandidate(replay: any, { id, step, iteration, bindings, key }: {
    id: any;
    step: any;
    iteration: any;
    bindings: any;
    key: any;
}): any;
export function unverifiable(id: any, iteration: any, step: any): void;
/**
 * Keep a copy of each file or folder in the run folder that a script step's outputs name, as the step left it. A later
 * step can change or remove it before the run ends; a case made from the run copies the kept version, which is what the
 * next step read. The first copy of a path stays. A path larger than the limits is not kept.
 */
export function keepRunPaths(runDir: any, outputs: any): Promise<void>;
/** Build a recording from a finished run: each accepted iteration's inputs and outputs, plus its effect observations. */
export function recordRun(runDir: any): Promise<{
    format: string;
    method_sha256: string;
    execution_id: any;
    source_run_dir: string;
    inputs: any;
    initial_state: any;
    environment: any;
    keys: {
        [k: string]: string;
    };
    iterations: {};
    observations: {};
    method: any;
}>;
export function stepKeys(method: any, { files, profiles, tools, learned }: {
    files: any;
    profiles: any;
    tools: any;
    learned: any;
}): {
    [k: string]: string;
};
export function keptFolder(runDir: any): string;
