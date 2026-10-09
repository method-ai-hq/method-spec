/**
 * Prepare to observe one script process. The result adds arguments before the profile's own arguments and
 * variables to its environment; `finish` reads what the process recorded. Observation never fails the step:
 * a problem gives `{unavailable: reason}`.
 * @param {{command: string}} profile
 * @param {{runDir: string, bundle: string, artifacts: string, env: Record<string, string>}} where
 * @returns {Promise<{args: string[], env: Record<string, string>, finish: () => Promise<any>}>}
 */
export function prepareObservation(profile: {
    command: string;
}, { runDir, bundle, artifacts, env }: {
    runDir: string;
    bundle: string;
    artifacts: string;
    env: Record<string, string>;
}): Promise<{
    args: string[];
    env: Record<string, string>;
    finish: () => Promise<any>;
}>;
export const OBSERVED_LIMIT: 200;
