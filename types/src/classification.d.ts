/** Shared response contract for hosted and embedded classification providers. */
export function validateClassification(answer: any, options: any, identity: any): {
    choice: any;
    probabilities: any;
};
/** One managed request; candidate checks and acceptance remain in the runner. */
export function executeClassification(execution: any, inputs: any, identity: any, provider: any, context: any): Promise<{
    choice: any;
    probabilities: any;
}>;
export const classificationByteLimit: 65536;
