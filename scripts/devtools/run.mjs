/**
 * 依次跑完全部真机检查，给一份汇总。
 *
 * 前提：应用必须**带 CDP 端口**运行（见 `dev-with-cdp.ps1`）。
 *
 * 用法：`node scripts/devtools/run.mjs`
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureCdpAvailable, CDP_BASE } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const STEPS = [
  ['inspect.mjs', '单页体检（挂载状态 / DOM 文本 / 运行时异常 / 截图）'],
  ['smoke.mjs', '路由冒烟（9 个页面逐个走）'],
  ['e2e.mjs', '端到端任务（真实转换 + 产出校验）'],
  ['verify.mjs', '验证包（解码 / 多文件扇出 / 恶意插件安全测试）'],
];

// 先确认 CDP 在，否则每个子脚本都会各自报一次同样的错
try {
  await ensureCdpAvailable();
} catch (e) {
  console.error(`\n${e.message}\n`);
  process.exit(2);
}

console.log(`CDP 端点: ${CDP_BASE}`);
console.log(`将依次运行 ${STEPS.length} 个检查\n${'═'.repeat(64)}`);

const results = [];
for (const [file, desc] of STEPS) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`▶ ${file} —— ${desc}`);
  console.log('═'.repeat(64));

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], {
      stdio: 'inherit',
      cwd: join(HERE, '..', '..'),
    });
    child.on('close', resolve);
    child.on('error', (err) => {
      console.error(`无法启动 ${file}: ${err.message}`);
      resolve(-1);
    });
  });
  results.push({ file, desc, code });
}

console.log(`\n${'═'.repeat(64)}`);
console.log('汇总');
console.log('═'.repeat(64));
for (const r of results) {
  const mark = r.code === 0 ? '✅' : '❌';
  console.log(`${mark} ${r.file.padEnd(14)} exit=${r.code}   ${r.desc}`);
}

const failed = results.filter((r) => r.code !== 0);
if (failed.length === 0) {
  console.log('\n全部通过。');
  console.log(
    '\n注意：这一套能验的是「渲染 / IPC / 任务链 / 安全属性」。' +
      '它**验不了**的两件事要靠人：\n' +
      '  * 从资源管理器**真实拖拽**文件（走的是 Tauri 原生 drag-drop 事件，不是 DOM 事件）；\n' +
      '  * 主题切换的**视觉效果**（浅色 / 深色 / 跟随系统 + 各套强调色）。'
  );
} else {
  console.log(`\n${failed.length} 个检查失败：${failed.map((f) => f.file).join(', ')}`);
}

process.exit(failed.length === 0 ? 0 : 1);
