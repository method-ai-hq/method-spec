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
  assert.throws(()=>validateMethod({...base,format:'method/2'}),error=>error instanceof MethodValidationError&&error.code==='unsupported_format');
});
test('contributor harness reports package version and accepts agent choice', () => {
  assert.match(execFileSync(process.execPath,['src/cli.js','--version'],{encoding:'utf8'}),new RegExp(info.version.replaceAll('.','\\.')));
  assert.match(execFileSync(process.execPath,['src/cli.js','--agent','claude','--help'],{encoding:'utf8'}),/--agent/);
});
