/**
 * 共享的 CDP（Chrome DevTools Protocol）客户端 + 测试素材生成器。
 *
 * ## 为什么这个文件存在
 *
 * ToolForge 的 UI 跑在 WebView2 里，而 WebView2 的内容由**独立的合成进程**绘制。
 * 这意味着：
 *
 * * `PrintWindow` 之类的窗口截图**抓不到 WebView 的内容** —— 它只能抓到窗口背景。
 *   我第一版据此得出过"应用白屏"的结论；结论碰巧对了（当时确实白屏），
 *   但理由是错的 —— 而靠巧合得出的正确结论，下次会以同样的方式给出错误结论。
 * * 想真正验证"用户看到什么"，只有一个可靠途径：**问 WebView 自己**。
 *
 * 这就是 CDP 的用途。它由 WebView 提供、看到的就是渲染结果，而且能读异常。
 *
 * ## 前提
 *
 * 应用必须带远程调试端口启动：
 *
 * ```powershell
 * $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*"
 * pnpm tauri:dev
 * ```
 *
 * 用 `scripts/devtools/dev-with-cdp.ps1` 可以一步到位。
 *
 * ## 这个目录下的工具
 *
 * | 脚本 | 作用 |
 * |---|---|
 * | `inspect.mjs` | 单页体检：`#root` 挂载状态、DOM 文本、运行时异常、真实截图 |
 * | `smoke.mjs`   | 逐个路由走一遍，报节点数 / 文本量 / 骨架屏 / 新异常 |
 * | `e2e.mjs`     | 提交一次真实转换任务并轮询到终态 |
 * | `verify.mjs`  | 解码校验 + 多文件扇出 + **恶意插件端到端安全测试** |
 * | `run.mjs`     | 依次跑上面全部，给一份汇总 |
 *
 * ## 它们抓到过什么
 *
 * 这四个脚本一共找出 3 个**发布级**缺陷，而当时
 * `cargo check` / 194 个单测 / `tsc` / `vite build` **全绿**：
 *
 * 1. `freezePrototype: true` 与 `@xyflow/react` 冲突 → 前端白屏（`inspect.mjs`）；
 * 2. `PathResolver` 一律拒绝绝对路径 → **任何真实转换都失败**（`e2e.mjs`）；
 * 3. 路径逃逸尝试不被审计（`verify.mjs` 的安全测试 + 人工看日志）。
 *
 * 共同点是"**组件各自正确，连起来不对**" —— 单元测试验证组件，集成测试验证
 * 接口形状，而真实数据流只有真跑一次才会经过。
 */

import { deflateSync, inflateSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CDP_PORT = Number(process.env.TOOLFORGE_CDP_PORT ?? 9222);
export const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;

/** 仓库根目录（本文件在 `<repo>/scripts/devtools/`） */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 测试素材与产物的落盘位置。
 *
 * 放在 `.tools/smoke/` 下（已被 `.gitignore` 忽略），不污染仓库。
 */
export const SMOKE_DIR = join(REPO_ROOT, '.tools', 'smoke');

/** 探一下 CDP 是否可用，不可用时给出可操作的提示而不是一个 ECONNREFUSED */
export async function ensureCdpAvailable() {
  try {
    const r = await fetch(`${CDP_BASE}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    throw new Error(
      `连不上 WebView 的调试端口 ${CDP_BASE}（${e.message}）。\n` +
        `请确认应用是**带 CDP 启动**的：\n` +
        `  PowerShell:  .\\scripts\\devtools\\dev-with-cdp.ps1\n` +
        `  或手动:      $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=${CDP_PORT} --remote-allow-origins=*"; pnpm tauri:dev`
    );
  }
}

/**
 * 连上主窗口的调试目标。
 *
 * 返回的对象提供 `evaluate` / `invoke` / `close`，并持续收集页面异常。
 */
export async function connect() {
  const targets = await ensureCdpAvailable();
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    throw new Error(`调试端口上没有 page 目标，只有：${JSON.stringify(targets)}`);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  /** 页面抛出的异常与 console.error，按出现顺序累积 */
  const errors = [];

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(`[exception] ${(d.exception?.description ?? d.text).split('\n')[0]}`);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(`[console.error] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  await send('Runtime.enable');
  await send('Page.enable');

  /**
   * 在页面里求值并取回结果（页面抛错 → JS 侧抛错）。
   *
   * ## 报错必须把**真实原因**带出来
   *
   * 原来只有一句 `exception?.description ?? text`。而 CDP 的
   * `exceptionDetails.exception.description` **只有当异常是 Error 实例时才有**；
   * 页面 reject 一个**普通对象**（Tauri 的错误就是这么走的）时它是 undefined，
   * 于是 fallback 到 `text` —— 那也是 undefined，最后抛出一句
   * `Error: Object`。**真实原因被自己的错误处理吃掉了。**
   *
   * 现在把能拿到的都摊开：description、text、以及异常对象的 JSON。
   * 排查"脚本为什么挂"时，这三样至少有一个能说清。
   */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const parts = [];
      if (d.exception?.description) parts.push(d.exception.description);
      if (d.text && d.text !== 'Uncaught') parts.push(`text=${d.text}`);
      if (d.exception?.value !== undefined) {
        try {
          parts.push(`value=${JSON.stringify(d.exception.value)}`);
        } catch {
          parts.push('value=(无法序列化)');
        }
      }
      if (d.exception?.preview) {
        try {
          parts.push(`preview=${JSON.stringify(d.exception.preview)}`);
        } catch {
          /* 预览拿不到就算了 */
        }
      }
      const err = new Error(parts.length ? parts.join(' | ') : '页面抛出了一个无法描述的值');
      err.cdpException = d;
      err.expression = expression.slice(0, 400);
      throw err;
    }
    return r.result.value;
  };

  /**
   * 调用一个 Tauri 命令。
   *
   * ⚠️ 这里直接调 `__TAURI_INTERNALS__.invoke`，**不是** `bindings.ts` 里包装过的
   * `commands.xxx`。两者的返回形状不同：
   *
   * * 包装过的会返回 `{status:"ok",data} | {status:"error",error}`；
   * * 裸 invoke **直接 resolve 命令的 Ok 值、reject 命令的 Err**。
   *
   * 我第一版就是照 `bindings.ts` 的形状去判 `status !== "ok"`，
   * 把一个**成功**的提交当成了失败 —— 测试脚本自身的假设错了，不是应用的问题。
   */
  const invoke = (cmd, args = {}) =>
    evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
    );

  /** 轮询到任务终态；超时返回最后一次快照 */
  const waitJob = async (jobId, tries = 60, intervalMs = 500) => {
    for (let i = 0; i < tries; i++) {
      await sleep(intervalMs);
      const j = await invoke('jobs_get', { jobId });
      if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    }
    return await invoke('jobs_get', { jobId });
  };

  return { page, evaluate, invoke, waitJob, send, errors, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简断言器：把"通过/失败/跳过"计数与打印收在一处，避免每个脚本各写一套 */
export class Checker {
  constructor(title) {
    this.pass = 0;
    this.fail = 0;
    this.skip = 0;
    if (title) console.log(`\n${title}`);
  }
  check(ok, label, extra = '') {
    console.log(`${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
    ok ? this.pass++ : this.fail++;
    return ok;
  }
  /**
   * 记一次**跳过**（前置条件不满足：缺引擎、缺权重、缺 API Key…）。
   *
   * 为什么一定要和"通过"分开计数：这两件事以前都写成
   * `c.check(true, '前置条件不满足，已显式记为跳过')` —— 打印出来是绿的 `✅`，
   * 最后也被算进"N 通过"。于是"本机没装 X，8 条检查全跳过"和
   * "8 条检查真的都验过了"在汇总里**长得一模一样**，而标签上还写着
   * "不是『通过』" —— 那句话对汇总数字而言是假的。
   * 现在跳过打 `⏭`，单独计数，并且**不计入**通过数。
   */
  skip(label, extra = '') {
    console.log(`⏭ ${label}${extra ? '  ' + extra : ''}`);
    this.skip++;
  }
  section(title) {
    console.log(`\n${title}`);
  }
  note(text) {
    console.log(`   ${text}`);
  }
  summary() {
    const skips = this.skip ? ` / ${this.skip} 跳过（跳过不计入通过）` : '';
    console.log(`\n================ ${this.pass} 通过 / ${this.fail} 失败${skips} ================`);
    return this.fail === 0;
  }
}

// ============================================================================
// 测试素材生成（零依赖）
// ============================================================================

function crc32(buf) {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const cb = Buffer.alloc(4);
  cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, cb]);
}

/** 生成一张可预测的渐变色 PNG（不用 sharp/canvas 这类依赖） */
export function makePng(width, height, seed = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = (x * 255 / width) | 0;
      raw[o + 1] = (y * 255 / height) | 0;
      raw[o + 2] = (seed * 40) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: zlibConstants.Z_DEFAULT_COMPRESSION })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 把测试输入写到 `<repo>/.tools/smoke/in/`，返回路径 */
export function writeInputPng(name, width, height, seed = 0) {
  const dir = join(SMOKE_DIR, 'in');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, makePng(width, height, seed));
  return p;
}

// ---------------------------------------------------------------------------
// 最小 DOCX（给 `doc.to-pdf` 用的输入素材）
// ---------------------------------------------------------------------------
//
// 为什么要手写一个：`doc.to-pdf` 的输入端口只收 Office 扩展名
// （`.doc .docx .xls .xlsx .ppt .pptx .odt .ods .odp`），而仓库里**不存二进制测试素材**。
// 之前 `ebook.convert` 那一节是用 pandoc 现造 epub 的（依赖另一个引擎），
// 这对一条"验证 LibreOffice"的检查来说是个多余的前置条件 —— 没有 pandoc 的机器上，
// 整节会被跳过，而它本该独立成立。
//
// DOCX 就是一个 ZIP，最小可用集合是三个条目：
// `[Content_Types].xml` + `_rels/.rels` + `word/document.xml`。
// 这里只写"存储"（不压缩）条目 —— 省掉 deflate，用系统 tar 就能验证结构。
// CRC 复用上面 `crc32()`（PNG 分块用的同一个），不另写一份。

/** 把一个 entry 列表打成 ZIP（全部用 stored，不压缩） */
/**
 * 把 `[名字, 内容]` 列表打成一个 ZIP（全部 stored，不压缩）。
 *
 * 导出给验证脚本用：需要"一个**带目录层级**的压缩包"当素材时，
 * 手搓一个 stored ZIP 比依赖系统 `tar`/`zip` 命令可靠得多
 * （Windows 的 bsdtar 能读 zip，但 Linux/macOS 的 GNU tar 不写 zip）。
 */
export function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** 生成一份最小但合法、LibreOffice 能打开的 `.docx` */
export function makeDocx(text) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = String(text)
    .split('\n')
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`)
    .join('');
  return zipStore([
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs}</w:body>
</w:document>`,
    ],
  ]);
}

/**
 * 生成一份**最小但合法**的多页 PDF（每页一个大号字）。
 *
 * ## 为什么要自己造
 *
 * `doc.ocr` 的 PDF 路径要有 PDF 才能验，而这个仓库里没有、也不该有二进制测试素材：
 * 一份几十 KB 的 PDF 一旦入库就再也没人知道它是怎么来的。
 * 手写的好处是**它是什么、有几页、每页写的是什么都一目了然**。
 *
 * 用到的 PDF 语法只有必需的那几样：catalog / pages 树 / page / Helvetica 字体 /
 * 一个画一行字的 content stream。**xref 表的字节偏移是真算出来的**，不是编的 ——
 * 少数阅读器会容忍坏掉的 xref（poppler 就会尝试重建），但"能容忍"不该被当成
 * "可以写错"：那样测出来的通过说明不了任何事。
 *
 * @param {string[]} pageTexts 每页一行文字（ASCII；非 ASCII 需要嵌入字体，这里不做）
 * @param {[number, number]} size 页面尺寸（点，1/72 英寸）
 */
export function makePdf(pageTexts, size = [420, 200]) {
  const enc = (s) => Buffer.from(s, 'latin1');
  const objects = [];

  // 1: catalog, 2: pages, 3: font —— 固定编号，页对象从 4 开始，每页两个（page + contents）
  const pageIds = pageTexts.map((_, i) => 4 + i * 2);
  const contentIds = pageTexts.map((_, i) => 5 + i * 2);

  objects[1] = enc(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects[2] = enc(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`
  );
  objects[3] = enc(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  pageTexts.forEach((text, i) => {
    const content = `BT /F1 36 Tf 24 80 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
    objects[pageIds[i]] = enc(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size[0]} ${size[1]}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[i]} 0 R >>`
    );
    objects[contentIds[i]] = enc(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
    );
  });

  const total = objects.length; // 最大编号 + 1（对象从 1 开始编号）
  let out = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offsets = [];
  for (let i = 1; i < total; i++) {
    offsets[i] = out.length;
    out = Buffer.concat([out, enc(`${i} 0 obj\n`), objects[i], enc('\nendobj\n')]);
  }
  const xrefStart = out.length;

  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out = Buffer.concat([
    out,
    enc(xref),
    enc(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`),
  ]);
  return out;
}

/** 把测试用 PDF 写到 `<repo>/.tools/smoke/in/`，返回路径 */
export function writeInputPdf(name, pageTexts, size) {
  const dir = join(SMOKE_DIR, 'in');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, makePdf(pageTexts, size));
  return p;
}

/** 准备一个干净的输出目录，返回路径 */
export function prepareOutDir(name) {
  const dir = join(SMOKE_DIR, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 解析 WebP 容器，取出真实尺寸与**有损/无损**。
 *
 * **只看文件头 4 字节是不够的** —— 那只能证明"是 RIFF 容器"。
 * 尺寸解码能证明位流本身是完整的（截断的文件会在这里露馅）。
 *
 * 关于有损/无损：libvips 写出来的 WebP 外面套的是 `VP8X`（扩展容器，
 * 用来放 ICC/EXIF/alpha 之类的元信息），**真正的编码块在它里面**。
 * 所以遇到 `VP8X` 不能就此下结论，得继续往里找 `VP8 `（有损）或 `VP8L`（无损）——
 * 否则"装了 libvips 之后是不是真的有损了"这件事就没法验证。
 */
export function webpInfo(buf) {
  if (buf.length < 16) return null;
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buf.subarray(8, 12).toString('ascii') !== 'WEBP') return null;

  let off = 12;
  let container = null;
  let codec = null;
  let width = 0;
  let height = 0;
  let signature = null;

  while (off + 8 <= buf.length) {
    const fourcc = buf.subarray(off, off + 4).toString('ascii');
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);

    if (fourcc === 'VP8L' && body.length >= 5) {
      const bits = body[1] | (body[2] << 8) | (body[3] << 16) | (body[4] << 24);
      codec = 'VP8L';
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
      signature = body[0];
    } else if (fourcc === 'VP8 ' && body.length >= 10) {
      codec = 'VP8';
      width = body.readUInt16LE(6) & 0x3fff;
      height = body.readUInt16LE(8) & 0x3fff;
    } else if (fourcc === 'VP8X' && body.length >= 10) {
      container = 'VP8X';
      width = 1 + (body[4] | (body[5] << 8) | (body[6] << 16));
      height = 1 + (body[7] | (body[8] << 8) | (body[9] << 16));
    }

    // 已经有编码块就不必再找了（VP8X 里的块紧跟在它后面）
    if (codec) break;
    off += 8 + size + (size % 2);
  }

  if (!codec && !container) {
    return { format: '(未知 chunk)', codec: null, lossless: null, width: 0, height: 0, signature: null };
  }
  const label = container ? `${container}(${codec ?? '?'})` : `${codec}(${codec === 'VP8L' ? 'lossless' : 'lossy'})`;
  return {
    format: label,
    codec,
    // `null` = 没能确定（例如只看到 VP8X 却没找到里面的编码块）
    lossless: codec === 'VP8L' ? true : codec === 'VP8' ? false : null,
    width,
    height,
    signature,
  };
}

/**
 * 生成一张"四象限纯色"的 PNG —— 四面**互不相同**、且离中心足够远。
 *
 * 为什么需要它：`image.crop` / `image.rotate` / `image.flip` 这类节点，
 * 「任务成功 + 输出文件存在」**完全不能证明任何事**。一个把参数吃掉的空实现
 * 同样会产出一张合法 PNG。要证明"裁的是哪一块""转的是哪个方向"，
 * 就必须让输出的**像素**说话 —— 而这需要一个每个角都认得出的输入。
 *
 * 四个象限的坐标是刻意不对称的（96×64 的左半比右半宽），
 * 所以"中心裁剪"落点的期望值可以手算，见 `verify-platform.mjs`【32】。
 */
export function makeQuadrantPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      const top = y < height / 2;
      const left = x < width / 2;
      const c = top ? (left ? QUADRANTS.tl : QUADRANTS.tr) : left ? QUADRANTS.bl : QUADRANTS.br;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: zlibConstants.Z_DEFAULT_COMPRESSION })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 四个象限的颜色（左上 / 右上 / 左下 / 右下），四面互不相同、无渐变 */
export const QUADRANTS = {
  tl: [255, 0, 0],
  tr: [0, 255, 0],
  bl: [0, 0, 255],
  br: [255, 255, 255],
};

/** 把一个颜色三元组说成人类可读的名字（断言失败时看得懂） */
export function quadrantName(px) {
  for (const [name, c] of Object.entries(QUADRANTS)) {
    if (px && px[0] === c[0] && px[1] === c[1] && px[2] === c[2]) return name.toUpperCase();
  }
  return px ? `rgb(${px.join(',')})` : '(越界)';
}

/**
 * 极简 PNG 解码器。支持：
 *
 * * **colorType 2（RGB）/ 6（RGBA）**，8 位；
 * * **colorType 3（调色板）**，位深 1 / 2 / 4 / 8（可选 `tRNS` → 带 alpha）；
 * * 非隔行（`interlace = 0`）。
 *
 * 其余（灰度、16 位、Adam7）**返回 `null` 而不是猜** —— 猜出来的像素会让
 * 断言变成"看起来通过了"，那比不检查更糟。
 *
 * 为什么要自己写：要验证 `image.crop` 裁的是哪一块、`image.rotate` 转的是
 * 哪个方向、`image.enhance` 是不是真的动了像素，就得读**像素**。
 * 而 Node 标准库不带图像解码，仓库也刻意不引 sharp/canvas 这类依赖。
 *
 * ⚠️ **必须实现全部 5 种行过滤器**（None/Sub/Up/Average/Paeth）：
 * 我们自己写出来的 PNG 只用 None，但 **`image` crate / libvips 编出来的
 * 输出会用别的**（常见 Paeth）。只实现 None 的话，读自己造的输入永远对、
 * 读节点产出永远错 —— 那会是一条**方向性错误**的断言：越是成功的产出
 * 越会被判为失败（或者更糟：把错的值当成对的）。
 *
 * ⚠️ **调色板支持是被真实数据逼出来的**（`verify-platform.mjs`【34】）：
 * 同一张 96×64 的四色图，三个后端编出来的 PNG **色彩类型各不相同** ——
 * libvips 给 colorType 2、纯 Rust 给 colorType 6、**ImageMagick 给
 * colorType 3 + 位深 2**（它发现只有 4 种颜色就转成了调色板）。
 * 那时本解码器对 colorType 3 返回 null，于是"三档结果一致"这条断言
 * 以"解码失败"收场 —— 而**像素其实是一致的**。也就是说：
 * 拒绝读合法的编码会把"一致"误报成"不一致"。
 */
export function decodePng(buf) {
  if (buf.length < 8 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let palette = null; // PLTE
  let paletteAlpha = null; // tRNS（只对调色板有意义）
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) return null; // 不支持隔行
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      paletteAlpha = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height) return null;

  const indexed = colorType === 3;
  if (indexed) {
    if (!palette || ![1, 2, 4, 8].includes(bitDepth)) return null;
  } else if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    return null;
  }

  const raw = inflateSync(Buffer.concat(idat));
  // 调色板图的行是按**位**打包的，所以步长与"每像素几字节"无关
  const stride = indexed
    ? Math.ceil((width * bitDepth) / 8)
    : width * (colorType === 6 ? 4 : 3);
  if (raw.length < (stride + 1) * height) return null;
  // 过滤器作用在**字节**上，所以左邻偏移是"每像素几字节"，位深 <8 时就是 1
  const bpp = indexed ? 1 : stride / width;
  const scan = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = scan.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; // 左
      const b = prev[i]; // 上
      const c = i >= bpp ? prev[i - bpp] : 0; // 左上
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) return null;
      cur[i] = v & 0xff;
    }
    prev = cur;
  }

  if (!indexed) {
    return { width, height, channels: colorType === 6 ? 4 : 3, data: scan, colorType };
  }

  // 调色板 → RGB（有 tRNS 就 → RGBA）
  const channels = paletteAlpha ? 4 : 3;
  const out = Buffer.alloc(width * height * channels);
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = scan[y * stride + Math.floor(x / perByte)];
      // 高位的像素在左（PNG 规定）
      const shift = 8 - bitDepth * ((x % perByte) + 1);
      const idx = (byte >> shift) & mask;
      const p = idx * 3;
      if (p + 2 >= palette.length) return null; // 索引越界 = 文件坏了，不猜
      const o = (y * width + x) * channels;
      out[o] = palette[p];
      out[o + 1] = palette[p + 1];
      out[o + 2] = palette[p + 2];
      if (channels === 4) out[o + 3] = idx < paletteAlpha.length ? paletteAlpha[idx] : 255;
    }
  }
  return { width, height, channels, data: out, colorType };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 取某个像素的 `[r,g,b]`（越界返回 `null`，而不是抛异常 —— 断言里更想看到"(越界)"） */
export function pixelAt(img, x, y) {
  if (!img) return null;
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const o = (y * img.width + x) * img.channels;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

/** 内置的示例插件 id —— 这些随应用分发，DevTools 用它们做真实任务测试 */
export const BUILTIN_PLUGINS = {
  imageConvert: 'com.toolforge.builtin.image-convert',
  batchRename: 'com.toolforge.builtin.batch-rename',
  videoToGif: 'com.toolforge.builtin.video-to-gif',
  removeBg: 'com.toolforge.builtin.remove-bg',
};
