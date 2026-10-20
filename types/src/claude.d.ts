/**
 * The Claude Code arguments of one step. A live run allows the file tools everywhere. A replay allows reading only in
 * its scratch folder and its run folder, writing only in its scratch folder and the run's artifacts, and no shell.
 */
export function claudeArgs({ schema, mcpConfig, profile, artifacts, replay }: {
    schema: any;
    mcpConfig: any;
    profile?: {};
    artifacts: any;
    replay?: any;
}): any[];
export function executeClaude(execution: any, input: any, schema: any, context: any): Promise<any>;
