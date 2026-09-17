import {runMethod, type RuntimeConfig, type RunOptions} from '../types/src/index.js';
const config: RuntimeConfig = {allow_local_processes:true, models:{worker:{backend:'claude'}}};
const options: RunOptions = {agent:'claude', runDir:'runs/test', resume:true};
async function valid() {
  const result = await runMethod('test.method', config, options);
  if (result.status === 'completed') console.log(result.result);
  else console.log(result.error);
}
// @ts-expect-error Misspelled option must not compile.
void runMethod('test.method', config, {runDirectory:'wrong'});
// @ts-expect-error Unsupported provider must not compile.
const bad: RuntimeConfig = {models:{worker:{backend:'unknown'}}};
void valid; void bad;
