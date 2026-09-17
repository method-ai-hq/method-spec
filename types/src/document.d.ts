export function parseDocumentValue(value: any): any;
/** Validate values without dynamic code generation, including in browsers and Workers. */
export function shapeErrors(definition: any, value: any, label?: string): any;
export function validateMethod(value: any): {
    method: any;
    order: string[];
};
export class MethodValidationError extends Error {
    constructor(message: any, code?: string);
    code: string;
}
