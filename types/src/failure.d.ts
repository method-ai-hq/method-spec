/**
 * The failure record of a stopped run, written once. The owner comes from where the error happened: the class that
 * its fail() call states, or that the place that caught it set. An error without a class is a bug in Method.
 * @param {any} error
 * @param {{method?: any, step?: string | null, iteration?: number | null, failedIterations?: number[], total?: number | null,
 *   phase?: string | null, effects?: any[], stopped?: boolean}} where
 */
export function failureRecord(error: any, where?: {
    method?: any;
    step?: string | null;
    iteration?: number | null;
    failedIterations?: number[];
    total?: number | null;
    phase?: string | null;
    effects?: any[];
    stopped?: boolean;
}): {
    diagnostics?: string;
    owner: any;
    code: any;
    headline: any;
    step: string;
    step_name: any;
    iteration: number;
    failed_iterations: number[];
    total: number;
    phase: any;
    check_name: any;
    next: any;
    evidence: any[];
    details: string;
};
