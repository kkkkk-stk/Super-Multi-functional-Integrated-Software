/**
 * 假的 OpenAI 兼容端点（只用于真机验证，不是产品代码）。
 *
 * ## 为什么需要一个假端点
 *
 * `ai.describe` / `doc.ocr` 需要一个**视觉模型**才能跑。真模型要有 API Key、
 * 要联网、要花钱，而且同一张图两次回答还不一样 —— 这样的东西没法写进
 * 自动化验证。但"没法用真模型验证"**不等于**"没法验证"：
 * 我们能验的是**自己这一侧**：
 *
 *   1. 图片有没有被正确地压成 JPEG 并内联成 data URL 发出去；
 *   2. 请求体形状对不对（`content` 是数组、有 `image_url`、有 `text`）；
 *   3. 响应被正确解析成节点输出（`${steps.<id>.text}` 拿得到）；
 *   4. 下游节点能不能拿这段文本继续干活。
 *
 * 这四条恰恰是最容易写错、也最难靠肉眼发现的部分。真模型的"答得好不好"
 * 属于模型能力，不属于我们的正确性。
 *
 * ## 它还兼任"插件生成器"（【20】）
 *
 * 产品的招牌能力是"用一句话描述，它自己长出一个插件"。这条链路此前**从未被跑过**：
 * 它要一个**会按约定吐 YAML 的模型**，而真模型不可复现（同一个需求两次生成的
 * 插件不一样，还会偶发不合规）。所以这个 mock 也负责扮演那个模型：
 *
 *   * 请求里出现 `[mock:draft]` → 回一份**合规的 L1 插件草稿**；
 *   * 请求里出现 `[mock:malicious]` → 回一份**越权的草稿**（绝对路径写入 + exec），
 *     用来验证"审核必须拦下它"；
 *   * 请求里出现 `[mock:broken]` → 回一份**语法合法但引用未声明端口**的草稿
 *     （`${output.resized}` 而没声明 `resized`）—— 这是 AI 生成最常见的错法，
 *     它必须在校验阶段就红，而不是装上去跑起来才报"模板变量无法解析"；
 *   * 其它（有没有图）→ 维持原来的视觉回答，行为一点不变。
 *
 * 这样验证脚本能断言的是**我们这一侧**：草稿解析、静态审核、审计落盘、
 * 以及"装上去真的能跑出东西"。模型答得好不好仍然不在验证范围内，这一点要写清楚。
 *
 * 用法：`node scripts/devtools/mock-openai.mjs [port]`（默认 18123）
 * 它会把每次收到的请求摘要打到 stdout，并在响应里**回显**它收到了几张图、
 * 第一张图有多大 —— 验证脚本就靠这个断言。
 */

import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 18123);

/** 记录收到的请求摘要，供 /__received 查询 */
const received = [];

/**
 * 从 JPEG 字节里读出宽高（扫 SOF 段）。
 *
 * 为什么这个 mock 要在意图片尺寸：`doc.ocr` 的 PDF 栅格化有一个 `pdfDpi`
 * 参数，而"DPI 到底有没有生效"只能从**渲染出来的像素尺寸**看出来 ——
 * A4 在 200 DPI 下是 1654×2339，在 100 DPI 下是 827×1169。
 * 假端点拿到的是 base64 图片，顺手读一下 SOF 就能把这件事钉死，
 * 否则那个参数就是个没人验过的旋钮。
 */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // 无长度字段的标记：SOI / TEM / RSTn
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15，但要排掉 DHT(c4) / JPG(c8) / DAC(cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url ?? '';

    // 供测试脚本查询"到底收到了什么"
    if (url === '/__received') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(received));
      return;
    }
    if (url === '/__reset') {
      received.length = 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // ---- "话多的网关"：把请求原样回显（含 Authorization 头）----
    //
    // ⚠️ 这一段必须排在 `/models` **之前**。第一版放在后面，于是
    // `ai_test_connection`（它走的是列模型那条路）先撞上 `/models` 的 200，
    // 压根没有失败 —— 脱敏断言于是**空过**（"错误信息里没有密钥"，
    // 因为根本没有错误信息）。检查自己会跑偏这件事，只能靠"断言前置条件"挡。
    //
    // 这不是编出来的场景：代理 / 网关 / 开着调试模式的后端**真的会**把请求回显在
    // 响应体里，而那段响应体正是应用截下来放进错误 detail 给用户看的东西 ——
    // 于是一个密钥就可能顺着"看得到的错误信息"漏出去。
    // 用真实请求头回显（而不是我编一个字符串），才能验到应用**真的**在脱敏。
    if (url.includes('__echo')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'upstream rejected the request',
            request: { url, headers: req.headers, body: body.slice(0, 200) },
          },
        })
      );
      return;
    }

    if (url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-vision' }, { id: 'mock-text' }] }));
      return;
    }

    if (!url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route for ${url}` } }));
      return;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid json' } }));
      return;
    }

    // ---- 把请求形状摘出来 ----
    const messages = parsed.messages ?? [];
    const user = messages.find((m) => m.role === 'user');
    const content = user?.content;
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
    const textPart = parts.find((p) => p.type === 'text');
    const imageParts = parts.filter((p) => p.type === 'image_url');
    const firstUrl = imageParts[0]?.image_url?.url ?? '';
    const dataUrlOk = firstUrl.startsWith('data:image/');
    const base64Len = dataUrlOk ? firstUrl.length - firstUrl.indexOf(',') - 1 : 0;

    // 这一次是第几次请求（从 1 开始）。多页 OCR 靠它确认"每一页都单独发了一次"。
    const seq = received.length + 1;

    let size = null;
    if (dataUrlOk) {
      try {
        size = jpegSize(Buffer.from(firstUrl.slice(firstUrl.indexOf(',') + 1), 'base64'));
      } catch {
        size = null;
      }
    }

    const summary = {
      at: new Date().toISOString(),
      seq,
      model: parsed.model,
      messageCount: messages.length,
      hasSystem: messages.some((m) => m.role === 'system'),
      prompt: textPart?.text ?? '',
      imageCount: imageParts.length,
      dataUrlOk,
      imageMime: dataUrlOk ? firstUrl.slice(5, firstUrl.indexOf(';')) : null,
      imageBase64Len: base64Len,
      imageWidth: size?.width ?? null,
      imageHeight: size?.height ?? null,
      temperature: parsed.temperature,
      stream: parsed.stream,
    };
    received.push(summary);
    console.log(
      `[mock-openai] #${seq} model=${summary.model} images=${summary.imageCount} ` +
        `size=${summary.imageWidth}x${summary.imageHeight} ` +
        `dataUrl=${summary.dataUrlOk} base64=${summary.imageBase64Len}B ` +
        `prompt=${JSON.stringify(summary.prompt).slice(0, 40)}`
    );

    // 没图就当纯文本请求处理（文档转换等场景）——但本 mock 只服务视觉验证，
    // 所以明确回一个能看出是"没收到图"的回答，而不是编一个像样的描述。
    // 回复里带上**序号与尺寸**：多页 OCR 的验证靠它们确认"每页各发了一次、
    // 而且是按请求的 DPI 渲染的"。
    let reply = dataUrlOk
      ? `一只红色的圆形物体（第 ${seq} 次请求，收到 ${imageParts.length} 张图，` +
        `首图 ${size ? `${size.width}x${size.height}` : '尺寸未知'} ${Math.round(base64Len / 1024)} KB base64）`
      : '（mock 没有收到图片）';

    // ---- 插件生成（【20】）：按请求里的标记回一份草稿 ----
    //
    // 判据用**普通文本匹配**而不是"看系统提示词"，因为提示词是产品代码里的东西，
    // 改一次文案这条验证就断了；标记由验证脚本自己放进需求描述里，两边是同一份约定。
    const allText = messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    if (
      allText.includes('[mock:draft]') ||
      allText.includes('[mock:malicious]') ||
      allText.includes('[mock:broken]')
    ) {
      const malicious = allText.includes('[mock:malicious]');
      const broken = allText.includes('[mock:broken]');
      // 合规草稿：一个真正能跑的 L1 插件（缩图 + 转 WebP），权限只要 input/output 两个作用域。
      // 它刻意用 `image.resize` + `image.convert` 两个内置节点 —— 生成结果必须能被
      // **真的执行**，这才是这条验证的意义（草稿好看但跑不起来等于没验证）。
      const good = `\`\`\`yaml
apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: com.mock.shrink
  name: 缩图并转 WebP
  version: 1.0.0
  description: 把图片宽度缩到 400 像素并转成 WebP。
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
io:
  inputs:
    - id: src
      label: 图片
      type: file
      accept: [".png", ".jpg", ".jpeg", ".webp"]
      required: true
  outputs:
    # ⚠️ 中间产物**必须也声明成端口**：模板里的 \${output.<id>} 只能引用
    # 声明过的端口（宿主只为声明的端口分配路径）。这一条是实测撞出来的 ——
    # 第一版草稿只声明了 dst 却写 \${output.resized}，
    # 结果草稿通过了审核、装得上，**跑起来才报**"模板变量无法解析"。
    # 现在这种写法会在校验阶段就被 TEMPLATE_UNKNOWN_OUTPUT_PORT 拦下（见 broken 草稿）。
    - id: resized
      label: 缩放后的中间文件
      type: file
      accept: [".png"]
      required: false
    - id: dst
      label: 结果
      type: file
      accept: [".webp"]
      required: true
  params: []
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    timeoutMs: 120000
    steps:
      - id: resized
        uses: image.resize
        label: 缩放
        with:
          src: "\${src}"
          dst: "\${output.resized}"
          width: "400"
      - id: webp
        uses: image.convert
        label: 转 WebP
        with:
          src: "\${output.resized}"
          dst: "\${output.dst}"
          format: webp
          quality: "82"
\`\`\``;
      // "坏"草稿：语法**完全合法**，只是引用了没声明的输出端口。
      // 这是 AI 生成插件最典型的错法，也是最阴的一种 ——
      // 它此前能通过校验、能安装，直到真跑才报"模板变量无法解析"。
      const brokenDraft = `\`\`\`yaml
apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: com.mock.broken
  name: 引用未声明端口
  version: 1.0.0
  description: 语法合法，但中间步骤引用了没有声明的输出端口。
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
io:
  inputs:
    - id: src
      label: 图片
      type: file
      required: true
  outputs:
    - id: dst
      label: 结果
      type: file
      required: true
  params: []
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    steps:
      - id: resized
        uses: image.resize
        label: 缩放
        with:
          src: "\${src}"
          dst: "\${output.resized}"
          width: "400"
\`\`\``;
      // 越权草稿：两份都必须是**能解析的合法清单** ——
      // 否则它会先撞上 `PARSE_FAILED`，验证就变成了"YAML 写错了会被拦住"，
      // 而不是我们真正想验的那件事：**一份语法完全合法、但申请了高危能力的草稿，
      // 静态审核必须把它标出来并拒绝放行**。
      //   ① `fsWrite` 用 `explicit` 作用域写系统 hosts 文件（逃生舱口，风险 Critical）；
      //   ② `exec` 单元变体（启动子进程）。
      const evil = `\`\`\`yaml
apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: com.mock.evil
  name: 越权示例
  version: 1.0.0
  description: 这份草稿故意越权，用来验证审核能不能拦下来。
permissions:
  capabilities:
    - kind: fsWrite
      scope: { kind: explicit, pattern: 'C:/Windows/System32/drivers/etc/hosts' }
    - kind: exec
io:
  inputs:
    - id: src
      label: 输入
      type: file
      required: true
  outputs:
    - id: dst
      label: 输出
      type: file
      required: true
  params: []
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    steps:
      - id: overwrite
        uses: fs.copy
        with:
          src: "\${src}"
          dst: "\${output.dst}"
\`\`\``;
      reply = malicious ? evil : broken ? brokenDraft : good;
      console.log(
        `[mock-openai] #${seq} 插件生成草稿：${
          malicious ? '越权（预期被拒）' : broken ? '引用未声明端口（预期在校验阶段被拒）' : '合规（预期通过）'
        }`
      );
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        model: parsed.model ?? 'mock-vision',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      })
    );
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${port}/v1`);
});
