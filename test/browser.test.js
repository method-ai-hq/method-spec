import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMethod} from '../src/runner.js';
import {validateMethod} from '../src/validate.js';
import {executionTools,toolContent} from '../src/tool-connections.js';
const doc=()=>({format:'method/3.1',name:'Browser',goal:'Read',environment:{browser:{type:'browser',description:'Browser'}},steps:{read:{changes:['environment.browser'],do:{kind:'agent',model:'default',browser:'environment.browser',prompt:'Read'},out:{value:{type:'text'}},check:{present:'value'}}},result:'value'});
const definition={description:'Open page',connection:'browser',tool:'browser_navigate',parameters:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false},effects:['browser']};
test('browser reference and automatic controls; omitted custom tools; collision',()=>{
 validateMethod(doc());
 assert.deepEqual(executionTools(doc().steps.read.do,{browser_navigate:definition}),['browser_navigate']);
 assert.deepEqual(executionTools({kind:'agent'}, {browser_navigate:definition}),[]);
 assert.throws(()=>executionTools({...doc().steps.read.do,tools:['browser_navigate']},{browser_navigate:definition}),/Duplicate/);
 const m=doc();m.steps.read.do.browser='environment.missing';assert.throws(()=>validateMethod(m),/browser environment/);
});
for(const backend of ['codex','claude'])test(`${backend} receives text and images through the normal bridge; private call data stays out of journal`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'method-browser-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'task.method');await writeFile(file,JSON.stringify(doc()));
 const fake=join(root,'codex');await writeFile(fake,`#!/usr/bin/env node
(async()=>{
const args=process.argv.slice(2);const claude=${backend==='claude'};
if(args.includes('--max-turns'))throw Error('Native agents must not receive a turn cap');
const server=claude?JSON.parse((await import('node:fs')).readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.method_step:null;
const url=claude?server.url:JSON.parse(args.find(x=>x.startsWith('mcp_servers.method_step.url=')).split('=').slice(1).join('='));
const headers={'content-type':'application/json',authorization:claude?server.headers.Authorization:'Bearer '+process.env.METHOD_CODEX_TOOL_TOKEN};
const list=await (await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).json();
if(list.result.tools.length!==1)throw Error('tools');
const r=await (await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'browser_navigate',arguments:{url:'https://example.com/private'}}})})).json();
if(r.result.content[1].type!=='image')throw Error('lost image');
if(claude)console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{value:r.result.content[0].text}}));
else (await import('node:fs')).writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({value:r.result.content[0].text}));
})().catch(e=>{console.error(e);process.exitCode=1});
`,{mode:0o700});
 const config={allow_local_processes:true,models:{default:{backend,command:fake}},environment:{browser:'selected'},tools:{browser_navigate:definition}};
 let count=0;
 const result=await runMethod(file,config,{runDir:join(root,'run'),connections:{browser:{call:async(name,args)=>{count++;assert.equal(name,'browser_navigate');return {content:[{type:'text',text:'Read page'},{type:'image',mimeType:'image/png',data:'aGVsbG8='}]};}}}});
 assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(count,1);assert.equal(result.result,'Read page');
 assert.doesNotMatch(await readFile(join(root,'run/events.jsonl'),'utf8'),/example.com\/private|aGVsbG8=/);
 await assert.rejects(runMethod(file,config,{runDir:join(root,'missing')}),/Missing tool connection/);
 const noEffects=doc();delete noEffects.steps.read.changes;await writeFile(file,JSON.stringify(noEffects));
 await assert.rejects(runMethod(file,config,{runDir:join(root,'effects'),connections:{browser:{call:async()=>{throw Error('unexpected');}}}}),/Undeclared tool effect/);
});

test('script output named content remains structured data',()=>{const value={content:[{text:'ordinary field'}]};assert.equal(toolContent(value).content[0].type,'text');assert.deepEqual(toolContent(value).structuredContent,value);});
