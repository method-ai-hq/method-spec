/**
 * The Claude Code arguments of one step. A live run allows the file tools everywhere and web search and fetch. A replay
 * allows reading only in its scratch folder and its run folder, writing only in its scratch folder and the run's
 * artifacts, and no shell or network. web: false (the config's web) takes web search and fetch away from a live run. A bare session ({tools}: the session tools that it may use) has no output form,
 * no Method tools and no MCP servers; it runs in restricted mode (no settings files, file tools only in its working
 * folder) with only its own tools, and without skills or slash commands.
 */
export function claudeArgs({ schema, mcpConfig, profile, artifacts, replay, bare, web }: {
    schema: any;
    mcpConfig: any;
    profile?: {};
    artifacts: any;
    replay?: any;
    bare?: any;
    web?: boolean;
}): any[];
/**
 * Run one Claude Code process in its attempt folder and return its successful result event. The folder keeps
 * prompt.md, events.jsonl, stderr.log and transcript.jsonl. clean removes values that no record may hold.
 * onInit sees Claude Code's init event.
 */
export function runClaude({ command, args, prompt, cwd, env, directory, model, context, clean, onInit }: {
    command: any;
    args: any;
    prompt: any;
    cwd: any;
    env: any;
    directory: any;
    model: any;
    context: any;
    clean?: (value: any) => string;
    onInit: any;
}): Promise<any>;
export function executeClaude(execution: any, input: any, schema: any, context: any): Promise<any>;
