/** A digest of every file under the cases directory. The learn gate compares it before and after a repair. */
export function casesDigest(casesDir: any): Promise<{
    sha256: string;
    files: number;
}>;
/**
 * Cases recorded from runs of this Method file.
 * @param {string} methodFile
 * @param {string | undefined} [casesDir]
 * @returns {Promise<any[]>}
 */
export function listCases(methodFile: string, casesDir?: string | undefined): Promise<any[]>;
/**
 * Evaluate the expectations against one outcome. A missing value or an effect that was not replayed makes the
 * result unverifiable: the case cannot say whether the version is right.
 */
export function evaluate(expect: any, outcome: any, { caseDir, config }: {
    caseDir: any;
    config: any;
}): Promise<{
    status: string;
    results: {
        kind: any;
        status: string;
        reason: string;
        text?: any;
    }[];
}>;
/**
 * Record a case from a finished run. The expectation must not pass on an empty outcome; a case that cannot fail
 * tests nothing.
 * @param {{methodFile: string, runDir: string, id: string, note: string, author?: string | null | undefined, expect: any[], observations?: Record<string, any[]> | undefined,
 *   redact?: Record<string, string> | undefined, runs?: number | undefined, minPass?: number | undefined, retentionDays?: number | undefined, locate?: any,
 *   supersedes?: string[] | undefined, casesDir?: string | undefined, config?: any}} options
 */
export function createCase({ methodFile, runDir, id, note, author, expect, observations, redact, runs, minPass, retentionDays, locate, supersedes, casesDir, config }: {
    methodFile: string;
    runDir: string;
    id: string;
    note: string;
    author?: string | null | undefined;
    expect: any[];
    observations?: Record<string, any[]> | undefined;
    redact?: Record<string, string> | undefined;
    runs?: number | undefined;
    minPass?: number | undefined;
    retentionDays?: number | undefined;
    locate?: any;
    supersedes?: string[] | undefined;
    casesDir?: string | undefined;
    config?: any;
}): Promise<{
    dir: string;
    expect: any[];
    runs: number;
    min_pass: number;
    supersedes: string[];
    superseded_by: any;
    retention_until: string;
    redacted: boolean;
    locate?: any;
    format: string;
    id: string;
    status: string;
    method_file: string;
    note: any;
    author: string;
    created: string;
    source: {
        run_dir: string;
        execution_id: any;
        method_sha256: string;
    };
}>;
/**
 * Retire a case whose rule is obsolete. The case stays on disk with its reason, so the history is kept.
 * @param {string} methodFile
 * @param {string} id
 * @param {{by?: string | null | undefined, reason: string, casesDir?: string | undefined}} options
 */
export function retireCase(methodFile: string, id: string, { by, reason, casesDir }: {
    by?: string | null | undefined;
    reason: string;
    casesDir?: string | undefined;
}): Promise<void>;
/**
 * Replay one case against a Method file `runs` times.
 * @param {string} methodFile
 * @param {any} config
 * @param {any} testCaseValue
 * @param {any} [runOptions]
 */
export function testCase(methodFile: string, config: any, testCaseValue: any, runOptions?: any): Promise<{
    id: any;
    status: string;
    passes: number;
    runs: any;
    min_pass: any;
    attempts: ({
        status: string;
        reason: any;
    } | {
        live_steps: any[];
        code?: any;
        run_status: "needs_input" | "completed" | "failed" | "unconfirmed";
        status: string;
        results: {
            kind: any;
            status: string;
            reason: string;
            text?: any;
        }[];
        reason?: undefined;
    })[];
}>;
/**
 * Test a Method version against its active cases. With a baseline (the version before a change), each case is
 * compared on both versions. A case that fails on both is already failing, not a regression. New cases must fail on
 * the baseline and pass on the candidate.
 * @param {string} methodFile
 * @param {any} config
 * @param {{casesDir?: string | undefined, ids?: string[] | undefined, baseline?: string | undefined, newIds?: string[] | undefined, runOptions?: any}} [options]
 */
export function testSuite(methodFile: string, config: any, { casesDir, ids, baseline, newIds, runOptions }?: {
    casesDir?: string | undefined;
    ids?: string[] | undefined;
    baseline?: string | undefined;
    newIds?: string[] | undefined;
    runOptions?: any;
}): Promise<{
    counts: {
        [k: string]: number;
    };
    retired: number;
    expired: any[];
    cases: {
        baseline?: {
            id: any;
            status: string;
            passes: number;
            runs: any;
            min_pass: any;
            attempts: ({
                status: string;
                reason: any;
            } | {
                live_steps: any[];
                code?: any;
                run_status: "needs_input" | "completed" | "failed" | "unconfirmed";
                status: string;
                results: {
                    kind: any;
                    status: string;
                    reason: string;
                    text?: any;
                }[];
                reason?: undefined;
            })[];
        };
        candidate: {
            id: any;
            status: string;
            passes: number;
            runs: any;
            min_pass: any;
            attempts: ({
                status: string;
                reason: any;
            } | {
                live_steps: any[];
                code?: any;
                run_status: "needs_input" | "completed" | "failed" | "unconfirmed";
                status: string;
                results: {
                    kind: any;
                    status: string;
                    reason: string;
                    text?: any;
                }[];
                reason?: undefined;
            })[];
        };
        expired?: any;
        id: any;
        verdict: string;
        note: any;
    }[];
    baseline?: string;
    passed: boolean;
    method: string;
}>;
export function defaultCasesDir(methodFile: any): string;
