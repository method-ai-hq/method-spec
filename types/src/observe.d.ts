/**
 * Make the observations that are due for one finished run. Only observers run; no action runs.
 * The run's status changes when the new evidence changes what its effects establish.
 * @param {string} runDir
 * @param {{config?: any, now?: Date, signal?: AbortSignal, processPath?: string}} [options]
 */
export function observeRun(runDir: string, options?: {
    config?: any;
    now?: Date;
    signal?: AbortSignal;
    processPath?: string;
}): Promise<{
    run_dir: string;
    status: any;
    observed: {
        final: boolean;
        completed_at: string;
        horizon_at: string;
        next_observation_at: string;
        error?: {
            code: any;
            message: any;
        };
        effect: string;
        token: string;
        inputs: any;
        action_outcome: string;
        attempt: number;
        observed_at: string;
        verdict: any;
        reason: any;
        evidence: any;
        observations: string;
        observations_sha256: string;
        observer: {
            builtin: any;
            source: string;
            observe?: undefined;
            judge?: undefined;
        } | {
            observe: any;
            judge: any;
            source: string;
            builtin?: undefined;
        };
    }[];
    changed: boolean;
    effects: any;
}>;
/** Run directories under `root` with effects that are still open. */
export function pendingRuns(root: any): Promise<any[]>;
