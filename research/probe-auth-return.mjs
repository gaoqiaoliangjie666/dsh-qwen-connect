// 核实 t1 的 getValidToken() 真实返回结构（不打印任何凭据值）
const auth = await import('../lib/auth.js');
console.log('auth.js 导出:', Object.keys(auth).join(', '));

const r = await auth.getValidToken();
console.log('\ngetValidToken() 返回类型:', typeof r);
if (typeof r === 'object' && r !== null) {
  console.log('顶层键:', Object.keys(r).join(', '));
  console.log('  token 存在:', typeof r.token === 'string' && r.token.length > 0, '| len:', r.token?.length);
  console.log('  refreshed:', r.refreshed);
  if (r.credentials) {
    console.log('  credentials 键:', Object.keys(r.credentials).join(', '));
    console.log('    含 user:', r.credentials.user !== undefined);
    console.log('    含 loginDeviceId:', typeof r.credentials.loginDeviceId === 'string' && r.credentials.loginDeviceId.length > 0);
    console.log('    含 user.id:', typeof r.credentials.user?.id === 'string');
  } else {
    console.log('  credentials: 不存在');
  }
}
