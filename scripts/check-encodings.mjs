// 检查 Windows 脚本（`.ps1` / `.bat` / `.cmd`）的**编码与行尾**。
//
// ## 为什么需要这个脚本
//
// 这条规则是被**实测**逼出来的，而且代价不小：`scripts/devtools/dev-with-cdp.ps1`
// 一度在 Windows 自带的 PowerShell 5.1 下**连解析都过不去**，报
// `Unexpected token '}'` —— 指的还是几行完全正确的代码。
//
// 原因不是语法，是**解码**：
//
//   * Windows PowerShell 5.1 在文件**没有 BOM** 时按 **ANSI/GBK** 解码。
//     PowerShell 7 默认按 UTF-8 读，所以这个问题只在"用系统自带 PowerShell 跑"
//     时出现 —— 而这正是 Windows 用户的默认情况。
//   * 注释里的中文是多字节 UTF-8 序列。GBK 会把其中某些字节当成**后继字节**，
//     把它后面紧邻的那个 ASCII 字符**吞掉**。
//   * GBK 的后继字节范围是 `0x40–0x7E`，而这里**正好包含 `}`**！
//     于是哈希表 `@{ a = 1; b = '中文' }` 里的 `}` 被吃掉 → 括号配对崩掉。
//
// 实测判据（本机）：`[System.Management.Automation.Language.Parser]::ParseFile()`
// 在去掉 BOM 后立刻报 1–9 个 `Unexpected token`，加回去就是 0 个。
// （注意：报错数量随注释内容漂移，所以"看起来能跑"完全不可靠。）
//
// 所以规则是：**只要文件里有非 ASCII 字符，就必须带 UTF-8 BOM**；
// 并且行尾用 CRLF（`.gitattributes` 已经这么声明了，这里顺带核对工作区是不是也这样）。
//
// 反过来，"编辑工具把 BOM 悄悄吃掉"是很常见的事（本项目就发生过：一次 `edit`
// 之后 BOM 没了，脚本立刻变成 9 个解析错误）。这条检查就是为了让那种情况**变红**，
// 而不是等到某个人在 Windows 上运行脚本时才发现。
//
// 用法：`node scripts/check-encodings.mjs`（已被 `pnpm check:all` 自动调用）

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 不扫这些目录：产物、依赖、本机隔离工具链 */
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', '.git', '.tools', 'gen']);

const WINDOWS_SCRIPTS = /\.(ps1|bat|cmd)$/i;
const BOM = [0xef, 0xbb, 0xbf];

/** @returns {string[]} 命中规则的文件（相对路径） */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collect(full, out);
    } else if (WINDOWS_SCRIPTS.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const problems = [];
const checked = [];

for (const file of collect(ROOT)) {
  const buf = readFileSync(file);
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const hasBom = buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
  // "有非 ASCII 字节"的朴素判据：任何一个 >= 0x80 的字节
  const hasNonAscii = buf.some((b) => b >= 0x80);
  // 行尾：只看内容区（去掉可能的 BOM）里有多少裸 LF
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;

  checked.push(rel);

  if (hasNonAscii && !hasBom) {
    problems.push(
      `${rel}\n` +
        `    ✗ 含有非 ASCII 字符，但**没有 UTF-8 BOM**。\n` +
        `      Windows PowerShell 5.1 会按 ANSI/GBK 解码它：注释里的中文会吞掉后面紧邻的\n` +
        `      ASCII 字符（GBK 后继字节范围 0x40–0x7E **包含 }**），脚本连解析都过不去。\n` +
        `      修法：把它重新存成「UTF-8 带 BOM」。`
    );
  }
  if (bareLf > 0) {
    problems.push(
      `${rel}\n` +
        `    ✗ 有 ${bareLf} 处裸 LF 行尾。`.concat(
          `\n      .gitattributes 声明了 *.ps1 / *.bat / *.cmd 用 CRLF（老版本 PowerShell 的解析器\n` +
            `      对 LF 更挑剔），工作区应当与之一致 —— 否则 git 会在下次触碰时整文件重写。`
        )
    );
  }
}

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

console.log(`检查了 ${checked.length} 个 Windows 脚本：`);
for (const f of checked) console.log(c.dim(`  · ${f}`));

if (problems.length === 0) {
  console.log(c.green('\n✓ 编码与行尾都符合要求（含非 ASCII 的脚本都带 UTF-8 BOM，行尾都是 CRLF）'));
  process.exit(0);
}

console.log('');
for (const p of problems) console.log(c.red(p));
console.log(c.red(`\n✗ ${problems.length} 处问题`));
process.exit(1);
