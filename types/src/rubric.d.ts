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
