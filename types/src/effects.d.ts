/** Connections an action may see; observer credentials and endpoints go only to observers. */
export function connectionsFor(method: any, environment: {}, role: any): {
    [k: string]: any;
};
/** Fixture files are part of the bundle, so every run tests the judge that it will use. */
export function fixtureFiles(method: any, sourceRoot: any): Promise<string[]>;
/**
 * Run each judge on its fixtures. A judge must give the expected verdict for each fixture, and must be able to
 * report a contradiction and an absence of evidence. A judge that cannot fail proves nothing.
 */
export function testFixtures(method: any, bundle: any, manifest: any, judge: any): Promise<{
    effect: string;
    fixture: string;
    verdict: any;
}[]>;
/** Run an observer script. Observers get observer connections and the token; judges get no connections. */
export function runObserverScript({ exec, input, role, token, bundle, runtimeInfo, connections, processPath, signal, maxBytes }: {
    exec: any;
    input: any;
    role: any;
    token: any;
    bundle: any;
    runtimeInfo: any;
    connections: any;
    processPath: any;
    signal: any;
    maxBytes: any;
}): Promise<{
    output: any;
    diagnostics: any;
}>;
/** The next scheduled observation after `after`, or null when the horizon has passed. */
export function nextObservation(effect: any, completedAt: any, after: any): string;
/** Map a judgment to a verdict. Absence of evidence never confirms an effect. */
export function verdictFor(judgment: any, final: any, effect: any): any;
/**
 * Observe one effect once and return its ledger entry. With replay observations, only the judge runs.
 * @param {{effect: any, key: string, token: string, inputs: any, attempt: number, actionOutcome: string, completedAt: string, run: (exec: any, input: any, role: string) => Promise<{output: any}>, replay?: any[] | undefined, final?: boolean, runDir?: string, now?: Date, previous?: any[]}} options
 */
export function observeEffect({ effect, key, token, inputs, attempt, actionOutcome, completedAt, run, replay, final, runDir, now, previous }: {
    effect: any;
    key: string;
    token: string;
    inputs: any;
    attempt: number;
    actionOutcome: string;
    completedAt: string;
    run: (exec: any, input: any, role: string) => Promise<{
        output: any;
    }>;
    replay?: any[] | undefined;
    final?: boolean;
    runDir?: string;
    now?: Date;
    previous?: any[];
}): Promise<{
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
}>;
/** Earlier readings of one effect, oldest first. */
export function previousObservations(runDir: any, key: any): Promise<{
    observed_at: any;
    observations: any;
}[]>;
export function readLedger(runDir: any): Promise<any[]>;
/** The current entry of each effect is its last entry. */
export function currentEffects(entries: any): any[];
/**
 * The runtime, not the Method, decides what a finished run's effects establish.
 * Worst verdict wins: contradicted > final unknown > pending > confirmed or unrefuted.
 */
export function effectSummary(entries: any): {
    total: number;
    confirmed: number;
    unrefuted: number;
    contradicted: number;
    unknown: number;
    pending: number;
    next_observation_at: any;
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
};
/** Apply the effect summary to a completed run's status. */
export function statusWithEffects(base: any, summary: any): any;
/** Wait until an ISO time, within a deadline. Returns false when the wait does not fit. */
export function waitUntil(time: any, deadline: any, signal: any): Promise<boolean>;
export function effectKey(step: any, iteration: any, name: any): string;
export function isBuiltin(exec: any): boolean;
export function effectEntries(method: any): {
    id: string;
    step: any;
    name: string;
    effect: any;
}[];
export function horizonAt(effect: any, completedAt: any): string;
export function isFinal(entry: any): boolean;
export function appendLedger(runDir: any, entry: any): Promise<void>;
