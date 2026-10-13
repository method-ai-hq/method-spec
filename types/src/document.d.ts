export function parseDocumentValue(value: any): any;
/** Validate values without dynamic code generation, including in browsers and Workers. */
export function shapeErrors(definition: any, value: any, label?: string): any;
/**
 * Turn schema errors into a few readable lines. Alternatives that the document did not choose (oneOf branches) are
 * noise; an unknown key that contains a space is almost always a YAML value with a comma inside { }.
 */
export function readableShapeErrors(errors: any): string;
/**
 * Every issue in a Method: the first format error, or else the code checks; then accepts are applied.
 * @param {unknown} document Method text or parsed value.
 * @param {import('./api-types.js').IssueOptions} [options]
 * @returns {import('./api-types.js').Issue[]}
 */
export function methodIssues(document: unknown, options?: import("./api-types.js").IssueOptions): import("./api-types.js").Issue[];
/**
 * What the code checks prove about a valid Method, as plain statements. Empty for an invalid Method, or when
 * nothing is proved. Proofs come from declarations only: a script that reads the web without declaring it is not seen.
 * @param {unknown} document Method text or parsed value.
 * @param {Pick<import('./api-types.js').IssueOptions, 'tools'>} [options]
 * @returns {import('./api-types.js').Proof[]}
 */
export function methodProofs(document: unknown, options?: Pick<import("./api-types.js").IssueOptions, "tools">): import("./api-types.js").Proof[];
/** Throw the first format error; return the Method, its step order, and its dependencies. */
export function validateMethod(value: any): {
    method: any;
    order: string[];
    dependencies: {};
};
/** The document as its content digest sees it: the account Method ID is left out, so a copy keeps its versions. */
export function documentForDigest(document: any): any;
export class MethodValidationError extends Error {
    constructor(message: any, code?: string);
    code: string;
    owner: string;
}
