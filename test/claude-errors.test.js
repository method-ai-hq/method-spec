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

for (const off of [{ web: false }, { env: 'off' }]) {
 test(`a Claude Code step runs without web search and fetch when ${off.env ? 'METHOD_WEB=off' : 'the config says web: false'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-claude-web-'));
  t.after(() => { delete process.env.METHOD_WEB; return rm(root, {recursive:true, force:true}); });
  const command = join(root, 'claude');
  await writeFile(command, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(join(root, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{text:'ok'}}));
`, {mode:0o700});
  const file = join(root, 'task.method');
  await writeFile(file, JSON.stringify({format:'method/3.1',name:'No web',goal:'Work without the web',
    steps:{write:{do:{kind:'agent',model:'writer',prompt:'Write.',tools:[]},out:{text:{type:'text'}}}},result:'text'}));
  if (off.env) process.env.METHOD_WEB = off.env;
  const result = await runMethod(file, {allow_local_processes:true, models:{writer:{backend:'claude',command}}, ...(off.web === false ? {web:false} : {})}, {runDir:join(root,'run')});
  assert.equal(result.status, 'completed', result.failure?.details);
  const args = JSON.parse(await readFile(join(root, 'args.json'), 'utf8'));
  assert.ok(!args[args.indexOf('--allowedTools') + 1].includes('WebSearch'));
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'WebSearch,WebFetch');
 });
}

test('a Claude step keeps its structured result when background subagents report later results', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-claude-background-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const command = join(root, 'claude');
  // The shape of a recorded stream: the step's answer, then results for the task notifications of background subagents.
  const stats = {spawned:2, started_in_background:2, completed:2};
  const events = [
    {type:'system', subtype:'init', model:'claude-opus', mcp_servers:[{name:'method_step', status:'connected'}]},
    {type:'assistant', message:{content:[{type:'tool_use', id:'t1', name:'StructuredOutput', input:{text:'Briefing'}}]}},
    {type:'result', subtype:'success', is_error:false, result_index:0, result:'{"text":"Briefing"}', structured_output:{text:'Briefing'}, subagent_stats:stats},
    {type:'result', subtype:'success', is_error:false, result_index:1, origin:{kind:'task-notification'}, result:'The subagent finished.', subagent_stats:stats},
    {type:'result', subtype:'success', is_error:false, result_index:2, result:'The briefing is complete.', subagent_stats:stats},
  ];
  await writeFile(command, `#!/usr/bin/env node\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`, {mode:0o700});
  const file = join(root, 'task.method');
  await writeFile(file, JSON.stringify({format:'method/3.1',name:'Background subagents',goal:'Keep the step answer',
    steps:{write:{do:{kind:'agent',model:'writer',prompt:'Write.',tools:[]},out:{text:{type:'text'}}}},result:'text'}));
  const result = await runMethod(file, {allow_local_processes:true,models:{writer:{backend:'claude',command}}}, {runDir:join(root,'run')});
  assert.equal(result.status, 'completed', result.failure?.details);
  assert.equal(result.result, 'Briefing');
});
