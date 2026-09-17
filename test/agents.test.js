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
