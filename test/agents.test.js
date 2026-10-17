import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModels, localAgent, localAgents, callerAgent } from '../src/agents.js';
const method={steps:{write:{do:{kind:'agent',model:'writer'}}}};
const plain={steps:{write:{do:{kind:'agent',model:'default'}}}};

/** A PATH folder with fake agents. A signed-in agent answers its status command; a signed-out one exits 1. */
async function installed(t, agents) {
 const dir=await mkdtemp(join(tmpdir(),'method-agents-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [name,signedIn] of Object.entries(agents)){
  const status=name==='claude'?`echo '{"loggedIn": ${signedIn}}'`:signedIn?'echo "Logged in"':'exit 1';
  await writeFile(join(dir,name),`#!/bin/sh\n${status}\n`,{mode:0o700});
 }
 return dir;
}

test('the caller is Claude Code from CLAUDECODE or Codex from CODEX_THREAD_ID, and neither when both are set',()=>{
 assert.equal(callerAgent({CLAUDECODE:'1'}),'claude');
 assert.equal(callerAgent({CODEX_THREAD_ID:'task'}),'codex');
 assert.equal(callerAgent({CLAUDECODE:'1',CODEX_THREAD_ID:'task'}),undefined);
 assert.equal(callerAgent({}),undefined);
});

test('a step that names no model runs on the agent that started the run, before an installed one and before hosted models',async t=>{
 const PATH=await installed(t,{codex:true,claude:true});
 assert.equal((await resolveModels(plain,{}, {env:{PATH,CODEX_THREAD_ID:'task'},hostedModel:'x/y'})).default.backend,'codex');
 assert.equal((await resolveModels(plain,{}, {env:{PATH,CLAUDECODE:'1'},hostedModel:'x/y'})).default.backend,'claude');
 // A step model name with no profile uses the same default.
 assert.equal((await resolveModels(method,{}, {env:{PATH,CLAUDECODE:'1'},hostedModel:'x/y'})).writer.backend,'claude');
});

test('without a caller, an installed and signed-in agent is used: Claude Code when both are',async t=>{
 assert.equal(await localAgent({PATH:await installed(t,{codex:true,claude:true})}),'claude');
 assert.equal(await localAgent({PATH:await installed(t,{codex:true})}),'codex');
 assert.equal(await localAgent({PATH:await installed(t,{claude:true})}),'claude');
 // A signed-out agent is skipped.
 assert.equal(await localAgent({PATH:await installed(t,{codex:true,claude:false})}),'codex');
 // A caller that is not installed or not signed in is skipped too.
 assert.equal(await localAgent({PATH:await installed(t,{codex:true}),CLAUDECODE:'1'}),'codex');
 assert.equal(await localAgent({PATH:await installed(t,{codex:true,claude:false}),CLAUDECODE:'1'}),'codex');
});

test('every signed-in local agent is listed in the order of choice, the caller first',async t=>{
 assert.deepEqual(await localAgents({PATH:await installed(t,{codex:true,claude:true}),CODEX_THREAD_ID:'task'}),['codex','claude']);
 assert.deepEqual(await localAgents({PATH:await installed(t,{codex:true,claude:true})}),['claude','codex']);
 assert.deepEqual(await localAgents({PATH:await installed(t,{codex:false,claude:true})}),['claude']);
 assert.deepEqual(await localAgents({PATH:await installed(t,{claude:false})}),[]);
});

test('hosted models are used only when no local agent can run the step',async t=>{
 const none=await installed(t,{claude:false});
 assert.deepEqual((await resolveModels(plain,{}, {env:{PATH:none},hostedModel:'x/y'})).default,{backend:'method',model:'x/y'});
 assert.deepEqual((await resolveModels(plain,{}, {env:{},hostedModel:'x/y'})).default,{backend:'method',model:'x/y'});
 await assert.rejects(resolveModels(plain,{}, {env:{PATH:none}}),error=>error.code==='needs_input'&&!/--agent/.test(error.message)&&/Claude Code or Codex/.test(error.message));
});

test('an explicitly named model keeps its backend; a bare local-agent default follows the rule',async t=>{
 const PATH=await installed(t,{codex:true,claude:true});
 const env={PATH,CLAUDECODE:'1'};
 assert.deepEqual((await resolveModels({...method,models:{writer:'openai/gpt-x'}},{}, {env,hostedModel:'x/y'})).writer,{backend:'method',model:'openai/gpt-x'});
 assert.deepEqual((await resolveModels({...method,models:{writer:{agent:'codex',model:'gpt-5',reasoning_effort:'low'}}},{}, {env})).writer,{backend:'codex',model:'gpt-5',reasoning_effort:'low'});
 assert.equal((await resolveModels(method,{models:{writer:{backend:'openai-responses'}}},{env})).writer.backend,'openai-responses');
 assert.equal((await resolveModels(plain,{models:{default:{backend:'codex',command:'my-codex'}}},{env})).default.command,'my-codex');
 assert.equal((await resolveModels(plain,{models:{default:{backend:'codex'}}},{env})).default.backend,'claude');
 assert.equal((await resolveModels(plain,{models:{default:{backend:'claude'}}},{env:{PATH,CODEX_THREAD_ID:'task'}})).default.backend,'codex');
});

test('resume keeps the saved profiles',async()=>{
 assert.equal((await resolveModels(method,{}, {savedModels:{writer:{backend:'codex'}},env:{CLAUDECODE:'1'}})).writer.backend,'codex');
});

test('keeps the executable invocation path for virtual environments',async t=>{
 const {mkdtemp,symlink,rm}=await import('node:fs/promises');
 const {executable}=await import('../src/io.js');
 const root=await mkdtemp(join(tmpdir(),'method-executable-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const alias=join(root,'python');await symlink(process.execPath,alias);
 assert.equal(await executable(alias),alias);
});

test('classification and scripts do not prepare an unused agent', async () => {
 const method = {steps: {classify: {do: {kind: 'classify'}}, route: {do: {kind: 'run'}}}};
 assert.deepEqual(await resolveModels(method, {models: {default: {backend: 'codex'}}}, {env: {CODEX_THREAD_ID: 'outer'}}), {});
});
