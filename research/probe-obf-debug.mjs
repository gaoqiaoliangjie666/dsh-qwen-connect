import { resolveCosyVersion } from '../lib/runtime-identity.js';
import fs from 'node:fs';
import path from 'node:path';

const OBF_RELATIVE = path.join('resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker', 'qoder-worker-runtime.obf.mjs');
const root = 'E:\\software\\Qwen\\QwenWorkCN';
const sub = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d/.test(e.name));
console.log('版本子目录:', sub.map(e => e.name));

const versioned = sub[0].name;
const obfPath = path.join(root, versioned, OBF_RELATIVE);
console.log('obf 存在:', fs.existsSync(obfPath), obfPath);

const text = fs.readFileSync(obfPath, 'utf8');
const aliasMatch = /COSY_VERSION:\(\)=>([A-Za-z_$][\w$]*)/.exec(text);
console.log('alias:', aliasMatch?.[1]);
const alias = aliasMatch[1];
const escaped = alias.replace(/\$/g, '\\$');
console.log('escaped alias:', escaped);
const direct = new RegExp(`\\b${escaped}\\s*=\\s*[^;]{0,200}?"(\\d+\\.\\d+\\.\\d+)"`).exec(text);
console.log('direct match:', direct?.[0]?.slice(0, 120));
console.log('direct ver:', direct?.[1]);
// 换一种：不用 \b，直接找 alias=
const d2 = new RegExp(`${escaped}\\s*=\\s*[^;]{0,200}?"(\\d+\\.\\d+\\.\\d+)"`).exec(text);
console.log('no-\\b match:', d2?.[1]);

console.log('\nresolveCosyVersion():', JSON.stringify(resolveCosyVersion()));
