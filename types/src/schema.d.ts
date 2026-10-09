export function object(properties: any, required?: string[]): {
    type: string;
    properties: any;
    required: string[];
    additionalProperties: boolean;
};
export const modelIdPattern: "^[a-z0-9-]+/[A-Za-z0-9._:-]+$";
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
