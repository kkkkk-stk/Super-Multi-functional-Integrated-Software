/**
 * 端到端：提交一次真实的转换任务，轮询到终态，检查磁盘上的产出。
 *
 * 走的路径与 UI 完全相同（IPC → 命令层 → 任务队列 → L1 流水线 → 内置节点），
 * 只是跳过了"拖文件 / 点按钮"。它验证的是**真实数据流**，而不是函数。
 *
 * ## 它抓到过什么
 *
 * 第一次跑就抓到一个**发布级**缺陷（当时 194 个单测 + 6 个集成测试 + `tsc`
 * 全绿）：`PathResolver` 一律拒绝绝对路径，而 `l1.rs` 把 `${src}` 绑定成
 * 真实绝对路径 —— 于是**任何一次真实转换都失败**：
 *
 * ```text
 * PERMISSION_DENIED — 插件不允许使用绝对路径：D:\...\gradient.png
 * ```
 *
 * 所有 `PathResolver` 测试都是拿相对路径直接调 `resolve()`，
 * 没有一个走过"用户选中的文件 → 模板渲染 → 节点 → resolver"这条真实数据流。
 *
 * 用法：`node scripts/devtools/e2e.mjs`
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  connect,
  prepareOutDir,
  writeInputPng,
  webpInfo,
  BUILTIN_PLUGINS,
  Checker,
} from './cdp.mjs';

const c = new Checker();
const client = await connect();

const srcPath = writeInputPng('e2e-gradient.png', 320, 200, 0);
const outDir = prepareOutDir('out-e2e');

console.log(`输入      : ${srcPath}  (${statSync(srcPath).size} 字节, 320x200 PNG)`);
console.log(`输出目录  : ${outDir}\n`);

c.section('【1】插件与权限状态');
const pre = await client.invoke('plugins_list');
for (const p of pre.plugins) {
  console.log(
    `   ${p.id.padEnd(42)} enabled=${p.enabled} granted=${p.grantedCount}/${p.permissionCount} pending=${p.hasPendingPermissions}`
  );
}
c.check(pre.pendingPermissionCount === 0, '所有插件都已授权（否则跑不起来是预期的）', `待授权 ${pre.pendingPermissionCount}`);

c.section('【2】提交一次真实转换');
const submitted = await client.invoke('plugins_run', {
  req: {
    pluginId: BUILTIN_PLUGINS.imageConvert,
    inputs: { src: [srcPath] },
    params: {
      format: { kind: 'str', value: 'webp' },
      quality: { kind: 'int', value: 85 },
    },
    outputDir: outDir,
  },
});
console.log(`   提交返回: ${JSON.stringify(submitted)}`);
c.check(!!submitted?.jobId, '拿到 jobId');

c.section('【3】轮询到终态');
const job = await client.waitJob(submitted.jobId);
console.log(`   状态: ${job.status}`);
console.log(`   标题: ${job.title}`);
if (job.error) {
  console.log(`   错误: ${job.error.code} — ${job.error.message}`);
  if (job.error.detail) console.log(`   详情: ${job.error.detail}`);
}
console.log('   --- 任务日志 ---');
for (const l of job.logs ?? []) console.log(`   [${l.level}] ${l.message}`);

c.section('【4】磁盘上的产出');
let produced = [];
if (existsSync(outDir)) produced = readdirSync(outDir);
if (produced.length === 0) {
  console.log('   (空)');
} else {
  for (const f of produced) {
    const p = join(outDir, f);
    const buf = readFileSync(p);
    const info = webpInfo(buf);
    console.log(
      `   ${f}  ${buf.length} 字节  ${info ? `${info.format} ${info.width}x${info.height}` : '（不是 WebP）'}`
    );
  }
}

c.section('================ 判定 ================');
c.check(job.status === 'succeeded', '任务成功', `实际 ${job.status}`);
c.check(produced.length === 1, '磁盘上有 1 个产出', `实际 ${produced.length}`);
if (produced.length === 1) {
  const info = webpInfo(readFileSync(join(outDir, produced[0])));
  // 只看魔数不够 —— 尺寸能证明位流完整（截断的文件会露馅）
  c.check(info !== null, '产出是合法 WebP 容器', info?.format ?? '');
  c.check(info?.width === 320 && info?.height === 200, '解码出的尺寸与输入一致', info ? `${info.width}x${info.height}` : '');
}

client.close();
process.exit(c.summary() ? 0 : 1);
