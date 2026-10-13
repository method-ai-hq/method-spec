import {runMethod, type RuntimeConfig, type RunOptions} from '../types/src/index.js';
const config: RuntimeConfig = {allow_local_processes:true, models:{worker:{backend:'claude'}}};
const options: RunOptions = {agent:'claude', runDir:'runs/test', resume:true};
async function valid() {
  const result = await runMethod('test.method', config, options);
  if (result.status === 'completed') console.log(result.result);
  else if (result.status === 'failed' || result.status === 'needs_input') console.log(result.failure.headline, result.failure.next.action);
}
// @ts-expect-error Misspelled option must not compile.
void runMethod('test.method', config, {runDirectory:'wrong'});
// @ts-expect-error Unsupported provider must not compile.
const bad: RuntimeConfig = {models:{worker:{backend:'unknown'}}};
void valid; void bad;
import {methodIssues, methodProofs, applyEdits, type Proof, type Edit} from '../types/src/index.js';
const proofs: Proof[] = methodProofs('format: method/3.4');
const [first] = methodIssues('format: method/3.4');
const edits: Edit[] = first?.patch?.edits ?? [{op:'set', path:['steps','send','when'], value:'send_approved'}];
void applyEdits({steps:{}}, edits); void proofs;
// @ts-expect-error An edit needs a known op.
const wrong: Edit = {op:'move', path:[]};
void wrong;
