import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
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
 assert.equal(result.failure?.details,'OAuth access token has expired. Re-authenticate to continue.');
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
    assert.equal(result.failure.code, 'output_limit');
  } else {
    assert.equal(result.status, 'completed', result.failure?.details);
    assert.equal(result.result, text);
  }
 });
}

for (const agent of ['claude', 'codex']) {
 test(`records the failed ${agent} attempt when its output has the wrong form`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-agent-form-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const command = join(root, agent);
  await writeFile(command, agent === 'claude'
    ? `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{wrong:1}}));\n`
    : `#!/usr/bin/env node\nconst a=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>require('fs').writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({wrong:1})));\n`, {mode:0o700});
  const file = join(root, 'task.method');
  await writeFile(file, JSON.stringify({format:'method/3.1',name:'Form',goal:'Return the declared output',
    steps:{write:{do:{kind:'agent',model:'writer',prompt:'Write.',tools:[]},out:{text:{type:'text'}}}},result:'text'}));
  const result = await runMethod(file, {allow_local_processes:true,models:{writer:{backend:agent,command}}}, {runDir:join(root,'run')});
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'invalid_output');
  assert.match(await readFile(join(root, 'run', 'events.jsonl'), 'utf8'), agent === 'claude' ? /"event":"agent\.failed"/ : /"event":"codex\.failed"/);
 });
}
