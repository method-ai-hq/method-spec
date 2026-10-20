/**
 * The Codex arguments of one step. A live run bypasses the sandbox, as before. A replay runs in Codex's workspace-write
 * sandbox rooted at its scratch folder, with the run's artifacts as the only other writable folder and no network.
 */
export function codexArgs({ schemaFile, output, url, profile, artifacts, replay }: {
    schemaFile: any;
    output: any;
    url: any;
    profile?: {};
    artifacts: any;
    replay?: any;
}): any[];
export function executeCodex(execution: any, input: any, schema: any, context: any): Promise<any>;
export { startMethodTools } from "./method-tools.js";
