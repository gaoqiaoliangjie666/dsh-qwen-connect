import fs from 'node:fs';
const p = 'E:/software/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
for (let i = 1759; i < 1870 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i]}`);
