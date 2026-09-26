#!/usr/bin/env node
/**
 * enginectl —— ToolForge 引擎开发辅助脚本
 *
 * ⚠️ 定位说明（务必先读）
 * ---------------------------------------------------------------
 * 这是一个**开发 / CI 辅助脚本**，不是产品功能。正式的分发逻辑在 Rust 的
 * `crates/toolforge-engines`（`registry.rs` 的 `EngineRegistry::install`：
 * 探测 → 按需下载 → SHA-256 校验 → 解压 → 注册状态）里，由应用在运行时调用。
 * 本脚本的用途是：
 *   1. 本地开发时把引擎预热到仓库的 `engines/` 目录，省掉反复点 UI 下载；
 *   2. CI 里预热缓存，让集成测试不用每次重新下载几百 MB；
 *   3. 让人能在一个不装 Tauri 的环境里查看引擎清单与探测结果。
 *
 * 依赖：**只用 Node 内置模块**（node:fs / node:https 走 fetch / node:crypto /
 * node:zlib 不用，解压交给系统 tar/7z）。要求 Node >= 20（见 package.json）。
 *
 * 数据来源（单一真相来源，本脚本不维护第二份）
 * ---------------------------------------------------------------
 * * 引擎清单：`crates/toolforge-core/src/engine.rs` 的 `engine_catalog()`，
 *   本脚本用正则解析该文件。**改了 Rust 里的引擎目录，这里自动跟着变**。
 * * 下载地址与哈希：`crates/toolforge-engines/engine-sources.json`。
 *   注意该文件里所有 `sha256` 目前都是 `null`（待维护者按版本回填）。
 *   Rust 侧 `EngineSourceSpec` 规定 **`sha256` 为 `None` 时禁止自动安装**；
 *   本脚本在开发场景下允许"先下后补"，但会**打印实际哈希并明确提示回填**，
 *   绝不会凭空编造一个哈希值。
 *
 * 用法
 * ---------------------------------------------------------------
 *   node scripts/enginectl.mjs list                 打印引擎目录表
 *   node scripts/enginectl.mjs probe                探测全部引擎是否已安装
 *   node scripts/enginectl.mjs probe ffmpeg         只探测 ffmpeg
 *   node scripts/enginectl.mjs install ffmpeg       下载并解压到 engines/ffmpeg/
 *   node scripts/enginectl.mjs install ffmpeg --keep-archive   保留下载的压缩包
 *
 * 退出码：0 成功；1 失败（网络不可用、哈希不匹配、解压失败、参数错误等）。
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 路径与常量
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 引擎目录的唯一真相来源 */
const ENGINE_CATALOG_RS = path.join(ROOT, 'crates', 'toolforge-core', 'src', 'engine.rs');
/** 下载源表（Rust 侧 EngineSourceSpec 反序列化的就是它） */
const ENGINE_SOURCES_JSON = path.join(ROOT, 'crates', 'toolforge-engines', 'engine-sources.json');
/** 引擎安装目录，与 .gitignore 里的 `/engines/` 对应；Rust 侧 AppPaths::engines() 也是它 */
const ENGINES_DIR = path.join(ROOT, 'engines');
/** 下载缓存（放在 engines/ 下，整个目录本来就不入库） */
const DOWNLOAD_DIR = path.join(ENGINES_DIR, '.downloads');

/** 与 registry.rs 的 ENGINE_BINARIES 保持一致（探测用） */
const ENGINE_BINARIES = {
  ffmpeg: ['ffmpeg'],
  ffprobe: ['ffprobe'],
  libvips: ['vips', 'vips.exe'],
  imagemagick: ['magick', 'convert'],
  pandoc: ['pandoc'],
  libreoffice: ['soffice'],
  '7zip': ['7z', '7za', '7zz'],
  calibre: ['ebook-convert'],
  tesseract: ['tesseract'],
  python: ['python', 'python3', 'python3.11'],
  'onnx-models': [],
  'ai-provider': [],
};

/**
 * 必须排除的"同名误报"。
 *
 * 最典型的坑：`imagemagick` 的候选名里有 `convert`，而 Windows 自带
 * `C:\Windows\System32\convert.exe`（NTFS 卷转换工具，完全不是 ImageMagick）。
 * 实测 `where convert` 会命中它，如果不过滤，UI 就会宣称"已检测到 ImageMagick"，
 * 之后调用必然失败。Rust 侧 `ENGINE_BINARIES` 也有同样的候选名，属于待加固项。
 */
const REJECT_BINARIES = {
  win32: ['convert.exe'],
};

function isRejectedBinary(p) {
  const rejects = REJECT_BINARIES[process.platform] ?? [];
  const base = path.basename(p).toLowerCase();
  return rejects.some((r) => base === r.toLowerCase());
}

/** 应用托管目录里的相对可执行路径（与 lib.rs 的 MANAGED_LAYOUT 一致） */
const MANAGED_LAYOUT = {
  ffmpeg: 'bin/ffmpeg',
  libvips: 'bin/vips',
  imagemagick: 'magick',
  pandoc: 'pandoc',
  libreoffice: 'program/soffice',
  '7zip': '7z',
  calibre: 'ebook-convert',
  tesseract: 'tesseract',
  python: 'python',
};

/** 与 lib.rs 的 version_args() 保持一致（拿版本用的参数） */
const VERSION_ARGS = {
  ffmpeg: ['-version'],
  libvips: ['--version'],
  imagemagick: ['-version'],
  pandoc: ['--version'],
  libreoffice: ['--version'],
  '7zip': [],
  calibre: ['--version'],
  tesseract: ['--version'],
  python: ['--version'],
};

/** UTF-8 终端里 CJK 字符占两列，表格对齐要靠它 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s, width) {
  const text = String(s ?? '');
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells) => cells.map((c, i) => pad(c ?? '', widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '─'.repeat(w)).join('──'));
  for (const r of rows) console.log(line(r));
}

function info(msg) {
  console.log(msg);
}
function warn(msg) {
  console.warn(`⚠️  ${msg}`);
}
function fail(msg, detail) {
  console.error(`\n❌ ${msg}`);
  if (detail) console.error(`   ${String(detail).split('\n').join('\n   ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 引擎目录：从 Rust 源码解析（不维护第二份常量表）
// ---------------------------------------------------------------------------

/**
 * 解析 `engine_catalog()` 里的 `EngineDescriptor { ... }` 块。
 *
 * 用"找块 + 括号配平 + 字段正则"而不是完整 Rust 解析器：这个文件是机器生成的
 * 风格固定，正则足够；一旦解析失败我们会明确报错，而不是静默返回空表。
 */
async function loadEngineCatalog() {
  let src;
  try {
    src = await readFile(ENGINE_CATALOG_RS, 'utf8');
  } catch (e) {
    fail(`读不到引擎目录源码：${ENGINE_CATALOG_RS}`, '是不是不在仓库根目录下运行？');
  }

  const fnStart = src.indexOf('pub fn engine_catalog()');
  if (fnStart < 0) {
    fail(
      'engine.rs 里找不到 `pub fn engine_catalog()`',
      '本脚本靠解析它来生成清单。若函数被重命名，请同步更新 scripts/enginectl.mjs。',
    );
  }

  const blocks = [];
  let cursor = fnStart;
  while (true) {
    const at = src.indexOf('EngineDescriptor {', cursor);
    if (at < 0) break;
    let depth = 0;
    let i = src.indexOf('{', at);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(src.slice(start + 1, i));
    cursor = i + 1;
  }

  if (blocks.length === 0) {
    fail('未能从 engine.rs 解析出任何引擎条目', '请检查 engine_catalog() 的写法是否变了。');
  }

  const grab = (block, field) => {
    const m = block.match(new RegExp(`${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? m[1] : null;
  };
  const grabNum = (block, field) => {
    const m = block.match(new RegExp(`${field}:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const grabList = (block, field) => {
    const m = block.match(new RegExp(`${field}:\\s*vec!\\[([\\s\\S]*?)\\]`));
    if (!m) return null;
    return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  };

  return blocks.map((b) => ({
    id: grab(b, 'id'),
    name: grab(b, 'name'),
    description: grab(b, 'description'),
    homepage: grab(b, 'homepage'),
    license: grab(b, 'license'),
    licenseNote: grab(b, 'license_note'),
    approxSizeMb: grabNum(b, 'approx_size_mb'),
    core: /core:\s*true/.test(b),
    provides: grabList(b, 'provides') ?? [],
    platforms: grabList(b, 'platforms') ?? [],
    installModes: [...b.matchAll(/EngineInstallMode::(\w+)/g)].map((x) => x[1]),
    requiresLicenseAck: /requires_license_ack:\s*true/.test(b),
  }));
}

/** 读取下载源表（`engine-sources.json`） */
async function loadSources() {
  try {
    const raw = await readFile(ENGINE_SOURCES_JSON, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    warn(`读不到下载源表 ${path.relative(ROOT, ENGINE_SOURCES_JSON)}：${e.message}`);
    return [];
  }
}

function platformKey() {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

const INSTALL_MODE_LABEL = {
  System: '仅探测系统安装',
  Download: '应用按需下载',
  Pip: 'pip 安装到插件私有 venv',
  Remote: '远程服务（无本地二进制）',
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function cmdList() {
  const catalog = await loadEngineCatalog();
  const sources = await loadSources();
  const plat = platformKey();

  const byId = new Map();
  for (const s of sources) {
    if (!byId.has(s.id)) byId.set(s.id, {});
    byId.get(s.id)[s.platform] = s;
  }

  info(`ToolForge 引擎目录（来源：${path.relative(ROOT, ENGINE_CATALOG_RS)}）`);
  info(`当前平台：${plat}　共 ${catalog.length} 个引擎\n`);

  printTable(
    ['id', '名称', '体积', '安装方式', '核心', '许可证', '需确认许可证', '下载源'],
    catalog.map((e) => {
      const src = byId.get(e.id)?.[plat];
      let dl;
      if (!e.installModes.includes('Download')) dl = '—（不支持下载）';
      else if (!src) dl = '待定（源表缺该平台）';
      else if (!src.url) dl = '待定';
      else dl = src.sha256 ? '已固定哈希' : '有 URL，哈希待回填';
      return [
        e.id,
        e.name,
        e.approxSizeMb ? `${e.approxSizeMb}MB` : '—',
        e.installModes.map((m) => INSTALL_MODE_LABEL[m] ?? m).join(' / '),
        e.core ? '是' : '',
        e.license,
        e.requiresLicenseAck ? '是' : '否',
        dl,
      ];
    }),
  );

  info('\n提供的节点：');
  for (const e of catalog) {
    info(`  ${pad(e.id, 14)} ${e.provides.join('、') || '（无）'}`);
  }

  const missingHash = sources.filter((s) => !s.sha256).length;
  if (missingHash > 0) {
    warn(
      `${path.relative(ROOT, ENGINE_SOURCES_JSON)} 里有 ${missingHash} 条下载源没有 sha256。` +
        '\n   Rust 侧规定 sha256 为 null 时**禁止自动安装**，所以这些引擎目前只能走系统安装模式。' +
        '\n   回填方法：node scripts/enginectl.mjs install <id>，脚本会打印实际哈希。',
    );
  }
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

function which(bin) {
  const isWin = process.platform === 'win32';
  // Windows 用 where，其它平台用 which；两者都会打印所有命中项
  const r = spawnSync(isWin ? 'where' : 'which', [bin], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error) return { error: r.error };
  if (r.status !== 0) return { paths: [] };
  const paths = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { paths };
}

function readVersion(binPath, engineId) {
  const args = VERSION_ARGS[engineId] ?? ['--version'];
  if (args.length === 0) return null; // 例如 7-Zip：没有可靠的版本参数
  const r = spawnSync(binPath, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (r.error) return null;
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return text ? text.split(/\r?\n/)[0].slice(0, 80) : null;
}

async function cmdProbe(onlyId) {
  const catalog = await loadEngineCatalog();
  const targets = onlyId ? catalog.filter((e) => e.id === onlyId) : catalog;
  if (onlyId && targets.length === 0) {
    fail(`未知引擎 id：${onlyId}`, `可用 id：${catalog.map((e) => e.id).join(', ')}`);
  }

  const rows = [];
  for (const e of targets) {
    const bins = ENGINE_BINARIES[e.id];
    if (bins === undefined) {
      rows.push([
        e.id,
        '无本地可执行文件',
        '',
        '该引擎是本脚本未登记的形态（例如只有模型权重或只有远程服务），无需探测。',
      ]);
      continue;
    }
    if (bins.length === 0) {
      rows.push([e.id, '无需探测', '', '该引擎没有本地可执行文件（远程服务 / 模型权重包）。']);
      continue;
    }

    // 第一站：应用托管目录（与 Rust 的探测顺序一致：托管目录 → PATH → 常见安装路径）
    const managedRel = MANAGED_LAYOUT[e.id];
    if (managedRel) {
      const suffix = process.platform === 'win32' ? '.exe' : '';
      const managed = path.join(ENGINES_DIR, e.id, `${managedRel}${suffix}`);
      if (existsSync(managed)) {
        rows.push([e.id, '已安装（应用管理）', readVersion(managed, e.id) ?? '', managed]);
        continue;
      }
    }

    let found = null;
    const tried = [];
    let probeError = null;
    for (const b of bins) {
      tried.push(b);
      const { paths, error } = which(b);
      if (error) {
        probeError = error;
        break;
      }
      // where 会返回所有命中项，逐个排除同名误报
      const hit = paths.find((p) => !isRejectedBinary(p));
      if (hit) {
        found = hit;
        break;
      }
    }
    if (probeError) {
      rows.push([
        e.id,
        '探测失败',
        '',
        `无法执行 ${process.platform === 'win32' ? 'where' : 'which'}：${probeError.message}`,
      ]);
      continue;
    }

    if (!found) {
      const hint = e.installModes.includes('Download')
        ? `未找到（试过 ${tried.join(', ')}）。可执行：node scripts/enginectl.mjs install ${e.id}`
        : `未找到（试过 ${tried.join(', ')}）。该引擎只支持系统安装，请用官方安装包。`;
      rows.push([e.id, '未检测到', '', hint]);
      continue;
    }
    rows.push([e.id, '已检测到（系统）', readVersion(found, e.id) ?? '（无法取得版本）', found]);
  }

  printTable(['id', '状态', '版本', '位置 / 说明'], rows);
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function humanSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * 流式下载并计算 SHA-256。
 *
 * 边下边算，避免为了校验再读一遍几百 MB 的文件；同时按 Content-Length 打印百分比。
 *
 * 空闲看门狗（重要）：大文件下载不能只靠"连不上就报错"——DNS 被劫持、企业代理
 * 静默丢包、镜像挂在 TCP 建连阶段时，`fetch` 会长时间既不返回也不失败。
 * 所以这里用一个**空闲超时**：只要 N 秒内没有任何新数据就中止并给出中文报错。
 * 用空闲超时而不是总超时，是为了不误杀"慢但一直在传"的大文件。
 *
 * 实现上**不只依赖** `AbortController`：某些网络故障会让 fetch 的 Promise
 * 长时间悬着不 reject（实测 gyan.dev 在本机不可达时就是这样）。所以看门狗
 * 会在超时那一刻直接打印错误并 `process.exit(1)` 兜底，abort 只作为"顺手清理"。
 */
async function downloadWithProgress(url, destFile, idleTimeoutMs = 60_000) {
  const controller = new AbortController();
  let settled = false;
  let idleTimer = null;

  const clearWatchdog = () => {
    settled = true;
    if (idleTimer) clearTimeout(idleTimer);
  };
  const armWatchdog = () => {
    if (settled) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort(new Error('idle-timeout'));
      try {
        out?.destroy();
      } catch {
        /* 忽略清理异常 */
      }
      rm(destFile, { force: true }).finally(() => {
        fail(
          `下载中断：超过 ${idleTimeoutMs / 1000} 秒没有收到任何新数据`,
          `地址：${url}\n` +
            '可能原因：目标站点在本机不可达、DNS 被劫持、企业代理静默丢包、镜像已下线。\n' +
            '排查建议：\n' +
            '  · 先确认该站点能否访问（例如用浏览器或 curl 打开上面的地址）；\n' +
            '  · 企业网络有 TLS 中间人代理时，需要设置 NODE_EXTRA_CA_CERTS 指向代理根证书（见 scripts/env.ps1）；\n' +
            '  · 网络较慢时用 `--idle-timeout <秒>` 放宽；\n' +
            '  · 若站点确实不可达，请改用系统安装模式，或换镜像后在 engine-sources.json 里更新地址。',
        );
      });
    }, idleTimeoutMs);
  };

  let out = null;
  armWatchdog();
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: controller.signal });
  } catch (e) {
    clearWatchdog();
    await rm(destFile, { force: true });
    fail(
      `下载失败：无法连接到下载服务器`,
      `地址：${url}\n原因：${e.message}\n` +
        '排查建议：检查网络/代理是否可用；企业网络有 TLS 中间人代理时需设置 ' +
        'NODE_EXTRA_CA_CERTS（见 scripts/env.ps1）；若站点不可达请改用系统安装模式。',
    );
  }
  if (!res.ok) {
    clearWatchdog();
    fail(`下载失败：服务器返回 HTTP ${res.status} ${res.statusText}`, `地址：${url}`);
  }

  const total = Number(res.headers.get('content-length') || 0);
  const hash = createHash('sha256');
  out = createWriteStream(destFile);

  let received = 0;
  let lastPrint = 0;
  const t0 = Date.now();
  process.stdout.write('  下载中 0%\r');

  try {
    for await (const chunk of res.body) {
      armWatchdog(); // 每收到一块数据就重置空闲计时
      const buf = Buffer.from(chunk);
      hash.update(buf);
      received += buf.length;
      if (!out.write(buf)) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      const now = Date.now();
      if (now - lastPrint > 200) {
        lastPrint = now;
        const speed = received / Math.max(0.001, (now - t0) / 1000);
        const pct = total ? ((received / total) * 100).toFixed(1) : '?';
        process.stdout.write(
          `  下载中 ${pct}%  ${humanSize(received)}${total ? ` / ${humanSize(total)}` : ''}  ${humanSize(speed)}/s\r`,
        );
      }
    }
  } catch (e) {
    if (settled) return; // 看门狗已经接管并退出了
    clearWatchdog();
    out.destroy();
    await rm(destFile, { force: true });
    fail(
      '下载中断（连接被重置或超时）',
      `${e.message}\n已下载 ${humanSize(received)}，文件不完整，已删除临时文件。`,
    );
  } finally {
    if (!settled) clearWatchdog();
    await new Promise((resolve) => out.end(resolve));
  }

  const pct = total ? '100.0' : '?';
  process.stdout.write(`  下载完成 ${pct}%  ${humanSize(received)}                \n`);
  return { sha256: hash.digest('hex'), bytes: received };
}

/** 用系统 tar 解压。Windows 10 1803+ 自带 bsdtar，能直接解 zip / tar.* */
function extractArchive(file, kind, stripComponents, destDir) {
  if (kind === 'raw') {
    return { ok: true, note: 'raw：未解压，原始文件即为产物' };
  }

  const args = ['-xf', file, '-C', destDir];
  if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`);

  // .7z 需要 7-Zip；先试 7z/7za/7zz
  const tryCmds =
    kind === '7z'
      ? [
          ['7z', ['x', file, `-o${destDir}`, '-y']],
          ['7za', ['x', file, `-o${destDir}`, '-y']],
          ['7zz', ['x', file, `-o${destDir}`, '-y']],
        ]
      : [['tar', args]];

  const errors = [];
  for (const [cmd, cmdArgs] of tryCmds) {
    const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', windowsHide: true });
    if (r.error) {
      errors.push(`${cmd}: ${r.error.message}`);
      continue;
    }
    if (r.status === 0) return { ok: true, note: `已用 ${cmd} 解压` };
    errors.push(`${cmd}: 退出码 ${r.status} ${(r.stderr || '').trim().split('\n')[0]}`);
  }

  return {
    ok: false,
    note:
      kind === '7z'
        ? '解压 .7z 需要系统已安装 7-Zip（先有鸡还是先有蛋的问题）。' +
          '建议改用系统安装模式，或先手动装一次 7-Zip。'
        : '系统 tar 解压失败。Windows 10 1803+ 自带 bsdtar；更老的系统请手动解压。',
    errors,
  };
}

async function cmdInstall(engineId, opts) {
  if (!engineId) fail('用法：node scripts/enginectl.mjs install <engine-id>');

  const catalog = await loadEngineCatalog();
  const engine = catalog.find((e) => e.id === engineId);
  if (!engine) {
    fail(`未知引擎 id：${engineId}`, `可用 id：${catalog.map((e) => e.id).join(', ')}`);
  }
  if (!engine.installModes.includes('Download')) {
    fail(
      `引擎 \`${engineId}\` 不支持应用托管下载`,
      `它的安装方式只有：${engine.installModes.map((m) => INSTALL_MODE_LABEL[m] ?? m).join('、')}\n` +
        '请使用官方安装包安装，应用会自动探测到它。',
    );
  }
  if (engine.requiresLicenseAck) {
    warn(
      `该引擎要求用户确认许可证：${engine.license}\n` +
        `   ${engine.licenseNote}\n` +
        '   本脚本是开发工具，不会替你记录"用户已同意"；正式流程由应用内的引擎管理页弹窗完成。',
    );
  }

  const sources = await loadSources();
  const plat = platformKey();
  const src = sources.find((s) => s.id === engineId && s.platform === plat);
  if (!src) {
    const avail = sources.filter((s) => s.id === engineId).map((s) => s.platform);
    fail(
      `下载源表里没有 \`${engineId}\` 在 ${plat} 平台的条目`,
      avail.length
        ? `已有平台：${avail.join('、')}。请在 engine-sources.json 里补 ${plat} 条目。`
        : `engine-sources.json 里完全没有 \`${engineId}\` 的条目。`,
    );
  }
  if (!src.url) {
    fail(`\`${engineId}\` 在 ${plat} 的下载地址还是"待定"（null）`, src.note ?? '');
  }

  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const archiveName = path.basename(new URL(src.url).pathname) || `${engineId}.bin`;
  const archivePath = path.join(DOWNLOAD_DIR, `${engineId}-${archiveName}`);

  info(`安装引擎 ${engine.name}（${engineId}）`);
  info(`  平台      ${plat}`);
  info(`  下载地址  ${src.url}`);
  info(`  归档格式  ${src.archive}（stripComponents=${src.stripComponents ?? 0}）`);
  if (src.note) info(`  说明      ${src.note}`);
  if (!src.sha256) {
    warn(
      '该下载源没有预置 sha256（engine-sources.json 里是 null）。\n' +
        '   本次下载**无法校验完整性**，完成后会把实际哈希打印出来，请回填到该文件。\n' +
        '   Rust 侧 `EngineSourceSpec` 规定 sha256 为 null 时禁止自动安装。',
    );
  }

  const t0 = Date.now();
  const { sha256, bytes } = await downloadWithProgress(src.url, archivePath, opts.idleTimeoutMs);
  info(`  用时      ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---- 校验 ----
  if (src.sha256) {
    const expected = String(src.sha256).replace(/^sha256:/i, '').toLowerCase();
    if (expected !== sha256) {
      await rm(archivePath, { force: true });
      fail(
        'SHA-256 校验失败：下载产物与预置哈希不一致',
        `期望：${expected}\n实际：${sha256}\n` +
          '可能原因：镜像/网络被劫持、下载源更新了版本但哈希没同步、下载被截断。\n' +
          '已删除下载文件，不做任何降级处理。',
      );
    }
    info(`  ✓ SHA-256 校验通过：${sha256}`);
  } else {
    info('');
    warn('请把下面这行哈希回填到 engine-sources.json 对应条目：');
    info(`     "sha256": "${sha256}"`);
    info(`   （文件：${path.relative(ROOT, ENGINE_SOURCES_JSON)}，引擎 ${engineId} / 平台 ${plat}）`);
    info(`   实际大小：${humanSize(bytes)}`);
    info('');
  }

  // ---- 解压 ----
  const destDir = path.join(ENGINES_DIR, engineId);
  await mkdir(destDir, { recursive: true });
  const r = extractArchive(archivePath, src.archive, src.stripComponents ?? 0, destDir);
  if (!r.ok) {
    fail('解压失败', `${r.note}\n${(r.errors ?? []).join('\n')}`);
  }
  info(`  ✓ ${r.note}`);
  info(`  安装目录  ${path.relative(ROOT, destDir)}`);
  if (src.binSubdir && src.binSubdir !== '.') {
    info(`  可执行文件子目录  ${src.binSubdir}（Rust 侧按 MANAGED_LAYOUT 查找）`);
  }

  if (!opts.keepArchive) {
    await rm(archivePath, { force: true });
  } else {
    info(`  已保留压缩包  ${path.relative(ROOT, archivePath)}`);
  }

  info('\n完成。应用启动后会把该目录识别为「已安装（应用管理）」。');
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const USAGE = `enginectl —— ToolForge 引擎开发辅助脚本

用法：
  node scripts/enginectl.mjs list                     打印引擎目录表
  node scripts/enginectl.mjs probe [id]               探测引擎是否已安装（默认全部）
  node scripts/enginectl.mjs install <id> [选项]      下载并解压到 engines/<id>/

install 选项：
  --keep-archive           保留下载的压缩包（默认下完即删）
  --idle-timeout <秒>      下载空闲超时，默认 60 秒（超过该时长没有新数据就中止）
  --help

退出码：0 成功 / 1 失败（含网络不可用）
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }

  if (!existsSync(ENGINE_CATALOG_RS)) {
    fail(
      '找不到 crates/toolforge-core/src/engine.rs',
      `当前解析出的仓库根目录：${ROOT}\n请在仓库根目录下运行本脚本。`,
    );
  }

  switch (cmd) {
    case 'list':
      await cmdList();
      break;
    case 'probe':
      await cmdProbe(argv[1]);
      break;
    case 'install': {
      const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
      // --idle-timeout <秒>：网络慢或走代理时放宽
      const idx = argv.indexOf('--idle-timeout');
      let idleTimeoutMs = 60_000;
      if (idx >= 0) {
        const secs = Number(argv[idx + 1]);
        if (!Number.isFinite(secs) || secs <= 0) {
          fail('--idle-timeout 需要一个正数（单位：秒）', `收到的是：${argv[idx + 1] ?? '(空)'}`);
        }
        idleTimeoutMs = secs * 1000;
      }
      const opts = { keepArchive: argv.includes('--keep-archive'), idleTimeoutMs };
      await cmdInstall(positional[0], opts);
      break;
    }
    default:
      fail(`未知子命令：${cmd}`, '可用子命令：list / probe / install。用 --help 看完整用法。');
  }
}

main().catch((e) => {
  fail('脚本内部错误', e?.stack ?? String(e));
});
