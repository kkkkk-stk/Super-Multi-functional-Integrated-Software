/**
 * 运行时验证包：**L2（Extism WASM）与 L3（Python 子进程）**。
 *
 * # 为什么单独一个脚本
 *
 * `verify.mjs` / `verify-platform.mjs` 覆盖的是 L1（内置流水线节点）。
 * 而三级运行时里，L2 与 L3 是**另外两条完全不同的执行路径**：
 *
 * | 层 | 执行者 | 隔离手段 |
 * |---|---|---|
 * | L1 | 宿主的 Rust 节点 | 无沙箱，靠能力裁决 + 路径收敛 |
 * | L2 | wasmtime（Extism），关掉 WASI | 燃料上限 + 内存上限 + 主机白名单 |
 * | L3 | 独立 Python 进程（JSON-RPC over stdio） | 清空环境 + cwd 锁定 + 默认断网 |
 *
 * 单元测试能验 `allowed_hosts_from()` 的**映射规则**，但验不了
 * "这条规则是否真的被交给了沙箱、沙箱是否真的照它拦"——那要装一个真插件、
 * 授权、启用、真跑一次。这正是本脚本存在的理由，也是本项目反复吃过的教训：
 * **`cargo check` + 单测全绿对一个从未被执行的运行时毫无意义。**
 *
 * # 最有价值的一组检查：L2 的 net 对照实验
 *
 * 同一个插件、同一份输入、**只改授权**，看结果是否不同：
 *
 * | 授权 | 请求的主机 | 期望 |
 * |---|---|---|
 * | `net{hosts:["127.0.0.1"]}` | `127.0.0.1` | ✅ 成功 |
 * | `net{hosts:["127.0.0.1"]}` | `localhost` | ❌ 被沙箱拒绝（**同一个服务、同一个端口，只有主机名不同**） |
 * | 全部授权被撤销 | `127.0.0.1` | ❌ 被拒绝（没有 net 授权 = 白名单为空 = 全拒） |
 *
 * 第二行是这个实验的关键：如果只有第一行和第三行，"拒绝了"也可能是因为
 * 别的原因（插件没跑起来、沙箱把网络整个关掉了），而那种情况下第三行之前
 * 就不该成功。有了第二行，才能确定**拦的就是这份白名单**，而且是逐主机匹配。
 *
 * 全部请求打在**本地起的 HTTP 服务**上，所以不依赖外网、结果可复现。
 *
 * # 为什么"没授权 net 也要先授权才能测"
 *
 * 启用插件曾经要求"清单声明的每一项都已授权"（`runnable_or_grant_all`），
 * 2026-09 已按"允许部分授权启用、运行期按交集真拦"改掉（见
 * `PluginStore::set_enabled` 的文档）。所以"授权被撤销后仍然启用"这个状态
 * 现在是**可达**的，也正是运行期交集真正起作用的那种状态。
 *
 * # 用法
 *
 * ```powershell
 * # 应用必须带 CDP 启动
 * .\scripts\devtools\dev-with-cdp.ps1
 * node scripts\devtools\verify-runtimes.mjs
 * ```
 *
 * 依赖：`plugins/wasm-example`、`plugins/wasm-http-example` 与
 * `plugins/python-example` 的**构建产物**（`plugin.wasm` / `main.py`）。
 * 缺产物时对应小节会**明确报失败并给出构建命令**，而不是悄悄跳过 ——
 * 悄悄跳过会让"没验"看起来像"验过了"。
 */

import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Checker, connect, prepareOutDir, REPO_ROOT, SMOKE_DIR, writeInputPng } from './cdp.mjs';

const c = new Checker();
const client = await connect();

const PLUGIN_SRC = join(REPO_ROOT, 'plugins');
const STAGE = join(SMOKE_DIR, 'plugin-stage');

/** 把插件目录"按用户会拿到的那样"暂存起来：只带运行需要的文件，不带 cargo 的 target/ */
function stage(sourceDir, name) {
  const dst = join(STAGE, name);
  rmSync(dst, { recursive: true, force: true });
  cpSync(sourceDir, dst, {
    recursive: true,
    filter: (src) => !src.includes(`${'target'}`) && !src.endsWith('.log'),
  });
  return dst;
}

/** 装一个插件（已存在则先卸掉，保证从干净状态开始） */
async function install(id, stageDir, { executableCode = false } = {}) {
  const existing = await client.invoke('plugins_get', { pluginId: id }).catch(() => null);
  if (existing) {
    await client.invoke('plugins_set_enabled', { pluginId: id, enabled: false }).catch(() => {});
    await client.invoke('plugins_uninstall', { pluginId: id }).catch(() => {});
  }
  const report = await client.invoke('plugins_install', {
    req: {
      source: { kind: 'directory', path: stageDir },
      overwrite: true,
      permissionsAcknowledged: true,
      executableCodeAcknowledged: executableCode,
    },
  });
  return report;
}

async function grant(id, capabilities) {
  return client.invoke('plugins_grant', { req: { pluginId: id, granted: { capabilities } } });
}

/** 跑一次插件并等到终态 */
async function run(id, inputs, params, outDir) {
  const sub = await client.invoke('plugins_run', {
    req: { pluginId: id, inputs, params, outputDir: outDir },
  });
  const job = await client.waitJob(sub.jobId, 240, 1000);
  return { sub, job };
}

/** 任务日志全文（断言插件返回值时用） */
const logText = (job) => (job.logs ?? []).map((l) => l.message).join('\n');

async function uninstall(id) {
  await client.invoke('plugins_set_enabled', { pluginId: id, enabled: false }).catch(() => {});
  await client.invoke('plugins_uninstall', { pluginId: id }).catch(() => {});
}

// ============================================================================
// 本地 HTTP 服务：L2 联网对照实验的靶子
// ============================================================================
const PAGE_TITLE = 'ToolForge 本地测试页';
const PAGE_DESC = 'verify-runtimes.mjs 起的本地 HTTP 服务';
const server = createServer((req, res) => {
  if (req.url === '/boom') {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('boom');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${PAGE_TITLE}</title>` +
      `<meta name="description" content="${PAGE_DESC}">` +
      `</head><body><h1>hello</h1></body></html>`
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const LOCAL_URL = `http://127.0.0.1:${PORT}/`;
const LOCAL_ALT_HOST_URL = `http://localhost:${PORT}/`;

const L2_TEXT = 'com.toolforge.example.text-toolkit';
const L2_HTTP = 'com.toolforge.example.http-fetch';
const L3_PY = 'com.toolforge.example.palette';
const NET_PROBE = 'com.toolforge.test.net-probe';

try {
  // ==========================================================================
  // 【1】L2 · 纯计算沙箱：装载 → 入口检查 → JSON 信封 → 返回值
  // ==========================================================================
  c.section('【1】L2 · WASM 纯计算插件能否真的跑起来');
  {
    const wasm = join(PLUGIN_SRC, 'wasm-example', 'plugin.wasm');
    c.check(
      existsSync(wasm),
      '示例插件的 wasm 产物存在',
      existsSync(wasm)
        ? `${statSync(wasm).size} 字节`
        : '缺失 —— 先跑 plugins/wasm-example/src/lib.rs 顶部注释里的构建命令'
    );

    if (existsSync(wasm)) {
      const dir = stage(join(PLUGIN_SRC, 'wasm-example'), 'text-toolkit');
      const rep = await install(L2_TEXT, dir);
      c.check(!!rep.contentHash, '安装返回内容哈希', String(rep.contentHash).slice(0, 24));

      await client.invoke('plugins_set_enabled', { pluginId: L2_TEXT, enabled: true });

      const outDir = prepareOutDir('out-rt-l2-stats');
      const { job } = await run(
        L2_TEXT,
        { text: ['Hello 世界'] },
        { mode: { kind: 'str', value: 'stats' } },
        outDir
      );
      c.check(
        job.status === 'succeeded',
        '任务成功（装载 + 调用 + 返回值解析整条链路）',
        job.error ? `${job.error.code}: ${job.error.message}` : job.status
      );

      // 「Hello 世界」= 5 字母 + 1 空格 + 2 汉字 = 8 字符 / 2 词 / 12 字节。
      // 这几个数是**算得出来的**，所以能真正验证 WASM 里的计算发生了，
      // 而不是只验证"有个 JSON 返回了"。
      //
      // 注意 `values` 是**未转义**的一层（`"chars":8`），而 `outputs.result` 里
      // 那段 JSON 是被转义成字符串的（`\"bytes\":12`）—— 两种写法都要认。
      const text = logText(job);
      c.check(/"chars"\s*:\s*8/.test(text), '插件返回的统计里字符数 = 8（values 未转义层）', '');
      c.check(
        /\\+"bytes\\+"\s*:\s*12/.test(text),
        '插件返回的统计里 UTF-8 字节数 = 12（汉字 3 字节，outputs 转义层）',
        /bytes[^\d]{0,4}\d+/.exec(text)?.[0] ?? '日志里没找到 bytes'
      );

      // slugify 分支走一遍，证明 `params` 真的传进沙箱了（而不是固定走默认分支）
      const { job: job2 } = await run(
        L2_TEXT,
        { text: ['Hello, ToolForge World!'] },
        { mode: { kind: 'str', value: 'slugify' } },
        prepareOutDir('out-rt-l2-slug')
      );
      c.check(job2.status === 'succeeded', 'slugify 分支成功', job2.status);
      c.check(
        /hello-toolforge-world/.test(logText(job2)),
        'params 真的传进了沙箱（slugify 结果正确）',
        ''
      );

      // ---- 插件自己报的错必须原样到达用户 ----
      //
      // 走 `{"error": "…"}` 通道而不是 `Err(...)`：后者在 Extism 1.30 + PDK 下
      // 会把作者写的文案丢掉，只剩一句 wasm 回溯（见 PLUGIN-SDK §4.4）。
      // 这条检查就是钉住那个约定的：文案必须原样出现在 `job.error.message` 里。
      const { job: jobErr } = await run(
        L2_TEXT,
        { text: ['x'] },
        { mode: { kind: 'str', value: 'no-such-mode' } },
        prepareOutDir('out-rt-l2-error')
      );
      console.log(`   [未知 mode] ${jobErr.status} — ${String(jobErr.error?.message ?? '').slice(0, 80)}`);
      c.check(jobErr.status === 'failed', '未知 mode 让任务失败', jobErr.status);
      c.check(
        String(jobErr.error?.message ?? '').includes('no-such-mode'),
        '插件写的报错文案原样到达用户（不是一句 wasm 回溯）',
        ''
      );
    }
  }

  // ==========================================================================
  // 【2】L2 · net 白名单：同一份输入，只改授权（对照实验）
  // ==========================================================================
  c.section('【2】L2 · net 主机白名单是否真的被沙箱执行');
  {
    const wasm = join(PLUGIN_SRC, 'wasm-http-example', 'plugin.wasm');
    c.check(
      existsSync(wasm),
      '联网示例插件的 wasm 产物存在',
      existsSync(wasm)
        ? `${statSync(wasm).size} 字节`
        : '缺失 —— 先跑 plugins/wasm-http-example/src/lib.rs 顶部注释里的构建命令'
    );

    if (existsSync(wasm)) {
      // 这个探针复用示例插件的 wasm，只换一份**测试用**清单：
      // 白名单写死 `127.0.0.1`，这样"同一台服务器换个主机名"就能当反证。
      // （示例插件自己的清单申请的是任意主机，那个状态下没法构造"被拒绝"。）
      const PROBE_ID = 'com.toolforge.test.net-probe';
      const probeYaml = `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${PROBE_ID}
  name: 网络白名单探针（测试用）
  version: 1.0.0
  description: 仅用于验证 L2 的 net 主机白名单是否被沙箱执行；复用 http-fetch 的 wasm。
permissions:
  capabilities:
    - kind: net
      hosts: ["127.0.0.1"]
io:
  inputs:
    - id: url
      label: 网址
      type: text
      required: true
  outputs:
    - id: result
      label: 页面信息
      type: json
      required: false
  params: []
runtime:
  kind: wasm
  wasm:
    path: plugin.wasm
    entry: run
    memoryLimitMb: 64
    timeoutMs: 10000
    allowHostFunctions: ["log"]
`;
      const dir = stage(join(PLUGIN_SRC, 'wasm-http-example'), 'net-probe');
      writeFileSync(join(dir, 'plugin.yaml'), probeYaml, 'utf8');
      await install(PROBE_ID, dir);
      // 部分授权模型：白名单里的那一条必须授权，插件才能联网；
      // 但**启用**不再要求"声明全给"（见 PluginStore::set_enabled 的文档）。
      await client.invoke('plugins_set_enabled', { pluginId: PROBE_ID, enabled: true });

      // ---- 用例 A：撤销全部授权（仍然启用）→ 白名单为空 → 一切被拒 ----
      await grant(PROBE_ID, []);
      const { job: jobDeny } = await run(
        PROBE_ID,
        { url: [`http://127.0.0.1:${PORT}/`] },
        {},
        prepareOutDir('out-rt-net-nogrant')
      );
      console.log(`   [撤销授权] ${jobDeny.status} ${jobDeny.error?.message ?? ''}`);
      c.check(
        jobDeny.status === 'failed',
        '没有 net 授权时请求被拒绝（而不是悄悄发出去）',
        `status=${jobDeny.status}`
      );
      c.check(
        /is not allowed/i.test(String(jobDeny.error?.message ?? '')),
        '拒绝来自沙箱的主机白名单（原文含 `is not allowed`）',
        String(jobDeny.error?.message ?? '').slice(0, 120)
      );

      // ---- 用例 B：授权白名单 → 放行 ----
      await grant(PROBE_ID, [{ kind: 'net', hosts: ['127.0.0.1'] }]);
      const { job: jobAllow } = await run(
        PROBE_ID,
        { url: [`http://127.0.0.1:${PORT}/`] },
        {},
        prepareOutDir('out-rt-net-allow')
      );
      console.log(`   [授权 127.0.0.1] ${jobAllow.status}`);
      if (jobAllow.error) console.log(`      ${jobAllow.error.code} — ${jobAllow.error.message}`);
      c.check(jobAllow.status === 'succeeded', '白名单内的主机被放行', jobAllow.status);

      const text = logText(jobAllow);
      c.check(text.includes(PAGE_TITLE), '页面标题解析正确', text.includes(PAGE_TITLE) ? '' : '未找到');
      c.check(/"status"\s*:\s*200/.test(text), '响应状态码 200', '');
      c.check(text.includes(PAGE_DESC), 'meta description 解析正确', '');

      // ---- 用例 C（反证核心）：同一个服务、同一个端口，只换主机名 ----
      //
      // `localhost` 与 `127.0.0.1` 指向同一台机器、同一个端口，服务端完全一样。
      // 所以"成功 → 失败"这个差异**只可能**来自白名单的逐主机匹配。
      const { job: jobOtherHost } = await run(
        PROBE_ID,
        { url: [`http://localhost:${PORT}/`] },
        {},
        prepareOutDir('out-rt-net-otherhost')
      );
      console.log(`   [换主机名 localhost] ${jobOtherHost.status}`);
      if (jobOtherHost.error) console.log(`      ${jobOtherHost.error.message}`);
      c.check(
        jobOtherHost.status === 'failed',
        '同一服务换个主机名（localhost）就被拒 —— 白名单是逐主机匹配的',
        `status=${jobOtherHost.status}`
      );
      c.check(
        /is not allowed/i.test(String(jobOtherHost.error?.message ?? '')),
        '拒绝原因仍然是主机白名单',
        String(jobOtherHost.error?.message ?? '').slice(0, 120)
      );

      // 审计：装载 L2 插件时必须记下**翻译给沙箱的**主机白名单。
      // 这一条把"用户勾的授权"与"沙箱实际拿到的名单"钉在一起 ——
      // 没有它，两者不一致时没有任何痕迹可查。
      const audit = await client.invoke('plugins_audit', { limit: 300 });
      const detailOf = (e) => {
        try {
          return JSON.parse(e.detail ?? '{}');
        } catch {
          return {};
        }
      };
      const loads = (audit.events ?? [])
        .filter((e) => e.subject === PROBE_ID && e.kind === 'installed')
        .map(detailOf)
        .filter((d) => Array.isArray(d.allowedHosts));
      console.log(`   审计里带 allowedHosts 的装载事件：${JSON.stringify(loads.map((d) => d.allowedHosts))}`);
      c.check(loads.length > 0, '装载 L2 插件时审计记录了 allowedHosts');
      c.check(
        loads.some((d) => d.allowedHosts.length === 1 && d.allowedHosts[0] === '127.0.0.1'),
        '授权的主机被如实翻译给沙箱',
        JSON.stringify(loads.map((d) => d.allowedHosts))
      );
      c.check(
        loads.some((d) => d.allowedHosts.length === 0),
        '撤销授权后翻译出来的是空名单（fail-closed）',
        ''
      );

      // ---- 用例 D：带端口的白名单必须在**安装校验**阶段就被拒 ----
      //
      // Extism 用 `url.host_str()` 匹配，端口不参与比较，所以
      // `127.0.0.1:8080` 这种写法永远匹配不上。报错比让它装上去然后在
      // 运行时神秘失败要好得多。
      const PORTED_ID = 'com.toolforge.test.net-port';
      const portedYaml = probeYaml
        .replace(PORTED_ID, PORTED_ID)
        .replace('hosts: ["127.0.0.1"]', `hosts: ["127.0.0.1:${PORT}"]`);
      const val = await client.invoke('plugins_validate', {
        req: { source: { kind: 'manifest', yaml: portedYaml } },
      });
      const issues = val.validation?.issues ?? [];
      const ported = issues.filter((i) => i.code === 'NET_HOST_WITH_PORT');
      console.log(`   带端口清单的校验结论：${issues.map((i) => `${i.severity}/${i.code}`).join(', ')}`);
      c.check(ported.length === 1, '带端口的 net.hosts 命中 NET_HOST_WITH_PORT', String(ported.length));
      c.check(
        ported[0]?.severity === 'error',
        '而且是 error（不是警告）—— 这是必然失效，不是风格问题',
        String(ported[0]?.severity)
      );
      c.check(val.validation?.ok === false, '校验整体不通过', String(val.validation?.ok));

      await uninstall(PROBE_ID);

      // ---- 用例 E：**示例插件本身**按它自己的清单也能跑 ----
      //
      // 上面四条用的是测试清单。这一条装的是仓库里那一份 `plugin.yaml`
      // （申请 `net{hosts: []}` = 任意主机），确认"随仓库分发的示例"是可用的 ——
      // 否则文档里那句"完整可运行例子"就是假的。
      const exampleDir = stage(join(PLUGIN_SRC, 'wasm-http-example'), 'http-fetch');
      await install(L2_HTTP, exampleDir, { executableCode: false });
      await grant(L2_HTTP, [{ kind: 'net', hosts: [] }]);
      await client.invoke('plugins_set_enabled', { pluginId: L2_HTTP, enabled: true });
      const { job: jobExample } = await run(
        L2_HTTP,
        { url: [`http://127.0.0.1:${PORT}/`] },
        {},
        prepareOutDir('out-rt-net-example')
      );
      console.log(`   [示例插件原样运行] ${jobExample.status}`);
      if (jobExample.error) console.log(`      ${jobExample.error.code} — ${jobExample.error.message}`);
      c.check(jobExample.status === 'succeeded', '示例插件按其清单可运行', jobExample.status);
      c.check(
        logText(jobExample).includes(PAGE_TITLE),
        '示例插件拿回了正确的页面标题',
        ''
      );
      await uninstall(L2_HTTP);
    }
  }

  // ==========================================================================
  // 【4】L2 · 装载前的体检：坏 wasm 与"错误构建目标"都必须给出可操作的报错
  // ==========================================================================
  c.section('【4】L2 · 装载非法/错目标的 wasm 时，报错是否可操作');
  {
    /** 单字节 LEB128（测试里的长度都小于 128） */
    const leb = (n) => {
      if (n >= 0x80) throw new Error('测试里的 LEB128 只用得到单字节');
      return n;
    };

    /**
     * 造一个只有导入段的最小合法 wasm 模块。
     *
     * 手写字节而不是引用某个构建产物：这一节要验的正是"宿主能不能读懂导入段"，
     * 用别的工具生成反而把被测对象藏起来了。
     */
    const wasmWithImports = (imports) => {
      const payload = [leb(imports.length)];
      for (const [mod, field] of imports) {
        payload.push(leb(mod.length), ...Buffer.from(mod, 'ascii'));
        payload.push(leb(field.length), ...Buffer.from(field, 'ascii'));
        payload.push(0x00, 0x00); // kind = func, type index = 0
      }
      return Buffer.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
        0x02, leb(payload.length), ...payload, // import section
      ]);
    };

    /**
     * 用一个临时插件跑一次，返回任务快照。
     *
     * `wasmBytes` 直接写进暂存目录，所以不需要任何构建产物。
     */
    const probeWithWasm = async (id, wasmBytes) => {
      const yaml = `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${id}
  name: wasm 装载体检探针
  version: 1.0.0
  description: 仅用于验证装载期的报错质量。
permissions:
  capabilities: []
io:
  inputs:
    - id: text
      label: 文本
      type: text
      required: false
  outputs: []
  params: []
runtime:
  kind: wasm
  wasm:
    path: plugin.wasm
    entry: run
    memoryLimitMb: 64
    timeoutMs: 2000
    allowHostFunctions: ["log"]
`;
      const dir = join(STAGE, id);
      rmSync(dir, { recursive: true, force: true });
      cpSync(join(PLUGIN_SRC, 'wasm-example'), dir, {
        recursive: true,
        filter: (src) => !src.includes('target') && !src.endsWith('.log'),
      });
      writeFileSync(join(dir, 'plugin.yaml'), yaml, 'utf8');
      writeFileSync(join(dir, 'plugin.wasm'), wasmBytes);
      try {
        await install(id, dir);
        await client.invoke('plugins_set_enabled', { pluginId: id, enabled: true });
        const { job } = await run(id, { text: ['x'] }, {}, prepareOutDir(`out-rt-${id}`));
        console.log(`   ${id}: ${job.status} / ${job.error?.code ?? ''} — ${job.error?.message ?? ''}`);
        return job;
      } finally {
        await uninstall(id);
      }
    };

    // ---- 4a：根本不是 wasm ----
    const jobGarbage = await probeWithWasm(
      'com.toolforge.test.garbage-wasm',
      Buffer.from('not a wasm module at all', 'utf8')
    );
    c.check(jobGarbage.status === 'failed', '垃圾字节被拒绝（不是静默成功）', jobGarbage.status);
    c.check(
      String(jobGarbage.error?.code ?? '') === 'PLUGIN_RUNTIME',
      '错误码是 PLUGIN_RUNTIME',
      String(jobGarbage.error?.code ?? '')
    );
    c.check(
      /WebAssembly/.test(String(jobGarbage.error?.detail ?? '')),
      '详情说明"这不是合法的 WebAssembly 模块"',
      String(jobGarbage.error?.detail ?? '').slice(0, 80)
    );

    // ---- 4b：用 wasm32-wasip1 构建出来的模块（**这次修复的靶心**）----
    //
    // 这种模块会导入 `wasi_snapshot_preview1::environ_get`（Rust 的 wasip1 std
    // 启动时无条件读环境变量），而宿主关掉了 WASI。此前 wasmtime 只回一句
    // `unknown import: … has not been defined` —— 对插件作者完全不可操作。
    const jobWasi = await probeWithWasm(
      'com.toolforge.test.wasi-wasm',
      wasmWithImports([
        ['wasi_snapshot_preview1', 'environ_get'],
        ['wasi_snapshot_preview1', 'environ_sizes_get'],
        ['extism:host/env', 'input_length'],
      ])
    );
    c.check(jobWasi.status === 'failed', '引用 WASI 的模块被拒绝', jobWasi.status);
    c.check(
      String(jobWasi.error?.code ?? '') === 'PLUGIN_INVALID',
      '错误码是 PLUGIN_INVALID（配置问题，不是运行期故障）',
      String(jobWasi.error?.code ?? '')
    );
    const wasiDetail = String(jobWasi.error?.detail ?? '');
    c.check(
      /wasm32-unknown-unknown/.test(wasiDetail),
      '详情直接给出了正确的构建目标 wasm32-unknown-unknown',
      wasiDetail.includes('wasm32-unknown-unknown') ? '' : wasiDetail.slice(0, 100)
    );
    c.check(
      /wasm32-wasip1/.test(wasiDetail),
      '并点名了错误的目标 wasm32-wasip1',
      ''
    );

    // ---- 4c：导入了宿主没有提供的自定义宿主函数 ----
    const jobHostFn = await probeWithWasm(
      'com.toolforge.test.hostfn-wasm',
      wasmWithImports([['extism:host/user', 'my_secret_helper']])
    );
    c.check(jobHostFn.status === 'failed', '未知宿主函数被拒绝', jobHostFn.status);
    c.check(
      String(jobHostFn.error?.message ?? '').includes('my_secret_helper'),
      '报错点名了具体是哪个函数',
      String(jobHostFn.error?.message ?? '').slice(0, 100)
    );

    // ---- 4d：应用仍然活着（一个坏插件不该拖垮宿主）----
    const alive = await client.invoke('plugins_list');
    c.check(Array.isArray(alive?.plugins ?? alive), '应用仍然可以响应命令');
  }

  // ==========================================================================
  // 【5】L3 · Python 子进程：venv 依赖安装 + JSON-RPC 循环
  // ==========================================================================
  c.section('【5】L3 · Python 插件的依赖安装与 JSON-RPC 调用');
  {
    const entry = join(PLUGIN_SRC, 'python-example', 'main.py');
    c.check(existsSync(entry), 'Python 示例的入口文件存在', entry.replace(REPO_ROOT, '.'));

    if (existsSync(entry)) {
      const dir = stage(join(PLUGIN_SRC, 'python-example'), 'palette');
      const rep = await install(L3_PY, dir, { executableCode: true });
      c.check(!!rep.contentHash, '安装返回内容哈希', String(rep.contentHash).slice(0, 24));

      await grant(L3_PY, [
        { kind: 'fsRead', scope: { kind: 'input' } },
        { kind: 'fsWrite', scope: { kind: 'output' } },
      ]);
      await client.invoke('plugins_set_enabled', { pluginId: L3_PY, enabled: true });

      const outDir = prepareOutDir('out-rt-l3-palette');
      const src = writeInputPng('palette-input.png', 96, 96, 7);
      // 首次运行要建 venv + pip install Pillow（约 3 MB）。
      // 给足时间，并明确提示"慢是正常的"，免得把冷启动误判成卡死。
      console.log('   首次运行需要创建 venv 并安装 Pillow，可能要 1~3 分钟…');
      const { job } = await run(L3_PY, { src: [src] }, { count: { kind: 'int', value: 5 } }, outDir);
      console.log(`   任务状态: ${job.status}`);
      if (job.error) {
        console.log(`   错误: ${job.error.code} — ${job.error.message}`);
        if (job.error.detail) console.log(`   详情: ${String(job.error.detail).slice(0, 300)}`);
      }
      c.check(job.status === 'succeeded', 'L3 插件调用成功（含 venv 冷启动）', job.status);

      const text = logText(job);
      c.check(/hex/i.test(text), '插件返回了主色调 JSON（含 hex 字段）', '');

      const files = (job.outputs ?? []).filter((p) => p.toLowerCase().endsWith('.png'));
      console.log(`   任务产出: ${JSON.stringify(job.outputs ?? [])}`);
      c.check(files.length > 0, '色卡图被登记为产出', String(files.length));
    }
  }

  // ==========================================================================
  // 【6】L3 · env 与 exec：两个曾经"勾了等于没勾"的能力
  // ==========================================================================
  //
  // 这一项此前是彻底惰性的：L3 进程被 `env_clear()`，而白名单没有注入通道 ——
  // 用户勾了"允许读取环境变量 FOO"，插件里 `os.environ.get("FOO")` 仍然是 None。
  // 现在宿主会把**声明 ∩ 授权**里的名字逐个读出来注入。
  //
  // 验证方式仍然是对照：同一个探针插件、同一份输入，只改授权。
  // 用 `USERPROFILE`（Windows）/ `HOME`（其它平台）当"存在的变量"，
  // 用 `USERNAME` / `USER` 当"存在但没声明的变量" —— 后者必须**读不到**。
  c.section('【6】L3 · env 白名单是否真的注入了（勾了有没有用）');
  {
    const POS = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const NEG = process.platform === 'win32' ? 'USERNAME' : 'USER';
    const hostPos = process.env[POS];
    const hostNeg = process.env[NEG];

    if (!hostPos) {
      c.note(`跳过：验证脚本自己的环境里没有 ${POS}`);
      c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
    } else {
      const ENV_PROBE = 'com.toolforge.test.env-probe';
      const probeDir = join(STAGE, 'env-probe');
      rmSync(probeDir, { recursive: true, force: true });
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(
        join(probeDir, 'plugin.yaml'),
        `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${ENV_PROBE}
  name: 环境变量白名单探针（测试用）
  version: 1.0.0
  description: 仅用于验证 env 能力是否真的注入了环境变量。
permissions:
  capabilities:
    - kind: env
      names: ["${POS}"]
io:
  inputs:
    - id: src
      label: 任意文本
      type: text
      required: true
  outputs:
    - id: report
      label: 报告
      type: json
      required: false
  params:
    - id: expected
      label: 期望值
      type: text
      description: 宿主侧那个环境变量的真实值；插件拿它和 os.environ 里的比对。
      required: false
runtime:
  kind: python
  python:
    entry: main.py
    pythonVersion: "3.11"
    requirements: []
    timeoutMs: 60000
    workers: 1
    allowNetwork: false
`,
        'utf8'
      );
      // 探针脚本：把**比较**放在插件里做，只回报布尔值。
      //
      // 为什么不让插件把变量的值回传、由脚本比对：插件返回值会嵌进宿主的
      // JSON 日志里，Windows 路径里的反斜杠要经过**两层**转义
      // （`C:\Users\...` → `C:\\\\Users\\\\...`），脚本侧一不小心就把
      // "值不一致"当成缺陷报出来 —— 那是测试自己错了，不是产品错了。
      // 让插件比对、只回布尔，输出里连一个反斜杠都没有。
      writeFileSync(
        join(probeDir, 'main.py'),
        `"""env 白名单探针：只报告布尔结论，不回传变量的值。"""
import json
import os
import sys

POS = ${JSON.stringify(POS)}
NEG = ${JSON.stringify(NEG)}


def _write(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()


def handle_initialize(params):
    return {"ok": True}


def handle_run(params):
    # 期望值走**参数**而不是输入端口。
    #
    # 两个原因：① 输入端口的值会被宿主当成"路径/值"处理（目录展开、输入根收敛），
    # 参数不会；② 参数正是"插件作者想要的配置"这条语义。
    # （这段 Python 源码整个嵌在 JS 模板字符串里，所以**不能**出现反引号 ——
    #   一个反引号就会把模板提前结束掉，报的却是"missing ) after argument list"）
    expected = (params.get("params") or {}).get("expected")
    declared = os.environ.get(POS)
    report = {
        "declaredIsNone": declared is None,
        "declaredMatches": declared is not None and declared == expected,
        "undeclaredIsNone": os.environ.get(NEG) is None,
        "envCount": len(os.environ),
    }
    return {"outputs": {"report": json.dumps(report)}}


def handle_shutdown(params):
    return {"ok": True}


HANDLERS = {"initialize": handle_initialize, "run": handle_run, "shutdown": handle_shutdown}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        handler = HANDLERS.get(msg.get("method"))
        if handler is None:
            continue
        try:
            result = handler(msg.get("params") or {})
            _write({"jsonrpc": "2.0", "id": msg.get("id"), "result": result})
        except Exception as exc:  # noqa: BLE001
            _write({"jsonrpc": "2.0", "id": msg.get("id"),
                    "error": {"code": -32000, "message": str(exc)}})


main()
`,
        'utf8'
      );

      await install(ENV_PROBE, probeDir, { executableCode: true });
      await client.invoke('plugins_set_enabled', { pluginId: ENV_PROBE, enabled: true });

      /** 跑一次探针（参数带上宿主侧的真值）并解析它回报的布尔结论 */
      const probeOnce = async (tag) => {
        const { job } = await run(
          ENV_PROBE,
          { src: ['x'] },
          { expected: { kind: 'str', value: hostPos } },
          prepareOutDir(`out-rt-env-${tag}`)
        );
        const text = logText(job);
        const flag = (name) => {
          const m = new RegExp(`${name}\\\\?":\\s*(true|false)`).exec(text);
          return m ? m[1] === 'true' : undefined;
        };
        const count = /envCount\\?":\s*(\d+)/.exec(text);
        return {
          status: job.status,
          error: job.error?.message,
          declaredIsNone: flag('declaredIsNone'),
          declaredMatches: flag('declaredMatches'),
          undeclaredIsNone: flag('undeclaredIsNone'),
          envCount: count ? Number(count[1]) : undefined,
        };
      };

      // ---- 6a：撤销全部授权（插件仍启用）→ 两个都读不到 ----
      await grant(ENV_PROBE, []);
      const noGrant = await probeOnce('nogrant');
      console.log(`   [撤销授权] ${JSON.stringify(noGrant)}`);
      c.check(noGrant.status === 'succeeded', '零授权时探针仍能运行（不因缺权限而崩）', noGrant.status);
      c.check(
        noGrant.declaredIsNone === true,
        `零授权时声明过的 ${POS} 读不到`,
        String(noGrant.declaredIsNone)
      );

      // ---- 6b：授权 → 声明的那个能读到且值一致，未声明的仍然读不到 ----
      await grant(ENV_PROBE, [{ kind: 'env', names: [POS] }]);
      const granted = await probeOnce('granted');
      console.log(`   [授权 ${POS}] ${JSON.stringify(granted)}`);
      c.check(granted.status === 'succeeded', '授权后探针运行成功', granted.status);
      c.check(
        granted.declaredMatches === true,
        `声明并授权后 ${POS} 真的被注入（值就是宿主的那一份）`,
        String(granted.declaredMatches)
      );
      c.check(
        granted.undeclaredIsNone === true,
        `没声明的 ${NEG} 依然读不到（白名单不是"放行整个环境"）`,
        String(granted.undeclaredIsNone)
      );
      c.check(
        typeof granted.envCount === 'number' && granted.envCount < 20,
        '插件进程的环境变量总数很少（说明 env_clear 仍然生效）',
        String(granted.envCount)
      );
      c.check(
        (granted.envCount ?? 0) >= (noGrant.envCount ?? 0),
        '授权后环境变量数不减少（注入是加法）',
        `${noGrant.envCount} → ${granted.envCount}`
      );

      await uninstall(ENV_PROBE);
    }
  }

  // ==========================================================================
  // 【6b】L3 · exec：运行期拦不住，但装载期必须拦得住
  // ==========================================================================
  //
  // L3 是普通进程，宿主**没有办法在运行期**阻止它 `import subprocess`（那需要
  // Job Object + AppContainer / seccomp，见 SECURITY.md §9 第 3 项）。
  // 能做的是装载期的静态门：代码里出现起子进程的 API 而生效能力里没有 `exec`
  // → 拒绝装载。这一节验的就是这道门，以及"声明并授权之后它不该挡路"。
  c.section('【6b】L3 · exec：没声明/没授权时起子进程会被拦住吗');
  {
    const EXEC_PROBE = 'com.toolforge.test.exec-probe';
    const probeDir = join(STAGE, 'exec-probe');
    const probeMain = `"""exec 探针：代码里真的会起子进程（走 sys.executable，不经过 shell）。"""
import json
import os
import subprocess
import sys


def _write(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()


def handle_initialize(params):
    return {"ok": True}


def handle_run(params):
    want = bool((params.get("params") or {}).get("spawn"))
    if not want:
        return {"outputs": {"report": json.dumps({"spawned": False})}}
    # 用 sys.executable 而不是 shell，跨平台且不依赖 PATH
    child = subprocess.run(
        [sys.executable, "-c", "print('child-ok')"],
        capture_output=True, text=True, timeout=30,
    )
    return {"outputs": {"report": json.dumps({
        "spawned": True,
        "exit": child.returncode,
        "stdout": child.stdout.strip(),
        "hasSubprocess": hasattr(subprocess, "Popen"),
        "envCount": len(os.environ),
    })}}


def handle_shutdown(params):
    return {"ok": True}


HANDLERS = {"initialize": handle_initialize, "run": handle_run, "shutdown": handle_shutdown}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        handler = HANDLERS.get(msg.get("method"))
        if handler is None:
            continue
        try:
            result = handler(msg.get("params") or {})
            _write({"jsonrpc": "2.0", "id": msg.get("id"), "result": result})
        except Exception as exc:  # noqa: BLE001
            _write({"jsonrpc": "2.0", "id": msg.get("id"),
                    "error": {"code": -32000, "message": str(exc)}})


main()
`;
    const probeYaml = (withExec) => `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${EXEC_PROBE}
  name: exec 探针（测试用）
  version: 1.0.0
  description: 仅用于验证 exec 能力的装载期静态门。
permissions:
  capabilities:
${withExec ? '    - kind: exec\n' : ''}    - kind: fsRead
      scope: { kind: input }
io:
  inputs:
    - id: src
      label: 任意文本
      type: text
      required: true
  outputs:
    - id: report
      label: 报告
      type: json
      required: false
  params:
    - id: spawn
      label: 是否真的起子进程
      type: bool
      default: { kind: bool, value: false }
      required: false
runtime:
  kind: python
  python:
    entry: main.py
    pythonVersion: "3.11"
    requirements: []
    timeoutMs: 60000
    workers: 1
    allowNetwork: false
`;

    /** 装一份探针（可切换是否声明 exec）并启用 */
    const installProbe = async (withExec) => {
      rmSync(probeDir, { recursive: true, force: true });
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(join(probeDir, 'plugin.yaml'), probeYaml(withExec), 'utf8');
      writeFileSync(join(probeDir, 'main.py'), probeMain, 'utf8');
      await install(EXEC_PROBE, probeDir, { executableCode: true });
      await client.invoke('plugins_set_enabled', { pluginId: EXEC_PROBE, enabled: true });
    };

    const runProbe = async (tag, spawn) => {
      const { job } = await run(
        EXEC_PROBE,
        { src: ['x'] },
        { spawn: { kind: 'bool', value: spawn } },
        prepareOutDir(`out-rt-exec-${tag}`)
      );
      const text = logText(job);
      const m = /\\?"spawned\\?":\s*(true|false)/.exec(text);
      const out = /\\?"stdout\\?":\s*\\?"([^"\\]*)\\?"/.exec(text);
      const exit = /\\?"exit\\?":\s*(-?\d+)/.exec(text);
      return {
        status: job.status,
        code: job.error?.code,
        message: job.error?.message,
        detail: job.error?.detail,
        spawned: m ? m[1] === 'true' : undefined,
        childStdout: out ? out[1] : undefined,
        childExit: exit ? Number(exit[1]) : undefined,
      };
    };

    // ---- 6b-1：**没声明** exec，代码里却用了 subprocess → 拒绝装载 ----
    await installProbe(false);
    const blocked = await runProbe('undeclared', false);
    console.log(`   [没声明 exec] ${blocked.status} / ${blocked.code} — ${String(blocked.message).slice(0, 70)}`);
    c.check(blocked.status === 'failed', '没声明 exec 时插件跑不起来', String(blocked.status));
    c.check(
      blocked.code === 'PLUGIN_INVALID',
      '错误码是 PLUGIN_INVALID（作者漏声明，不是运行期故障）',
      String(blocked.code)
    );
    c.check(
      /main\.py/.test(String(blocked.detail ?? '')) && /subprocess/.test(String(blocked.detail ?? '')),
      '详情点名了是哪个文件里的哪个 API',
      String(blocked.detail ?? '').split('\n')[0]
    );
    c.check(
      /kind: exec/.test(String(blocked.detail ?? '')),
      '并且告诉作者声明该怎么写',
      ''
    );

    // ---- 6b-2：声明了 exec、但**没授权** → 仍然拦住（部分授权模型下这是可达状态）----
    await installProbe(true);
    const notGranted = await runProbe('notgranted', false);
    console.log(`   [声明但没授权] ${notGranted.status} / ${notGranted.code} — ${String(notGranted.message).slice(0, 60)}`);
    c.check(notGranted.status === 'failed', '声明了但没授权时仍然跑不起来', String(notGranted.status));
    c.check(
      notGranted.code === 'PERMISSION_DENIED',
      '错误码是 PERMISSION_DENIED（这次是用户还没勾选）',
      String(notGranted.code)
    );

    // ---- 6b-3：声明 + 授权 → 放行，而且子进程**真的起来了** ----
    await grant(EXEC_PROBE, [
      { kind: 'exec' },
      { kind: 'fsRead', scope: { kind: 'input' } },
    ]);
    const allowed = await runProbe('granted', true);
    console.log(`   [声明 + 授权] ${allowed.status} spawned=${allowed.spawned} exit=${allowed.childExit} stdout=${JSON.stringify(allowed.childStdout)}`);
    c.check(allowed.status === 'succeeded', '声明并授权之后插件能跑', String(allowed.status));
    c.check(allowed.spawned === true, '插件真的起了子进程', String(allowed.spawned));
    c.check(
      allowed.childStdout === 'child-ok' && allowed.childExit === 0,
      '子进程真的执行了并且输出被拿到（不是"假装成功"）',
      `${allowed.childExit} / ${allowed.childStdout}`
    );

    // ---- 6b-4：审计里要留下"这个插件会起子进程"的记录 ----
    const audit = await client.invoke('plugins_audit', { limit: 300 });
    const loads = (audit.events ?? []).filter(
      (e) => e.subject === EXEC_PROBE && e.kind === 'installed'
    );
    const withUsage = loads
      .map((e) => {
        try {
          return JSON.parse(e.detail ?? '{}');
        } catch {
          return {};
        }
      })
      .filter((d) => Array.isArray(d.execUsage) && d.execUsage.length > 0);
    console.log(`   L3 装载事件 ${loads.length} 条，其中记了 execUsage 的 ${withUsage.length} 条`);
    c.check(withUsage.length > 0, '审计记录了装载期扫到的 subprocess 用法');
    c.check(
      withUsage.some((d) => d.execGranted === true),
      '审计里也记了"当时 exec 是否已授权"',
      JSON.stringify(withUsage.map((d) => d.execGranted))
    );

    await uninstall(EXEC_PROBE);
  }

  // ==========================================================================
  // 【7】收尾：测试插件不能留在用户的插件列表里
  // ==========================================================================
  c.section('【7】测试插件已清理');
  {
    const all = [
      L2_TEXT,
      L2_HTTP,
      L3_PY,
      NET_PROBE,
      'com.toolforge.test.env-probe',
      'com.toolforge.test.exec-probe',
      'com.toolforge.test.garbage-wasm',
      'com.toolforge.test.wasi-wasm',
      'com.toolforge.test.hostfn-wasm',
      'com.toolforge.test.net-port',
    ];
    for (const id of all) {
      await uninstall(id);
    }
    for (const id of all) {
      const gone = await client.invoke('plugins_get', { pluginId: id }).catch(() => null);
      c.check(!gone, `${id} 已卸载`);
    }
    const list = await client.invoke('plugins_list');
    const ids = (list?.plugins ?? list ?? []).map((p) => p.id ?? p.summary?.id);
    console.log(`   剩余插件: ${ids.join(', ')}`);
    c.check(
      !ids.some((x) => /example|test/.test(String(x))),
      '插件列表里没有示例/测试插件残留',
      ids.join(', ')
    );
  }
} finally {
  server.close();
  client.close();
}

process.exit(c.summary() ? 0 : 1);
