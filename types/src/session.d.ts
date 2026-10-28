/**
 * One headless Claude Code or Codex session with no Method prompt, output form or tools: a plain agent, as a person
 * would run it. It runs in a clean room (cleanRoomEnv) and works in the clean room's own copy of its room folder. When
 * the session ends, each file that it added or changed goes back into the room folder, so the work it hands in is in
 * the folder that later steps read. exec.prompt is the rendered prompt; input holds the step's values, and exec.room
 * names the one that is the folder. Returns {final_text, files_written, transcript}: the agent's last message, a copy of
 * each file that it added or changed in its room, and its transcript, all under artifacts/session/attempt-*.
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
/**
 * Put the files that a session wrote (paths in its room, kept under attempt/room/) into the room folder. A reused
 * session puts its recorded files back the same way, so later steps read the same folder either way.
 */
export function writeBack(attempt: any, folder: any, paths: any): Promise<void>;
