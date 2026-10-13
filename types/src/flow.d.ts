/**
 * Trace untrusted text through a valid Method. Returns its sources, its acting steps, and one finding per acting
 * step that untrusted text can reach without a question to the person.
 */
export function traceUntrusted(method: any, options?: {}): {
    sources: Map<any, any>;
    acting: Map<any, any>;
    findings: {
        step: any;
        actions: any;
        field: string;
        source: any;
        connection: any;
        kind: any;
        path: any;
        reads: {
            label: any;
            ref: any;
            field: string;
            alias: string;
        }[];
    }[];
};
/** The untrusted_reaches_action issues of a valid Method. */
export function untrustedIssues(method: any, options?: {}): {
    patch?: {
        safety: string;
        edits: ({
            op: string;
            before: any;
            id: any;
            step: {
                name: string;
                purpose: string;
                in: {};
                ask: string;
                out: {
                    [x: number]: {
                        type: string;
                        description: string;
                    };
                };
            };
            path?: undefined;
            value?: undefined;
        } | {
            op: string;
            path: any[];
            value: any;
            before?: undefined;
            id?: undefined;
            step?: undefined;
        })[];
    };
    code: string;
    level: string;
    step: any;
    field: string;
    path: any;
    message: string;
    fix: string;
}[];
/** What the flow check proves about a valid Method: a list of {code, statement}; empty when it proves nothing. */
export function untrustedProofs(method: any, options?: {}): {
    code: string;
    statement: string;
}[];
/**
 * Apply a list of edits to a Method document (an object) and return a new document; the input is not changed.
 * Edits:
 *   {op: 'set', path: [KEY, ...], value}      set the value at path; missing records on the way are made
 *   {op: 'remove', path: [KEY, ...]}          remove the value at path
 *   {op: 'insert_step', before, id, step}     add step id to steps, placed just before step before
 * Paths are lists of keys from the document root, for example ['steps', 'send', 'when'].
 * @param {Record<string, any>} document
 * @param {import('./api-types.js').Edit[]} edits
 * @returns {Record<string, any>}
 */
export function applyEdits(document: Record<string, any>, edits: import("./api-types.js").Edit[]): Record<string, any>;
