// research/probes-2026-09-14/probe-credential-layer.mjs
// 排查凭据层：刷新链路、过期处理、异常路径。
import { getValidCredential, getValidToken, isWired, getAccountContext } from '../../lib/credentials-seam.js';
import { resolveCosyVersion, resolveMachineId } from '../../lib/runtime-identity.js';

console.log('=== 1) 接缝可用性 ===');
console.log('  isWired:', await isWired());

console.log('\n=== 2) 凭据结构（脱敏）===');
const cred = await getValidCredential();
const keys = Object.keys(cred ?? {}).sort();
console.log('  字段:', keys.join(', '));
console.log('  schemaVersion:', cred?.schemaVersion);
console.log('  token 长度:', typeof cred?.token === 'string' ? cred.token.length : 'N/A');
console.log('  refreshToken 存在:', typeof cred?.refreshToken === 'string' && cred.refreshToken.length > 0);
console.log('  expiresAt:', cred?.expiresAt ? new Date(cred.expiresAt).toISOString() : '未提供');
console.log('  loginDeviceId:', cred?.loginDeviceId ? '存在(' + String(cred.loginDeviceId).length + '字符)' : '缺失');
console.log('  user.id 存在:', cred?.user?.id !== undefined);
console.log('  refreshStrategy:', cred?.refreshStrategy);

console.log('\n=== 3) 签名身份解析 ===');
try {
  const cosy = resolveCosyVersion();
  console.log('  Cosy-Version:', cosy, '(source 见下)');
} catch (e) {
  console.log('  Cosy-Version 解析失败:', e.message.slice(0, 80));
}
try {
  const mid = resolveMachineId();
  console.log('  machineId:', mid ? '解析成功(' + String(mid).length + '字符)' : '返回 null');
} catch (e) {
  console.log('  machineId 解析失败:', e.message.slice(0, 80));
}

console.log('\n=== 4) token 与 credential 一致性 ===');
try {
  const r = await getValidToken();
  const tok = typeof r === 'string' ? r : r?.token;
  console.log('  getValidToken 返回类型:', typeof r);
  console.log('  与 credential.token 相同:', tok === cred?.token);
  if (typeof r === 'object') {
    console.log('  返回对象字段:', Object.keys(r).join(', '));
    console.log('  refreshed 标志:', r.refreshed);
  }
} catch (e) {
  console.log('  getValidToken 失败:', e.message.slice(0, 80));
}

console.log('\n=== 5) 账号上下文（脱敏）===');
try {
  const ctx = await getAccountContext();
  console.log('  status:', ctx ? 'ok' : 'null');
  console.log('  degraded:', ctx?.degraded ?? false);
  console.log('  quota.remaining:', ctx?.quota?.remaining);
  console.log('  plan.name:', ctx?.plan?.name);
} catch (e) {
  console.log('  失败:', e.message.slice(0, 80));
}

process.exit(0);
