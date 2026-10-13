/**
 * Where an event or a failure happened, in words: `step "Search the web" (task 5 of 12)`.
 * Tasks are 1-based in text. A repeat step counts rounds.
 * @param {{name: string, iteration?: number | null, total?: number | null, repeat?: number | null}} place
 */
export function placeText({ name, iteration, total, repeat }: {
    name: string;
    iteration?: number | null;
    total?: number | null;
    repeat?: number | null;
}): string;
/** The next step of a failure, with the effects that a failed action may have made. */
export function nextText(owner: any, slots: any, effects?: any[]): any;
/** The problem phrase of a failure, from structured data only. */
export function problemText({ validation, exitCode, code }: {
    validation: any;
    exitCode: any;
    code: any;
}): string;
/** A run or step limit that is 80% used. */
export function limitNotice({ where, limit, used, max }: {
    where: any;
    limit: any;
    used: any;
    max: any;
}): string;
/**
 * The message of a user-facing event, or undefined for other events.
 * @param {string} event
 * @param {any} data
 * @param {{place: (step: string, iteration?: number) => string, checkName: (step: string) => string, methodName: string}} names
 */
export function eventText(event: string, data: any, { place, checkName, methodName }: {
    place: (step: string, iteration?: number) => string;
    checkName: (step: string) => string;
    methodName: string;
}): any;
export function headlineText(owner: any, slots: any): any;
export function validationLine({ path, expected, found }: {
    path: any;
    expected: any;
    found: any;
}): string;
export function retryNotice({ service, kind, status, attempt, attempts }: {
    service: any;
    kind: any;
    status: any;
    attempt: any;
    attempts: any;
}): string;
export function agentNotice({ agent, level, message }: {
    agent: any;
    level: any;
    message: any;
}): string;
