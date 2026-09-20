// 直接调用 raw wasm export，绕过 glue 包装，观察返回值
import path from 'node:path';
import { initFromFile } from './qoder-wasm-glue.mjs';

const WASM = path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm');
const exp = initFromFile(WASM);

// 手工复刻 glue 的调用序列：alloc 参数 -> 调用 -> 读 retptr
const mem = () => new Uint8Array(exp.memory.buffer);
const enc = new TextEncoder();

function passString(s) {
  // glue 的 alloc 用 __wbindgen_export2(len, align)
  const bytes = enc.encode(s);
  const ptr = exp.__wbindgen_export2(bytes.length, 1) >>> 0;
  new Uint8Array(exp.memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

// 合成 uid，仅用于验证 raw export 的返回槽形态；禁止写入真实账号数据。
const input = JSON.stringify({
  uid: '00000000-0000-4000-8000-000000000001',
  organization_id: '',
  organization_tags: [],
  data_policy_agreed: false,
});
console.log('input len:', input.length);

const sp = exp.__wbindgen_add_to_stack_pointer(-16);
const { ptr, len } = passString(input);
console.log('allocated arg at', ptr, 'len', len);

exp.generate_runtime_auth_fields(sp, ptr, len);
const dv = new DataView(exp.memory.buffer);
const p0 = dv.getInt32(sp + 0, true);
const n0 = dv.getInt32(sp + 4, true);
const p1 = dv.getInt32(sp + 8, true);
const n1 = dv.getInt32(sp + 12, true);
console.log('ret slots: [0]=', p0, ' [4]=', n0, ' [8]=', p1, ' [12]=', n1);

if (p0 && n0) {
  console.log('ret#0 str:', new TextDecoder().decode(new Uint8Array(exp.memory.buffer, p0, n0)));
}
if (p1 && n1) {
  console.log('ret#1 str:', new TextDecoder().decode(new Uint8Array(exp.memory.buffer, p1, n1)));
}

// 检查是否有错误抛出（wasm-bindgen 抛异常时第一个 int32 非 0）
console.log('\nmemory after bump:', exp.__wbindgen_add_to_stack_pointer(16));
