import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const appDir = path.join(os.homedir(), 'AppData', 'Roaming', 'QwenWorkCN');
console.log('=== QwenWorkCN 目录 ===');
for (const e of fs.readdirSync(appDir, { withFileTypes: true })) {
  const p = path.join(appDir, e.name);
  let size = '';
  try { size = fs.statSync(p).size; } catch { }
  console.log(`  ${e.isDirectory() ? '[D]' : '   '} ${e.name}  ${size}`);
}

// 找可能的 machine id 文件
function walk(dir, depth = 0) {
  if (depth > 3) return;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of items) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(Cache|GPUCache|Code Cache|ShaderCache|DawnCache|blob_storage|IndexedDB|Local Storage|Session Storage|logs|Partitions)$/i.test(e.name)) continue;
      walk(p, depth + 1);
    } else if (/machine|device|umid|credential|auth|id/i.test(e.name)) {
      let size = 0; try { size = fs.statSync(p).size; } catch { }
      console.log(`  FILE ${p}  ${size} bytes`);
    }
  }
}
console.log('\n=== 名称含 machine/device/auth/id 的文件 ===');
walk(appDir);
