/** Code checks on a Method that passed validation. */
export function codeIssues(method: any, options?: {}): {
    message: any;
    fix: any;
    code: any;
    level: any;
}[];
/**
 * Mark the warnings and notes that a step accepts, and give a note for an accept whose code no longer fires.
 * Errors cannot be accepted. Codes in notChecked were not computed this time, so their accepts are not reported.
 */
export function applyAccepts(method: any, issues: any, notChecked?: any[]): any;
