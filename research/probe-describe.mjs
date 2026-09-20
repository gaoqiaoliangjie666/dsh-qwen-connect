import { createSignerSession } from '../lib/signer-session.js';
import { loadCredentials } from '../lib/credentials.js';

// 用真实凭据看 describe() 输出（但绝不打印真实值）
const cred = loadCredentials();
const session = await createSignerSession({ credential: cred });
const d = session.describe();
console.log('describe():');
console.log(JSON.stringify(d, null, 2));

const text = JSON.stringify(d);
const internal = { token: cred.token, dev: cred.loginDeviceId, uid: cred.user?.id };
for (const [k, v] of Object.entries(internal)) {
  if (typeof v === 'string' && v !== '') {
    console.log(`\n含 ${k} 原文:`, text.includes(v));
  }
}
session.dispose();
