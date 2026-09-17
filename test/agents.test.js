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
