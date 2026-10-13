export function progressMessage(value: any): {
    message: any;
};
export function codexProgress(event: any): {
    message: any;
};
/**
 * An error-type or warning-type event of an agent's JSON stream (Codex or Claude Code), selected by its type, with
 * the agent's own message; or null. A failed turn is not a notice: it fails the step.
 */
export function agentEvent(event: any): {
    level: string;
    message: any;
};
