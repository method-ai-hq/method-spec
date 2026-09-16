/** Method 3.1 prompts: declared values only, without expressions or recursive expansion. */
export function parsePrompt(template: any): {
    text?: string;
    reference?: string;
    source?: string;
}[];
export function validatePrompt(template: any, definitions: any, typeAt: any): void;
export function renderPrompt(template: any, inputs: any): string;
