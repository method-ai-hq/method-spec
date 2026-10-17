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
export function evaluate(expect: any, outcome: any, { caseDir, config, options }: {
    caseDir: any;
    config: any;
    options?: {};
}): Promise<{
    status: string;
    results: {
        criteria?: ({
            id: string;
            text: string;
            judge: string;
            probability: any;
            pass: boolean;
            reason: string;
            votes?: undefined;
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any;
            pass: boolean;
            reason: any;
            probability?: undefined;
        })[];
        judge_calls?: number;
        kind: any;
        status: string;
        reason: string;
        text?: any;
    }[];
}>;
/** What a finished run produced, as a case sees it. */
export function outcomeOfRun(runDir: any): Promise<{
    status: any;
    failure: any;
    result: any;
    inputs: any;
    outputs: {
        [k: string]: any;
    };
    effects: {
        effect: any;
        verdict: any;
        final: any;
        reason: any;
        observed_at: any;
        next_observation_at: any;
        horizon_at: any;
        action_outcome: any;
    }[];
    artifacts: string;
    files: {};
}>;
/**
 * Record a case from a run that went wrong. The case must fail on that run: otherwise it does not capture the
 * problem, or the note does not match the run. With a passing run (the output the person accepted after the fix),
 * the case must pass on it. A case from a passing run alone pins behaviour that is already right. A rubric's judge
 * is calibrated on the runs it has. A case that can pass only by breaking an instruction of the Method's model steps is
 * refused, unless the person's answer accepts the conflict.
 * @param {{methodFile: string, runDir?: string | undefined, id: string, note: string, author?: string | null | undefined, expect?: any[] | undefined, rubric?: string[] | undefined,
 *   ref?: string | undefined, context?: string[] | undefined, passingRun?: string | undefined, observations?: Record<string, any[]> | undefined, redact?: Record<string, string> | undefined,
 *   runs?: number | undefined, minPass?: number | undefined, retentionDays?: number | undefined, supersedes?: string[] | undefined, casesDir?: string | undefined,
 *   acceptConflict?: string | undefined, config?: any, options?: any}} input
 */
export function createCase({ methodFile, runDir, id, note, author, expect, rubric, ref, context, passingRun, observations, redact, runs, minPass, retentionDays, supersedes, casesDir, acceptConflict, config, options }: {
    methodFile: string;
    runDir?: string | undefined;
    id: string;
    note: string;
    author?: string | null | undefined;
    expect?: any[] | undefined;
    rubric?: string[] | undefined;
    ref?: string | undefined;
    context?: string[] | undefined;
    passingRun?: string | undefined;
    observations?: Record<string, any[]> | undefined;
    redact?: Record<string, string> | undefined;
    runs?: number | undefined;
    minPass?: number | undefined;
    retentionDays?: number | undefined;
    supersedes?: string[] | undefined;
    casesDir?: string | undefined;
    acceptConflict?: string | undefined;
    config?: any;
    options?: any;
}): Promise<{
    on_passing_run?: {
        criteria?: ({
            id: string;
            text: string;
            judge: string;
            probability: any;
            pass: boolean;
            reason: string;
            votes?: undefined;
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any;
            pass: boolean;
            reason: any;
            probability?: undefined;
        })[];
        judge_calls?: number;
        kind: any;
        status: string;
        reason: string;
        text?: any;
    }[];
    on_failing_run?: {
        criteria?: ({
            id: string;
            text: string;
            judge: string;
            probability: any;
            pass: boolean;
            reason: string;
            votes?: undefined;
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any;
            pass: boolean;
            reason: any;
            probability?: undefined;
        })[];
        judge_calls?: number;
        kind: any;
        status: string;
        reason: string;
        text?: any;
    }[];
    warnings?: string[];
    dir: string;
    retention_until: string;
    redacted: boolean;
    files?: {};
    accepted_conflicts?: {
        answer: any;
        conflicts: any;
    };
    format: string;
    id: string;
    status: string;
    method_file: string;
    note: any;
    author: string;
    created: string;
    source: {
        passing_run_dir?: string;
        run_dir: string;
        execution_id: any;
        method_sha256: string;
    };
    expect: any[];
    runs: number;
    min_pass: number;
    supersedes: string[];
    superseded_by: any;
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
 * Replay one case against a Method file. Files connections are bound to fresh scratch folders, so a changed step
 * that writes files can run safely. Only the steps the expectations need run. A strict case stops at its first
 * failed run. once: one run decides, for a quick check such as the improvement loop's.
 * @param {string} methodFile
 * @param {any} config
 * @param {any} testCaseValue
 * @param {any} [runOptions]
 * @param {{once?: boolean}} [check]
 */
export function testCase(methodFile: string, config: any, testCaseValue: any, runOptions?: any, { once }?: {
    once?: boolean;
}): Promise<{
    attempts: ({
        live_steps: any[];
        live_model_steps: any[];
        judge_calls: number;
        failure?: {
            code: any;
            headline: any;
        };
        run_status: "completed" | "unconfirmed" | "failed" | "needs_input";
        status: string;
        results: {
            criteria?: ({
                id: string;
                text: string;
                judge: string;
                probability: any;
                pass: boolean;
                reason: string;
                votes?: undefined;
            } | {
                id: string;
                text: string;
                judge: string;
                votes: any;
                pass: boolean;
                reason: any;
                probability?: undefined;
            })[];
            judge_calls?: number;
            kind: any;
            status: string;
            reason: string;
            text?: any;
        }[];
        reason?: undefined;
    } | {
        status: string;
        reason: any;
    })[];
    duration_ms: number;
    unreliable?: string;
    id: any;
    status: string;
    passes: number;
    runs: number;
    min_pass: any;
}>;
/**
 * Test a Method version against its active cases. Every active case must pass. With a baseline (the version
 * before a change), each case also runs on the old version, to show what the change fixed or broke. New cases
 * must fail on the baseline and pass on the candidate. once: each case runs once, even when a model step runs live.
 * @param {string} methodFile
 * @param {any} config
 * @param {{casesDir?: string | undefined, ids?: string[] | undefined, baseline?: string | undefined, newIds?: string[] | undefined, runOptions?: any, concurrency?: number | undefined, once?: boolean | undefined}} [options]
 */
export function testSuite(methodFile: string, config: any, { casesDir, ids, baseline, newIds, runOptions, concurrency, once }?: {
    casesDir?: string | undefined;
    ids?: string[] | undefined;
    baseline?: string | undefined;
    newIds?: string[] | undefined;
    runOptions?: any;
    concurrency?: number | undefined;
    once?: boolean | undefined;
}): Promise<{
    counts: {
        [k: string]: number;
    };
    retired: number;
    expired: any[];
    cases: any[];
    baseline?: string;
    passed: boolean;
    totals: {
        duration_ms: number;
        live_model_steps: any;
        judge_calls: any;
    };
    method: string;
}>;
export function defaultCasesDir(methodFile: any): string;
export function rubricCriteria(sentences: any): any;
