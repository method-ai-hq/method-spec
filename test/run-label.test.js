import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMethod } from '../src/document.js';
import { runLabel } from '../src/run-label.js';
const method = {format:'method/3.1',name:'Greeting',goal:'Greet.',inputs:{person:{type:'text'}},steps:{greet:{ask:'Greet',out:{greeting:{type:'text'}}}},result:'greeting'};
test('run label declaration names a scalar input and is optional', () => {
  validateMethod(method);
  validateMethod({...method,run_label_input:'person'});
  assert.throws(() => validateMethod({...method,run_label_input:'missing'}), /run_label_input/);
  assert.throws(() => validateMethod({...method,inputs:{people:{type:'list',items:'text'}},run_label_input:'people'}), /run_label_input/);
});
test('labels use recorded values, never defaults or arbitrary object serialization', () => {
  const current = {...method,run_label_input:'person'};
  assert.equal(runLabel(current,{person:'  Alex\nChen  '}),'Alex Chen');
  assert.equal(runLabel(current,{person:''}),null);
  assert.equal(runLabel(current,{person:{name:'Alex'}}),null);
  assert.equal(runLabel({...current,inputs:{person:{type:'text',default:'Today'}}},{}),null);
  assert.equal(runLabel(method,{person:'Alex'}),null);
  for (const [type,value] of [['number',0],['boolean',false]]) {
    assert.equal(runLabel({...current,inputs:{person:{type}}},{person:value}),String(value));
  }
  assert.equal(runLabel(current,{person:'x'.repeat(200)}).length,160);
});
