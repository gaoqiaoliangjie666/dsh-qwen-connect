import fs from 'node:fs';
const p = 'E:/software/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
console.log('=== foreignAssistant / toPiAssistant / appendAssistant ===');
for (let i = 200; i < 260 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i]}`);
console.log('\n--- appendAssistant @1150 ---');
for (let i = 1145; i < 1190 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i]}`);
