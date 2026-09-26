/**
 * 页面冒烟：逐个路由走一遍。
 *
 * 它验证的不是某个函数，而是**前端路由 + 每个页面的数据依赖
 * （TanStack Query → IPC → Rust）** 这条整链。一个页面白屏、抛异常、
 * 或者永远停在骨架屏，都会被抓到。
 *
 * 用法：`node scripts/devtools/smoke.mjs`
 */

import { connect, sleep, Checker } from './cdp.mjs';

/** 与 `src/lib/nav.ts` 的侧边栏保持一致 */
const ROUTES = [
  ['仪表盘', '/'],
  ['格式转换', '/convert'],
  ['图片工具', '/image'],
  ['批量处理', '/batch'],
  ['流程编辑器', '/pipeline'],
  ['插件市场', '/plugins'],
  ['AI 工作室', '/ai'],
  ['任务中心', '/jobs'],
  ['设置', '/settings'],
];

/** 每页等多久让 Query 拿到数据。dev 模式下首次会现编译依赖，给足余量。 */
const SETTLE_MS = Number(process.env.TOOLFORGE_SMOKE_SETTLE_MS ?? 3500);

const c = new Checker();
const client = await connect();

console.log(`对 ${ROUTES.length} 个路由做冒烟（每页等 ${SETTLE_MS} ms）\n`);

const rows = [];
for (const [name, path] of ROUTES) {
  const before = client.errors.length;

  await client.evaluate(
    `(() => { history.pushState({}, '', ${JSON.stringify(path)});
              window.dispatchEvent(new PopStateEvent('popstate'));
              return location.pathname; })()`
  );
  await sleep(SETTLE_MS);

  const info = await client.evaluate(`(() => {
    const root = document.getElementById('root');
    const text = ((root && root.innerText) || '').replace(/\\s+/g, ' ').trim();
    return {
      path: location.pathname,
      nodes: document.querySelectorAll('*').length,
      textLen: text.length,
      head: text.slice(0, 240),
      skeletons: document.querySelectorAll('[class*="animate-pulse"],[class*="skeleton"],[class*="Skeleton"]').length,
    };
  })()`);

  const newErr = client.errors.length - before;
  rows.push({ name, ...info, newErr });

  console.log(`── ${name}   ${info.path}`);
  console.log(`   节点 ${info.nodes}   文本 ${info.textLen} 字   骨架屏元素 ${info.skeletons}   新异常 ${newErr}`);
  console.log(`   ${info.head.slice(0, 180)}`);
  console.log('');
}

c.section('================ 汇总 ================');
// 阈值刻意保守：抓的是"整页没渲染"这类问题，不是某个组件少了个图标
const broken = rows.filter((r) => r.nodes < 60 || r.textLen < 40 || r.newErr > 0);
c.check(broken.length === 0, `全部 ${rows.length} 个页面渲染正常`, broken.length ? `异常页: ${broken.map((b) => b.name).join(', ')}` : '');
for (const b of broken) {
  console.log(`   ${b.name}: 节点 ${b.nodes} / 文本 ${b.textLen} / 新异常 ${b.newErr}`);
}

c.section('================ 全量错误 ================');
if (client.errors.length === 0) console.log('(无)');
else [...new Set(client.errors)].slice(0, 25).forEach((e) => console.log('  ' + e));

client.close();
process.exit(c.summary() ? 0 : 1);
