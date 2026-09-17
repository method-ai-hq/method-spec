import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModels } from '../src/agents.js';
const method={steps:{write:{do:{kind:'agent',model:'writer'}}}};
test('uses caller and preserves explicit and resumed profiles',async()=>{
 assert.equal((await resolveModels(method,{}, {env:{CLAUDECODE:'1'}})).writer.backend,'claude');
 assert.equal((await resolveModels(method,{}, {env:{CODEX_THREAD_ID:'test'}})).writer.backend,'codex');
 assert.equal((await resolveModels(method,{models:{writer:{backend:'openai-responses'}}},{agent:'claude'})).writer.backend,'openai-responses');
 assert.equal((await resolveModels(method,{}, {savedModels:{writer:{backend:'codex'}},agent:'claude'})).writer.backend,'codex');
});

test('keeps the executable invocation path for virtual environments',async t=>{
 const {mkdtemp,symlink,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {executable}=await import('../src/io.js');
 const root=await mkdtemp(join(tmpdir(),'method-executable-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const alias=join(root,'python');await symlink(process.execPath,alias);
 assert.equal(await executable(alias),alias);
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function installed(t, names) {
 const dir=await mkdtemp(join(tmpdir(),'method-agents-'));
 const prior=process.env.PATH;process.env.PATH=dir;
 t.after(async()=>{process.env.PATH=prior;await rm(dir,{recursive:true,force:true});});
 for(const name of names)await writeFile(join(dir,name),'#!/bin/sh\nexit 99\n',{mode:0o700});
}

test('ambiguous callers with both agents require a choice even with an old preference',async t=>{
 await installed(t,['codex','claude']);
 await assert.rejects(resolveModels(method,{}, {env:{CLAUDECODE:'1',CODEX_THREAD_ID:'outer'},preference:'codex'}), {code:'needs_input'});
 await assert.rejects(resolveModels(method,{}, {env:{},preference:'claude'}), {code:'needs_input'});
});

test('an explicit agent selects unconfigured profiles ahead of caller and configured default',async()=>{
 assert.equal((await resolveModels(method,{models:{default:{backend:'codex'}}},{agent:'claude',env:{CODEX_THREAD_ID:'outer'}})).writer.backend,'claude');
 assert.equal((await resolveModels(method,{models:{default:{backend:'claude'}}},{env:{CODEX_THREAD_ID:'outer'}})).writer.backend,'codex');
 await assert.rejects(resolveModels(method,{}, {agent:'other'}),{code:'needs_input'});
});

test('uses the only available agent and requests setup when none is available',async t=>{
 await installed(t,['claude']);
 assert.equal((await resolveModels(method,{}, {env:{}})).writer.backend,'claude');
 await rm(join(process.env.PATH,'claude'));
 await assert.rejects(resolveModels(method,{}, {env:{}}),{code:'needs_input'});
});

test('never replaces a known caller with another installed agent',async t=>{
 await installed(t,['codex']);
 assert.equal((await resolveModels(method,{}, {env:{CLAUDECODE:'1'}})).writer.backend,'claude');
});

test('an incomplete saved selection cannot select a new provider',async()=>{
 await assert.rejects(resolveModels(method,{}, {savedModels:{},agent:'codex'}),{code:'resume_mismatch'});
});

 test('the default model follows the caller even when already configured',async()=>{
 const m={steps:{work:{do:{kind:'agent',model:'default'}}}};
 assert.equal((await resolveModels(m,{models:{default:{backend:'claude'}}},{env:{CODEX_THREAD_ID:'task'}})).default.backend,'codex');
 assert.equal((await resolveModels(m,{models:{default:{backend:'codex'}}},{env:{CLAUDECODE:'1'}})).default.backend,'claude');
 assert.equal((await resolveModels(m,{models:{default:{backend:'claude'}}},{agent:'codex',env:{CLAUDECODE:'1'}})).default.backend,'codex');
 });
