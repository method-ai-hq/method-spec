export function assertSchema(schema: any, value: any, label: any): void;
export function validateConfig(config: any): any;
export function validateMethod(method: any): {
    method: any;
    order: string[];
};
export { own, fail, safeData, shape, dataSchema, outputSchema, resolve, typeAt } from "./semantics.js";
