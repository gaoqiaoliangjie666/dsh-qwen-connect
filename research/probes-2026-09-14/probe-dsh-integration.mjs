// research/probes-2026-09-14/probe-dsh-integration.mjs
// DSH 集成面排查：package.json 契约、cordis.patch.yml、profile 登记、Junction。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

console.log('=== 1) package.json 契约 ===');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('name 存在', typeof pkg.name === 'string' && pkg.name !== '');
check('type=module', pkg.type === 'module');
check('main 指向 lib/index.js', pkg.main === 'lib/index.js', pkg.main);
check('dsh.bundle.patch 存在', pkg.dsh?.bundle?.patch !== undefined, pkg.dsh?.bundle?.patch);
check('dsh.client.platform=web', pkg.dsh?.client?.platform === 'web');
check('dsh.client.inject 三项', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length === 3);
check('private=true（防误发 registry）', pkg.private === true);

console.log('\n=== 2) exports 路径全部可达 ===');
for (const [key, rel] of Object.entries(pkg.exports ?? {})) {
  if (typeof rel !== 'string') continue;
  const abs = path.join(ROOT, rel.replace(/^\.\//, ''));
  check(`exports["${key}"]`, fs.existsSync(abs), rel);
}

console.log('\n=== 3) cordis.patch.yml ===');
const patchPath = path.join(ROOT, 'cordis.patch.yml');
check('文件存在', fs.existsSync(patchPath));
if (fs.existsSync(patchPath)) {
  const yml = fs.readFileSync(patchPath, 'utf8');
  check('声明 llm-qwenwork', yml.includes('llm-qwenwork'));
  check('使用 insert（非 replace）', yml.includes('insert'));
}

console.log('\n=== 4) DSH profile 登记（三处）===');
const roaming = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const profileDir = path.join(roaming, 'dsh-desktop', 'harness', 'profiles', 'web');
const profilePkgPath = path.join(profileDir, 'package.json');

if (fs.existsSync(profilePkgPath)) {
  const pp = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'));
  const name = pkg.name;
  check(`dependencies["${name}"]`, pp.dependencies?.[name] !== undefined, pp.dependencies?.[name]);
  check('dsh.profile.bundles 含本插件', Array.isArray(pp.dsh?.profile?.bundles) && pp.dsh.profile.bundles.includes(name));
  check(`pnpm.overrides["${name}"]`, pp.pnpm?.overrides?.[name] !== undefined, pp.pnpm?.overrides?.[name]);

  // ⚠️ 关键：profile 层的 cordis.patch.yml 不得再插一条（会 duplicate loader entry id）
  const profilePatch = path.join(profileDir, 'cordis.patch.yml');
  if (fs.existsSync(profilePatch)) {
    const py = fs.readFileSync(profilePatch, 'utf8');
    check('profile 层 patch 未重复插入 llm-qwenwork', !py.includes('llm-qwenwork'));
  } else {
    console.log('  ℹ️  profile 无 cordis.patch.yml（正常）');
  }
} else {
  console.log('  ⏭️  本机无 DSH profile，跳过');
}

console.log('\n=== 5) Junction 可达性 ===');
const link = path.join(profileDir, 'node_modules', pkg.name);
if (fs.existsSync(link)) {
  check('Junction 指向本目录', fs.realpathSync(link) === fs.realpathSync(ROOT), fs.realpathSync(link));
  for (const rel of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'research/wasm.bin', 'research/qoder-wasm-glue.mjs']) {
    check(`经 Junction 可达 ${rel}`, fs.existsSync(path.join(link, rel)));
  }
} else {
  console.log('  ⏭️  本机未安装，跳过');
}

console.log('\n=== 6) 依赖桥（peer 依赖解析）===');
for (const spec of ['@deepseek-ai/dsh-llm', '@deepseek-ai/cordis', '@earendil-works/pi-ai']) {
  let dir = ROOT;
  let found = null;
  for (let i = 0; i < 8; i++) {
    const probe = path.join(dir, 'node_modules', ...spec.split('/'));
    if (fs.existsSync(probe)) { found = probe; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  check(`解析 ${spec}`, found !== null, found ?? '未找到');
}

console.log(fail === 0 ? '\n✅ DSH 集成面全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
