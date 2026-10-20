/** The learned rules in a folder, validated, or null when the folder has none. */
export function readLearned(dir: any): Promise<any>;
/** The file of learned rules beside a Method file. It is part of the bundle and the manifest. */
export const learnedFile: "learned.json";
export function activeRules(learned: any, id: any): any;
export function rulesText(rules: any): string;
/** The call that decides which conditional rules apply to one iteration, on the step's own model. */
export const selectionPrompt: string;
export namespace selectionSchema {
    let type: string;
    namespace properties {
        namespace applies {
            let type_1: string;
            export { type_1 as type };
            export namespace items {
                let type_2: string;
                export { type_2 as type };
            }
        }
    }
    let required: string[];
    let additionalProperties: boolean;
}
