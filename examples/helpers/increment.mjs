let text = '';
for await (const chunk of process.stdin) text += chunk;
console.log(JSON.stringify({ result: JSON.parse(text).value + 1 }));
