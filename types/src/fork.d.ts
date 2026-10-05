/**
 * Read the saved records of a parent run without changing it.
 * @param {string} dir
 */
export function readParentRun(dir: string): Promise<{
    dir: string;
    checkpoint: any;
    manifest: any;
    method: any;
    config: any;
    initialState: any;
}>;
/**
 * Select the parent's accepted outputs that a new run may reuse.
 * A step is reusable only when everything that determines its execution is unchanged.
 */
export function planFork({ parent, method, dependencies, steps, root, profiles, config, runtimeInfo, manifest }: {
    parent: any;
    method: any;
    dependencies: any;
    steps: any;
    root: any;
    profiles: any;
    config: any;
    runtimeInfo: any;
    manifest: any;
}): {
    accepted: {};
    skipped: any[];
    collections: {};
    provenance: {
        run_dir: any;
        execution_id: any;
        executor_version: any;
        method_sha256: any;
        steps: ({
            step: any;
            skipped: boolean;
            iterations?: undefined;
            outputs_sha256?: undefined;
        } | {
            step: any;
            iterations: any;
            outputs_sha256: string;
            skipped?: undefined;
        })[];
        changed_files: {
            file: string;
            change: string;
        }[];
        file_evidence: string;
    };
};
/** Copy the declared file outputs of reused steps into the new run's artifacts. */
export function copyForkFiles(parent: any, method: any, accepted: any, artifacts: any): Promise<void>;
