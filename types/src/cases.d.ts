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
            unsure?: undefined;
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any[];
            pass: boolean;
            unsure: boolean;
            reason: string;
            probability?: undefined;
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any[];
            pass: boolean;
            reason: any;
            probability?: undefined;
            unsure?: undefined;
        })[];
        judge_calls?: number;
        kind: any;
        status: string;
        reason: string;
        text?: any;
    }[];
}>;
/**
 * The tokens that a run's model work reported in its events: Codex and Claude Code steps and sessions (input, cached
 * input and output) and hosted model calls. 0 when nothing reported usage.
 */
export function eventTokens(events: any): number;
/**
 * What a finished run produced, as a case sees it: its status, result, inputs and outputs, effects, the files it wrote
 * (files: path -> kept copy), the calls of its Method tools (tool_calls, with each stand-in of a replay) and the
 * inputs of its declared effects (effect_inputs). A replay passes paths (copy -> original), so the outcome names the
 * paths that the recorded run saw, and copies (original -> copy), so a file ref reads the attempt's copy.
 * @param {string} runDir
 * @param {{paths?: Record<string, string>, copies?: Record<string, string>}} [replay]
 */
export function outcomeOfRun(runDir: string, { paths, copies }?: {
    paths?: Record<string, string>;
    copies?: Record<string, string>;
}): Promise<any>;
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
            unsure?: undefined;
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any[];
            pass: boolean;
            unsure: boolean;
            reason: string;
            probability?: undefined;
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any[];
            pass: boolean;
            reason: any;
            probability?: undefined;
            unsure?: undefined;
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
            unsure?: undefined;
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any[];
            pass: boolean;
            unsure: boolean;
            reason: string;
            probability?: undefined;
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any[];
            pass: boolean;
            reason: any;
            probability?: undefined;
            unsure?: undefined;
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
    snapshots: any;
    snapshot_missing: any;
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
 * The places where case runs run: about 12 at once, for every case of every test in this process. The number sets
 * itself. A run that a model service failed (as when too many runs reach one subscription at once) halves it, and that
 * run waits and runs again, at most twice; as many good runs in a row as there are places add one, up to 16. Runs with
 * a lower priority number start first. A usage limit of the person's plan is not a busy service: the test stops with it.
 */
export function runSlots(start?: number, most?: number): {
    readonly limit: number;
    /** Run work in a place; priority orders the queue (lower first). */
    run(work: any, priority?: number): Promise<any>;
    busy(): void;
    ok(): void;
};
/**
 * Replay one case against a Method file. Each attempt has its own scratch folder: it holds a copy of every snapshot
 * of the case and of each files connection that a step writes, and the recorded paths are rewritten to these copies,
 * so attempts never share a folder and a replay never changes the source run or the real folders. Only the steps the
 * expectations need run. The runs of a case run at the same time when a model step will run live (a step it needs
 * differs from the recording), and the case stops as soon as its result is decided.
 * once: one run decides (runs: 1). runs and minPass replace the case's own. live: steps that run live even when they
 * match the recording; target_live says whether they did. judgeCache: false judges again. keepDir: a folder that
 * keeps each attempt's run folder (attempt.run_dir). judges: a list of judge model profiles that must all pass a
 * rubric criterion; a disagreement fails it as unsure. upTo: make at most this many runs now; a case that passed them
 * and needs more is pass with more: the runs it still needs. signal: stops the case (status not_run). priority: its
 * place in the queue of runs (lower first).
 * @param {string} methodFile
 * @param {any} config
 * @param {any} testCaseValue
 * @param {any} [runOptions]
 * @param {{once?: boolean, runs?: number | undefined, minPass?: number | undefined, live?: string[] | undefined, judgeCache?: boolean | undefined, keepDir?: string | undefined, judges?: any[] | undefined,
 *   upTo?: number | undefined, signal?: AbortSignal | undefined, priority?: number | undefined}} [check]
 */
export function testCase(methodFile: string, config: any, testCaseValue: any, runOptions?: any, { once, runs, minPass, live, judgeCache, keepDir, judges, upTo, signal, priority }?: {
    once?: boolean;
    runs?: number | undefined;
    minPass?: number | undefined;
    live?: string[] | undefined;
    judgeCache?: boolean | undefined;
    keepDir?: string | undefined;
    judges?: any[] | undefined;
    upTo?: number | undefined;
    signal?: AbortSignal | undefined;
    priority?: number | undefined;
}): Promise<{
    attempts: any[];
    duration_ms: number;
    target_live?: boolean;
    more?: number;
    unreliable?: string;
    id: any;
    status: string;
    passes: number;
    runs: number;
    min_pass: any;
}>;
/** Remove a folder that may hold read-only copies; tests call it. */
export function _removeTree(path: any): Promise<void>;
/**
 * Test a Method version against its active cases. Every active case must pass. With a baseline (the version
 * before a change), each case also runs on the old version, to show what the change fixed or broke. New cases
 * must fail on the baseline and pass on the candidate. once, runs, minPass, live, judgeCache, keepDir and judges apply to each
 * case run, on both versions, as in testCase. Every case runs at once; their runs share the places of runSlots.
 * gate: decide only whether a change can be applied. The old version runs a case only when it is new or fails on the
 * new version (a case that passes is pass, whatever it did before), and the test stops at the first case that blocks
 * the change: a regression, a new case that is not fixed, or a case that cannot run safely any more. The cases that
 * did not run then are not_run.
 * firstRun: each case that is not new makes only its first run now; a case that passed it and needs more runs has
 * more: the runs it still needs. moreRuns: each case runs this many more times on the new version, and every run must
 * pass (the rest of a first-run test).
 * @param {string} methodFile
 * @param {any} config
 * @param {{casesDir?: string | undefined, ids?: string[] | undefined, baseline?: string | undefined, newIds?: string[] | undefined, runOptions?: any, once?: boolean | undefined,
 *   runs?: number | undefined, minPass?: number | undefined, live?: string[] | undefined, judgeCache?: boolean | undefined, keepDir?: string | undefined, judges?: any[] | undefined,
 *   gate?: boolean | undefined, firstRun?: boolean | undefined, moreRuns?: number | undefined}} [options]
 */
export function testSuite(methodFile: string, config: any, { casesDir, ids, baseline, newIds, runOptions, once, runs, minPass, live, judgeCache, keepDir, judges, gate, firstRun, moreRuns }?: {
    casesDir?: string | undefined;
    ids?: string[] | undefined;
    baseline?: string | undefined;
    newIds?: string[] | undefined;
    runOptions?: any;
    once?: boolean | undefined;
    runs?: number | undefined;
    minPass?: number | undefined;
    live?: string[] | undefined;
    judgeCache?: boolean | undefined;
    keepDir?: string | undefined;
    judges?: any[] | undefined;
    gate?: boolean | undefined;
    firstRun?: boolean | undefined;
    moreRuns?: number | undefined;
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
export function isAgentRecord(name: any): boolean;
