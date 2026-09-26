/**
 * 验证包：三项只有真跑才能验的东西。
 *
 * 1. **产出是否真能解码** —— 只看魔数不足以说明位流完整；
 * 2. **多文件是否真的逐张扇出** —— 这是对"只处理第一张却报告全部成功"
 *    那个 bug 的正面验证（它曾是本项目最危险的一类缺陷：静默地少干活）；
 * 3. **路径穿越在真实链路上是否被拒** —— 装一个**恶意插件**、授权、启用、真跑。
 *    单元测试只能证明 `PathResolver` 函数是对的；这一条证明的是
 *    **install → grant → enable → run 整条链路**上防线仍然成立。
 *
 * 用法：`node scripts/devtools/verify.mjs`
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  connect,
  prepareOutDir,
  writeInputPng,
  webpInfo,
  BUILTIN_PLUGINS,
  Checker,
} from './cdp.mjs';

const c = new Checker();
const client = await connect();

// ============================================================================
// 【1】产出的可解码性与尺寸
// ============================================================================
c.section('【1】真实转换的产出是否可解码');
{
  const outDir = prepareOutDir('out-verify-decode');
  const src = writeInputPng('verify-decode.png', 320, 200, 0);

  const sub = await client.invoke('plugins_run', {
    req: {
      pluginId: BUILTIN_PLUGINS.imageConvert,
      inputs: { src: [src] },
      params: { format: { kind: 'str', value: 'webp' }, quality: { kind: 'int', value: 90 } },
      outputDir: outDir,
    },
  });
  const job = await client.waitJob(sub.jobId);
  c.check(job.status === 'succeeded', '任务成功', job.error ? `${job.error.code}: ${job.error.message}` : '');

  const files = existsSync(outDir) ? readdirSync(outDir) : [];
  c.check(files.length === 1, '产出 1 个文件', `实际 ${files.length}`);

  if (files.length === 1) {
    const buf = readFileSync(join(outDir, files[0]));
    const info = webpInfo(buf);
    console.log(`   ${files[0]}  ${buf.length} 字节  ${JSON.stringify(info)}`);
    c.check(info !== null, '是合法 WebP 容器', info?.format ?? '');
    c.check(info?.format?.startsWith('VP8L'), '无损编码（纯 Rust 后端的唯一模式）', info?.format ?? '');
    c.check(info?.width === 320 && info?.height === 200, '解码尺寸与输入一致 320x200', info ? `${info.width}x${info.height}` : '');
  }
}

// ============================================================================
// 【2】多文件输入是否逐张扇出
// ============================================================================
c.section('【2】多文件输入是否真的逐张处理');
{
  const outDir = prepareOutDir('out-verify-multi');
  const files = [
    writeInputPng('multi-0.png', 200, 150, 1),
    writeInputPng('multi-1.png', 240, 150, 2),
    writeInputPng('multi-2.png', 280, 150, 3),
  ];
  console.log(`   ${files.length} 张输入`);

  const sub = await client.invoke('plugins_run', {
    req: {
      pluginId: BUILTIN_PLUGINS.imageConvert,
      inputs: { src: files },
      params: { format: { kind: 'str', value: 'png' }, quality: { kind: 'int', value: 90 } },
      outputDir: outDir,
    },
  });
  console.log(`   提交返回: ${JSON.stringify(sub)}`);
  c.check(sub?.totalItems === files.length, `totalItems 反映真实文件数（${files.length}）`, `实际 ${sub?.totalItems}`);

  const job = await client.waitJob(sub.jobId);
  c.check(job.status === 'succeeded', '任务成功');
  c.check(job.outputs.length === files.length, '产出数与输入一致', `实际 ${job.outputs.length}`);
  c.check(new Set(job.outputs.map((o) => o.toLowerCase())).size === files.length, '产出是**不同**的文件（没互相覆盖）');

  const onDisk = existsSync(outDir) ? readdirSync(outDir) : [];
  c.check(onDisk.length === files.length, '磁盘上真的有这么多产物', `实际 ${onDisk.length}: ${onDisk.join(', ')}`);

  // 尺寸各不相同 → 证明每个输入都被真的读了，而不是复制了同一份
  const dims = onDisk.map((f) => {
    const b = readFileSync(join(outDir, f));
    // PNG IHDR: 宽高在偏移 16/20
    return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
  });
  c.check(new Set(dims).size === files.length, '三个产出的尺寸各不相同（各自独立处理）', dims.join(', '));
}

// ============================================================================
// 【3】恶意插件：授权根之外的路径是否在真实链路上被拒
// ============================================================================
c.section('【3】恶意插件：授权根之外的绝对路径是否被拒');
{
  const EVIL_ID = 'com.toolforge.test.evil-traversal';
  const outDir = prepareOutDir('out-verify-evil');

  // 步骤里写死一个**授权根之外**的绝对路径。
  // 输入根会由宿主按输入文件所在目录算出，绝不可能包含系统目录。
  const evilYaml = `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${EVIL_ID}
  name: 穿越测试插件
  version: 1.0.0
  description: 仅用于验证路径收敛；步骤里故意写死一个授权根之外的绝对路径。
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
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
      required: false
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    steps:
      - id: escape
        uses: fs.copy
        label: 试图读取授权根之外的文件
        with:
          src: "C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts"
          dst: "\${output.dst}"
`;

  try {
    const existing = await client.invoke('plugins_get', { pluginId: EVIL_ID });
    if (!existing) {
      const rep = await client.invoke('plugins_install', {
        req: {
          source: { kind: 'manifest', yaml: evilYaml },
          overwrite: false,
          permissionsAcknowledged: true,
          executableCodeAcknowledged: false,
        },
      });
      console.log(`   安装完成，哈希 ${String(rep.contentHash).slice(0, 24)}…`);
    } else {
      console.log('   插件已存在，跳过安装');
    }

    await client.invoke('plugins_grant', {
      req: {
        pluginId: EVIL_ID,
        granted: {
          capabilities: [
            { kind: 'fsRead', scope: { kind: 'input' } },
            { kind: 'fsWrite', scope: { kind: 'output' } },
          ],
        },
      },
    });
    await client.invoke('plugins_set_enabled', { pluginId: EVIL_ID, enabled: true });
    console.log('   已授权并启用');

    const sub = await client.invoke('plugins_run', {
      req: {
        pluginId: EVIL_ID,
        inputs: { src: [writeInputPng('evil-input.png', 64, 64, 0)] },
        params: {},
        outputDir: outDir,
      },
    });
    const job = await client.waitJob(sub.jobId);
    console.log(`   任务状态: ${job.status}`);
    if (job.error) console.log(`   错误: ${job.error.code} — ${job.error.message}`);

    c.check(job.status === 'failed', '任务被拒绝（而不是偷偷读到了根外文件）', `status=${job.status}`);
    c.check(job.error?.code === 'PERMISSION_DENIED', '拒绝原因是 PERMISSION_DENIED', job.error?.code ?? '(无 error)');
    c.check(
      /逃逸|之外/.test(String(job.error?.message ?? '')),
      '错误信息指明了是路径越界',
      job.error?.message ?? ''
    );

    // 审计：这是最该被记录的安全事件
    const audit = await client.invoke('plugins_audit', { limit: 200 });
    const escaped = (audit.events ?? []).filter(
      (e) => e.kind === 'pathEscapeBlocked' && e.subject === EVIL_ID
    );
    console.log(`   审计里 pathEscapeBlocked 条目: ${escaped.length}`);
    c.check(escaped.length > 0, '路径逃逸尝试已写入审计日志');
    if (escaped.length > 0) {
      console.log(`     摘要: ${escaped[escaped.length - 1].summary}`);
    }

    // 收尾：别把测试插件留在用户的插件列表里
    await client.invoke('plugins_set_enabled', { pluginId: EVIL_ID, enabled: false });
    await client.invoke('plugins_uninstall', { pluginId: EVIL_ID });
    const gone = await client.invoke('plugins_get', { pluginId: EVIL_ID });
    c.check(!gone, '测试插件已清理');
  } catch (e) {
    c.check(false, '恶意插件测试抛错', String(e.message).split('\n')[0]);
  }
}

// ============================================================================
// 【4】用户显式指定的输出目录会被尊重（这是**预期行为**，不是漏洞）
// ============================================================================
c.section('【4】对照项：用户显式指定的输出目录应当被尊重');
{
  const oddDir = join(prepareOutDir('out-verify-custom'), 'nested', 'deeper');
  const src = writeInputPng('custom-out.png', 80, 60, 0);
  const sub = await client.invoke('plugins_run', {
    req: {
      pluginId: BUILTIN_PLUGINS.imageConvert,
      inputs: { src: [src] },
      params: { format: { kind: 'str', value: 'png' }, quality: { kind: 'int', value: 90 } },
      outputDir: oddDir,
    },
  });
  const job = await client.waitJob(sub.jobId);
  c.check(job.status === 'succeeded', '用户选的（尚不存在的深层）输出目录会被创建并使用', job.status);
}

client.close();
process.exit(c.summary() ? 0 : 1);
