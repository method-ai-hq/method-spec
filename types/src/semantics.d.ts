export function fail(message: any, code?: string, details?: {}): void;
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
/** Milliseconds in a schedule duration such as 60s, 10m, 1h or 5d. */
export function durationMs(value: any): number;
/** Observation offsets from the action's completion; the last offset is the finality horizon. */
export function effectSchedule(effect: any): number[];
/** A built-in observer reads its own connection, or by default the one connection the step changes. */
export function observerConnection(effect: any, step: any): any;
export function validateSemantics(method: any, assertData: any): {
    method: any;
    order: string[];
    dependencies: {};
};
export function own(obj: any, key: any): boolean;
export function effectConfirm(effect: any): any;
export function modelName(exec: any): any;
export function isModelId(model: any): boolean;
