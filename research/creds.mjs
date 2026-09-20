// 独立凭据读取（只读，不落盘任何凭据）
// 用途：为签名测试提供 token / uid / machineId 等参数
// 注意：本模块只返回内存对象，绝不写日志/文件
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const APP_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'QwenWorkCN');

function dpapiUnprotect(blob) {
  // 通过 PowerShell 调用 DPAPI（Node 无内置）
  const b64 = Buffer.from(blob).toString('base64');
  const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b=[Convert]::FromBase64String('${b64}')
$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')
[Convert]::ToBase64String($r)
`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  return Buffer.from(out.trim(), 'base64');
}

export function getMasterKey() {
  const ls = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'Local State'), 'utf8'));
  const blob = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
  // 去掉 'DPAPI' 前缀 5 字节
  return dpapiUnprotect(blob.subarray(5));
}

export function decryptV10(file, key) {
  const b = fs.readFileSync(file);
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(3, 15), { authTagLength: 16 });
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(15, b.length - 16)), d.final()]).toString('utf8');
}

export function loadAuth() {
  const key = getMasterKey();
  const auth = JSON.parse(decryptV10(path.join(APP_DIR, 'auth-v2.dat'), key));
  return auth;
}
