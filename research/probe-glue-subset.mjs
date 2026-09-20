// 严格验证：'function Mo(.js' 的内容是否被 'Mo.js' 完全覆盖（可从后者重建）
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, 'glue');
const A = fs.readFileSync(path.join(DIR, 'Mo.js'), 'utf8');          // async function Mo(A)...
const B = fs.readFileSync(path.join(DIR, 'function Mo(.js'), 'utf8'); // function Mo(A)...

console.log('A (Mo.js) 长度:', A.length);
console.log('B (function Mo(.js) 长度:', B.length);

// B 应该是 A 去掉 "async " 前缀后的同长度切片
const A_noAsync = A.slice('async '.length);
console.log('\nA 去掉 "async " 前缀后:', JSON.stringify(A_noAsync.slice(0, 40)));
console.log('B 开头               :', JSON.stringify(B.slice(0, 40)));

// 两者是否逐字节相同（在去掉 async 前缀后）
let samePrefix = true;
const n = Math.min(A_noAsync.length, B.length);
for (let i = 0; i < n; i++) {
  if (A_noAsync[i] !== B[i]) { samePrefix = false; console.log('首个差异 @', i); break; }
}
console.log('\n去掉 async 前缀后前', n, '字节完全一致:', samePrefix);

// 差异是否仅在于结尾多出的字节
const extraA = A_noAsync.slice(n);
const extraB = B.slice(n);
console.log('\nA 多出:', JSON.stringify(extraA));
console.log('B 多出:', JSON.stringify(extraB));

console.log('\n>>> 结论：B 的内容是否被 A 完全包含（可从 A 重建）:',
  samePrefix ? '是 —— B 是 A 的严格后缀，内容冗余' : '否 —— 两者有实质差异');
