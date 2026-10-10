import { modelName } from './semantics.js';
import { executionTools } from './tool-connections.js';
import { resolveModels, packageModels } from './agents.js';
import { configuration } from './defaults.js';
import { readFile, stat } from 'node:fs/promises';
import { validateMethod, validateConfig, own, fail } from './validate.js';
import { executable, hash, relativeFile, containedFile } from './io.js';
import { fixtureFiles } from './effects.js';
import { directBackends } from './model.js';

/** A declared secret has a value in the host's store or the process environment. */
const hasSecret = (options, name) => !!(options.secrets && own(options.secrets, name) ? options.secrets[name] : process.env[name]);

/** Check local dependencies without executing a script or model. Shared by validate and run. */
export async function preflight(method, config, sourceRoot, options = {}) {
  validateMethod(method);
  validateConfig(config);
  config = configuration(config, method);
  const missingSetup = [];
  const missingSecrets = Object.keys(method.secrets ?? {}).filter(name => !hasSecret(options, name));
  if (missingSecrets.length && !options.allowMissingSetup) fail(`Missing secrets: ${missingSecrets.join(', ')}.`, 'missing_secret', { missing: missingSecrets });
  if (missingSecrets.length) missingSetup.push(`Supply secrets: ${missingSecrets.join(', ')}`);
  let profiles;
  const saved = options.packageModels ?? await packageModels(method, sourceRoot);
  try { profiles = await resolveModels(method, config, { ...options, packageModels: saved }); } catch (error) { if (!options.allowMissingSetup || error.code !== 'needs_input') throw error; missingSetup.push(error.message); profiles = {}; }
  const runtimeProfiles = config.runtimes ?? {}, tools = config.tools ?? {};
  const executions = [], usedTools = new Set();
  for (const step of Object.values(method.steps)) {
    for (const [phase, exec] of [['action', step.do], ['check', step.check]]) if (exec?.kind) {
      executions.push(exec);
      if (exec.kind === 'classify' && config.classification?.api_key_env) {
        if (!hasSecret(options, config.classification.api_key_env)) fail(`Missing environment variable: ${config.classification.api_key_env}`, 'preflight');
      } else if (exec.kind === 'classify' && (!config.classification || !options.classification?.evaluate)) {
        const message = 'Classification needs Method sign-in, your own OpenRouter key (OPENROUTER_API_KEY), or an embedded classification provider.';
        if (options.allowMissingSetup) missingSetup.push(message); else fail(message, 'needs_input');
      }
      if (['call', 'agent'].includes(exec.kind)) {
        const profile = profiles[modelName(exec)];
        if (!profile && options.allowMissingSetup) { /* run resolves the agent */ }
        else if (['codex', 'claude'].includes(profile.backend)) {
          if (config.allow_local_processes !== true) fail('Local agents require allow_local_processes in operator configuration', 'preflight');
          try { await executable(profile.command ?? profile.backend); } catch(error) { if(!options.allowMissingSetup)throw error; missingSetup.push(error.message); }
        } else if (profile.backend === 'method') {
          if (!options.hostedModels && !options.transport) { const message = 'Hosted models need Method sign-in. Run method login, then run again.'; if (options.allowMissingSetup) missingSetup.push(message); else fail(message, 'needs_input'); }
        } else if (!options.transport && !hasSecret(options, profile.api_key_env)) fail(`Missing environment variable: ${profile.api_key_env}`, 'preflight');
      }
      if (exec.browser && !Object.values(tools).some(t => t.connection === exec.browser.split('.')[1])) {
        if(options.allowMissingSetup) missingSetup.push(`Prepare browser: ${exec.browser}`);
        else fail(`Missing browser connection: ${exec.browser}`, 'needs_input');
      }
      if (exec.kind === 'agent') for (const name of executionTools(exec, tools)) {
        if (!own(tools, name)) fail(`Unknown tool: ${name}`, 'preflight');
        const tool = tools[name]; usedTools.add(name);
        if (method.format !== 'method/3.1' && tool.run && !tool.description.trim()) fail(`Tool ${name}: describe its operation and effects.`);
        if (tool.connection && !options.connections?.[tool.connection]) {
          if(options.allowMissingSetup) missingSetup.push(`Connect tool: ${name}`);
          else fail(`Missing tool connection: ${tool.connection}`, 'needs_input');
        }
        if(tool.connection && directBackends.includes(profiles[modelName(exec)]?.backend)) fail('Connection browser tools require Codex or Claude; select an agent.', 'preflight');
        for (const effect of tool.effects) {
          if (phase === 'check') fail(`Checker cannot use effectful tool: ${name}`, 'preflight');
          if (!(step.changes ?? []).includes(`environment.${effect}`)) fail(`Undeclared tool effect: ${name} -> ${effect}`, 'preflight');
        }
      }
    }
  }
  for (const name of usedTools) if(tools[name].run) executions.push(tools[name].run);
  for (const step of Object.values(method.steps)) for (const effect of Object.values(step.effects ?? {})) if (effect.observe.kind === 'run') executions.push(effect.observe, effect.judge);
  const scripts = executions.filter(x => x.kind === 'run');
  if (scripts.length && config.allow_local_processes !== true) fail('This method requires allow_local_processes in operator configuration', 'preflight');
  const runtimeInfo = {};
  for (const exec of scripts) {
    const profile = runtimeProfiles[exec.runtime];
    if (!profile && options.allowMissingSetup && ['node','python'].includes(exec.runtime)) { missingSetup.push(`Prepare ${exec.runtime} with method run.`); continue; }
    if (!profile) fail(`Unknown runtime: ${exec.runtime}`, 'preflight');
    if (!runtimeInfo[exec.runtime]) {
      const command = await executable(profile.command);
      runtimeInfo[exec.runtime] = { ...profile, command, binary_sha256: hash(await readFile(command)) };
    }
  }
  for (const name of Object.keys(method.environment ?? {})) {
    if (!own(config.environment, name)) { if(options.allowMissingSetup)missingSetup.push(`Bind input: ${name}`); else fail(`Missing environment binding: ${name}`, 'preflight'); }
  }
  const code = [...new Set([...(method.files ?? []), ...scripts.map(x => x.entrypoint)])];
  const files = [...new Set([...code, ...(options.checkFiles === false ? [] : await fixtureFiles(method, sourceRoot))])];
  for (const name of options.checkFiles === false ? [] : files) {
    relativeFile(name);
    let file;
    try { file = await containedFile(sourceRoot, name); }
    catch (error) { fail(`Cannot read Method file ${name}: ${error.message}`, 'preflight'); }
    const info = await stat(file);
    if (!info.isFile()) fail(`Method file is not a regular file: ${name}`, 'preflight');
    if (info.size > 20_000_000) fail(`Bundle file exceeds 20 MB: ${name}`, 'preflight');
  }
  return { scripts, runtimeInfo, files, missingSetup };
}
