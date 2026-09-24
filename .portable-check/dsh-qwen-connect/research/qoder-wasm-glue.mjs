// ============================================================================
// qoder_auth_wasm glue 的独立 Node 复刻版
// 目标：在 Node 中实例化 QwenWorkCN 内联的签名 WASM 并直接调用官方签名逻辑。
//
// 来源（只读）：qoder-worker-runtime.obf.mjs 中的 wasm-bindgen glue 区块
// 本文件是手写复刻，逐一对照原 glue 的语义（见 research/glue/qodercontext_pretty.js）
// 不含任何凭据。
// ============================================================================
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// wasm-bindgen 运行时状态
// ---------------------------------------------------------------------------
let kt = null;            // wasm exports
let LlA = null;           // DataView cache
let F6A = null;           // Uint8Array cache
let U6A = 0;              // heap object free slot
const Zq = new Array(1024).fill(undefined);
Zq.push(undefined, null, true, false);
U6A = Zq.length;
const N6A = new TextEncoder();
let KQt = 0;
let ug = 0;               // 最近写入的字节长度
const Vfs = 2146435072;
let oCe = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

function ZB(A) {                                    // addHeapObject
  if (U6A === Zq.length) Zq.push(Zq.length + 1);
  const e = U6A;
  U6A = Zq[e];
  Zq[e] = A;
  return e;
}
function jfs(A) {                                   // takeHeapObject
  if (A < 1028) return;
  Zq[A] = U6A;
  U6A = A;
}
function DSA(A, e) {                                // getUint8ArrayFromMem
  return A >>>= 0, SSA().subarray(A, A + e);
}
function Mr() {                                     // getDataView
  if (LlA === null || LlA.buffer.detached === true ||
      (LlA.buffer.detached === undefined && LlA.buffer !== kt.memory.buffer)) {
    LlA = new DataView(kt.memory.buffer);
  }
  return LlA;
}
function Ww(A, e) {                                 // getStringFromWasm0
  return qfs(A >>>= 0, e);
}
function SSA() {                                    // getUint8Array
  if (F6A === null || F6A.byteLength === 0) F6A = new Uint8Array(kt.memory.buffer);
  return F6A;
}
function om(A) { return Zq[A]; }                    // getObject
function Wq(A) { return A === null || A === undefined; }
function kS(A) { const e = om(A); jfs(A); return e; } // takeObject

function b6A(A, e) {                                // handleError: run + route JS exception into wasm
  try { return A.apply(this, e); }
  catch (A) { kt.__wbindgen_export(ZB(A)); }
}
function qfs(A, e) {                                // getStringFromWasm0 impl
  KQt += e;
  if (KQt >= Vfs) { oCe = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }); oCe.decode(); KQt = e; }
  return oCe.decode(SSA().subarray(A, A + e));
}
function QZn(A, e) {                                // passArray8ToWasm0
  const t = e(A.length, 1) >>> 0;
  SSA().set(A, t);
  ug = A.length;
  return t;
}
function bf(A, e, t) {                              // passStringToWasm0
  if (t === undefined) {
    const t = N6A.encode(A);
    const i = e(t.length, 1) >>> 0;
    SSA().subarray(i, i + t.length).set(t);
    ug = t.length;
    return i;
  }
  let i = A.length;
  let n = e(i, 1) >>> 0;
  const r = SSA();
  let o = 0;
  for (; o < i; o++) { const e = A.charCodeAt(o); if (e > 127) break; r[n + o] = e; }
  if (o !== i) {
    if (o !== 0) A = A.slice(o);
    n = t(n, i, i = o + 3 * A.length, 1) >>> 0;
    const e = SSA().subarray(n + o, n + i);
    o += N6A.encodeInto(A, e).written;
    n = t(n, i, o, 1) >>> 0;
  }
  ug = o;
  return n;
}
function CZn(A, e) { kt = A.exports; LlA = null; F6A = null; return kt; }

// ---------------------------------------------------------------------------
// imports（严格照抄 hZn() 的实现）
// ---------------------------------------------------------------------------
function hZn() {
  return {
    './qoder_auth_wasm_bg.js': {
      __wbg_Error_2e59b1b37a9a34c3: (A, e) => ZB(Error(Ww(A, e))),
      __wbg___wbindgen_is_function_49868bde5eb1e745: (A) => typeof om(A) === 'function',
      __wbg___wbindgen_is_object_40c5a80572e8f9d3: (A) => { const e = om(A); return typeof e === 'object' && e !== null; },
      __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (A) => typeof om(A) === 'string',
      __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (A) => om(A) === undefined,
      __wbg___wbindgen_throw_81fc77679af83bc6: (A, e) => { throw new Error(Ww(A, e)); },
      __wbg_call_d578befcc3145dee: function () { return b6A((A, e, t) => ZB(om(A).call(om(e), om(t))), arguments); },
      __wbg_crypto_38df2bab126b63dc: (A) => ZB(om(A).crypto),
      __wbg_getRandomValues_c44a50d8cfdaebeb: function () { return b6A((A, e) => { om(A).getRandomValues(om(e)); }, arguments); },
      __wbg_getRandomValues_d49329ff89a07af1: function () { return b6A((A, e) => { globalThis.crypto.getRandomValues(DSA(A, e)); }, arguments); },
      __wbg_length_0c32cb8543c8e4c8: (A) => om(A).length,
      __wbg_msCrypto_bd5a034af96bcba6: (A) => ZB(om(A).msCrypto),
      __wbg_new_99cabae501c0a8a0: () => ZB(new Map()),
      __wbg_new_with_length_9cedd08484b73942: (A) => ZB(new Uint8Array(A >>> 0)),
      __wbg_node_84ea875411254db1: (A) => ZB(om(A).node),
      __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
      __wbg_process_44c7a14e11e9f69e: (A) => ZB(om(A).process),
      __wbg_prototypesetcall_3e05eb9545565046: (A, e, t) => { Uint8Array.prototype.set.call(DSA(A, e), om(t)); },
      __wbg_randomFillSync_6c25eac9869eb53c: function () { return b6A((A, e) => { om(A).randomFillSync(kS(e)); }, arguments); },
      // 注意：原 glue 用 module.require；在 ESM 下 module 不存在，但该分支在本流程中用不到，
      // 保留惰性求值以免 import 阶段抛错。
      __wbg_require_b4edbdcf3e2a1ef0: function () {
        return b6A(function () { return ZB(typeof module !== 'undefined' ? module.require : (() => { throw new Error('require unavailable'); })); }, arguments);
      },
      __wbg_set_08463b1df38a7e29: (A, e, t) => ZB(om(A).set(om(e), om(t))),
      __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => { const A = typeof globalThis === 'undefined' ? null : globalThis; return Wq(A) ? 0 : ZB(A); },
      __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => { const A = typeof global === 'undefined' ? null : global; return Wq(A) ? 0 : ZB(A); },
      __wbg_static_accessor_SELF_24f78b6d23f286ea: () => { const A = typeof self === 'undefined' ? null : self; return Wq(A) ? 0 : ZB(A); },
      __wbg_static_accessor_WINDOW_59fd959c540fe405: () => { const A = typeof window === 'undefined' ? null : window; return Wq(A) ? 0 : ZB(A); },
      __wbg_subarray_0f98d3fb634508ad: (A, e, t) => ZB(om(A).subarray(e >>> 0, t >>> 0)),
      __wbg_versions_276b2795b1c6a219: (A) => ZB(om(A).versions),
      __wbindgen_cast_0000000000000001: (A, e) => ZB(DSA(A, e)),
      __wbindgen_cast_0000000000000002: (A, e) => ZB(Ww(A, e)),
      __wbindgen_object_clone_ref: (A) => ZB(om(A)),
      __wbindgen_object_drop_ref: (A) => { kS(A); },
    },
  };
}

// ---------------------------------------------------------------------------
// 类包装（照抄 H6A / HlA）
// ---------------------------------------------------------------------------
const NOOP_REGISTRY = { register: () => {}, unregister: () => {} };
const IZn = typeof FinalizationRegistry === 'undefined' ? NOOP_REGISTRY
  : new FinalizationRegistry((A) => kt.__wbg_qodercontext_free(A >>> 0, 1));
const BZn = typeof FinalizationRegistry === 'undefined' ? NOOP_REGISTRY
  : new FinalizationRegistry((A) => kt.__wbg_requestresult_free(A >>> 0, 1));

class RequestResult {
  static __wrap(e) {
    e >>>= 0;
    const t = Object.create(RequestResult.prototype);
    t.__wbg_ptr = e;
    BZn.register(t, t.__wbg_ptr, t);
    return t;
  }
  __destroy_into_raw() { const A = this.__wbg_ptr; this.__wbg_ptr = 0; BZn.unregister(this); return A; }
  free() { const A = this.__destroy_into_raw(); kt.__wbg_requestresult_free(A, 0); }
  get body() {
    try {
      const t = kt.__wbindgen_add_to_stack_pointer(-16);
      kt.requestresult_body(t, this.__wbg_ptr);
      const A = Mr().getInt32(t + 0, true), e = Mr().getInt32(t + 4, true);
      let i;
      if (A !== 0) { i = Ww(A, e).slice(); kt.__wbindgen_export4(A, 1 * e, 1); }
      return i;
    } finally { kt.__wbindgen_add_to_stack_pointer(16); }
  }
  get headerCount() { return kt.requestresult_headerCount(this.__wbg_ptr) >>> 0; }
  get headers() { return kS(kt.requestresult_headers(this.__wbg_ptr)); }
  get url() {
    let A, e;
    try {
      const n = kt.__wbindgen_add_to_stack_pointer(-16);
      kt.requestresult_url(n, this.__wbg_ptr);
      const t = Mr().getInt32(n + 0, true), i = Mr().getInt32(n + 4, true);
      A = t; e = i;
      return Ww(t, i);
    } finally { kt.__wbindgen_add_to_stack_pointer(16); kt.__wbindgen_export4(A, e, 1); }
  }
}

class QoderContext {
  __destroy_into_raw() { const A = this.__wbg_ptr; this.__wbg_ptr = 0; IZn.unregister(this); return A; }
  free() { const A = this.__destroy_into_raw(); kt.__wbg_qodercontext_free(A, 0); }
  get_external_providers_access() {
    let A, e;
    try {
      const n = kt.__wbindgen_add_to_stack_pointer(-16);
      kt.qodercontext_get_external_providers_access(n, this.__wbg_ptr);
      const t = Mr().getInt32(n + 0, true), i = Mr().getInt32(n + 4, true);
      A = t; e = i;
      return Ww(t, i);
    } finally { kt.__wbindgen_add_to_stack_pointer(16); kt.__wbindgen_export4(A, e, 1); }
  }
  constructor(A, e, t, i) {
    try {
      const a = kt.__wbindgen_add_to_stack_pointer(-16);
      const g = bf(A, kt.__wbindgen_export2, kt.__wbindgen_export3), l = ug;
      const B = bf(e, kt.__wbindgen_export2, kt.__wbindgen_export3), c = ug;
      const Q = bf(t, kt.__wbindgen_export2, kt.__wbindgen_export3), E = ug;
      const n = Wq(i) ? 0 : bf(i, kt.__wbindgen_export2, kt.__wbindgen_export3), r = ug;
      kt.qodercontext_new(a, g, l, B, c, Q, E, n, r);
      const o = Mr().getInt32(a + 0, true), s = Mr().getInt32(a + 4, true);
      if (Mr().getInt32(a + 8, true)) throw kS(s);
      this.__wbg_ptr = o >>> 0;
      IZn.register(this, this.__wbg_ptr, this);
      return this;
    } finally { kt.__wbindgen_add_to_stack_pointer(16); }
  }
  prepareInferRequest(A, e, t, i) {
    try {
      const l = kt.__wbindgen_add_to_stack_pointer(-16);
      const B = bf(A, kt.__wbindgen_export2, kt.__wbindgen_export3), c = ug;
      const Q = bf(e, kt.__wbindgen_export2, kt.__wbindgen_export3), E = ug;
      const n = Wq(t) ? 0 : bf(t, kt.__wbindgen_export2, kt.__wbindgen_export3), r = ug;
      const o = Wq(i) ? 0 : bf(i, kt.__wbindgen_export2, kt.__wbindgen_export3), s = ug;
      kt.qodercontext_prepareInferRequest(l, this.__wbg_ptr, B, c, Q, E, n, r, o, s);
      const a = Mr().getInt32(l + 0, true), g = Mr().getInt32(l + 4, true);
      if (Mr().getInt32(l + 8, true)) throw kS(g);
      return RequestResult.__wrap(a);
    } finally { kt.__wbindgen_add_to_stack_pointer(16); }
  }
  prepareRequest(A, e, t, i, n, r) {
    try {
      const c = kt.__wbindgen_add_to_stack_pointer(-16);
      const Q = bf(A, kt.__wbindgen_export2, kt.__wbindgen_export3), E = ug;
      const I = bf(e, kt.__wbindgen_export2, kt.__wbindgen_export3), u = ug;
      const d = bf(t, kt.__wbindgen_export2, kt.__wbindgen_export3), C = ug;
      const w = bf(i, kt.__wbindgen_export2, kt.__wbindgen_export3), h = ug;
      const o = Wq(n) ? 0 : bf(n, kt.__wbindgen_export2, kt.__wbindgen_export3), s = ug;
      const a = Wq(r) ? 0 : bf(r, kt.__wbindgen_export2, kt.__wbindgen_export3), g = ug;
      kt.qodercontext_prepareRequest(c, this.__wbg_ptr, Q, E, I, u, d, C, w, h, o, s, a, g);
      const l = Mr().getInt32(c + 0, true), B = Mr().getInt32(c + 4, true);
      if (Mr().getInt32(c + 8, true)) throw kS(B);
      return RequestResult.__wrap(l);
    } finally { kt.__wbindgen_add_to_stack_pointer(16); }
  }
  refreshAuthFields(A) {
    try {
      const t = kt.__wbindgen_add_to_stack_pointer(-16);
      const i = bf(A, kt.__wbindgen_export2, kt.__wbindgen_export3), n = ug;
      kt.qodercontext_refreshAuthFields(t, this.__wbg_ptr, i, n);
      const e = Mr().getInt32(t + 0, true);
      if (Mr().getInt32(t + 4, true)) throw kS(e);
    } finally { kt.__wbindgen_add_to_stack_pointer(16); }
  }
}

// ---------------------------------------------------------------------------
// initSync：给定 wasm bytes，构造 imports 并实例化
// ---------------------------------------------------------------------------
export function initSync(wasmBytes) {
  if (kt !== null) return kt;
  const e = hZn();
  const mod = wasmBytes instanceof WebAssembly.Module ? wasmBytes : new WebAssembly.Module(wasmBytes);
  return CZn(new WebAssembly.Instance(mod, e), mod);
}

export function getWasm() { return kt; }
export function wasmExports() { return kt; }
export { QoderContext, RequestResult };

// ---------------------------------------------------------------------------
// 顶层自由函数（照抄 glue 中 Ufs / Ffs / Nfs / Lfs / Hfs / Ofs / Yfs 等）
// 注意：kt.xxx 是 wasm 原始导出，ABI 为 (retptr, ptr, len) -> ()，
// 绝不能按 JS 语义直接调用，必须经过下面的包装。
// ---------------------------------------------------------------------------
export function generate_runtime_auth_fields(A) {
  let e, t;
  try {
    const g = kt.__wbindgen_add_to_stack_pointer(-16);
    const l = bf(A, kt.__wbindgen_export2, kt.__wbindgen_export3), B = ug;
    kt.generate_runtime_auth_fields(g, l, B);
    const i = Mr().getInt32(g + 0, true), n = Mr().getInt32(g + 4, true);
    const r = Mr().getInt32(g + 8, true), o = Mr().getInt32(g + 12, true);
    let s = i, a = n;
    if (o) { s = 0; a = 0; throw kS(r); }
    e = s; t = a;
    return Ww(s, a);
  } finally {
    kt.__wbindgen_add_to_stack_pointer(16);
    kt.__wbindgen_export4(e, t, 1);
  }
}

export function decrypt_server_response(A) {
  let e, t;
  try {
    const g = kt.__wbindgen_add_to_stack_pointer(-16);
    const l = bf(A, kt.__wbindgen_export2, kt.__wbindgen_export3), B = ug;
    kt.decrypt_server_response(g, l, B);
    const i = Mr().getInt32(g + 0, true), n = Mr().getInt32(g + 4, true);
    const r = Mr().getInt32(g + 8, true), o = Mr().getInt32(g + 12, true);
    let s = i, a = n;
    if (o) { s = 0; a = 0; throw kS(r); }
    e = s; t = a;
    return Ww(s, a);
  } finally {
    kt.__wbindgen_add_to_stack_pointer(16);
    kt.__wbindgen_export4(e, t, 1);
  }
}

function nullary0(fn) {
  let A, e;
  try {
    const n = kt.__wbindgen_add_to_stack_pointer(-16);
    kt[fn](n);
    const t = Mr().getInt32(n + 0, true), i = Mr().getInt32(n + 4, true);
    A = t; e = i;
    return Ww(t, i);
  } finally {
    kt.__wbindgen_add_to_stack_pointer(16);
    kt.__wbindgen_export4(A, e, 1);
  }
}
export const get_httpdns_account_id = () => nullary0('get_httpdns_account_id');
export const get_httpdns_config = () => nullary0('get_httpdns_config');
export const get_httpdns_secret_key = () => nullary0('get_httpdns_secret_key');
export const get_profile_key_fingerprint = () => nullary0('get_profile_key_fingerprint');

// 便捷：从文件加载
export function initFromFile(p) { return initSync(fs.readFileSync(p)); }
