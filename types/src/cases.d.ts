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
            reason: string;
            narrow?: boolean;
            id: string;
            text: string;
            judge: string;
            probability: any;
            pass: boolean;
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
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any[];
            pass: boolean;
            reason: any;
            unsure?: undefined;
        })[];
        judge_calls?: number;
        status: string;
        reason: string;
        scope?: any;
        kind: any;
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
 * @param {{methodFile: string, runDir?: string | undefined, id: string, note: string, author?: string | null | undefined, expect?: any[] | undefined, rubric?: string[] | undefined, everyInput?: string[] | undefined,
 *   ref?: string | undefined, context?: string[] | undefined, passingRun?: string | undefined, observations?: Record<string, any[]> | undefined, redact?: Record<string, string> | undefined,
 *   runs?: number | undefined, minPass?: number | undefined, retentionDays?: number | undefined, supersedes?: string[] | undefined, casesDir?: string | undefined,
 *   acceptConflict?: string | undefined, config?: any, options?: any}} input
 */
export function createCase({ methodFile, runDir, id, note, author, expect, rubric, everyInput, ref, context, passingRun, observations, redact, runs, minPass, retentionDays, supersedes, casesDir, acceptConflict, config, options }: {
    methodFile: string;
    runDir?: string | undefined;
    id: string;
    note: string;
    author?: string | null | undefined;
    expect?: any[] | undefined;
    rubric?: string[] | undefined;
    everyInput?: string[] | undefined;
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
            reason: string;
            narrow?: boolean;
            id: string;
            text: string;
            judge: string;
            probability: any;
            pass: boolean;
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
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any[];
            pass: boolean;
            reason: any;
            unsure?: undefined;
        })[];
        judge_calls?: number;
        status: string;
        reason: string;
        scope?: any;
        kind: any;
        text?: any;
    }[];
    on_failing_run?: {
        criteria?: ({
            reason: string;
            narrow?: boolean;
            id: string;
            text: string;
            judge: string;
            probability: any;
            pass: boolean;
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
        } | {
            id: string;
            text: string;
            judge: string;
            votes: any[];
            pass: boolean;
            reason: any;
            unsure?: undefined;
        })[];
        judge_calls?: number;
        status: string;
        reason: string;
        scope?: any;
        kind: any;
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
 * sure: one run decides when it passes clearly; a first run that passes narrowly (a classifier close to its threshold)
 * makes two more runs, which must pass too. A failing run decides at once.
 * saved: {dir, keys}: a passing run keeps its model steps' outputs in dir; with keys (the step keys of the version that
 * this one is compared with), a step whose key is the same there serves the output kept for the same inputs, so only the
 * steps that differ, and those after them, run again.
 * once: one run decides (runs: 1). runs and minPass replace the case's own. live: steps that run live even when they
 * match the recording; target_live says whether they did. judgeCache: false judges again. keepDir: a folder that
 * keeps each attempt's run folder (attempt.run_dir). judges: a list of judge model profiles that must all pass a
 * rubric criterion; a disagreement fails it as unsure. signal: stops the case (status not_run). priority: its
 * place in the queue of runs (lower first).
 * @param {string} methodFile
 * @param {any} config
 * @param {any} testCaseValue
 * @param {any} [runOptions]
 * @param {{once?: boolean, runs?: number | undefined, minPass?: number | undefined, live?: string[] | undefined, judgeCache?: boolean | undefined, keepDir?: string | undefined, judges?: any[] | undefined,
 *   sure?: boolean | undefined, saved?: {dir: string, keys?: Record<string, string> | undefined} | undefined, signal?: AbortSignal | undefined, priority?: number | undefined}} [check]
 */
export function testCase(methodFile: string, config: any, testCaseValue: any, runOptions?: any, { once, runs, minPass, live, judgeCache, keepDir, judges, sure, saved, signal, priority }?: {
    once?: boolean;
    runs?: number | undefined;
    minPass?: number | undefined;
    live?: string[] | undefined;
    judgeCache?: boolean | undefined;
    keepDir?: string | undefined;
    judges?: any[] | undefined;
    sure?: boolean | undefined;
    saved?: {
        dir: string;
        keys?: Record<string, string> | undefined;
    } | undefined;
    signal?: AbortSignal | undefined;
    priority?: number | undefined;
}): Promise<{
    attempts: any[];
    duration_ms: number;
    target_live?: boolean;
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
 * The steps that a change touched, for each case: the steps that the case needs (its expectations' producers and the
 * steps before them) whose step key differs between the baseline and this version. A case with none serves every step
 * it needs from the outputs kept when it last passed, so the change cannot alter its result.
 * @param {string} methodFile
 * @param {string} baseline
 * @param {any} config
 * @param {{casesDir?: string | undefined, ids?: string[] | undefined}} [options]
 * @returns {Promise<Record<string, string[]>>}
 */
export function touchedSteps(methodFile: string, baseline: string, config: any, { casesDir, ids }?: {
    casesDir?: string | undefined;
    ids?: string[] | undefined;
}): Promise<Record<string, string[]>>;
/**
 * Test a Method version against its active cases. Every active case must pass. With a baseline (the version
 * before a change), each case also runs on the old version, to show what the change fixed or broke. New cases
 * must fail on the baseline and pass on the candidate. once, runs, minPass, live, judgeCache, keepDir and judges apply to each
 * case run, on both versions, as in testCase. Every case runs at once; their runs share the places of runSlots.
 * gate: decide only whether a change can be applied. The old version runs a case only when it is new or fails on the
 * new version (a case that passes is pass, whatever it did before), and the test stops at the first case that blocks
 * the change: a regression, a new case that is not fixed, or a case that cannot run safely any more. The cases that
 * did not run then are not_run. A gate runs each case that is not new once on the new version when that run passes
 * clearly, and 3 times (every run must pass) when it passes narrowly (sure in testCase); a new case passes 3 runs in 3
 * when a model step runs live, and fails on the old version.
 * stopOnFailure: false keeps a gate running after a break, so a full check reports every case.
 * saved: a folder for the model steps' outputs of passing case runs. Every passing run keeps them there; with a
 * baseline, each version serves the outputs of the steps that are the same in the other version, so a case runs again
 * only the steps that the change touched and the steps after them.
 * @param {string} methodFile
 * @param {any} config
 * @param {{casesDir?: string | undefined, ids?: string[] | undefined, baseline?: string | undefined, newIds?: string[] | undefined, runOptions?: any, once?: boolean | undefined,
 *   runs?: number | undefined, minPass?: number | undefined, live?: string[] | undefined, judgeCache?: boolean | undefined, keepDir?: string | undefined, judges?: any[] | undefined,
 *   gate?: boolean | undefined, stopOnFailure?: boolean | undefined, saved?: string | undefined}} [options]
 */
export function testSuite(methodFile: string, config: any, { casesDir, ids, baseline, newIds, runOptions, once, runs, minPass, live, judgeCache, keepDir, judges, gate, stopOnFailure, saved }?: {
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
    stopOnFailure?: boolean | undefined;
    saved?: string | undefined;
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
/** The longest text that a parts check compares: a label or a short value. Longer text is judged by a rubric. */
export const PART_CHARS: 200;
export function rubricCriteria(sentences: any): any;
export function isAgentRecord(name: any): boolean;
