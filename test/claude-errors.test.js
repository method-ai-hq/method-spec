import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMethod} from '../src/runner.js';

test('preserves the Claude error result when its process exits nonzero',async t=>{
 const root=await mkdtemp(join(tmpdir(),'method-claude-error-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const command=join(root,'claude');
 await writeFile(command,'#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"result",subtype:"success",is_error:true,result:"OAuth access token has expired. Re-authenticate to continue."}));process.exitCode=1;\n',{mode:0o700});
 const file=join(root,'task.method');
 await writeFile(file,JSON.stringify({format:'method/3.1',name:'Claude error',goal:'Preserve the provider error',steps:{read:{do:{kind:'agent',model:'writer',prompt:'Read the fixture.',tools:[]},out:{text:{type:'text'}}}},result:'text'}));
 const result=await runMethod(file,{allow_local_processes:true,models:{writer:{backend:'claude',command}}},{runDir:join(root,'run')});
 assert.equal(result.status,'failed');
 assert.equal(result.error,'OAuth access token has expired. Re-authenticate to continue.');
});

for (const limited of [false, true]) {
 test(limited ? 'reports the output limit for oversized Claude output' : 'accepts a Claude result larger than a progress line across UTF-8 chunks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-claude-result-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const command = join(root, 'claude');
  const text = 'Briefing café. '.repeat(3000);
  await writeFile(command, `#!/usr/bin/env node
const event = Buffer.from(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{text:${JSON.stringify(text)}}})+'\\n');
(async()=>{for(let i=0;i<event.length;i+=101){await new Promise(resolve=>process.stdout.write(event.subarray(i,i+101),resolve));}})();
`, {mode:0o700});
  const file = join(root, 'task.method');
  await writeFile(file, JSON.stringify({format:'method/3.1',name:'Claude result',goal:'Read a complete agent result',
    steps:{write:{do:{kind:'agent',model:'writer',prompt:'Write the fixture.',tools:[]},out:{text:{type:'text'}}}},result:'text'}));
  const result = await runMethod(file, {allow_local_processes:true,models:{writer:{backend:'claude',command}},
    limits:{max_output_bytes:limited ? 1024 : 100000}}, {runDir:join(root,'run')});
  if (limited) {
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'output_limit');
  } else {
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.result, text);
  }
 });
}
