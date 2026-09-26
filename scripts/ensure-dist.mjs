// 确保 apps/desktop/dist 存在（最小占位）。
//
// ## 为什么需要这个脚本（附实测结论）
//
// `tauri::generate_context!()` 会在**编译期**把 `frontendDist`
// （`tauri.conf.json` 里的 `../dist`）嵌进二进制。
//
// **实测（本仓库，rustc 1.98.1）**：
// * `cargo check`（debug）在 `dist/` **不存在**时**不会失败** ——
//   tauri-build 在 dev 配置下走 `devUrl`（vite dev server），不读 dist。
// * 但 `cargo check --release` / `cargo build --release` **会**失败，
//   错误形如 `The `frontendDist` configuration is set to "../dist" but this path doesn't exist`。
// * `tauri build` 本身不受影响 —— 它会先跑 `beforeBuildCommand`（即 `pnpm build`）。
//
// 所以这个脚本针对的是"只改 Rust 却想跑 release 检查"以及 CI 的场景：
// **存在就什么都不做，不存在才写一个最小占位**，绝不会覆盖真实产物。
//
// 用法：`node scripts/ensure-dist.mjs`（已被 `pnpm check:rust` 自动调用）

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'apps', 'desktop', 'dist');
const INDEX = join(DIST, 'index.html');

if (existsSync(INDEX)) {
  // 已经有真实产物（或上次留下的占位）。什么都不做，避免把 vite 的构建结果改掉。
  process.exit(0);
}

mkdirSync(DIST, { recursive: true });
writeFileSync(
  INDEX,
  `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>ToolForge</title>
  </head>
  <body>
    <!--
      这是 scripts/ensure-dist.mjs 写入的**占位页**，只为了让 cargo check 能过。
      跑一次 \`pnpm build\`（或 \`pnpm tauri:dev\`）就会被真实的 Vite 产物替换。
    -->
    <div id="root">请先运行 pnpm build 生成前端产物。</div>
  </body>
</html>
`,
  'utf8'
);

console.log('已写入 apps/desktop/dist/index.html 占位页（仅为让 cargo check 通过，pnpm build 会覆盖它）');
