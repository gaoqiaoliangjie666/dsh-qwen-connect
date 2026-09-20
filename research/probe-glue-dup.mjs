// 核实 glue 目录中两个 Mo 文件的真实差异
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.join(import.meta.dirname, 'glue');
const a = path.join(DIR, 'Mo.js');
const b = path.join(DIR, 'function Mo(.js');

const A = fs.readFileSync(a, 'utf8');
const B = fs.readFileSync(b, 'utf8');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
console.log('Mo.js              size=', A.length, 'sha=', sha(A));
console.log('function Mo(.js    size=', B.length, 'sha=', sha(B));
console.log('内容相同:', A === B);

// 找第一个差异点
let i = 0;
while (i < Math.min(A.length, B.length) && A[i] === B[i]) i += 1;
console.log('\n首个差异位置:', i);
console.log('Mo.js           :', JSON.stringify(A.slice(Math.max(0, i - 40), i + 60)));
console.log('function Mo(.js :', JSON.stringify(B.slice(Math.max(0, i - 40), i + 60)));

// 检查是否为偏移关系（一个是否是另一个的子串）
console.log('\nMo.js 是 function Mo(.js 的子串:', B.includes(A));
console.log('function Mo(.js 是 Mo.js 的子串:', A.includes(B));

// 两个文件的起点
console.log('\nMo.js           开头:', JSON.stringify(A.slice(0, 80)));
console.log('function Mo(.js 开头:', JSON.stringify(B.slice(0, 80)));
console.log('Mo.js           结尾:', JSON.stringify(A.slice(-60)));
console.log('function Mo(.js 结尾:', JSON.stringify(B.slice(-60)));
