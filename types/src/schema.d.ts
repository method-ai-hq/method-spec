/**
 * Check and judge results carry two display-only fields, reason and evidence. Any JSON value is accepted there and
 * shown as text: a reason that is not text and each evidence item that is not text become JSON text, and evidence
 * that is not a list becomes a list of one. Fields with meaning (status, verdict) are never converted.
 */
export function displayText(result: any): any;
export const callerVariables: string[];
export const scriptVariables: string[];
export function object(properties: any, required?: string[]): {
    type: string;
    properties: any;
    required: string[];
    additionalProperties: boolean;
};
export const modelIdPattern: "^[a-z0-9-]+/[A-Za-z0-9._:-]+$";
export const sessionTools: string[];
export const formats: string[];
/** @type {Record<string, any>} */
export const methodSchema: Record<string, any>;
/** @type {Record<string, any>} */
export const configSchema: Record<string, any>;
export namespace observationSchema {
    export let type: string;
    export { properties };
    export { required };
    export let additionalProperties: boolean;
}
export const builtinObserverKinds: string[];
export namespace judgmentSchema { }
export namespace checkResultSchema { }
/**
 * learned.json beside a Method file: rules learned from corrections, by step. A rule with when null always applies;
 * a retired rule is kept for its history and never applies.
 * @type {Record<string, any>}
 */
export const learnedSchema: Record<string, any>;
