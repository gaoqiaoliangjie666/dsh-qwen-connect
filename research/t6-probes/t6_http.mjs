// t6 验收：status 路由 200 + 404 反证 + 安全边界 + token 不下发（原生 socket）
import net from 'node:net';

const PORT = 63878;
const OK_PATH = '/plugins/dsh-qwen-connect/status';

function raw(method, path, headers) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write(`${method} ${path} HTTP/1.1\r\n` + headers.map(([k, v]) => `${k}: ${v}\r\n`).join('') + 'Connection: close\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => { buf += d.toString('utf8'); });
    s.on('end', () => {
      const [head, ...rest] = buf.split('\r\n\r\n');
      resolve({ statusLine: head.split('\r\n')[0], body: rest.join('\r\n\r\n') });
    });
    s.on('error', (e) => resolve({ statusLine: 'ERR ' + e.message, body: '' }));
  });
}

const LH = [['Host', `127.0.0.1:${PORT}`], ['Accept', 'application/json']];

console.log('=== 4. status 路由 200 + 404 反证 ===');
const ok1 = await raw('GET', OK_PATH, LH);
console.log('  本插件路由        :', ok1.statusLine);

const neg1 = await raw('GET', '/plugins/dsh-not-a-real-plugin/status', LH);
console.log('  不存在的插件路由  :', neg1.statusLine, '(期望 404)');
const neg2 = await raw('GET', '/plugins/dsh-qwen-connect/nonexistent', LH);
console.log('  本插件错误子路径  :', neg2.statusLine, '(期望 404)');
const neg3 = await raw('GET', '/plugins/', LH);
console.log('  裸 /plugins/      :', neg3.statusLine);

console.log('\n=== 5. 安全边界 ===');
const badHost = await raw('GET', OK_PATH, [['Host', 'evil.example.com'], ['Accept', 'application/json']]);
console.log('  非环回 Host       :', badHost.statusLine, '(期望 403)');
const badOrigin = await raw('GET', OK_PATH, [['Host', `127.0.0.1:${PORT}`], ['Origin', 'http://evil.example.com'], ['Accept', 'application/json']]);
console.log('  非环回 Origin     :', badOrigin.statusLine, '(期望 403)');
const post = await raw('POST', OK_PATH, LH);
console.log('  POST 方法         :', post.statusLine, '(期望 405)');
const pubIp = await raw('GET', OK_PATH, [['Host', '10.0.0.5:63878'], ['Accept', 'application/json']]);
console.log('  内网非环回 Host   :', pubIp.statusLine, '(期望 403)');

console.log('\n=== 6. token/JWT 不下发 ===');
const body = ok1.body;
console.log('  响应体长度        :', body.length);
console.log('  含 "token" 字段   :', /"token"/i.test(body));
console.log('  含 JWT 明文       :', /eyJ[A-Za-z0-9_-]{25,}/.test(body));
console.log('  含 refreshToken   :', /ory_rt_|"refreshToken"/i.test(body));
console.log('  含 email/username :', /@phone\.local|7693uc7/i.test(body));
console.log('  响应体            :', body.slice(0, 400));
