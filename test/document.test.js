import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {parseDocumentValue, validateMethod, shapeErrors, MethodValidationError} from '../src/document.js';
import {assertSchema, dataSchema} from '../src/validate.js';
import info from '../package.json' with {type:'json'};
const base = {format:'method/3.1',name:'Test',goal:'Check a document.',steps:{ask:{ask:'Answer.',out:{answer:{type:'text'}}}},result:'answer'};
test('browser-safe file validation matches executor output validation', () => {
  for(const value of [{path:'x'},{path:'x',sha256:'0'.repeat(64)},{path:'x',sha256:'wrong'},{path:'x',sha256:'0'.repeat(64),extra:true},null]) {
    let accepted=true;try{assertSchema(dataSchema('file'),value,'file');}catch{accepted=false;}
    assert.equal(shapeErrors('file',value).length===0,accepted);
    const method={...base,inputs:{file:{type:'file',default:value}}};
    if(accepted)validateMethod(method);else assert.throws(()=>validateMethod(method),MethodValidationError);
  }
});
test('shared parser preserves text and accepts bounded aliases', () => {
  assert.equal(validateMethod({...base,run_prompt:'  Keep spaces.  '}).method.run_prompt,'  Keep spaces.  ');
  assert.deepEqual(parseDocumentValue('a: &value {type: text}\nb: *value'),{a:{type:'text'},b:{type:'text'}});
  assert.throws(()=>parseDocumentValue('a: 1\na: 2'),MethodValidationError);
  assert.throws(()=>parseDocumentValue('x'.repeat(2_000_001)),MethodValidationError);
});
test('unsupported formats have a typed validation code', () => {
  for (const format of ['method/2', 'method/3', 'workflow/2']) assert.throws(()=>validateMethod({...base,format}),error=>error instanceof MethodValidationError&&error.code==='unsupported_format');
});
test('contributor harness reports package version and accepts agent choice', () => {
  assert.match(execFileSync(process.execPath,['src/cli.js','--version'],{encoding:'utf8'}),new RegExp(info.version.replaceAll('.','\\.')));
  assert.match(execFileSync(process.execPath,['src/cli.js','--agent','claude','--help'],{encoding:'utf8'}),/--agent/);
});

test('schema errors name the field and give a hint for a comma in a flow map', () => {
  const comma = { format: 'method/3.3', name: 'x', goal: 'y', steps: { read: { name: 'R', purpose: 'p', do: { kind: 'run', runtime: 'node', entrypoint: 'r.mjs' }, out: { material: { type: 'text', description: 'All source texts', 'each headed by its file name.': null } } } }, result: 'material' };
  assert.throws(() => validateMethod(comma), /steps\.read\.out\.material: the text "each headed by its file name\." became a separate field\. A value inside \{ \} that contains a comma must be quoted/);
  const wrong = { format: 'method/3.3', name: 'x', goal: 'y', environment: { web: { type: 'service', description: 'd' } }, steps: { send: { name: 'S', purpose: 'p', do: { kind: 'run', runtime: 'node', entrypoint: 's.mjs' }, out: { r: { type: 'text', description: 'd' } }, changes: ['environment.web'], effects: { e: { intent: 'i', observe: { kind: 'http', path: '/x', expect: { fieldz: { a: 1 } } } } } } }, result: 'r' };
  assert.throws(() => validateMethod(wrong), error => error.message === 'Method: steps.send.effects.e.observe.expect: unknown field "fieldz"; steps.send.effects.e.observe.expect: missing field "fields"');
  const alias = { format: 'method/3.3', name: 'x', goal: 'y', inputs: { notes: { type: 'text' } }, steps: { read: { name: 'R', purpose: 'p', in: { notes: 'inputs.notes' }, do: { kind: 'run', runtime: 'node', entrypoint: 'r.mjs' }, out: { notes: { type: 'text', description: 'd' } } } }, result: 'notes' };
  assert.throws(() => validateMethod(alias), /read\.in\.notes: this step also has an output named notes/);
});
