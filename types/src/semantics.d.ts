export function fail(message: any, code?: string): void;
export function safeData(value: any, seen?: Set<any>, depth?: number): void;
export function shape(def: any): any;
/** Derive primitive outputs once for validators, executors, and readers. */
export function effectiveOutputs(step: any): any;
export function dataSchema(definition: any): any;
export function outputSchema(definitions?: {}): any;
export function resolve(root: any, reference: any): any;
export function typeAt(root: any, reference: any): any;
/** A label selects one scalar input or one non-repeated step's saved output. */
export function runLabelType(method: any): any;
export function validateSemantics(method: any, assertData: any): {
    method: any;
    order: string[];
};
export function own(obj: any, key: any): boolean;
