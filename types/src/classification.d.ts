/** Shared response contract for hosted and embedded classification providers. */
export function validateClassification(answer: any, options: any, identity: any): {
    choice: any;
    probabilities: any;
};
/**
 * Call Typesafe directly with the operator's own key. The endpoint is fixed, so the key cannot go to another host.
 * @param {string} apiKeyEnv
 * @returns {import('./api-types.js').ClassificationProvider}
 */
export function typesafeClassification(apiKeyEnv: string, secret?: (name: any) => string): import("./api-types.js").ClassificationProvider;
/** One managed classification; candidate checks and acceptance remain in the runner. */
export function executeClassification(execution: any, inputs: any, identity: any, provider: any, context: any): Promise<{
    choice: any;
    probabilities: any;
}>;
export const classificationByteLimit: 65536;
/** The classifier version a direct run uses when the configuration names none. */
export const typesafeModel: "jev-1.13.0";
