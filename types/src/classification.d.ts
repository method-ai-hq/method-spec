/** The answer form of a classify step or request: named options, yes or no, or ordered levels. */
export function classificationForm(execution: any): {
    answer: string;
    levels?: undefined;
    options?: undefined;
} | {
    levels: any;
    answer?: undefined;
    options?: undefined;
} | {
    options: any;
    answer?: undefined;
    levels?: undefined;
};
/**
 * Shared response contract for hosted and embedded classification providers.
 * @param {any} answer
 * @param {{options?: Record<string, string>, answer?: 'yes_no', levels?: string[]}} execution the classify step or request
 * @param {{provider: string, model: string}} identity
 */
export function validateClassification(answer: any, execution: {
    options?: Record<string, string>;
    answer?: "yes_no";
    levels?: string[];
}, identity: {
    provider: string;
    model: string;
}): {
    answer: any;
    probability: any;
    level?: undefined;
    score?: undefined;
    probabilities?: undefined;
    choice?: undefined;
} | {
    level: any;
    score: any;
    probabilities: any;
    answer?: undefined;
    probability?: undefined;
    choice?: undefined;
} | {
    choice: any;
    probabilities: any;
    answer?: undefined;
    probability?: undefined;
    level?: undefined;
    score?: undefined;
};
/** The Jev request body for one classification request. */
export function jevRequest(request: any): {
    model: any;
    state: any;
    questions: {
        classification: {
            type: string;
            instructions: any;
            criteria?: undefined;
        } | {
            type: string;
            instructions: any;
            criteria: any;
        };
    };
};
/** Convert a Jev response to the provider answer. Only an answer from the pinned release is accepted; it keeps the pinned name. */
export function jevAnswer(request: any, data: any): {
    provider: string;
    model: any;
    confidence: any;
    usage: {
        cost?: any;
        input_tokens: any;
        output_tokens: any;
    };
    answer: boolean;
    probability: any;
} | {
    provider: string;
    model: any;
    confidence: any;
    usage: {
        cost?: any;
        input_tokens: any;
        output_tokens: any;
    };
    level: any;
    score: any;
    probabilities: any;
} | {
    provider: string;
    model: any;
    confidence: any;
    usage: {
        cost?: any;
        input_tokens: any;
        output_tokens: any;
    };
    choice: any;
    probabilities: any;
};
/**
 * Call Jev through OpenRouter directly with the operator's own key. The endpoint is fixed, so the key cannot go to
 * another host.
 * @param {string} apiKeyEnv
 * @returns {import('./api-types.js').ClassificationProvider}
 */
export function typesafeClassification(apiKeyEnv: string, secret?: (name: any) => string): import("./api-types.js").ClassificationProvider;
/** One managed classification; candidate checks and acceptance remain in the runner. */
export function executeClassification(execution: any, inputs: any, identity: any, provider: any, context: any): Promise<{
    answer: any;
    probability: any;
    level?: undefined;
    score?: undefined;
    probabilities?: undefined;
    choice?: undefined;
} | {
    level: any;
    score: any;
    probabilities: any;
    answer?: undefined;
    probability?: undefined;
    choice?: undefined;
} | {
    choice: any;
    probabilities: any;
    answer?: undefined;
    probability?: undefined;
    level?: undefined;
    score?: undefined;
}>;
export const classificationByteLimit: 65536;
/** The classifier version a direct run uses when the configuration names none. */
export const typesafeModel: "jev-1.13.0";
export function jevModel(pin: any): any;
export const jevEndpoint: "https://openrouter.ai/api/v1/systemone";
