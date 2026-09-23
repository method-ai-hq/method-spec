import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMethod } from '../src/document.js';
import { runLabel } from '../src/run-label.js';
const method = {format:'method/3.1',name:'Reflection',goal:'Review a day.',inputs:{target:{type:'text',default:''}},steps:{prepare:{ask:'Select the day',out:{plan:{type:'record',fields:{date:'text'}}}}},result:'plan'};

test('labels select declared scalar inputs or nested step outputs', () => {
  validateMethod(method);
  for (const run_label of ['inputs.target','steps.prepare.outputs.plan.date']) validateMethod({...method,run_label});
  for (const run_label of ['inputs.missing','steps.missing.outputs.plan.date','steps.prepare.outputs.plan','steps.prepare.outputs.plan.missing','state.target','steps.prepare.inputs.target','inputs.constructor']) {
    assert.throws(() => validateMethod({...method,run_label}));
  }
  assert.throws(() => validateMethod({...method,run_label_input:'target'}));
  for (const extra of [{each:{target:'inputs.target'}},{repeat:{max_iterations:2,until:'plan.date'}}]) {
    assert.throws(() => validateMethod({...method,steps:{prepare:{...method.steps.prepare,...extra}},run_label:'steps.prepare.outputs.plan.date'}), /repeated step/);
  }
});
test('input labels use recorded values, never defaults or arbitrary object serialization', () => {
  const current = {...method,run_label:'inputs.target'};
  assert.equal(runLabel(current,{inputs:{target:'  Alex\nChen  '}}),'Alex Chen');
  for (const target of ['', '  ', {name:'Alex'}, null, 3]) assert.equal(runLabel(current,{inputs:{target}}),null);
  assert.equal(runLabel({...current,inputs:{target:{type:'text',default:'Today'}}},{inputs:{}}),null);
  assert.equal(runLabel(method,{inputs:{target:'Alex'}}),null);
  for (const [type,value] of [['number',0],['boolean',false]]) {
    assert.equal(runLabel({...current,inputs:{target:{type}}},{inputs:{target:value}}),String(value));
  }
  assert.equal(runLabel(current,{inputs:{target:'x'.repeat(200)}}).length,160);
});
test('past runs with blank target use the date saved by preparation', () => {
  const current = {...method,run_label:'steps.prepare.outputs.plan.date'};
  const invocation = {step_id:'prepare',outputs:{plan:{date:'2026-09-22'}}};
  const run = {workflow:method,inputs:{target:''},invocations:{'prepare:0':invocation}};
  const original = JSON.stringify(run);
  assert.equal(runLabel(current,run),'2026-09-22');
  assert.equal(JSON.stringify(run),original);
  assert.equal(runLabel(current,{inputs:{target:'2026-09-23'},invocations:{}}),null);
  assert.equal(runLabel(current,{invocations:{'prepare:0':{step_id:'prepare'}}}),null);
  assert.equal(runLabel(current,{invocations:{'prepare:0':{step_id:'prepare',outputs:{plan:{date:42}}}}}),null);
  assert.equal(runLabel(current,{invocations:{'prepare:0':invocation,'prepare:1':invocation}}),null);
  assert.equal(runLabel(current,{invocations:{'other:0':{...invocation,step_id:'other'}}}),null);
});
