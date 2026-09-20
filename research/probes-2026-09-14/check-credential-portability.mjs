// research/probes-2026-09-14/check-credential-portability.mjs
// 凭据可移植性：把凭据文件拷到别的机器能直接用吗？
// 结论对用户很关键——决定「换电脑」是否需要在新机重新登录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const dir = path.join(appData, 'QwenWorkCN');

console.log('=== 1) 凭据文件构成 ===');
const files = ['Local State', 'auth-v2.dat', 'auth.dat'];
for (const f of files) {
  const abs = path.join(dir, f);
  if (!fs.existsSync(abs)) {
    console.log(`  ── ${f}（不存在）`);
    continue;
  }
  const kb = (fs.statSync(abs).size / 1024).toFixed(1);
  console.log(`  · ${f.padEnd(16)} ${kb} KB`);
}

console.log('\n=== 2) 加密链路（逐层判断可移植性）===');
const layers = [
  {
    step: '① Chromium v10 加密',
    detail: 'auth-v2.dat 用 AES-256-GCM 加密，密钥来自下一层',
    portable: '✅ 文件本身可拷贝',
  },
  {
    step: '② 主密钥（master key）',
    detail: 'Local State 的 os_crypt.encrypted_key 用 DPAPI 加密',
    portable: '❌ DPAPI 绑定「当前 Windows 用户」，拷到别的机器/用户账户无法解密',
  },
  {
    step: '③ DPAPI CryptUnprotectData',
    detail: '解密需要用户登录密码派生的密钥',
    portable: '❌ 跨机器必然失败（无用户主密钥）',
  },
];

for (const l of layers) {
  console.log(`  ${l.step}`);
  console.log(`      ${l.detail}`);
  console.log(`      ${l.portable}`);
}

console.log('\n=== 3) 实测：本机凭据能否被读出 ===');
try {
  // seam 暴露的是 getValidCredential（返回「可用的凭据」，必要时先续期），
  // 不是 loadCredentials（那是直接读盘、不续期）。
  const seam = await import('../../lib/credentials-seam.js');
  const cred = await seam.getValidCredential();
  console.log(`  [OK] 本机读出成功`);
  console.log(`        token 长度=${String(cred.token ?? '').length}`);
  console.log(`        loginDeviceId=${cred.loginDeviceId ? '有（机器绑定，随凭据走）' : '无'}`);
  console.log(`        refreshToken=${cred.refreshToken ? '有（可续期）' : '无'}`);
  console.log(`        expiresAt=${cred.expiresAt ?? '?'}`);
} catch (e) {
  console.log(`  [FAIL] ${e.message.slice(0, 120)}`);
}

console.log('\n=== 4) 换电脑的正确做法 ===');
const steps = [
  ['拷贝插件目录/zip', '✅ 直接拷', '插件本身无机器绑定'],
  ['拷贝凭据文件', '❌ 无效', 'DPAPI 解不开，会报「DPAPI 解密主密钥失败」'],
  ['在新机安装千问办公并登录', '✅ 正确做法', '新机自己生成可解的凭据'],
  ['或用环境变量提供凭据', '⚠️ 有限支持', 'QWEN_MACHINE_ID 可覆盖设备 id，但 token 仍需有效'],
];
for (const [what, verdict, note] of steps) {
  console.log(`  ${what.padEnd(26)} ${verdict.padEnd(12)} ${note}`);
}

console.log('\n=== 5) 错误提示是否清楚（用户遇到时的可读性）===');
const errors = fs.readFileSync(path.join('lib', 'errors.js'), 'utf8');
const probes = [
  ['DPAPI 解密失败', /DPAPI 解密主密钥失败/],
  ['凭据缺失', /未找到千问办公/],
  ['凭据损坏', /凭据文件格式不是预期/],
];
for (const [label, re] of probes) {
  console.log(`  ${re.test(errors) ? '[OK]' : '[FAIL]'} ${label}`);
}
