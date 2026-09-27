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
 *   node scripts/enginectl.mjs verify               校验**本地已有的权重文件**是否与
 *                                                   预置 SHA-256 一致（离线，逐字节算）
 *   node scripts/enginectl.mjs verify --json        同上，输出机器可读的 JSON
 *
 * 退出码：0 成功；1 失败（网络不可用、哈希不匹配、解压失败、参数错误等）。
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
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
/** 引擎可执行文件候选名的唯一真相来源（`pub const ENGINE_BINARIES`） */
const ENGINE_REGISTRY_RS = path.join(ROOT, 'crates', 'toolforge-engines', 'src', 'registry.rs');
/** 下载源表（Rust 侧 EngineSourceSpec 反序列化的就是它） */
const ENGINE_SOURCES_JSON = path.join(ROOT, 'crates', 'toolforge-engines', 'engine-sources.json');
/** 引擎安装目录，与 .gitignore 里的 `/engines/` 对应；Rust 侧 AppPaths::engines() 也是它 */
const ENGINES_DIR = path.join(ROOT, 'engines');
/** 下载缓存（放在 engines/ 下，整个目录本来就不入库） */
const DOWNLOAD_DIR = path.join(ENGINES_DIR, '.downloads');

/**
 * 与 registry.rs 的 `ENGINE_BINARIES` **保持一致**（探测用）—— 直接从那份 Rust 源码解析。
 *
 * # 为什么是"解析"而不是"再抄一张表"（这里真的漂移过）
 *
 * 这张表原本在 JS 里手抄了一份，注释还写着"与 registry.rs 保持一致"。
 * 结果是：Rust 那边加了 `poppler`（`pdftoppm`），JS 这份没跟上 ——
 * 于是 `verify` / `probe` 对 poppler 报的是"该引擎是本脚本未登记的形态"，
 * 而机器上它明明装好了。**声明与实现不一致**，这一次发生在开发脚本自己身上。
 * 现在改成从 `registry.rs` 解析，抄一份的机会就没有了。
 *
 * 平台的 `#[cfg(windows)]` / `#[cfg(not(windows))]` 属性照旧生效：
 * 例如 `imagemagick` 在 Windows 上只认 `magick`（`convert.exe` 是系统自带的卷转换工具）。
 */
async function loadEngineBinaries() {
  let src;
  try {
    src = await readFile(ENGINE_REGISTRY_RS, 'utf8');
  } catch (e) {
    fail(`读不到引擎注册表源码：${ENGINE_REGISTRY_RS}`, '是不是不在仓库根目录下运行？');
  }
  const at = src.indexOf('pub const ENGINE_BINARIES');
  if (at < 0) {
    fail(
      'registry.rs 里找不到 `pub const ENGINE_BINARIES`',
      '本脚本靠解析它来探测引擎。若它被重命名，请同步更新 scripts/enginectl.mjs。',
    );
  }
  const region = src.slice(at, src.indexOf('];', at));

  const isWindows = process.platform === 'win32';
  const table = {};
  for (const m of region.matchAll(
    /((?:#\[cfg\([^\]]*\)\]\s*)*)\("([a-z0-9-]+)",\s*&\[([^\]]*)\]\)/g,
  )) {
    const [, cfgs, id, names] = m;
    // 认得了 `windows` / `not(windows)` 就够用：这张表目前只用这两种
    if (/cfg\(\s*windows\s*\)/.test(cfgs) && !isWindows) continue;
    if (/cfg\(\s*not\(\s*windows\s*\)\s*\)/.test(cfgs) && isWindows) continue;
    table[id] = [...names.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  }

  if (Object.keys(table).length === 0) {
    fail(
      '未能从 registry.rs 解析出任何引擎可执行文件名',
      'ENGINE_BINARIES 的写法变了？请更新 scripts/enginectl.mjs 里的 loadEngineBinaries()。',
    );
  }
  return table;
}

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

/**
 * 拿版本用的参数。
 *
 * ⚠️ 这张表**仍然是 JS 里的一份拷贝**（Rust 侧的 `version_args()` 是个 match 表达式，
 * 解析它比解析一张常量表脆得多）。所以这里把代价写清楚：
 * 表里没有的引擎会退化成 `--version`，拿到的东西不对时**只会显示"（无法取得版本）"**，
 * **不会给出错误结论** —— 版本号在本脚本里只用于人眼确认，不参与任何判断。
 * （此前 `MANAGED_LAYOUT` 与 `ENGINE_BINARIES` 两张表也是这么抄的，而后者真的漂移过，
 *   所以现在已经改成从 Rust 解析，见 `loadEngineBinaries()`。）
 */
const VERSION_ARGS = {
  ffmpeg: ['-version'],
  libvips: ['--version'],
  imagemagick: ['-version'],
  pandoc: ['--version'],
  libreoffice: ['--version'],
  '7zip': [],
  calibre: ['--version'],
  tesseract: ['--version'],
  poppler: ['-v'],
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
 * 从 `engine.rs` 里抽出 `const NAME: &str = "…";`，用来还原 `Some(format!("{CONST}/x"))`。
 *
 * 权重的 URL 大量写成 `Some(format!("{REMBG_RELEASE}/u2netp.onnx"))` ——
 * 不把常量代回去，输出里就只剩一个 `{REMBG_RELEASE}`，看着像坏数据。
 */
function loadStringConstants(src) {
  const map = new Map();
  for (const m of src.matchAll(/const\s+([A-Z0-9_]+)\s*:\s*&str\s*=\s*"([^"]*)"/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/**
 * 解析 `engine_catalog()` 里的 `EngineDescriptor { ... }` 块。
 *
 * 用"找块 + 括号配平 + 字段正则"而不是完整 Rust 解析器：这个文件是机器生成的
 * 风格固定，正则足够；一旦解析失败我们会明确报错，而不是静默返回空表。
 *
 * ⚠️ **字段有三种写法，少认一种就会静默出错**：
 * ```rust
 * id: "ffmpeg".into(),                                  // 裸字符串
 * sha256: Some("309c…".into()),                         // Some("…".into())
 * url: Some(format!("{REMBG_RELEASE}/u2netp.onnx")),    // Some(format!("…"))
 * file_name: None,                                      // 没有值
 * ```
 * 第一版只认第一种，于是**每一个权重的 sha256 都被读成 null**，
 * `verify` 把 9 个权重全报成"未回填哈希"—— 输出看着"正常"，结论却全是错的。
 * 这就是本项目反复出现的"静默错误"，所以现在补了两道保险：
 * 三种写法都认；以及下面的 `guardExtracted()`（原文里有值、我们没抽出来 → 直接失败）。
 */
async function loadEngineCatalog() {
  let src;
  try {
    src = await readFile(ENGINE_CATALOG_RS, 'utf8');
  } catch (e) {
    fail(`读不到引擎目录源码：${ENGINE_CATALOG_RS}`, '是不是不在仓库根目录下运行？');
  }
  const constants = loadStringConstants(src);

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

  /** 三种写法都认；抽不出来返回 null */
  const grab = (block, field) => {
    const bare = block.match(new RegExp(`${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    const some = block.match(
      new RegExp(`${field}:\\s*Some\\(\\s*(?:format!\\()?\\s*"((?:[^"\\\\]|\\\\.)*)"`),
    );
    const raw = bare?.[1] ?? some?.[1];
    if (raw === undefined) return null;
    // 把 `{CONST}` 代回真实值；代不出来的保留原样（一眼能看出是没解析成功）
    return raw.replace(/\{([A-Z0-9_]+)\}/g, (whole, name) => constants.get(name) ?? whole).replace(/\\\\"/g, '"');
  };
  /**
   * 抽完之后对账：**原文里明明有值，却没抽出来 → 立刻失败**。
   *
   * 宁可让脚本炸掉，也不要输出一份"看着正常、其实全错"的表 ——
   * 第一版就是因为少认了 `Some(...)` 这种写法，把 9 个权重的哈希全报成"未回填"。
   */
  const guardExtracted = (block, field, value, where) => {
    if (value !== null) return;
    if (new RegExp(`${field}:\\s*Some\\(`).test(block)) {
      fail(
        // ⚠️ 这里**不能**出现反引号：整段字符串本身就在模板字符串里（踩过一次）
        `解析 \`${field}\` 失败：${where} 里写着 \`${field}: Some(…)\`，但脚本没能抽出来`,
        'engine.rs 的写法变了？请更新 scripts/enginectl.mjs 里的 grab()。\n' +
          '（这条守卫存在的理由：静默输出一份错的清单比直接报错危险得多。）',
      );
    }
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

  return blocks.map((b) => {
    const id = grab(b, 'id');
    const where = `引擎 \`${id}\``;
    for (const f of ['id', 'name', 'homepage', 'license', 'license_note']) {
      guardExtracted(b, f, grab(b, f), where);
    }
    return {
      id,
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
      models: parseModels(b, grab, grabNum, grabList, guardExtracted),
    };
  });
}

/**
 * 解析描述符里的 `models: vec![ EngineModel { ... } ]`。
 *
 * ⚠️ 不能用 `grabList` 那种"非贪婪匹配到第一个 `]`"的写法：模型块里还有
 * `used_by: vec!["…"]` 这样的嵌套方括号，非贪婪会在**第一个** `]` 就收住。
 * 所以这里自己做方括号配平（与上面解析 `EngineDescriptor` 用的是同一套办法）。
 */
function parseModels(descriptorBlock, grab, grabNum, grabList, guardExtracted) {
  const at = descriptorBlock.search(/models:\s*vec!\[/);
  if (at < 0) return [];
  const open = descriptorBlock.indexOf('[', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < descriptorBlock.length; i++) {
    if (descriptorBlock[i] === '[') depth++;
    else if (descriptorBlock[i] === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const region = descriptorBlock.slice(open + 1, end);

  const models = [];
  let cursor = 0;
  while (true) {
    const head = region.indexOf('EngineModel {', cursor);
    if (head < 0) break;
    let d = 0;
    let i = region.indexOf('{', head);
    const start = i;
    for (; i < region.length; i++) {
      if (region[i] === '{') d++;
      else if (region[i] === '}') {
        d--;
        if (d === 0) break;
      }
    }
    const body = region.slice(start + 1, i);
    cursor = i + 1;
    const id = grab(body, 'id');
    for (const f of ['id', 'name', 'license', 'url', 'sha256', 'file_name']) {
      guardExtracted(body, f, grab(body, f), `权重 \`${id}\``);
    }
    models.push({
      id,
      name: grab(body, 'name'),
      approxSizeMb: grabNum(body, 'approx_size_mb'),
      license: grab(body, 'license'),
      commercialUse: /commercial_use:\s*true/.test(body),
      url: grab(body, 'url'),
      sha256: grab(body, 'sha256'),
      // `file_name` 是"落盘文件名"，与 id **经常对不上**（如 isnet-general → isnet-general-use.onnx）
      fileName: grab(body, 'file_name') ?? `${id}.onnx`,
      usedBy: grabList(body, 'used_by') ?? [],
    });
  }
  return models;
}

/**
 * 应用数据目录 —— 与 Rust 侧 `AppPaths::root()` 同一处。
 *
 * 权重不在仓库里（它们在用户数据目录下），所以 `verify` 必须知道它在哪；
 * 用 `--data-dir` 可以覆盖，方便在另一台机器/CI 上校验一份拷贝。
 */
function defaultDataDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'com.toolforge.desktop');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'com.toolforge.desktop');
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'com.toolforge.desktop');
  }
}

/**
 * "这个权重文件看起来是完整的吗" —— 与 Rust 侧
 * `toolforge_core::engine::model_size_looks_complete()` **同一条判据**：
 * 0 字节、或不足标称体积 60% → 不完整。
 *
 * 为什么要在这里也判一次：`verify` 的价值就是**在推理之前**发现那种文件。
 * 实测事故：一次中断的下载把 928 MB 的权重截成 0 字节，而 `Path::is_file()`
 * 对它同样为真 —— 界面显示"已就绪"，直到跑任务时才炸出一句看不懂的错误。
 * 判据刻意宽松（60%）：`approx_size_mb` 是"约"，把完好文件误判成损坏比漏判更糟。
 */
function sizeLooksComplete(actualBytes, approxSizeMb) {
  if (actualBytes === 0) return false;
  const approx = (approxSizeMb ?? 0) * 1024 * 1024;
  if (approx === 0) return true;
  return actualBytes >= (approx * 6) / 10;
}

/** 流式算文件的 SHA-256（900 MB 的权重不能一次读进内存） */
async function hashFile(file) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const rs = createReadStream(file, { highWaterMark: 1 << 22 });
    rs.on('data', (c) => {
      hash.update(c);
      bytes += c.length;
    });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  return { sha256: hash.digest('hex'), bytes };
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
  const binaries = await loadEngineBinaries();
  const targets = onlyId ? catalog.filter((e) => e.id === onlyId) : catalog;
  if (onlyId && targets.length === 0) {
    fail(`未知引擎 id：${onlyId}`, `可用 id：${catalog.map((e) => e.id).join(', ')}`);
  }

  const rows = [];
  for (const e of targets) {
    const bins = binaries[e.id];
    if (bins === undefined) {
      rows.push([
        e.id,
        '无本地可执行文件',
        '',
        '该引擎没有登记可执行文件名（例如只有模型权重或只有远程服务），无需探测。',
      ]);
      continue;
    }
    if (bins.length === 0) {
      rows.push([e.id, '无需探测', '', '该引擎没有本地可执行文件（远程服务 / 模型权重包）。']);
      continue;
    }

    // 第一站：应用托管目录（与 Rust 的探测顺序一致：托管目录 → PATH → 常见安装路径）。
    // 按文件名在目录里找，而不是拿 MANAGED_LAYOUT 拼路径 —— 那张表在 JS 里也抄过一份，
    // 而它同样漂移过（缺 poppler）。见 loadEngineBinaries() 的注释。
    //
    // 找**两个**根：仓库的 `engines/`（`enginectl install` 装的）与
    // 应用数据目录的 `engines/`（应用里一键装的）。只找前者会在"应用装过、仓库没装"的
    // 机器上把所有引擎报成"未检测到" —— 那是一条**看着正常、结论全错**的输出。
    const roots = [
      ['仓库', ENGINES_DIR],
      ['应用', path.join(defaultDataDir(), 'engines')],
    ];
    let managed = null;
    let managedRoot = null;
    for (const [label, dir] of roots) {
      const found = findManagedBinary(path.join(dir, e.id), bins);
      if (found) {
        managed = found;
        managedRoot = label;
        break;
      }
    }
    if (managed) {
      rows.push([
        e.id,
        `已安装（${managedRoot}托管）`,
        readVersion(managed, e.id) ?? '',
        managed,
      ]);
      continue;
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
// verify
// ---------------------------------------------------------------------------

/**
 * 在托管目录里找一个可执行文件。
 *
 * **不用 `MANAGED_LAYOUT` 去拼路径**，而是按候选文件名在目录里**浅层递归查找**：
 * 真实布局在不同平台/不同归档下并不一致 ——
 * 7-Zip 的 MSI 把文件放在 `Files/7-Zip/7z.exe`，LibreOffice 的入口是 `program/soffice.com`
 * （`soffice.exe` 是 GUI 启动器，跑 `--version` 会挂住），
 * Python 的托管布局又是 `python.exe` 直接躺在根下。
 * 把这几张表在 JS 里再抄一遍，就又多了一处会漂移的东西；
 * 按名字找则天然跟着实际布局走。
 */
function findManagedBinary(dir, names, depth = 3) {
  if (depth < 0 || !existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const wanted = names.map((n) => n.toLowerCase());
  const suffix = process.platform === 'win32' ? '.exe' : '';
  // 先看本层（同层命中优先，避免舍近求远）
  for (const e of entries) {
    if (!e.isFile()) continue;
    const base = e.name.toLowerCase();
    const stem = suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
    if (wanted.includes(stem) || wanted.includes(base)) {
      const full = path.join(dir, e.name);
      if (!isRejectedBinary(full)) return full;
    }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findManagedBinary(path.join(dir, e.name), names, depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * 校验**本地已有的模型权重**是不是和预置的 SHA-256 一致。
 *
 * # 为什么这个子命令值得存在
 *
 * 因为"文件在 ≠ 文件能用"，而且这**不是理论**：本仓库实测撞过一次 ——
 * 一次被中断的下载把 928 MB 的 `birefnet-general` 截成了 **0 字节**，
 * 而当时"装好了吗"的判据是 `Path::is_file()`，0 字节同样为真。于是界面显示「已就绪」、
 * 节点把空文件交给 onnxruntime、用户看到的是「抠图脚本执行失败」，
 * 真正的原因埋在 Python 的 stderr 里，跟"文件是空的"隔了三层。
 *
 * 应用侧现在有两层防线（状态接口不再谎报 + 节点在推理前拦一道），但它们都是
 * **运行时的兜底**。这个子命令补的是**离线、可脚本化**的那一层：
 * 不启动应用、不需要网络，逐字节算一遍哈希，并明确报出 0 字节 / 明显截断的文件。
 *
 * # 判据
 *
 * * 权重文件**不存在** → 记"未下载"，**不算失败**（权重本来就是按需下载的）；
 * * 存在但 0 字节 / 不足标称体积 60% → **失败**（与 Rust 侧同一条判据）；
 * * 存在且能算出哈希 → 与预置 `sha256` 比对，不一致 → **失败**；
 * * 预置 `sha256` 为 null（还没回填）→ 只打印实际哈希，**不算失败**（但会警告）。
 *
 * 引擎那一侧**不做哈希校验**：`engine-sources.json` 里的 sha256 是**压缩包**的哈希，
 * 而本地是解压后的目录，两者不可比。所以引擎只报"托管目录在不在、版本是多少"，
 * 以及该平台有没有固定哈希（有 URL 没哈希 = 只能系统安装）。
 */
async function cmdVerify(opts) {
  const catalog = await loadEngineCatalog();
  const binaries = await loadEngineBinaries();
  const sources = await loadSources();
  const plat = platformKey();
  const dataDir = opts.dataDir ?? defaultDataDir();

  const byId = new Map();
  for (const s of sources) {
    if (!byId.has(s.id)) byId.set(s.id, {});
    byId.get(s.id)[s.platform] = s;
  }

  // ---- 引擎：只报事实（托管目录 / 版本 / 是否有固定哈希）----
  //
  // 找**两个**托管根目录：仓库的 `engines/`（`enginectl install` 的结果）
  // 与应用数据目录下的 `engines/`（应用里一键安装的结果）。
  // 早先只找仓库那一个，于是本机 12 个引擎明明都装好了，这一列却全是 `—` ——
  // 一份"看着正常、结论全错"的表。
  const engineRows = [];
  for (const e of catalog) {
    const names = binaries[e.id] ?? [];
    let managed = null;
    let root = null;
    if (names.length > 0) {
      const candidates = [
        ['仓库', path.join(ENGINES_DIR, e.id)],
        ['应用', path.join(dataDir, 'engines', e.id)],
      ];
      for (const [label, dir] of candidates) {
        const found = findManagedBinary(dir, names);
        if (found) {
          managed = found;
          root = label;
          break;
        }
      }
    }
    const src = byId.get(e.id)?.[plat];
    engineRows.push({
      id: e.id,
      managed,
      root,
      version: managed ? (readVersion(managed, e.id) ?? null) : null,
      pinnedHash: Boolean(src?.sha256),
      hasSource: Boolean(src?.url),
    });
  }

  // ---- 权重：**逐个算哈希**（这才是这个子命令的意义）----
  const models = catalog.flatMap((e) => (e.models ?? []).map((m) => ({ ...m, engineId: e.id })));
  const weightRows = [];
  let failures = 0;

  for (const m of models) {
    const file = path.join(dataDir, 'models', m.id, m.fileName);
    const row = {
      id: m.id,
      engineId: m.engineId,
      path: file,
      expected: m.sha256 ? String(m.sha256).replace(/^sha256:/i, '').toLowerCase() : null,
      actual: null,
      bytes: null,
      verdict: 'missing',
    };

    if (!existsSync(file)) {
      weightRows.push(row);
      continue;
    }

    const size = statSync(file).size;
    row.bytes = size;
    if (!sizeLooksComplete(size, m.approxSizeMb)) {
      row.verdict = size === 0 ? 'empty' : 'truncated';
      failures += 1;
      weightRows.push(row);
      continue;
    }

    const { sha256, bytes } = await hashFile(file);
    row.actual = sha256;
    row.bytes = bytes;
    if (!row.expected) {
      row.verdict = 'unpinned';
    } else if (row.expected === sha256) {
      row.verdict = 'ok';
    } else {
      row.verdict = 'mismatch';
      failures += 1;
    }
    weightRows.push(row);
  }

  // ---- 输出 ----
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          platform: plat,
          dataDir,
          enginesDir: ENGINES_DIR,
          engines: engineRows,
          weights: weightRows,
          failures,
        },
        null,
        2,
      ),
    );
  } else {
    info(`权重与引擎校验（离线，逐字节算哈希）`);
    info(`  平台        ${plat}`);
    info(`  数据目录    ${dataDir}`);
    info(`  仓库引擎目录 ${path.relative(ROOT, ENGINES_DIR)}\n`);

    const VERDICT = {
      ok: '✓ 与预置哈希一致',
      mismatch: '✗ 哈希不一致',
      empty: '✗ 文件是 0 字节',
      truncated: '✗ 明显不完整',
      unpinned: '· 未回填哈希（只报实际值）',
      missing: '· 未下载（不算失败）',
    };
    printTable(
      ['权重', '体积', '预置哈希', '实际哈希', '结论'],
      weightRows.map((r) => [
        r.id,
        r.bytes === null ? '—' : humanSize(r.bytes),
        r.expected ? r.expected.slice(0, 12) : '（无）',
        r.actual ? r.actual.slice(0, 12) : '—',
        VERDICT[r.verdict],
      ]),
    );

    info('\n引擎（托管目录 / 版本 / 该平台下载源是否有固定哈希）：');
    printTable(
      ['引擎', '托管安装', '版本', '下载源'],
      engineRows.map((r) => [
        r.id,
        r.managed ? `${r.root}托管` : '—',
        (r.version ?? '').slice(0, 46),
        !r.hasSource ? '（该平台无来源）' : r.pinnedHash ? '已固定哈希' : '有 URL，哈希待回填',
      ]),
    );
    const found = engineRows.filter((r) => r.managed).length;
    info(
      `\n  托管安装 ${found}/${engineRows.length} 个（` +
        `仓库 ${path.relative(ROOT, ENGINES_DIR)}/ 与应用数据目录 engines/ 都查了）。` +
        '\n  引擎侧**不做哈希校验**：来源表里的 sha256 是**压缩包**的哈希，' +
        '而本地是解压后的目录，两者不可比。',
    );

    const broken = weightRows.filter((r) => ['mismatch', 'empty', 'truncated'].includes(r.verdict));
    if (broken.length > 0) {
      console.error('');
      for (const r of broken) {
        console.error(`❌ ${r.id}：${VERDICT[r.verdict]}（${humanSize(r.bytes)}）`);
        console.error(`   文件：${r.path}`);
        if (r.verdict !== 'empty' && r.verdict !== 'truncated') {
          console.error(`   预置：${r.expected}\n   实际：${r.actual}`);
        }
        console.error(
          '   处理：删掉这个文件后重新下载（应用里「设置 → 引擎管理 → 模型权重」，' +
            '或让任务重新触发下载）—— 下载会重新做 SHA-256 校验。',
        );
      }
    }

    const unpinned = weightRows.filter((r) => r.verdict === 'unpinned');
    if (unpinned.length > 0) {
      warn(
        `${unpinned.length} 个已有权重没有预置 sha256，无法判断是否被篡改/截断：\n` +
          unpinned.map((r) => `   ${r.id}  实际 ${r.actual}`).join('\n') +
          `\n   回填到 crates/toolforge-core/src/engine.rs 对应条目的 sha256 字段。`,
      );
    }

    info(`\n合计：${weightRows.length} 个权重，${failures} 个有问题。`);
  }

  if (failures > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

/**
 * 清理**已经证明坏掉**的权重文件，以及本脚本自己的下载临时文件。
 *
 * # 为什么默认是"只看不删"
 *
 * 这个子命令会**删用户的文件**。§3.10（「保留源文件」）与 §3.15（一次事故）都说明了
 * 同一件事：删文件这件事，**默认值必须在安全的那一侧**。所以：
 *
 * * 不带 `--apply` 时**什么都不删**，只打印"如果加 --apply 会删哪些"；
 * * 带 `--apply` 时，一个文件要被删掉必须**同时**满足两条：
 *   ① 体积可疑（0 字节 / 不足标称体积 60%）—— 与 `verify` / Rust 侧同一条判据；
 *   ② **算过哈希且与预置值不符**（0 字节与截断文件必然不符）。
 *   只凭体积可疑**不删**：`approx_size_mb` 是"约"，误删一个完好权重比留着一个坏文件糟得多。
 * * 没有预置哈希的权重**一律不删**（无法证明它坏了），只报告。
 *
 * 另外会清 `<仓库>/engines/.downloads/` 里 `install` 留下的压缩包 —— 那是本脚本自己的
 * 临时目录，不是用户数据（`install` 默认下完即删，`--keep-archive` 才会留下）。
 */
async function cmdClean(opts) {
  const catalog = await loadEngineCatalog();
  const dataDir = opts.dataDir ?? defaultDataDir();
  const models = catalog.flatMap((e) => (e.models ?? []).map((m) => ({ ...m, engineId: e.id })));

  const candidates = []; // 权重
  const skipped = []; // 体积可疑但证明不了坏的

  for (const m of models) {
    const file = path.join(dataDir, 'models', m.id, m.fileName);
    if (!existsSync(file)) continue;
    const size = statSync(file).size;
    if (sizeLooksComplete(size, m.approxSizeMb)) continue;

    const expected = m.sha256 ? String(m.sha256).replace(/^sha256:/i, '').toLowerCase() : null;
    if (!expected) {
      skipped.push({ id: m.id, path: file, bytes: size, why: '没有预置 SHA-256，无法证明它坏了' });
      continue;
    }
    const { sha256 } = await hashFile(file);
    if (sha256 === expected) {
      skipped.push({
        id: m.id,
        path: file,
        bytes: size,
        why: `体积只有标称的 ${Math.round((size / ((m.approxSizeMb || 1) * 1024 * 1024)) * 100)}%，但哈希与预置值**一致**（说明标称体积不准），不删`,
      });
      continue;
    }
    candidates.push({
      id: m.id,
      path: file,
      bytes: size,
      why: size === 0 ? '文件是 0 字节' : '明显不完整',
      expected,
      actual: sha256,
    });
  }

  // 本脚本自己的下载临时文件
  const archives = existsSync(DOWNLOAD_DIR)
    ? readdirSync(DOWNLOAD_DIR).map((n) => path.join(DOWNLOAD_DIR, n))
    : [];

  info('enginectl clean —— 只清**已经证明坏掉**的权重，以及本脚本自己的下载临时文件\n');
  info(`  数据目录      ${dataDir}`);
  info(`  下载临时目录  ${path.relative(ROOT, DOWNLOAD_DIR)}（${archives.length} 个文件）\n`);

  if (candidates.length === 0 && archives.length === 0) {
    info('✓ 没有需要清理的东西。');
    return;
  }

  if (candidates.length > 0) {
    printTable(
      ['权重', '体积', '坏在哪', '预置哈希', '实际哈希'],
      candidates.map((c) => [
        c.id,
        humanSize(c.bytes),
        c.why,
        c.expected.slice(0, 12),
        c.actual.slice(0, 12),
      ]),
    );
  }
  if (archives.length > 0) {
    info('\n下载临时文件：');
    for (const a of archives) {
      info(`  ${path.relative(ROOT, a)}  ${humanSize(statSync(a).size)}`);
    }
  }

  if (skipped.length > 0) {
    info('\n以下文件**体积可疑但证明不了坏**，因此不会删（请自行判断）：');
    for (const s of skipped) info(`  ${s.id}  ${humanSize(s.bytes)}  —— ${s.why}`);
  }

  if (!opts.apply) {
    info(
      `\n以上**一个都没删**（默认只看不动）。要真的删掉它们：\n` +
        `  node scripts/enginectl.mjs clean --apply\n` +
        `删掉之后，下次用到该权重时会重新下载并做 SHA-256 校验。`,
    );
    return;
  }

  let removed = 0;
  for (const c of candidates) {
    try {
      await rm(c.path, { force: true });
      removed += 1;
      info(`  已删除 ${c.path}`);
    } catch (e) {
      warn(`删除失败 ${c.path}：${e.message}`);
    }
  }
  for (const a of archives) {
    try {
      await rm(a, { force: true });
      removed += 1;
      info(`  已删除 ${path.relative(ROOT, a)}`);
    } catch (e) {
      warn(`删除失败 ${a}：${e.message}`);
    }
  }
  info(`\n共删除 ${removed} 个。下次用到这些权重时会重新下载（并做 SHA-256 校验）。`);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const USAGE = `enginectl —— ToolForge 引擎开发辅助脚本

用法：
  node scripts/enginectl.mjs list                     打印引擎目录表
  node scripts/enginectl.mjs probe [id]               探测引擎是否已安装（默认全部）
  node scripts/enginectl.mjs install <id> [选项]      下载并解压到 engines/<id>/
  node scripts/enginectl.mjs verify [选项]            校验本地权重与预置哈希是否一致
  node scripts/enginectl.mjs clean [选项]             清理**已证明坏掉**的权重与下载临时文件

install 选项：
  --keep-archive           保留下载的压缩包（默认下完即删）
  --idle-timeout <秒>      下载空闲超时，默认 60 秒（超过该时长没有新数据就中止）
  --help

verify 选项：
  --json                   输出机器可读的 JSON（便于 CI 断言）
  --data-dir <路径>        覆盖应用数据目录（默认按平台推断，与 Rust 侧 AppPaths 一致）

clean 选项：
  --apply                  **真的删**（默认只看不动：只打印"会删哪些"）
  --data-dir <路径>        同 verify

退出码：0 成功 / 1 失败（含网络不可用、权重哈希不一致、权重文件为 0 字节）。
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
    case 'verify': {
      const idx = argv.indexOf('--data-dir');
      const dataDir = idx >= 0 ? argv[idx + 1] : null;
      if (idx >= 0 && (!dataDir || dataDir.startsWith('-'))) {
        fail('--data-dir 需要一个路径', `收到的是：${argv[idx + 1] ?? '(空)'}`);
      }
      await cmdVerify({ json: argv.includes('--json'), dataDir });
      break;
    }
    case 'clean': {
      const idx = argv.indexOf('--data-dir');
      const dataDir = idx >= 0 ? argv[idx + 1] : null;
      if (idx >= 0 && (!dataDir || dataDir.startsWith('-'))) {
        fail('--data-dir 需要一个路径', `收到的是：${argv[idx + 1] ?? '(空)'}`);
      }
      await cmdClean({ apply: argv.includes('--apply'), dataDir });
      break;
    }
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
      fail(
        `未知子命令：${cmd}`,
        '可用子命令：list / probe / install / verify / clean。用 --help 看完整用法。',
      );
  }
}

main().catch((e) => {
  fail('脚本内部错误', e?.stack ?? String(e));
});
