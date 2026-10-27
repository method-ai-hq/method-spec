import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fail } from './validate.js';
import { hash, tempFolder } from './io.js';

const execFileAsync = promisify(execFile);
// What a clean room keeps of the caller's environment: where programs are, and the language and the user's name.
const kept = ['PATH', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL'];
const exists = path => access(path, constants.F_OK).then(() => true, () => false);

/**
 * Where Claude Code keeps its sign-in on macOS: the login Keychain, which `security` and Claude Code find through
 * HOME/Library/Keychains. Tests replace hasClaude.
 */
export const keychain = {
  /** Whether the login Keychain of a home holds Claude Code's sign-in. It reads no secret. */
  async hasClaude(home, user) {
    if (process.platform !== 'darwin') return false;
    try {
      await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', ...(user ? ['-a', user] : [])], { env: { HOME: home }, timeout: 20_000 });
      return true;
    } catch { return false; }
  },
};

/**
 * The user's Claude Code sign-in in the room's HOME, where Claude Code finds it by itself: on macOS a link to the user's
 * login Keychain, else a link to the credentials file. Claude Code in the room reads the sign-in there and refreshes an
 * expired token itself, as it does for the user, so a long run never holds an expired copy. Every process that runs with
 * the room's HOME (a script of the run, and the agents that the script starts) finds the same sign-in. A token or key
 * that the caller sets as a variable stays a variable.
 */
async function claudeSignIn(base, home) {
  if (base.CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: base.CLAUDE_CODE_OAUTH_TOKEN };
  const userHome = base.HOME ?? homedir();
  if (!base.CLAUDE_CONFIG_DIR && await keychain.hasClaude(userHome, base.USER)) {
    await mkdir(join(home, 'Library'), { mode: 0o700 });
    await symlink(join(userHome, 'Library', 'Keychains'), join(home, 'Library', 'Keychains'));
    return {};
  }
  const credentials = join(base.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude'), '.credentials.json');
  if (await exists(credentials)) { await symlink(credentials, join(home, '.claude', '.credentials.json')); return {}; }
  if (base.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: base.ANTHROPIC_API_KEY };
  fail('setup', 'Claude Code is not signed in on this computer. Run claude once (or claude auth login), then run again.', 'needs_input');
}

/** The user's Codex sign-in: a link to its auth.json in the room's HOME/.codex, where Codex finds it by itself. */
async function codexSignIn(base, codexHome) {
  const auth = join(base.CODEX_HOME ?? join(base.HOME ?? homedir(), '.codex'), 'auth.json');
  if (await exists(auth)) { await symlink(auth, join(codexHome, 'auth.json')); return {}; }
  if (base.CODEX_API_KEY) return { CODEX_API_KEY: base.CODEX_API_KEY };
  fail('setup', 'Codex is not signed in on this computer. Run codex login, then run again.', 'needs_input');
}

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
export async function cleanRoomEnv(agent, base = process.env, { folders = {} } = {}) {
  const root = await tempFolder('mr-');
  try {
    const home = join(root, 'home'), tmp = join(root, 'tmp');
    await mkdir(tmp, { mode: 0o700 });
    const env = { ...Object.fromEntries(kept.flatMap(name => base[name] ? [[name, base[name]]] : [])), HOME: home, TMPDIR: tmp };
    const agents = new Set(Array.isArray(agent) ? agent : [agent]);
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (agents.has('claude')) {
      await mkdir(join(home, '.claude'), { recursive: true, mode: 0o700 });
      Object.assign(env, await claudeSignIn(base, home));
    }
    if (agents.has('codex')) {
      const codexHome = join(home, '.codex');
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      Object.assign(env, await codexSignIn(base, codexHome));
    }
    const copies = {};
    for (const [name, folder] of Object.entries(folders)) {
      copies[name] = join(root, 'folders', name);
      await cp(folder, copies[name], { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    }
    return { root, env, folders: copies, remove: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** The content hash of each file in a folder, by its path inside the folder. Links are not followed. */
export async function folderHashes(root) {
  const files = {};
  const visit = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files[relative(root, path).split(sep).join('/')] = hash(await readFile(path));
    }
  };
  await visit(root);
  return files;
}
