let text = '';
for await (const chunk of process.stdin) text += chunk;
const { count, target } = JSON.parse(text);
const next = count + 1;
console.log(JSON.stringify({ current: next, done: next >= target, state: { count: next } }));
