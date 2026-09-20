import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMethod, validateMethod, validateConfig, effectiveOutputs} from '../src/index.js';
import {validateClassification} from '../src/classification.js';
import {preflight} from '../src/preflight.js';

const identity = {provider: 'typesafe', model: 'jev-fixture'};
const doc = () => ({format: 'method/3.2', name: 'Route', goal: 'Choose a team.',
  inputs: {message: {type:'text'}}, steps: {classify: {name:'Classify message', in:{message:'inputs.message'},
    do:{kind:'classify', question:'What does {{message}} mean?', options:{billing:'Invoices', other:'Anything else'}}, out:'category'}}, result:'category'});
const answer = (p = .5) => ({...identity, choice:'billing', probabilities:{billing:p, other:1-p}, confidence:0, usage:null});
async function fixture(t, method = doc(), files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'method-classify-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  for (const [name, code] of Object.entries(files)) await writeFile(join(root,name),code);
  const file=join(root,'test.method'); await writeFile(file,JSON.stringify(method));
  const runDir=join(root,'run');
  const cfg={classification:identity,allow_local_processes:true,runtimes:{node:{command:process.execPath,version:process.version}}};
  const provider={resolve:async()=>identity,evaluate:async()=>answer()};
  return {root, file,runDir,cfg,provider,
    run:(options={},config=cfg)=>runMethod(file,config,{runDir,inputs:{message:'Invoice'},classification:provider,...options}),
    read:async name=>JSON.parse(await readFile(join(runDir,name),'utf8')),
    events:async()=> (await readFile(join(runDir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)};
}
test('classification derives output fields and preserves literal questions', async t=>{
  const m=doc();m.result='category.probabilities.billing';
  assert.equal(effectiveOutputs(m.steps.classify).category.fields.probabilities.fields.billing,'number');
  const f=await fixture(t,m);let calls=0;
  f.provider.evaluate=async request=>{calls++;assert.equal(request.question,m.steps.classify.do.question);assert.deepEqual(request.inputs,{message:'Invoice'});return answer();};
  const r=await f.run();assert.equal(r.status,'completed');assert.equal(r.result,.5);assert.equal(calls,1);assert.equal(r.model_requests,1);
  const events=await f.events();assert.equal(events.filter(e=>e.event==='prompt.rendered').length,0);
  assert.equal(events.find(e=>e.event==='model.response').confidence,0);
  assert.equal(r.usage.responses_without_usage,1);
});
test('new descriptions are required while historical scripts still validate', ()=>{
  const m={format:'method/3.1',name:'Script',goal:'Test',steps:{s:{do:{kind:'run',runtime:'node',entrypoint:'a.mjs'},out:{n:{type:'number'}}}},result:'n'};
  validateMethod(m);m.format='method/3.2';assert.throws(()=>validateMethod(m),/name/);
  m.steps.s.name='Calculate';assert.throws(()=>validateMethod(m),/purpose/);
  m.steps.s.purpose='Calculate n.';assert.throws(()=>validateMethod(m),/description/);
  m.steps.s.out.n.description='The number.';validateMethod(m);
  m.steps.s.check=m.steps.s.do;assert.throws(()=>validateMethod(m),/reading.check/);
  m.steps.s.reading={check:'Compare the result.'};validateMethod(m);
});
test('invalid classifier definitions and nested files fail before execution', ()=>{
  for(const edit of [
    m=>m.format='method/3.1', m=>m.steps.classify.name=' ', m=>m.steps.classify.do.question=' ',
    m=>m.steps.classify.do.options.other=' ', m=>delete m.steps.classify.do.options.other,
    m=>m.steps.classify.do.options=Object.fromEntries(Array.from({length:256},(_,i)=>['x'+i,'Option'])),
    m=>m.steps.classify.do.options.constructor='bad',m=>m.steps.classify.do.model='default',
    m=>delete m.steps.classify.in,m=>m.steps.classify.out={category:{type:'text'}},
    m=>m.steps.classify.changes=['state.x'],m=>m.steps.second=structuredClone(m.steps.classify),
    m=>m.inputs.message={type:'record',fields:{files:{type:'list',items:'file'}}},
  ]) {const m=doc();edit(m);assert.throws(()=>validateMethod(m));}
});
test('response validation rejects malformed results and preserves tied maxima', ()=>{
  for(const edit of [
    a=>a.probabilities.other=-1,a=>a.probabilities.billing=NaN,a=>delete a.probabilities.other,
    a=>a.probabilities.extra=0,a=>a.probabilities.other=.6,a=>a.choice='absent',
    a=>{a.probabilities.billing=.2;a.probabilities.other=.8;},a=>a.confidence=Infinity,
    a=>a.model='changed',a=>a.usage={input_tokens:-1,output_tokens:1},a=>a.extra=true,
  ]) {const a=answer();edit(a);assert.throws(()=>validateClassification(a,doc().steps.classify.do.options,identity));}
  const tied=answer();assert.equal(validateClassification(tied,doc().steps.classify.do.options,identity).choice,'billing');
  const within=answer();within.probabilities.other+=1e-7;validateClassification(within,doc().steps.classify.do.options,identity);
});
test('preflight reports managed setup without inference or agent setup', async t=>{
  const f=await fixture(t);const r=await preflight(doc(),{},f.root,{allowMissingSetup:true});
  assert.equal(r.missingSetup.length,1);assert.match(r.missingSetup[0],/Classification/);
});
test('each preserves order and empty each sends no requests', async t=>{
  for(const items of [[],['a','b']]) {
    const m=doc();m.inputs={items:{type:'list',items:'text'}};delete m.steps.classify.in;m.steps.classify.each={message:'inputs.items'};
    const f=await fixture(t,m);const seen=[];f.provider.evaluate=async r=>{seen.push(r.inputs.message);return answer();};
    const r=await f.run({inputs:{items}});assert.equal(r.status,'completed');assert.deepEqual(seen,items);assert.equal(r.result.length,items.length);
  }
});
test('limits prevent dispatch and oversized inputs fail',async t=>{
  const f=await fixture(t);let calls=0;f.provider.evaluate=async()=>{calls++;return answer();};
  assert.equal((await f.run({}, {...f.cfg,limits:{max_model_requests:0}})).code,'model_limit');assert.equal(calls,0);
  const g=await fixture(t);assert.equal((await g.run({inputs:{message:'x'.repeat(65536)}})).code,'input_limit');
});
test('timeout rejects late provider answers without retry',async t=>{
  const m=doc();m.steps.classify.limits={timeout_ms:20};const f=await fixture(t,m);let calls=0;
  f.provider.evaluate=async()=>{calls++;await new Promise(r=>setTimeout(r,100));return answer();};
  const r=await f.run();assert.equal(r.code,'timeout');assert.equal(calls,1);
  assert.equal((await f.events()).some(e=>e.event==='step.accepted'),false);
});
test('resume reuses accepted classification and enforces saved model identity',async t=>{
  const m=doc();m.steps.confirm={after:'classify',ask:'Continue?',out:{ok:{type:'boolean'}}};
  const f=await fixture(t,m);let calls=0;f.provider.evaluate=async()=>{calls++;return answer();};
  assert.equal((await f.run()).status,'needs_input');
  assert.equal((await f.run({resume:true,inputs:undefined,human:{steps:{'confirm:0':{outputs:{ok:true}}}}})).status,'completed');
  assert.equal(calls,1);
  await assert.rejects(f.run({resume:true,inputs:undefined},{...f.cfg,classification:{...identity,model:'other'}}),/configuration changed/);
});
test('provider failure is one attempt; explicit retry consumes another request',async t=>{
  const f=await fixture(t);let calls=0;f.provider.evaluate=async()=>{calls++;throw new Error('Service unavailable');};
  assert.equal((await f.run()).status,'failed');assert.equal(calls,1);
  f.provider.evaluate=async()=>{calls++;return answer();};
  const r=await f.run({resume:true,inputs:undefined,retry:['classify:0']});assert.equal(r.status,'completed');assert.equal(calls,2);
  const requests=(await f.events()).filter(e=>e.event==='model.request');assert.notEqual(requests[0].request_id,requests[1].request_id);
});
test('operation IDs distinguish phases and survive failed-check retry',async t=>{
  const m={format:'method/3.2',name:'ID',goal:'Test recovery',steps:{work:{name:'Read operation ID',purpose:'Return the operation ID.',do:{kind:'run',runtime:'node',entrypoint:'action.mjs'},out:{id:{type:'text',description:'Operation ID.'}},check:{kind:'run',runtime:'node',entrypoint:'check.mjs'},reading:{check:'Check the ID.'}}},result:'id'};
  const f=await fixture(t,m,{'action.mjs':'console.log(JSON.stringify({id:process.env.METHOD_OPERATION_ID}))',
    'check.mjs':"console.log(JSON.stringify({status:'fail',reason:process.env.METHOD_OPERATION_ID,evidence:[]}))"});
  await f.run({inputs:{}});await f.run({resume:true,inputs:undefined,retry:['work:0']});
  const started=(await f.events()).filter(e=>e.event==='process.started');
  assert.equal(started[0].operation_id,started[2].operation_id);assert.equal(started[1].operation_id,started[3].operation_id);
  assert.notEqual(started[0].operation_id,started[1].operation_id);
  assert.match(started[0].operation_id,/^mop_[a-f0-9]{64}$/);
  const g=await fixture(t,m,{'action.mjs':'console.log(JSON.stringify({id:process.env.METHOD_OPERATION_ID}))','check.mjs':"console.log(JSON.stringify({status:'pass',reason:'ok',evidence:[]}))"});
  const other=await g.run({inputs:{}});assert.notEqual(other.result,started[0].operation_id);
  assert.throws(()=>validateConfig({runtimes:{node:{command:'node',version:'22',env:['METHOD_OPERATION_ID']}}}),/reserved/);
});

test('explicit cancellation stops classification without accepting a late answer', async t=>{
  const f=await fixture(t); const controller=new AbortController(); let calls=0;
  f.provider.evaluate=async (_request,signal)=>{
    calls++; controller.abort(new Error('Operator cancelled'));
    assert.equal(signal.aborted,true);
    return answer();
  };
  const result=await f.run({signal:controller.signal});
  assert.equal(result.status,'failed'); assert.equal(calls,1);
  assert.equal((await f.events()).some(event=>event.event==='step.accepted'),false);
});
test('script iterations receive distinct stable operation IDs',async t=>{
  const method={format:'method/3.2',name:'Iterations',goal:'Record each operation ID.',inputs:{items:{type:'list',items:'text'}},steps:{work:{name:'Record ID',purpose:'Returns the operation ID for this item.',each:{item:'inputs.items'},do:{kind:'run',runtime:'node',entrypoint:'action.mjs'},out:{id:{type:'text',description:'The operation ID.'}}}},result:'id'};
  const f=await fixture(t,method,{'action.mjs':'console.log(JSON.stringify({id:process.env.METHOD_OPERATION_ID}))'});
  const result=await f.run({inputs:{items:['first','second']}});
  assert.equal(result.status,'completed'); assert.equal(result.result.length,2);
  assert.notEqual(result.result[0],result.result[1]);
  const resumed=await f.run({resume:true,inputs:undefined});
  assert.deepEqual(resumed.result,result.result);
  assert.equal((await f.events()).filter(event=>event.event==='process.started').length,2);
});
