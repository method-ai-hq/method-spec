import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventTokens } from '../src/cases.js';

test('a case run counts the tokens that its Codex, Claude Code and hosted model work reported', () => {
  assert.equal(eventTokens([
    { event: 'codex.completed', usage: [{ input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 }, { input_tokens: 10, output_tokens: 5 }] },
    { event: 'agent.completed', usage: { input_tokens: 3, cache_read_input_tokens: 200, cache_creation_input_tokens: 20, output_tokens: 7 } },
    { event: 'model.response', usage: { input_tokens: 100, output_tokens: 10 } },
    { event: 'step.completed' },
  ]), 1065 + 230 + 110);
  assert.equal(eventTokens([{ event: 'codex.completed', usage: null }]), 0);
});
