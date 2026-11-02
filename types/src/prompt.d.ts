/** Method 3.1 prompts: declared values only, without expressions or recursive expansion. */
export function parsePrompt(template: any): {
    text?: string;
    reference?: string;
    source?: string;
}[];
export function validatePrompt(template: any, definitions: any, typeAt: any): void;
export function renderPrompt(template: any, inputs: any): string;
/**
 * The step input without the values that the prompt names, so the model reads each value once: where the prompt puts
 * it. A record that is left empty goes too. An item of a list stays, because removing it would renumber the others.
 */
export function unnamedInput(template: any, input: any): any;
