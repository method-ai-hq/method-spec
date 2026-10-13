/** The kind of a JSON value, in words, without the value itself. */
export function kindOf(value: any): any;
/** One {path, expected, found} for each validator error. Found is a kind of value, never the value. */
export function validationErrors(errors: any, value: any): any;
/**
 * Validate a value that someone else produced. A failure carries the validator's errors as data (error.validation),
 * the producer (who returned the value), and its owner class; the raw validator text is the message.
 * @param {any} schema @param {any} value @param {string} label
 * @param {{producer: string, owner: string}} source
 */
export function assertSchema(schema: any, value: any, label: string, { producer, owner }: {
    producer: string;
    owner: string;
}): void;
export function validateConfig(config: any): any;
export { validateMethod } from "./document.js";
export { own, fail, safeData, shape, dataSchema, outputSchema, resolve, typeAt, effectiveOutputs } from "./semantics.js";
