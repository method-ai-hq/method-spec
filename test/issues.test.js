import test from 'node:test';
import assert from 'node:assert/strict';
import { methodIssues, validateMethod, MethodValidationError } from '../src/index.js';

const codes = issues => issues.map(issue => issue.code);
const only = (issues, code) => issues.filter(issue => issue.code === code);

// A support desk Method: read a ticket, decide if it is urgent, and reply.
const triage = (change = () => {}) => {
  const method = {
    format: 'method/3.4', name: 'Ticket triage', goal: 'Reply to urgent support tickets the same day.',
    inputs: { ticket: { type: 'text', description: 'The ticket text.' } },
    environment: { mail: { type: 'service', description: 'The support mailbox.' } },
    steps: {
      urgent: { name: 'Is it urgent', in: { ticket: 'inputs.ticket' }, do: { kind: 'classify', question: 'Does this ticket need a reply today?', answer: 'yes_no' }, out: 'urgency' },
      gate: { name: 'Apply threshold', purpose: 'Return true when the probability of yes is at least 0.8.', in: { urgency: 'urgency' },
        do: { kind: 'run', runtime: 'node', entrypoint: 'threshold.mjs' }, out: { reply_now: { type: 'boolean', description: 'Whether to reply today.' } } },
      draft: { in: { ticket: 'inputs.ticket' }, when: 'reply_now', do: { kind: 'call', model: 'writer', prompt: 'Write a short reply to {{ticket}}.' }, out: { reply: { type: 'text' } } },
      send: { name: 'Send reply', purpose: 'Send the reply through the mailbox.', in: { reply: 'reply' }, do: { kind: 'run', runtime: 'node', entrypoint: 'send.mjs' },
        out: { message_id: { type: 'text', description: 'The sent message ID.' } }, changes: ['environment.mail'], no_effect_reason: 'The mailbox has no read access.' },
    },
    models: { writer: 'openai/gpt-6-luna' },
    result: 'message_id',
  };
  change(method);
  return method;
};

test('a clean Method has no issues', () => {
  assert.deepEqual(methodIssues(triage()), []);
});

test('format failures become one error issue with the same code, a fix, the step, and the line', () => {
  const text = 'format: method/3.4\nname: Notes\ngoal: Summarize notes.\nsteps:\n  summarize:\n    in: {notes: inputs.notes}\n    do: {kind: call, prompt: "Summarize {{notes}}."}\n    out: {summary: {type: text}}\nresult: summary\n';
  const [issue, ...rest] = methodIssues(text);
  assert.equal(rest.length, 0);
  assert.equal(issue.level, 'error'); assert.equal(issue.code, 'invalid_method'); assert.equal(issue.step, 'summarize');
  assert.match(issue.message, /Invalid reference path: inputs\.notes/); assert.equal(typeof issue.fix, 'string'); assert.ok(issue.fix.length > 10);
  assert.equal(issue.line, 5);
  // validateMethod throws the same first error.
  assert.throws(() => validateMethod(text), error => error instanceof MethodValidationError && error.code === 'invalid_method' && error.issue.step === 'summarize');
  // An existing specific code is kept.
  const prompt = methodIssues(triage(m => { m.steps.draft.do.prompt = 'Reply to {{customer}}.'; }));
  assert.deepEqual(codes(prompt), ['invalid_prompt']); assert.equal(prompt[0].step, 'draft');
  assert.equal(methodIssues({ ...triage(), format: 'method/9' })[0].code, 'unsupported_format');
  const shape = methodIssues(triage(m => { m.steps.draft.do.temperature = 1; }))[0];
  assert.equal(shape.code, 'invalid_method'); assert.equal(shape.step, 'draft'); assert.match(shape.message, /steps\.draft\.do/);
  assert.equal(methodIssues('a: [')[0].code, 'invalid_method');
});

test('every format error carries a fix sentence', () => {
  const broken = [
    m => { m.steps.gate.after = 'missing'; }, m => { m.steps.draft.when = 'urgency'; }, m => { m.steps.send.no_effect_reason = undefined; delete m.steps.send.no_effect_reason; },
    m => { m.steps.urgent.changes = ['state.x']; }, m => { m.steps.gate.after = 'send'; m.steps.send.in.flag = 'reply_now'; m.steps.gate.in.id = 'message_id'; },
  ];
  for (const change of broken) {
    const [issue] = methodIssues(triage(change));
    assert.equal(issue.level, 'error'); assert.ok(issue.fix && !issue.fix.includes('undefined'), issue.message);
  }
});

test('a known secret value in the document or an uploaded file is an error, and the value is never shown', () => {
  const token = 'sk-archive-4f9a1c2e7b';
  const doc = triage(m => { m.steps.draft.do.prompt = `Write a short reply to {{ticket}}. Use key ${token}.`; });
  const found = only(methodIssues(doc, { secretValues: { MAIL_TOKEN: token } }), 'secret_value');
  assert.equal(found.length, 1); assert.equal(found[0].level, 'error'); assert.equal(found[0].step, 'draft'); assert.equal(found[0].field, 'do.prompt');
  assert.match(found[0].message, /MAIL_TOKEN/); assert.equal(JSON.stringify(found).includes(token), false);
  const files = { 'send.mjs': `const key = process.env.MAIL_TOKEN;\nconst fallback = "${token}";\n`, 'threshold.mjs': 'console.log(1)' };
  const inFile = only(methodIssues(triage(), { secretValues: [token], files }), 'secret_value');
  assert.deepEqual(inFile.map(i => [i.file, i.line]), [['send.mjs', 2]]); assert.equal(JSON.stringify(inFile).includes(token), false);
  // No match, a value too short to check, and no values give nothing.
  assert.deepEqual(only(methodIssues(triage(), { secretValues: [token], files: { 'send.mjs': 'process.env.MAIL_TOKEN' } }), 'secret_value'), []);
  assert.deepEqual(only(methodIssues(triage(), { secretValues: ['reply'] }), 'secret_value'), []);
  assert.deepEqual(only(methodIssues(doc), 'secret_value'), []);
});

test('a missing secret is a warning in validate and an error for a run', () => {
  const doc = triage(m => { m.secrets = { MAIL_TOKEN: 'Sends mail from the support mailbox.' }; });
  assert.equal(only(methodIssues(doc, { availableSecrets: [] }), 'missing_secret')[0].level, 'warning');
  assert.equal(only(methodIssues(doc, { availableSecrets: [], phase: 'run' }), 'missing_secret')[0].level, 'error');
  assert.deepEqual(only(methodIssues(doc, { availableSecrets: ['MAIL_TOKEN'] }), 'missing_secret'), []);
  assert.deepEqual(only(methodIssues(doc), 'missing_secret'), []);
});

test('a classify result that gates a step or feeds a change directly gives a warning', () => {
  const gated = triage(m => { m.steps.draft.when = 'urgency.answer'; m.steps.gate.out.reply_now.description = 'Unused here.'; m.result = { id: 'message_id', now: 'reply_now' }; });
  const [warning] = only(methodIssues(gated), 'classify_without_threshold');
  assert.equal(warning.level, 'warning'); assert.equal(warning.step, 'draft'); assert.equal(warning.field, 'when'); assert.match(warning.message, /urgent/);
  const fed = triage(m => { m.steps.send.in.urgency = 'urgency'; });
  assert.deepEqual(only(methodIssues(fed), 'classify_without_threshold').map(i => [i.step, i.field]), [['send', 'in.urgency']]);
  // A threshold step between them is the fix.
  assert.deepEqual(only(methodIssues(triage()), 'classify_without_threshold'), []);
});

// A research Method: an agent reads web pages, then something posts the summary.
const research = (change = () => {}) => {
  const method = {
    format: 'method/3.4', name: 'Competitor watch', goal: 'Post a weekly summary of competitor pricing.',
    environment: { web: { type: 'browser', description: 'A signed-out browser.' }, chat: { type: 'service', description: 'The team chat.' } },
    steps: {
      read: { do: { kind: 'agent', prompt: 'Read the pricing pages and list each plan and price.', browser: 'environment.web' }, out: { plans: { type: 'list', items: 'text' } } },
      post: { name: 'Post summary', purpose: 'Post the plans to the team chat.', in: { plans: 'plans' }, do: { kind: 'run', runtime: 'node', entrypoint: 'post.mjs' },
        out: { posted: { type: 'boolean', description: 'Whether the post went out.' } }, changes: ['environment.chat'], no_effect_reason: 'The chat has no read API.' },
    },
    result: 'posted',
  };
  change(method);
  return method;
};

test('an agent with a browser that can change things gives a warning, decided only from declarations', () => {
  assert.deepEqual(only(methodIssues(research()), 'untrusted_content_can_act'), []);
  const both = research(m => { m.steps.read.changes = ['environment.chat']; m.steps.read.no_effect_reason = 'The chat has no read API.'; });
  const [warning] = only(methodIssues(both), 'untrusted_content_can_act');
  assert.equal(warning.step, 'read'); assert.match(warning.message, /environment\.web/); assert.match(warning.message, /environment\.chat/);
  // A tool named send_email with no declared effects does not count; the same tool with effects does.
  const named = research(m => { m.steps.read.do.tools = ['send_email']; });
  const tool = effects => ({ send_email: { description: 'Send an email.', connection: 'mail', tool: 'send', parameters: {}, effects } });
  assert.deepEqual(only(methodIssues(named), 'untrusted_content_can_act'), []);
  assert.deepEqual(only(methodIssues(named, { tools: tool([]) }), 'untrusted_content_can_act'), []);
  assert.match(only(methodIssues(named, { tools: tool(['mail']) }), 'untrusted_content_can_act')[0].message, /send_email/);
  // Without a browser, tools with effects are not untrusted content.
  const noBrowser = research(m => { delete m.steps.read.do.browser; m.steps.read.do.tools = ['send_email']; });
  assert.deepEqual(only(methodIssues(noBrowser, { tools: tool(['mail']) }), 'untrusted_content_can_act'), []);
});

test('an output that nothing uses gives a warning', () => {
  const doc = triage(m => { m.steps.draft.out.subject = { type: 'text' }; });
  const [warning] = only(methodIssues(doc), 'unused_output');
  assert.equal(warning.level, 'warning'); assert.equal(warning.step, 'draft'); assert.equal(warning.field, 'out.subject');
  // Used by the result, a when, a check, a repeat, or the run label: no warning.
  assert.deepEqual(only(methodIssues(triage(m => { m.steps.draft.out.subject = { type: 'text' }; m.result = { id: 'message_id', subject: 'subject' }; })), 'unused_output'), []);
  assert.deepEqual(only(methodIssues(triage(m => { m.steps.draft.out.subject = { type: 'text' }; m.run_label = 'steps.draft.outputs.subject'; })), 'unused_output'), []);
  const checked = triage(m => { m.steps.draft.out.ok = { type: 'boolean' }; m.steps.draft.check = { equals: { actual: 'ok', expected: 'ok' } }; });
  assert.deepEqual(only(methodIssues(checked), 'unused_output'), []);
  const classify = triage(m => { m.steps.draft.when = undefined; delete m.steps.draft.when; delete m.steps.gate; });
  assert.deepEqual(only(methodIssues(classify), 'unused_output').map(i => [i.step, i.field]), [['urgent', 'out']]);
});

test('an agent step with no tools and no browser gives a note', () => {
  const doc = triage(m => { m.steps.draft.do.kind = 'agent'; });
  const [note] = only(methodIssues(doc), 'agent_without_tools');
  assert.equal(note.level, 'note'); assert.equal(note.step, 'draft');
  assert.deepEqual(only(methodIssues(research()), 'agent_without_tools'), []);
  assert.deepEqual(only(methodIssues(triage(m => { m.steps.draft.do = { kind: 'agent', model: 'writer', prompt: 'Write a reply to {{ticket}}.', tools: ['lookup_order'] }; })), 'agent_without_tools'), []);
});

test('a check that repeats the output type gives a note', () => {
  assert.equal(only(methodIssues(triage(m => { m.steps.draft.check = { present: 'reply' }; })), 'check_repeats_output_type')[0].step, 'draft');
  assert.equal(only(methodIssues(research(m => { m.steps.read.check = { count: { value: 'plans' } }; })), 'check_repeats_output_type').length, 1);
  assert.deepEqual(only(methodIssues(research(m => { m.steps.read.check = { count: { value: 'plans', min: 1 } }; })), 'check_repeats_output_type'), []);
  assert.deepEqual(only(methodIssues(research(m => { m.steps.read.check = { present: 'plans.0' }; })), 'check_repeats_output_type'), []);
});

test('accept marks a warning or note and keeps it; an accept that no longer fires gives a note; errors stay', () => {
  const doc = triage(m => { m.steps.draft.do.kind = 'agent'; m.steps.draft.accept = { agent_without_tools: 'The agent backend adds its own tools.' }; });
  const [accepted] = only(methodIssues(doc), 'agent_without_tools');
  assert.equal(accepted.accepted, 'The agent backend adds its own tools.');
  const stale = triage(m => { m.steps.draft.accept = { agent_without_tools: 'Was an agent once.' }; });
  const [note] = only(methodIssues(stale), 'accept_unused');
  assert.equal(note.level, 'note'); assert.equal(note.step, 'draft'); assert.equal(note.field, 'accept.agent_without_tools');
  assert.deepEqual(only(methodIssues(stale, { notChecked: ['agent_without_tools'] }), 'accept_unused'), []);
  // Issues from other checks (model checks) are accepted too.
  const modelCheck = { code: 'prompt_multiple_tasks', level: 'warning', step: 'draft', message: 'The prompt asks for two things.', fix: 'Split the step.' };
  const withModel = triage(m => { m.steps.draft.accept = { prompt_multiple_tasks: 'The user wants one combined reply.' }; });
  assert.equal(only(methodIssues(withModel, { issues: [modelCheck] }), 'prompt_multiple_tasks')[0].accepted, 'The user wants one combined reply.');
  // An error is never accepted.
  const secret = triage(m => { m.steps.draft.do.prompt = 'Write a reply to {{ticket}} with key sk-archive-4f9a1c2e7b.'; m.steps.draft.accept = { secret_value: 'Test key.' }; });
  const [error] = only(methodIssues(secret, { secretValues: ['sk-archive-4f9a1c2e7b'] }), 'secret_value');
  assert.equal(error.accepted, undefined);
  // Errors come first, notes last.
  const levels = methodIssues(triage(m => { m.steps.draft.do.kind = 'agent'; m.steps.draft.out.subject = { type: 'text' }; }), { secretValues: ['Write a short reply'] }).map(i => i.level);
  assert.deepEqual(levels, ['error', 'warning', 'note']);
});
