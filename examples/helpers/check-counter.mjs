let text = '';
for await (const chunk of process.stdin) text += chunk;
const { inputs, outputs, state_before, state_after } = JSON.parse(text);
const correct = outputs.current === state_before.count + 1 && state_after.count === outputs.current && outputs.done === (outputs.current >= inputs.target);
console.log(JSON.stringify({ status: correct ? 'pass' : 'fail', reason: 'Compare the observed count and state transition.', evidence: [] }));
