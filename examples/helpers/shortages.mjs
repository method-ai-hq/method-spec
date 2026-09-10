let text = '';
for await (const chunk of process.stdin) text += chunk;
const { observation } = JSON.parse(text);
console.log(JSON.stringify({ shortages: Object.keys(observation).filter(key => observation[key] < 10) }));
