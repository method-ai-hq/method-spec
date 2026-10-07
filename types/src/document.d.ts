export function parseDocumentValue(value: any): any;
/** Validate values without dynamic code generation, including in browsers and Workers. */
export function shapeErrors(definition: any, value: any, label?: string): any;
/**
 * Turn schema errors into a few readable lines. Alternatives that the document did not choose (oneOf branches) are
 * noise; an unknown key that contains a space is almost always a YAML value with a comma inside { }.
 */
export function readableShapeErrors(errors: any): string;
export function validateMethod(value: any): {
    method: any;
    order: string[];
    dependencies: {};
};
export class MethodValidationError extends Error {
    constructor(message: any, code?: string);
    code: string;
}
