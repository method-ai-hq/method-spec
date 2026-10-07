/** A digest of every file under the cases directory. The learn gate compares it before and after a repair. */
export function casesDigest(casesDir: any): Promise<{
    sha256: string;
    files: number;
}>;
/** Cases recorded from runs of this Method file. */
export function listCases(methodFile: any, casesDir?: string): Promise<any[]>;
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
 */
export function createCase({ methodFile, runDir, id, note, author, expect, observations, redact, runs, minPass, retentionDays, locate, supersedes, casesDir, config }: {
    methodFile: any;
    runDir: any;
    id: any;
    note: any;
    author: any;
    expect: any;
    observations?: {};
    redact: any;
    runs?: number;
    minPass: any;
    retentionDays?: number;
    locate: any;
    supersedes?: any[];
    casesDir?: string;
    config?: {};
}): Promise<{
    dir: string;
    expect: any;
    runs: number;
    min_pass: any;
    supersedes: any[];
    superseded_by: any;
    retention_until: string;
    redacted: boolean;
    locate?: any;
    format: string;
    id: any;
    status: string;
    method_file: string;
    note: any;
    author: any;
    created: string;
    source: {
        run_dir: string;
        execution_id: any;
        method_sha256: string;
    };
}>;
/** Retire a case whose rule is obsolete. The case stays on disk with its reason, so the history is kept. */
export function retireCase(methodFile: any, id: any, { by, reason, casesDir }: {
    by?: any;
    reason: any;
    casesDir?: string;
}): Promise<void>;
/** Replay one case against a Method file `runs` times. */
export function testCase(methodFile: any, config: any, testCaseValue: any, runOptions?: {}): Promise<{
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
 */
export function testSuite(methodFile: any, config: any, { casesDir, ids, baseline, newIds, runOptions }?: {
    casesDir?: string;
    newIds?: any[];
    runOptions?: {};
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
