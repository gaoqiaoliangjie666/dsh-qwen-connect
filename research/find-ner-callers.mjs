import fs from 'node:fs';
import path from 'node:path';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');

// 看 ner 在真实推理链中的调用处：搜 "infer-sse" / agent_chat_generation / Pnl 使用点
for (const t of ['Pnl,', 'ner(', 'sendRemoteChatAsk']) {
  const ps = []; let i = 0;
  while (true) { const q = src.indexOf(t, i); if (q === -1) break; ps.push(q); i = q + 1; if (ps.length > 30) break; }
  console.log(`\n### ${t}: ${ps.length} -> ${ps.slice(0, 30).join(', ')}`);
}
