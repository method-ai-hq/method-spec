export function object(properties: any, required?: string[]): {
    type: string;
    properties: any;
    required: string[];
    additionalProperties: boolean;
};
/** @type {Record<string, any>} */
export const methodSchema: Record<string, any>;
/** @type {Record<string, any>} */
export const configSchema: Record<string, any>;
export namespace checkResultSchema {
    export let type: string;
    export { properties };
    export { required };
    export let additionalProperties: boolean;
}
