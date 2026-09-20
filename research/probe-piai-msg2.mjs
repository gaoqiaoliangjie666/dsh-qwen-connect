import fs from 'node:fs';
const p = 'E:/software/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const src = fs.readFileSync(p, 'utf8');
const lines = src.split(/\r?\n/);

// 找 foreignAssistant 定义
const idx = lines.findIndex((l) => /function foreignAssistant/.test(l));
console.log('foreignAssistant @', idx + 1);
for (let i = idx; i < idx + 30 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i]}`);

// 找 appendAssistant
const ai = lines.findIndex((l) => /function appendAssistant/.test(l));
console.log('\nappendAssistant @', ai + 1);
for (let i = ai; i < ai + 30 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i]}`);

// 找 textOnlyContext 里的消息处理
const ti = lines.findIndex((l) => /function textOnlyContext/.test(l));
console.log('\ntextOnlyContext @', ti + 1);
for (let i = ti; i < ti + 40 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i]}`);
