import path from 'node:path';
import { initFromFile, generate_runtime_auth_fields } from './qoder-wasm-glue.mjs';
initFromFile(path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm'));

// 合成 uid，仅用于验证 wasm 返回值形态；禁止写入真实账号数据。
const input = '{"uid":"00000000-0000-4000-8000-000000000001","organization_id":"","organization_tags":[],"data_policy_agreed":false}';
const r = generate_runtime_auth_fields(input);
console.log('typeof:', typeof r);
console.log('len:', r && r.length);
console.log('value (truncated):', r && r.slice(0, 120));
