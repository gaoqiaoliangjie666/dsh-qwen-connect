// 诊断 generate_runtime_auth_fields 的输入/输出形态
//
// ⚠️ 本脚本只观测**形态**（类型、长度、结构），不打印任何凭据取值。
// 需要账号相关输入时一律走：环境变量 → 运行时读取 → 合成值。
import path from 'node:path';
import { initFromFile } from './qoder-wasm-glue.mjs';

const WASM = path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm');
const exp = initFromFile(WASM);

/** 只暴露长度与短掩码，绝不回传原值。 */
function redact(value) {
  if (typeof value !== 'string' || value === '') return '(absent)';
  return value.length <= 8 ? '***' : `${value.slice(0, 3)}***${value.slice(-2)} (len=${value.length})`;
}

// 合成 uid 优先；仅在显式设置环境变量时才读真实凭据（供本地排障）。
const SYNTHETIC_UID = '00000000-0000-4000-8000-000000000001';
let uid = process.env.QWEN_UID ?? SYNTHETIC_UID;
if (process.env.QWEN_USE_REAL_CREDENTIALS === '1') {
  try {
    const { loadAuth } = await import('./creds.mjs');
    const auth = loadAuth();
    uid = auth.user?.id ?? SYNTHETIC_UID;
    // 只打印掩码，不打印原值
    console.log('loginDeviceId:', redact(auth.loginDeviceId));
    console.log('loginMethod:', auth.loginMethod);
    console.log('user keys:', Object.keys(auth.user ?? {}).join(','));
  } catch (error) {
    console.log('凭据读取失败（回退合成值）:', error.code ?? error.message);
  }
}
console.log('uid:', redact(uid));

const inputs = [
  JSON.stringify({ uid: 'x', organization_id: '', organization_tags: [], data_policy_agreed: false }),
  JSON.stringify({ uid, organization_id: '', organization_tags: [], data_policy_agreed: false }),
  '{}',
];

for (const inp of inputs) {
  // 输入可能含 uid，打印前先压扁成「键名 + 长度」摘要
  const shape = Object.keys(JSON.parse(inp)).join(',') || '(empty)';
  try {
    const raw = exp.generate_runtime_auth_fields(inp);
    console.log(`\nINPUT shape: {${shape}}`);
    console.log('  RAW type :', typeof raw);
    if (raw === undefined) {
      console.log('  RAW value: undefined');
      continue;
    }
    // 只报告产物的**结构**，不打印密文本身
    try {
      const parsed = JSON.parse(raw);
      console.log('  JSON keys:', Object.keys(parsed).join(','));
      for (const [k, v] of Object.entries(parsed)) {
        console.log(`    ${k}: ${redact(typeof v === 'string' ? v : JSON.stringify(v))}`);
      }
    } catch (e) {
      console.log('  JSON parse fail:', e.message, '| raw length:', raw.length);
    }
  } catch (e) {
    console.log(`\nINPUT shape: {${shape}}`);
    console.log('  THREW:', e.constructor.name, e.message);
  }
}
