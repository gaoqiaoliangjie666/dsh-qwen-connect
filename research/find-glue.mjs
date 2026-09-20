// 在 obf 文件中定位 qoder_auth_wasm_bg 的 JS glue（__wbindgen_* 实现 + 导出包装）
import fs from 'node:fs';

const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');

const terms = [
  'qoder_auth_wasm_bg',
  'qodercontext_prepareInferRequest',
  'qodercontext_prepareRequest',
  'qodercontext_new',
  '__wbindgen_object_drop_ref',
  '__wbg_getRandomValues_d49329ff89a07af1',
  'qodercontext_refreshAuthFields',
  'requestresult_url',
  '__wbg_set_08463b1df38a7e29',
  'generate_runtime_auth_fields',
];

for (const t of terms) {
  const positions = [];
  let i = 0;
  while (true) {
    const p = src.indexOf(t, i);
    if (p === -1) break;
    positions.push(p);
    i = p + 1;
    if (positions.length > 60) break;
  }
  console.log(`${t}: ${positions.length} hits -> ${positions.slice(0, 20).join(', ')}`);
}
