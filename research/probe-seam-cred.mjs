// 验证接缝返回的凭据含签名所需全部字段（不打印任何凭据值）
import { getValidCredential, getValidToken } from '../lib/credentials-seam.js';

const c = await getValidCredential();
console.log('getValidCredential():');
console.log('  含 token        :', typeof c.token === 'string' && c.token.length > 0, `(len=${c.token?.length})`);
console.log('  含 loginDeviceId:', typeof c.loginDeviceId === 'string' && c.loginDeviceId.length > 0, `(len=${c.loginDeviceId?.length})`);
console.log('  含 user.id      :', typeof c.user?.id === 'string' && c.user.id.length > 0);
console.log('  键:', Object.keys(c).join(','));

const t = await getValidToken();
console.log('\ngetValidToken() 仍是字符串:', typeof t === 'string', `(len=${t.length})`);
console.log('两者 token 一致:', t === c.token);
