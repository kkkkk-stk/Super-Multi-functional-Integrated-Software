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

import { deflateSync, constants as zlibConstants } from 'node:zlib';
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

/** 极简断言器：把"通过/失败"计数与打印收在一处，避免每个脚本各写一套 */
export class Checker {
  constructor(title) {
    this.pass = 0;
    this.fail = 0;
    if (title) console.log(`\n${title}`);
  }
  check(ok, label, extra = '') {
    console.log(`${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
    ok ? this.pass++ : this.fail++;
    return ok;
  }
  section(title) {
    console.log(`\n${title}`);
  }
  note(text) {
    console.log(`   ${text}`);
  }
  summary() {
    console.log(`\n================ ${this.pass} 通过 / ${this.fail} 失败 ================`);
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

/** 内置的示例插件 id —— 这些随应用分发，DevTools 用它们做真实任务测试 */
export const BUILTIN_PLUGINS = {
  imageConvert: 'com.toolforge.builtin.image-convert',
  batchRename: 'com.toolforge.builtin.batch-rename',
  videoToGif: 'com.toolforge.builtin.video-to-gif',
  removeBg: 'com.toolforge.builtin.remove-bg',
};
