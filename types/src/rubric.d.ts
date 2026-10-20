/**
 * Judge a value. Returns {status: pass|fail, criteria: [{id, text, pass, judge, votes|probability, reason}]}.
 * options.judgeCache: false judges again instead of reading the judgment cache.
 * options.judges: a list of judge model profiles (for example the user's Claude Code and Codex). Each one judges the
 * model criteria; a criterion passes only when every judge passes it. When the judges disagree, the criterion fails
 * with the reason "unsure" (unsure: true). Without it, the config's judge profile judges alone.
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
        unsure?: undefined;
    } | {
        id: string;
        text: string;
        judge: string;
        votes: any[];
        pass: boolean;
        unsure: boolean;
        reason: string;
        probability?: undefined;
    } | {
        id: string;
        text: string;
        judge: string;
        votes: any[];
        pass: boolean;
        reason: any;
        probability?: undefined;
        unsure?: undefined;
    })[];
    judge_calls: number;
}>;
/**
 * Find the rules of a new case that can be met only by breaking a standing instruction: a rule that needs a fact the
 * inputs do not give when an instruction forbids inventing it, or a rule that requires what an instruction forbids. A
 * rule conflicts when most judge votes report it with an instruction that is copied exactly from the instructions.
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
