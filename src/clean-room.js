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

/** The user's Claude Code sign-in as variables of a new config folder, or a link to its credentials file. */
async function claudeSignIn(base, config) {
  if (base.CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: base.CLAUDE_CODE_OAUTH_TOKEN };
  if (process.platform === 'darwin') {
    // The token stays in memory: it is never written to a file, a log, or an argument.
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 20_000 });
      const oauth = JSON.parse(stdout).claudeAiOauth;
      if (oauth?.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now() + 60_000)) return { CLAUDE_CODE_OAUTH_TOKEN: oauth.accessToken };
    } catch { /* No Keychain sign-in; try the credentials file. */ }
  }
  const credentials = join(base.CLAUDE_CONFIG_DIR ?? join(base.HOME ?? homedir(), '.claude'), '.credentials.json');
  if (await exists(credentials)) { await symlink(credentials, join(config, '.credentials.json')); return {}; }
  if (base.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: base.ANTHROPIC_API_KEY };
  fail('setup', 'Claude Code is not signed in on this computer, or its sign-in has expired. Run claude once (or claude auth login), then run again.', 'needs_input');
}

/** The user's Codex sign-in: a link to its auth.json in the new CODEX_HOME. */
async function codexSignIn(base, codexHome) {
  const auth = join(base.CODEX_HOME ?? join(base.HOME ?? homedir(), '.codex'), 'auth.json');
  if (await exists(auth)) { await symlink(auth, join(codexHome, 'auth.json')); return {}; }
  if (base.CODEX_API_KEY) return { CODEX_API_KEY: base.CODEX_API_KEY };
  fail('setup', 'Codex is not signed in on this computer. Run codex login, then run again.', 'needs_input');
}

/**
 * A clean room for one agent (claude or codex): a fresh HOME whose agent config folder (CLAUDE_CONFIG_DIR or
 * CODEX_HOME) holds only the user's sign-in, a short TMPDIR, and a private copy of each bound folder. The agent sees
 * none of the user's instructions (CLAUDE.md, AGENTS.md), memory, settings, skills, plugins, hooks or MCP servers.
 * base is the caller's environment: only its PATH, language and user name carry over, with the sign-in. A Method arm
 * runs `method run` with this environment, so its agent steps and its background fix get the same room as a session.
 * folders maps a name to a folder; the room's copy of it is in folders of the result. remove() deletes the room,
 * when nothing that uses it still runs.
 * @param {'claude' | 'codex'} agent
 * @param {NodeJS.ProcessEnv} [base]
 * @param {{folders?: Record<string, string>}} [options]
 */
export async function cleanRoomEnv(agent, base = process.env, { folders = {} } = {}) {
  const root = await tempFolder('mr-');
  try {
    const home = join(root, 'home'), tmp = join(root, 'tmp');
    await mkdir(tmp, { mode: 0o700 });
    const env = { ...Object.fromEntries(kept.flatMap(name => base[name] ? [[name, base[name]]] : [])), HOME: home, TMPDIR: tmp };
    if (agent === 'claude') {
      const config = join(home, '.claude');
      await mkdir(config, { recursive: true, mode: 0o700 });
      Object.assign(env, { CLAUDE_CONFIG_DIR: config }, await claudeSignIn(base, config));
    } else {
      const codexHome = join(home, '.codex');
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      Object.assign(env, { CODEX_HOME: codexHome }, await codexSignIn(base, codexHome));
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
