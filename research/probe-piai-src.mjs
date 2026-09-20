import fs from 'node:fs';
const p = 'E:/software/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
console.log('total lines:', lines.length);
console.log('\n=== profileOf ===');
for (let i = 1675; i < 1720 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i]}`);
console.log('\n=== prepareCall / stream ===');
for (let i = 1720; i < 1820 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i]}`);
