/**
 * 环回（loopback）访问闸门：插件本地 HTTP 面（状态路由、以及后续的聊天
 * shim）只应经由本机环回接口访问。
 *
 * 单独成模块的原因：host 侧的状态路由与聊天 shim 都要复用同一套判定，
 * 避免两处实现漂移。
 *
 * @module dsh-qwen-connect/loopback
 */

/** 本地插件面可被寻址的环回主机名。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * 去掉 Host 头里可选的 `:port`，并且正确处理 IPv6 方括号形式。
 *
 * @param {string} host
 * @returns {string}
 */
function hostnameOfHost(host) {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    return end === -1 ? hostname : hostname.slice(0, end + 1);
  }
  const colon = hostname.lastIndexOf(':');
  if (
    colon !== -1 &&
    !hostname.slice(0, colon).includes(':') &&
    /^\d+$/.test(hostname.slice(colon + 1))
  ) {
    hostname = hostname.slice(0, colon);
  }
  return hostname;
}

/**
 * 请求的 Host 头必须指向环回接口。
 *
 * 这道检查用于挡掉 DNS-rebinding 页面：攻击者页面把自己的域名重新解析到
 * 127.0.0.1 后，浏览器发出的 Host 仍是攻击者域名，因此在任何路由发生之前
 * 就被这里拒绝。
 *
 * @param {string | undefined} host
 * @returns {boolean}
 */
export function hostIsLoopback(host) {
  if (host === undefined || host.trim() === '') return false;
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}

/**
 * 浏览器发出的 Origin（存在该头时）必须是环回。非浏览器客户端（插件自身
 * 的 fetch 调用）完全不带 Origin，视为通过。
 *
 * @param {string | undefined} origin
 * @returns {boolean}
 */
export function originIsLoopback(origin) {
  if (origin === undefined || origin.trim() === '') return true;
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * 该请求是否可被信任为「来自本机」。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function loopbackRequest(req) {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
