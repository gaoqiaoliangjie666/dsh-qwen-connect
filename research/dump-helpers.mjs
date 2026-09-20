import fs from 'node:fs';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
console.log('=== function uE @7328 ===');
console.log(src.slice(7100, 8300));
console.log('\n=== function TD @21576610 ===');
console.log(src.slice(21576400, 21577600));
console.log('\n=== function ax @18782926 ===');
console.log(src.slice(18782800, 18783800));
