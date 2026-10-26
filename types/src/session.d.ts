/**
 * One headless Claude Code or Codex session with no Method prompt, output form or tools: a plain agent, as a person
 * would run it. It runs in a clean room (cleanRoomEnv) and works in the room's own copy of its room folder, so the
 * folder itself never changes. exec.prompt is the rendered prompt; input holds the step's values, and exec.room names
 * the one that is the folder. Returns {final_text, files_written, transcript}: the agent's last message, a copy of each
 * file that it added or changed in its room, and its transcript, all under artifacts/session/attempt-*.
 */
export function executeSession(exec: any, input: any, context: any): Promise<{
    final_text: any;
    files_written: {
        path: string;
        sha256: any;
    }[];
    transcript: {
        path: string;
        sha256: string;
    };
}>;
