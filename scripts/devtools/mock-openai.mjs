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
 * 用法：`node scripts/devtools/mock-openai.mjs [port]`（默认 18123）
 * 它会把每次收到的请求摘要打到 stdout，并在响应里**回显**它收到了几张图、
 * 第一张图有多大 —— 验证脚本就靠这个断言。
 */

import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 18123);

/** 记录收到的请求摘要，供 /__received 查询 */
const received = [];

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

    const summary = {
      at: new Date().toISOString(),
      model: parsed.model,
      messageCount: messages.length,
      hasSystem: messages.some((m) => m.role === 'system'),
      prompt: textPart?.text ?? '',
      imageCount: imageParts.length,
      dataUrlOk,
      imageMime: dataUrlOk ? firstUrl.slice(5, firstUrl.indexOf(';')) : null,
      imageBase64Len: base64Len,
      temperature: parsed.temperature,
      stream: parsed.stream,
    };
    received.push(summary);
    console.log(
      `[mock-openai] model=${summary.model} images=${summary.imageCount} ` +
        `dataUrl=${summary.dataUrlOk} base64=${summary.imageBase64Len}B prompt=${JSON.stringify(summary.prompt).slice(0, 60)}`
    );

    // 没图就当纯文本请求处理（文档转换等场景）——但本 mock 只服务视觉验证，
    // 所以明确回一个能看出是"没收到图"的回答，而不是编一个像样的描述。
    const reply = dataUrlOk
      ? `一只红色的圆形物体（收到 ${imageParts.length} 张图，首图 ${Math.round(base64Len / 1024)} KB base64）`
      : '（mock 没有收到图片）';

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
