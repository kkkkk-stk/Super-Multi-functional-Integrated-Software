/**
 * 单页体检：把"用户此刻看到什么"读出来。
 *
 * 这是排查"窗口起来了但什么都没有"时的第一个工具。它会回答：
 *
 * * React 挂载了没有（`#root` 的子节点数 —— **这是关键指标**：
 *   只有 `#root` 存在是不够的，`<div id="root"></div>` 空着也是白屏）；
 * * 屏幕上真实的文字（比截图更可靠，而且能直接看出是哪个页面）；
 * * 页面抛出的异常（白屏时这里一定有东西）；
 * * 设备像素级截图（CDP 抓的是合成后的内容，不是 `PrintWindow` 那种窗口背景）。
 *
 * 用法：`node scripts/devtools/inspect.mjs`
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { connect, SMOKE_DIR, Checker } from './cdp.mjs';

const c = new Checker();
const client = await connect();

console.log(`目标页面: ${client.page.url}  标题: ${client.page.title}`);

// 给 React 一点时间把首屏挂上去（dev 模式下模块是逐个请求的）
await new Promise((r) => setTimeout(r, 2500));

const v = await client.evaluate(`(() => {
  const root = document.getElementById('root');
  const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  return {
    hasRoot: !!root,
    rootChildCount: root ? root.children.length : -1,
    domNodeCount: document.querySelectorAll('*').length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    htmlClass: document.documentElement.className,
    bodyTextLength: text.length,
    bodyTextHead: text.slice(0, 900),
    interactives: Array.from(document.querySelectorAll('a,button')).slice(0, 30)
      .map(e => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean),
    svgCount: document.querySelectorAll('svg').length,
    canvasCount: document.querySelectorAll('canvas').length,
  };
})()`);

c.section('================ 渲染状态 ================');
console.log(`#root 存在            : ${v.hasRoot}`);
console.log(`#root 子节点数        : ${v.rootChildCount}`);
console.log(`DOM 节点总数          : ${v.domNodeCount}`);
console.log(`body 背景色           : ${v.bodyBg}`);
console.log(`<html> class          : ${v.htmlClass || '(空)'}`);
console.log(`可见文本长度          : ${v.bodyTextLength}`);
console.log(`svg 图标数            : ${v.svgCount}   canvas 数: ${v.canvasCount}`);

c.section('---------------- 屏幕上的文字 ----------------');
console.log(v.bodyTextHead || '(空)');

c.section('---------------- 可交互元素 ----------------');
console.log(v.interactives.join(' | ') || '(无)');

const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const shotPath = join(SMOKE_DIR, 'inspect.png');
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
c.section(`---------------- 截图已保存 ----------------`);
console.log(shotPath);

c.section('================ 页面异常 ================');
if (client.errors.length === 0) console.log('(无)');
else [...new Set(client.errors)].forEach((e) => console.log('  ' + e));

c.section('================ 判定 ================');
c.check(v.hasRoot, '#root 存在');
c.check(v.rootChildCount > 0, 'React 已挂载（#root 有子节点）', `实际 ${v.rootChildCount}`);
c.check(v.domNodeCount > 100, 'DOM 已展开（节点数 > 100）', `实际 ${v.domNodeCount}`);
c.check(client.errors.length === 0, '页面无运行时异常', `实际 ${client.errors.length} 条`);

client.close();
process.exit(c.summary() ? 0 : 1);
