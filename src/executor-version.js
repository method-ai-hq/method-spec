import { createRequire } from 'node:module';
import { fail } from './semantics.js';

export const executorVersion = createRequire(import.meta.url)('../package.json').version;

/** @param {{ executor_version?: string }} checkpoint */
export function assertCheckpointExecutor(checkpoint) {
  if (!checkpoint.executor_version) fail(`This checkpoint has no executor version. Resume with its original SDK/runtime installation. Installed executor: ${executorVersion}.`, 'resume_mismatch');
  if (checkpoint.executor_version !== executorVersion) fail(`This checkpoint needs executor ${checkpoint.executor_version}; installed executor: ${executorVersion}. Resume with the original executor.`, 'resume_mismatch');
}
