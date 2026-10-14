/**
 * Judge a value. Returns {status: pass|fail, criteria: [{id, text, pass, judge, votes|probability, reason}]}.
 * @param {{value: any, criteria: Array<{id: string, text: string}>, context?: any, judges?: Record<string, string>, config: any, options?: any}} input
 */
export function judgeRubric({ value, criteria, context, judges, config, options }: {
    value: any;
    criteria: Array<{
        id: string;
        text: string;
    }>;
    context?: any;
    judges?: Record<string, string>;
    config: any;
    options?: any;
}): Promise<{
    status: string;
    criteria: ({
        id: string;
        text: string;
        judge: string;
        probability: any;
        pass: boolean;
        reason: string;
        votes?: undefined;
    } | {
        id: string;
        text: string;
        judge: string;
        votes: any;
        pass: boolean;
        reason: any;
        probability?: undefined;
    })[];
    judge_calls: number;
}>;
/**
 * Find the rules of a new case that can be met only by breaking a standing instruction, such as "Do not invent missing
 * jurisdictions" when the inputs give no jurisdiction. A rule conflicts when most judge votes report it with an
 * instruction that is copied exactly from the instructions.
 * @param {{rules: Array<{id: string, text: string}>, note: string, instructions: string, config: any, options?: any}} input
 */
export function findConflicts({ rules, note, instructions, config, options }: {
    rules: Array<{
        id: string;
        text: string;
    }>;
    note: string;
    instructions: string;
    config: any;
    options?: any;
}): Promise<{
    rule: string;
    text: string;
    instruction: any;
    reason: any;
}[]>;
/**
 * Choose the fast judge for a criterion only when it agrees with every example: the model judge's verdicts on the
 * failing example, and pass on the passing example.
 */
export function chooseJudges({ criteria, examples, config, options }: {
    criteria: any;
    examples: any;
    config: any;
    options?: {};
}): Promise<{}>;
export function rubricSettings(config: any): any;
export function valueText(value: any): string;
