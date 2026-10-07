/**
 * Everything that decides what a step does, apart from its inputs. Display text and effect contracts do not change
 * the action, so they do not change the key. Runtime binaries are left out: a Node update does not make a recording
 * stale, but a changed script, prompt, model profile or tool does.
 */
export function stepKey(step: any, { files, profiles, tools }: {
    files?: {};
    profiles?: {};
    tools?: {};
}): string;
/** The recorded output for this iteration, when the step and its inputs are unchanged. */
export function replayedCandidate(replay: any, { id, step, iteration, bindings, manifest, profiles, tools }: {
    id: any;
    step: any;
    iteration: any;
    bindings: any;
    manifest: any;
    profiles: any;
    tools: any;
}): any;
export function unverifiable(id: any, iteration: any, step: any): void;
/** Build a recording from a finished run: each accepted iteration's inputs and outputs, plus its effect observations. */
export function recordRun(runDir: any): Promise<{
    format: string;
    method_sha256: string;
    execution_id: any;
    inputs: any;
    initial_state: any;
    keys: {
        [k: string]: string;
    };
    iterations: {};
    observations: {};
    method: any;
}>;
