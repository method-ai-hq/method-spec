/** Throw a Method error. The owner class is required: it says whose problem the error is. */
export function fail(owner: any, message: any, code?: string, details?: {}): void;
/** Reject values that are not plain JSON data. owner is whose code produced the value. */
export function safeData(value: any, owner: any, seen?: Set<any>, depth?: number): void;
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
/** Whose problem a failure is. Every failure states one; the run's failure record takes its sentence and next step from it. */
export const owners: string[];
export function effectConfirm(effect: any): any;
export function modelName(exec: any): any;
export function isModelId(model: any): boolean;
