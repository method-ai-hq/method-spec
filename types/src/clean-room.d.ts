/**
 * A clean room for an agent (claude or codex), or for each agent of a list: a fresh HOME whose agent config folders
 * (.claude, .codex) hold only the user's sign-in, a short TMPDIR, and a private copy of each bound folder. The agent sees
 * none of the user's instructions (CLAUDE.md, AGENTS.md), memory, settings, skills, plugins, hooks or MCP servers.
 * base is the caller's environment: only its PATH, language and user name carry over, with the sign-in. A Method arm
 * runs `method run` with this environment, so its agent steps and its background fix get the same room as a session.
 * folders maps a name to a folder; the room's copy of it is in folders of the result. remove() deletes the room,
 * when nothing that uses it still runs.
 * @param {'claude' | 'codex' | Array<'claude' | 'codex'>} agent
 * @param {NodeJS.ProcessEnv} [base]
 * @param {{folders?: Record<string, string>}} [options]
 */
export function cleanRoomEnv(agent: "claude" | "codex" | Array<"claude" | "codex">, base?: NodeJS.ProcessEnv, { folders }?: {
    folders?: Record<string, string>;
}): Promise<{
    root: string;
    env: {
        HOME: string;
        TMPDIR: string;
    };
    folders: {};
    remove: () => Promise<void>;
}>;
/** The content hash of each file in a folder, by its path inside the folder. Links are not followed. */
export function folderHashes(root: any): Promise<{}>;
export namespace keychain {
    /** Whether the login Keychain of a home holds Claude Code's sign-in. It reads no secret. */
    function hasClaude(home: any, user: any): Promise<boolean>;
}
