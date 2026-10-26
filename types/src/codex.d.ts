/**
 * The Codex arguments of one step. A live run bypasses the sandbox, as before. A replay runs in Codex's workspace-write
 * sandbox rooted at its scratch folder, with the run's artifacts as the only other writable folder and no network.
 * A bare session ({room, tools}) has no output form and no Method tools: it ignores the user's config and rules, has
 * no plugins, apps or skill search, and runs in a sandbox rooted at its room, read-only unless it may write or edit,
 * with web search only when it may use the web.
 */
export function codexArgs({ schemaFile, output, url, profile, artifacts, replay, bare }: {
    schemaFile: any;
    output: any;
    url: any;
    profile?: {};
    artifacts: any;
    replay?: any;
    bare?: any;
}): any[];
/**
 * Run one Codex process in its attempt folder; it saves its last message in output. The folder keeps prompt.md,
 * events.jsonl, stderr.log and transcript.jsonl. clean removes values that no record may hold. messages: whether the
 * agent's messages are progress updates (a step's are; a session's are its work). readResult returns what the
 * transcript shows as the result, from the attempt's file resultFile; started adds to the codex.started event. Returns the usage that Codex reported.
 */
export function runCodex({ command, args, prompt, cwd, env, directory, model, context, clean, messages, readResult, resultFile, started }: {
    command: any;
    args: any;
    prompt: any;
    cwd: any;
    env: any;
    directory: any;
    model: any;
    context: any;
    clean?: (value: any) => string;
    messages?: boolean;
    readResult: any;
    resultFile?: string;
    started?: {};
}): Promise<any>;
export function executeCodex(execution: any, input: any, schema: any, context: any): Promise<undefined>;
export { startMethodTools } from "./method-tools.js";
