import { configuration } from './defaults.js';
import { readFile, stat } from 'node:fs/promises';
import { validateMethod, validateConfig, own, fail } from './validate.js';
import { executable, hash, relativeFile, containedFile } from './io.js';

/** Check local dependencies without executing a script or model. Shared by validate and run. */
export async function preflight(method, config, sourceRoot, options = {}) {
  validateMethod(method);
  validateConfig(config);
  config = configuration(config);
  const profiles = config.models ?? {}, runtimeProfiles = config.runtimes ?? {}, tools = config.tools ?? {};
  const executions = [], usedTools = new Set();
  for (const step of Object.values(method.steps)) {
    for (const [phase, exec] of [['action', step.do], ['check', step.check]]) if (exec?.kind) {
      executions.push(exec);
      if (exec.kind !== 'run') {
        const profile = profiles[exec.model] ?? { backend: 'codex' };
        if (profile.backend === 'codex') {
          if (config.allow_local_processes !== true) fail('Codex requires allow_local_processes in operator configuration', 'preflight');
          await executable(profile.command ?? 'codex');
        } else if (!options.transport && !process.env[profile.api_key_env]) fail(`Missing environment variable: ${profile.api_key_env}`, 'preflight');
      }
      if (exec.kind === 'agent') for (const name of exec.tools) {
        if (!own(tools, name)) fail(`Unknown tool: ${name}`, 'preflight');
        const tool = tools[name]; usedTools.add(name);
        for (const effect of tool.effects) {
          if (phase === 'check') fail(`Checker cannot use effectful tool: ${name}`, 'preflight');
          if (!(step.changes ?? []).includes(`environment.${effect}`)) fail(`Undeclared tool effect: ${name} -> ${effect}`, 'preflight');
        }
      }
    }
  }
  for (const name of usedTools) executions.push(tools[name].run);
  const scripts = executions.filter(x => x.kind === 'run');
  if (scripts.length && config.allow_local_processes !== true) fail('This method requires allow_local_processes in operator configuration', 'preflight');
  const runtimeInfo = {};
  for (const exec of scripts) {
    const profile = runtimeProfiles[exec.runtime];
    if (!profile) fail(`Unknown runtime: ${exec.runtime}`, 'preflight');
    for (const key of profile.env ?? []) if (!process.env[key]) fail(`Missing runtime environment variable: ${key}`, 'preflight');
    if (!runtimeInfo[exec.runtime]) {
      const command = await executable(profile.command);
      runtimeInfo[exec.runtime] = { ...profile, command, binary_sha256: hash(await readFile(command)) };
    }
  }
  for (const name of Object.keys(method.environment ?? {})) {
    if (!own(config.environment, name)) fail(`Missing environment binding: ${name}`, 'preflight');
  }
  const files = [...new Set([...(method.files ?? []), ...scripts.map(x => x.entrypoint)])];
  for (const name of options.checkFiles === false ? [] : files) {
    relativeFile(name);
    let file;
    try { file = await containedFile(sourceRoot, name); }
    catch (error) { fail(`Cannot read Method file ${name}: ${error.message}`, 'preflight'); }
    const info = await stat(file);
    if (!info.isFile()) fail(`Method file is not a regular file: ${name}`, 'preflight');
    if (info.size > 20_000_000) fail(`Bundle file exceeds 20 MB: ${name}`, 'preflight');
    await readFile(file);
  }
  return { scripts, runtimeInfo, files };
}
