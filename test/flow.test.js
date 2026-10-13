import test from 'node:test';
import assert from 'node:assert/strict';
import { methodIssues, methodProofs, applyEdits, validateMethod } from '../src/index.js';

const only = (issues, code) => issues.filter(issue => issue.code === code);
const reaches = (doc, options) => only(methodIssues(doc, options), 'untrusted_reaches_action');

// An agent reads web pages, a model drafts a message from what it found, and a script sends the message.
const outreach = (change = () => {}) => {
  const method = {
    format: 'method/3.4', name: 'Outreach', goal: 'Send one message about what the web pages say.',
    environment: { web: { type: 'browser', description: 'A signed-out browser.' }, email: { type: 'service', description: 'Outgoing mail.' } },
    steps: {
      discover: { do: { kind: 'agent', prompt: 'Read the pages and list what you find.', browser: 'environment.web' }, out: { findings: { type: 'text' } } },
      draft: { in: { findings: 'findings' }, do: { kind: 'call', prompt: 'Write a short message about {{findings}}.' }, out: { message: { type: 'text' } } },
      send: { name: 'Send message', in: { message: 'message' }, do: { kind: 'run', runtime: 'python', entrypoint: 'send.py' },
        out: { receipt: { type: 'text' } }, changes: ['environment.email'], no_effect_reason: 'The mailbox has no read access.' },
    },
    result: 'receipt',
  };
  change(method);
  return method;
};

test('web text that reaches a send through two steps is a warning with its path', () => {
  const [found, ...rest] = reaches(outreach());
  assert.equal(rest.length, 0);
  assert.equal(found.level, 'warning'); assert.equal(found.step, 'send'); assert.equal(found.field, 'in.message');
  assert.deepEqual(found.path, ['discover.findings', 'draft.message']);
  assert.equal(found.message, 'Text from discover (environment.web) can reach send, which changes email, without a question to you.');
  assert.equal(found.fix, 'Add a question before send, or pass only a choice or a number from the reading step.');
  assert.deepEqual(methodProofs(outreach()), []);
});

test('the patch asks the person before the send; the patched Method validates and the warning is gone', () => {
  const [found] = reaches(outreach());
  assert.equal(found.patch.safety, 'behavioral');
  const patched = applyEdits(outreach(), found.patch.edits);
  validateMethod(patched);
  assert.deepEqual(Object.keys(patched.steps), ['discover', 'draft', 'confirm_send', 'send']);
  assert.deepEqual(patched.steps.confirm_send.in, { message: 'message' });
  assert.match(patched.steps.confirm_send.ask, /\{\{message\}\}/);
  assert.equal(patched.steps.send.when, 'send_approved');
  assert.deepEqual(reaches(patched), []);
  assert.deepEqual(methodIssues(patched).filter(issue => issue.level !== 'note'), []);
  assert.deepEqual(methodProofs(patched), [{ code: 'no_untrusted_action', statement: 'Text from web pages cannot reach a step that sends or changes things without a question to you.' }]);
  // The input document is not changed.
  assert.equal(outreach().steps.send.when, undefined);
});

test('a classify step, an ask step, or a number or boolean output stops the text', () => {
  const classified = outreach(m => {
    m.steps.draft = { in: { findings: 'findings' }, do: { kind: 'classify', question: 'Should we write to them?', answer: 'yes_no' }, out: 'worth_it' };
    m.steps.send.in = { worth_it: 'worth_it' };
  });
  assert.deepEqual(reaches(classified), []);
  const asked = outreach(m => { m.steps.draft = { in: { findings: 'findings' }, ask: 'Write the message about {{findings}}.', out: { message: { type: 'text' } } }; });
  assert.deepEqual(reaches(asked), []);
  const counted = outreach(m => { m.steps.draft.out = { message: { type: 'number' } }; });
  assert.deepEqual(reaches(counted), []);
  const numbersOnly = outreach(m => { m.steps.draft.out = { message: { type: 'record', fields: { score: 'number', ok: 'boolean' } } }; });
  assert.deepEqual(reaches(numbersOnly), []);
  // A record with a text field keeps the label; a number field of it does not.
  const mixed = outreach(m => { m.steps.draft.out = { message: { type: 'record', fields: { score: 'number', body: 'text' } } }; });
  assert.deepEqual(reaches(mixed)[0]?.path, ['discover.findings', 'draft.message']);
  const scoreOnly = outreach(m => { m.steps.draft.out = { message: { type: 'record', fields: { score: 'number', body: 'text' } } }; m.steps.send.in = { score: 'message.score' }; });
  assert.deepEqual(reaches(scoreOnly), []);
  // Each proves that web text cannot reach the send.
  for (const doc of [classified, asked, counted]) assert.equal(methodProofs(doc)[0]?.code, 'no_untrusted_action');
});

test('text also travels through each, when, and state', () => {
  const each = outreach(m => {
    m.steps.draft.out = { messages: { type: 'list', items: 'text' } };
    m.steps.send.in = {}; m.steps.send.each = { message: 'messages' };
  });
  assert.equal(reaches(each)[0].field, 'each.message');
  const state = outreach(m => {
    m.state = { last: { type: 'text', default: '' } };
    m.steps.draft.changes = ['state.last'];
    m.steps.send.in = { message: 'message', last: 'state.last' };
  });
  assert.equal(reaches(state).length, 1);
});

test('one step that reads web pages and changes things is the same warning, with a path of one and no patch', () => {
  const both = outreach(m => { m.steps.discover.changes = ['environment.email']; m.steps.discover.no_effect_reason = 'The mailbox has no read access.'; });
  const found = reaches(both).find(issue => issue.step === 'discover');
  assert.deepEqual(found.path, ['environment.web']); assert.equal(found.field, 'do');
  assert.match(found.message, /discover reads text from environment\.web and changes email in the same step/);
  assert.match(found.fix, /^Split discover/); assert.equal(found.patch, undefined);
  // A tool counts only by its declared effects, never by its name.
  const tooled = outreach(m => { m.steps.discover.do.tools = ['send_email']; });
  const tool = effects => ({ send_email: { description: 'Send an email.', connection: 'email', tool: 'send', parameters: {}, effects } });
  assert.equal(reaches(tooled, { tools: tool([]) }).some(issue => issue.step === 'discover'), false);
  assert.match(reaches(tooled, { tools: tool(['email']) }).find(issue => issue.step === 'discover').message, /uses send_email/);
  // Document tools count as well.
  const ownTool = outreach(m => { m.steps.discover.do.tools = ['send_email']; m.tools = tool(['email']); });
  assert.ok(reaches(ownTool).some(issue => issue.step === 'discover'));
});

test('a step that reads a service connection it does not change is a source', () => {
  const inbox = outreach(m => {
    m.environment.inbox = { type: 'service', description: 'Incoming mail.' };
    m.steps.discover = { in: { inbox: 'environment.inbox' }, do: { kind: 'run', runtime: 'python', entrypoint: 'fetch.py' }, out: { findings: { type: 'text' } } };
  });
  const [found] = reaches(inbox);
  assert.match(found.message, /Text from discover \(environment\.inbox\)/);
  // The send binds the email connection that it changes: that is not a read.
  const binds = outreach(m => { delete m.steps.discover.do.browser; m.steps.send.in.email = 'environment.email'; });
  assert.deepEqual(reaches(binds), []);
});

test('a Method with no acting step has no warning and no proof; one without a source has no proof', () => {
  const reading = outreach(m => { delete m.steps.send.changes; delete m.steps.send.no_effect_reason; });
  assert.deepEqual(reaches(reading), []);
  assert.deepEqual(methodProofs(reading), []);
  const noSource = outreach(m => { delete m.steps.discover.do.browser; });
  assert.deepEqual(reaches(noSource), []);
  assert.deepEqual(methodProofs(noSource), []);
  assert.deepEqual(methodProofs('not: [valid'), []);
});

test('an existing when on the acting step keeps the warning but gives no patch', () => {
  const conditional = outreach(m => {
    m.inputs = { go: { type: 'boolean', default: true } };
    m.steps.send.when = 'inputs.go';
  });
  const [found] = reaches(conditional);
  assert.equal(found.step, 'send'); assert.equal(found.patch, undefined);
});

test('an old accept of untrusted_content_can_act gives the usual accept_unused note', () => {
  const old = outreach(m => { m.steps.send.accept = { untrusted_content_can_act: 'Reviewed.' }; });
  const [note] = only(methodIssues(old), 'accept_unused');
  assert.equal(note.step, 'send'); assert.equal(note.field, 'accept.untrusted_content_can_act');
  const accepted = outreach(m => { m.steps.send.accept = { untrusted_reaches_action: 'A person reads every draft first.' }; });
  assert.equal(reaches(accepted)[0].accepted, 'A person reads every draft first.');
  assert.deepEqual(methodProofs(accepted), []);
});

test('applyEdits sets, removes, and inserts steps, and refuses bad edits', () => {
  const doc = { steps: { a: { x: 1 }, b: { y: 2 } } };
  const out = applyEdits(doc, [
    { op: 'set', path: ['steps', 'a', 'when'], value: 'ok' }, { op: 'remove', path: ['steps', 'b', 'y'] },
    { op: 'insert_step', before: 'b', id: 'c', step: { z: 3 } }, { op: 'set', path: ['limits', 'step', 'timeout_ms'], value: 5 },
  ]);
  assert.deepEqual(out, { steps: { a: { x: 1, when: 'ok' }, c: { z: 3 }, b: {} }, limits: { step: { timeout_ms: 5 } } });
  assert.deepEqual(doc, { steps: { a: { x: 1 }, b: { y: 2 } } });
  for (const edit of [{ op: 'remove', path: ['steps', 'a', 'none'] }, { op: 'insert_step', before: 'zz', id: 'd', step: {} },
    { op: 'insert_step', before: 'b', id: 'a', step: {} }, { op: 'set', path: ['__proto__', 'x'], value: 1 }, { op: 'move' }]) {
    assert.throws(() => applyEdits(doc, [edit]), error => error.code === 'invalid_edit');
  }
});
