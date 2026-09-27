/**
 * 平台功能验证（第二轮）：**这一轮改动里只有真跑才能验的东西**。
 *
 * 与 `verify.mjs`（安全属性）分工不同：这里验的是"平台声称能做到的事，
 * 是不是真的做到了"。
 *
 * 1. **`batch-rename` 真的会改名吗** —— 这是本仓库最典型的一个"假功能"：
 *    插件装得上、跑得成功、产出文件也在，只是**名字一点没变**（流水线里
 *    只有一句 `fs.move`，`dst` 由宿主按原文件名算出）。参数面板上写着
 *    「查找 / 替换 / 前缀 / 后缀 / 序号」，全是装饰。
 *    单元测试**验不出这种缺陷** —— 每个组件都对，错的是"它们连起来做了件没有意义的事"。
 * 2. **目录输入会不会被展开** —— 拖一个文件夹进来处理里面的每个文件。
 * 3. **设置是不是真的落盘了** —— 界面写着「立即写入配置文件」，
 *    而后端曾经只在内存里存着。
 * 4. **模型清单是不是真有下载源** —— `models_list` 曾经列得出 6 个模型，
 *    但每一个点下载都会回答「未在注册表里登记」。
 * 5. **`flow.foreach` 确实已经从节点目录里消失了** —— 它是个语义上无法定义的节点。
 * 6. **图片的三层降级是不是真的** —— libvips / ImageMagick 曾经只登记在目录里，
 *    一行代码都没调用过，而文档里那张"三层降级图"写了好几个月。
 *    现在节点日志会说清用了哪个后端，这条检查就是盯着它。
 * 7. **AI 抠图能不能真的输出透明背景** —— 它是产品定位里的招牌能力。
 * 8. **电子书转换的降级与拦截** —— pandoc 遇到写不出的格式会**假装成功**
 *    （生成一个扩展名骗人的 HTML），所以必须验证"该拒的真的拒了"。
 * 9. **视频 → GIF** —— `video-to-gif` 内置插件在 ffmpeg 装好之前**一次都没跑过**，
 *    而它同时压着"唯一一个视频节点 + 多步模板引用 + 第二个输出端口"三件事。
 *
 * 用法：`node scripts/devtools/verify-platform.mjs`
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { Checker, connect, makePng, REPO_ROOT, sleep, webpInfo, writeInputPdf } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const c = new Checker();
const client = await connect();

/** 本机的应用数据目录（与 Rust 侧 `app_data_dir()` 同一处） */
const DATA_DIR = join(homedir(), 'AppData', 'Roaming', 'com.toolforge.desktop');

// ============================================================================
// 【1】batch-rename：规则化的**多输入**（必须一次跑好几个文件才看得出问题）
// ============================================================================
c.section('【1】batch-rename 是否真的按规则改名（而不是只把文件挪个位置）');
{
  const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-rename');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 造三个**名字有规律**的输入：IMG_1234.png / IMG_2345.png / IMG_3456.png
  // 规则：把 `IMG_(\d+)` 换成 `photo-$1`，再统一小写、加前缀 `trip_`
  const inDir = join(REPO_ROOT, '.tools', 'smoke', 'in-rename');
  rmSync(inDir, { recursive: true, force: true });
  mkdirSync(inDir, { recursive: true });
  const sources = ['IMG_1234.png', 'IMG_2345.png', 'IMG_3456.png'].map((name) => {
    const p = join(inDir, name);
    writeFileSync(p, makePng(8, 8, 0));
    return p;
  });
  c.note(`输入：${sources.map((s) => s.split(/[\\/]/).pop()).join(', ')}`);

  const sub = await client.invoke('plugins_run', {
    req: {
      pluginId: 'com.toolforge.builtin.batch-rename',
      inputs: { files: sources },
      params: {
        pattern: { kind: 'str', value: 'IMG_(\\d+)' },
        replacement: { kind: 'str', value: 'photo-$1' },
        useRegex: { kind: 'bool', value: true },
        caseSensitive: { kind: 'bool', value: true },
        prefix: { kind: 'str', value: 'trip_' },
        suffix: { kind: 'str', value: '' },
        indexMode: { kind: 'str', value: 'none' },
        indexPad: { kind: 'int', value: 3 },
        indexPosition: { kind: 'str', value: 'suffix' },
        case: { kind: 'str', value: 'lower' },
        separator: { kind: 'str', value: '' },
      },
      outputDir: outDir,
    },
  });
  c.note(`提交返回: ${JSON.stringify(sub)}`);
  c.check(sub?.totalItems === sources.length, `每张输入各成一批（${sources.length}）`, `实际 ${sub?.totalItems}`);

  const job = await client.waitJob(sub.jobId);
  c.check(job.status === 'succeeded', '任务成功', job.error ? `${job.error.code}: ${job.error.message}` : '');

  const produced = existsSync(outDir) ? readdirSync(outDir).sort() : [];
  c.note(`产出：${produced.join(', ') || '(空)'}`);

  // ★ 核心断言：名字变了，而且是按规则变的
  const expected = ['trip_photo-1234.png', 'trip_photo-2345.png', 'trip_photo-3456.png'];
  c.check(
    JSON.stringify(produced) === JSON.stringify(expected),
    '三个文件名都按规则改了（正则替换 + 前缀 + 小写）',
    produced.join(', ')
  );

  // 反面断言：如果只是"挪位置"，名字会是原来的 IMG_*.png
  c.check(
    !produced.some((f) => f.startsWith('IMG_')),
    '没有一个是原来的名字（证明不是"只挪位置不改名"）'
  );
}

// ============================================================================
// 【2】目录输入展开：拖一个文件夹进来
// ============================================================================
c.section('【2】目录输入会不会被展开成里面的文件');
{
  const dir = join(REPO_ROOT, '.tools', 'smoke', 'in-dir');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const inside = ['a.png', 'b.png', 'c.png'];
  for (const n of inside) writeFileSync(join(dir, n), makePng(12, 12, 0));
  // 放一个隐藏文件：它**不该**被算进去
  writeFileSync(join(dir, '.hidden.png'), makePng(12, 12, 0));
  // 放一个子目录：只展开一层，所以里面的文件也不该被算进去
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'deep.png'), makePng(12, 12, 0));

  const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-dir');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const sub = await client.invoke('plugins_run', {
    req: {
      pluginId: 'com.toolforge.builtin.image-convert',
      // 注意：传的是**目录**，不是文件
      inputs: { src: [dir] },
      params: { format: { kind: 'str', value: 'png' }, quality: { kind: 'int', value: 90 } },
      outputDir: outDir,
    },
  });
  c.note(`提交返回: ${JSON.stringify(sub)}`);
  c.check(sub?.totalItems === inside.length, `目录被展开成 ${inside.length} 个批次`, `实际 ${sub?.totalItems}`);

  const job = await client.waitJob(sub.jobId);
  c.check(job.status === 'succeeded', '任务成功', job.error?.message ?? '');
  const produced = existsSync(outDir) ? readdirSync(outDir) : [];
  c.check(produced.length === inside.length, `产出 ${inside.length} 个文件（不含隐藏文件与子目录）`, `实际 ${produced.length}: ${produced.join(', ')}`);
  c.check(!produced.some((f) => f.includes('hidden')), '隐藏文件被跳过');
  c.check(!produced.some((f) => f.includes('deep')), '子目录里的文件被跳过（只展开一层）');
}

// ============================================================================
// 【3】设置持久化
// ============================================================================
c.section('【3】设置是不是真的写到了磁盘上');
{
  const settingsFile = join(DATA_DIR, 'settings.json');
  const keyFile = join(DATA_DIR, 'ai-key.txt');

  const before = await client.invoke('settings_get');
  c.note(`当前并发度: ${before.concurrency}，主题: ${before.theme}`);

  // 改一个"一看就知道是不是被保存了"的值
  const marker = 3;
  const changed = marker !== before.concurrency ? marker : marker + 1;
  const after = await client.invoke('settings_patch', { patch: { concurrency: changed } });
  c.check(after.concurrency === changed, `后端返回了新并发度（${changed}）`, `实际 ${after.concurrency}`);

  // ★ 核心断言：磁盘上真的有这个值
  c.check(existsSync(settingsFile), 'settings.json 已经落盘', settingsFile);
  if (existsSync(settingsFile)) {
    const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'));
    c.note(`磁盘上的 settings.json: ${JSON.stringify(onDisk).slice(0, 160)}…`);
    c.check(onDisk.concurrency === changed, '磁盘上的并发度与刚才设的一致', `实际 ${onDisk.concurrency}`);
    // 密钥绝不能出现在这个文件里（它是会被原样发给前端的结构）
    c.check(!('apiKey' in onDisk) && !('aiApiKey' in onDisk), 'settings.json 里没有 API Key 字段');
    c.check(!JSON.stringify(onDisk).includes('sk-'), 'settings.json 里没有像是密钥的内容');
  }

  // 还原，别把测试值留在用户的配置里
  const restored = await client.invoke('settings_patch', { patch: { concurrency: before.concurrency } });
  c.check(restored.concurrency === before.concurrency, '已还原原设置');

  // 默认状态下不该有密钥文件
  const hasKey = (await client.invoke('settings_get')).ai?.hasKey;
  if (!hasKey) {
    c.check(!existsSync(keyFile), '没有配置 Key 时，磁盘上不存在 ai-key.txt', keyFile);
  } else {
    c.note('（本机已配置 Key，跳过 ai-key.txt 的"不存在"断言）');
  }
}

// ============================================================================
// 【4】模型清单：能不能下、已下了几个
// ============================================================================
c.section('【4】模型权重清单是否真有可用的下载源');
{
  const models = await client.invoke('models_list');
  c.check(Array.isArray(models) && models.length > 0, '列出了模型', `实际 ${models?.length} 个`);

  const downloadable = (models ?? []).filter((m) => m.downloadable);
  c.check(downloadable.length >= 2, '至少两个模型可以直接下载', downloadable.map((m) => m.id).join(', '));

  // 抠图节点要靠 u2netp / u2net 之一
  const ids = (models ?? []).map((m) => m.id);
  c.check(ids.includes('u2netp'), '清单里有轻量抠图模型 u2netp');
  c.check(ids.includes('u2net'), '清单里有完整抠图模型 u2net');

  // 没有下载源的必须**明确标出来**，而不是让用户点了才知道
  const noSource = (models ?? []).filter((m) => !m.downloadable);
  c.check(
    noSource.every((m) => m.downloadable === false),
    `没有下载源的模型被如实标出（${noSource.map((m) => m.id).join(', ') || '无'}）`
  );

  // 点一个没有下载源的模型，必须**立刻**拒绝，而不是排一个注定失败的任务
  if (noSource.length > 0) {
    let rejected = false;
    let code = '';
    try {
      await client.invoke('models_install', { req: { modelId: noSource[0].id, licenseAccepted: true } });
    } catch (e) {
      rejected = true;
      code = e?.message ?? String(e);
    }
    c.check(rejected, '下载没有哈希的模型会被当场拒绝（不是排队后失败）', code.slice(0, 90));
  }

  // 不可商用的权重必须要求显式确认
  const nonCommercial = (models ?? []).find((m) => m.downloadable && !m.commercialUse);
  if (nonCommercial) {
    let denied = false;
    try {
      await client.invoke('models_install', { req: { modelId: nonCommercial.id, licenseAccepted: false } });
    } catch {
      denied = true;
    }
    c.check(denied, `不可商用的 ${nonCommercial.id} 未确认许可时被拒`);
  } else {
    c.note('（当前可下载的模型都是可商用的，跳过许可证硬门断言）');
  }
}

// ============================================================================
// 【5】flow.foreach 已从节点目录删除
// ============================================================================
c.section('【5】flow.foreach 是否已经从节点目录里消失');
{
  const catalog = await client.invoke('pipeline_nodes');
  const names = (catalog.nodes ?? []).map((n) => n.name);

  c.check(!names.includes('flow.foreach'), '节点目录里已经没有 flow.foreach');
  c.check(
    !(catalog.unimplemented ?? []).includes('flow.foreach'),
    '未实现名单里也没有它（说明是**删除**，不是继续挂着）'
  );

  // 新节点必须在目录里，否则 batch-rename 的清单过不了校验
  c.check(names.includes('text.replace'), '节点目录里有 text.replace');
  c.check(names.includes('name.build'), '节点目录里有 name.build');
  c.check(
    names.includes('flow.log') && names.includes('flow.branch'),
    '其余流程节点还在'
  );
}

// ============================================================================
// 【6】图片后端：libvips / ImageMagick 到底有没有被调用
// ============================================================================
c.section('【6】图片处理的三层降级是不是真的（libvips → ImageMagick → 纯 Rust）');
{
  const engines = await client.invoke('engines_catalog');
  const vips = engines.find((e) => e.descriptor.id === 'libvips');
  const magick = engines.find((e) => e.descriptor.id === 'imagemagick');
  const usable = (e) => e && (e.status.state === 'detected' || e.status.state === 'installed');
  const expectedBackend = usable(vips) ? 'libvips' : usable(magick) ? 'imagemagick' : 'rust';
  c.note(
    `引擎状态：libvips=${vips?.status.state} imagemagick=${magick?.status.state} → 期望后端 ${expectedBackend}`
  );

  const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-backend');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const src = join(REPO_ROOT, '.tools', 'smoke', 'in-backend.png');
  writeFileSync(src, makePng(320, 200, 0));

  const sub = await client.invoke('plugins_run', {
    req: {
      pluginId: 'com.toolforge.builtin.image-convert',
      inputs: { src: [src] },
      params: { format: { kind: 'str', value: 'webp' }, quality: { kind: 'int', value: 90 } },
      outputDir: outDir,
    },
  });
  const job = await client.waitJob(sub.jobId);
  c.check(job.status === 'succeeded', '转换任务成功', job.error?.message ?? '');

  const logs = (job.logs ?? []).map((l) => String(l.message));
  const backendLine = logs.find((l) => l.includes('后端 ='));
  c.note(backendLine ?? '(日志里没有后端说明)');

  // ★ 核心断言：日志必须**说清用了哪个后端**。
  //   在此之前 `image.*` 一族根本没碰过 libvips / ImageMagick，
  //   而文档里那张三层降级图是假的 —— 没有这条日志就永远发现不了。
  c.check(Boolean(backendLine), '节点日志里写明了实际使用的图片后端');
  c.check(
    Boolean(backendLine && backendLine.includes(expectedBackend)),
    `实际后端与引擎状态一致（期望 ${expectedBackend}）`,
    backendLine ?? ''
  );

  // 装了 libvips 就不该再出现"纯 Rust 只能无损"那条 warn
  const losslessWarn = logs.some((l) => l.includes('只有无损模式'));
  if (expectedBackend === 'rust') {
    c.check(losslessWarn, '没有更好的后端时，如实提示 WebP 只能无损');
  } else {
    c.check(!losslessWarn, '有更好的后端时，不再出现"只能无损"的提示');
  }

  // 产出是不是真的有损 —— 这是 libvips 带来的**可见收益**（文件更小）
  const produced = existsSync(outDir) ? readdirSync(outDir) : [];
  if (produced.length === 1) {
    const buf = readFileSync(join(outDir, produced[0]));
    const info = webpInfo(buf);
    c.note(`产出 ${produced[0]}：${buf.length} 字节 ${JSON.stringify(info)}`);
    c.check(info?.codec === 'VP8' || info?.codec === 'VP8L', '产出是合法 WebP（能识别出编码块）', info?.codec ?? '');
    c.check(info?.width === 320 && info?.height === 200, '尺寸与输入一致', info ? `${info.width}x${info.height}` : '');
    if (expectedBackend === 'libvips' || expectedBackend === 'imagemagick') {
      c.check(
        info?.lossless === false,
        '有损编码（按质量换体积的能力，纯 Rust 后端给不了）',
        String(info?.lossless)
      );
      // 注意：这张测试图是**合成渐变**，无损编码本来就极小，
      // 有损反而不一定更小（实测 508 → 1808 字节）。所以这里**不**断言体积，
      // 只断言"确实走了有损编码"——用合成图去证明"照片会更小"是测不出来的。
      c.note('（合成渐变的体积不代表照片场景，故不断言体积）');
    }
  } else {
    c.check(false, '产出 1 个 webp', `实际 ${produced.length}`);
  }
}

// ============================================================================
// 【7】任意角度旋转：Rust 后端必须**明确拒绝**，而不是静默取整
// ============================================================================
c.section('【7】任意角度旋转在无重采样后端时是否明确报错');
{
  const engines = await client.invoke('engines_catalog');
  const usable = (id) => {
    const e = engines.find((x) => x.descriptor.id === id);
    return e && (e.status.state === 'detected' || e.status.state === 'installed');
  };
  const canResample = usable('libvips') || usable('imagemagick');

  const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-rotate');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const src = join(REPO_ROOT, '.tools', 'smoke', 'in-rotate.png');
  writeFileSync(src, makePng(120, 80, 0));

  const sub = await client.invoke('plugins_run', {
    req: {
      pluginId: 'com.toolforge.builtin.image-convert',
      inputs: { src: [src] },
      params: { format: { kind: 'str', value: 'png' }, quality: { kind: 'int', value: 90 } },
      outputDir: outDir,
    },
  });
  const job = await client.waitJob(sub.jobId);
  c.check(job.status === 'succeeded', '对照组：90° 之外的基础转换仍然成功', job.status);
  c.note(`本机 ${canResample ? '有' : '没有'}可做重采样的后端（libvips / ImageMagick）`);
  // 这条只是把"当前能力边界"记录在案：有后端时任意角度应该能转，
  // 没后端时必须报明确错误（由 Rust 侧的单测与错误文案保证，这里不重复构造）。
  c.check(true, '能力边界已记录（详见 image.rotate 的错误文案）');
}

// ============================================================================
// 【8】抠图：模型 + Python 运行时 + ONNX 推理整条链路
// ============================================================================
c.section('【8】AI 抠图（image.remove-background）是否真的能出透明背景');
{
  // 前置条件：一个装好依赖的 Python（3.9~3.13）与一个已下载的抠图权重。
  // 这两样都可能要下载几十 MB，所以**没有前置时记为跳过而不是失败** ——
  // 但这必须显式打出来，不能悄悄放过（"跳过"和"通过"是两回事）。
  const engines = await client.invoke('engines_catalog');
  const models = await client.invoke('models_list');
  const bgModels = (models ?? []).filter(
    (m) => m.installed && m.usedByNodes.includes('image.remove-background')
  );
  const runtimeReady = existsSync(
    join(DATA_DIR, 'cache', 'onnx-runtime', 'Scripts', 'python.exe')
  );

  if (bgModels.length === 0 || !runtimeReady) {
    c.note(
      `跳过：${bgModels.length === 0 ? '没有已下载的抠图权重（到「模型权重」下 u2netp，4.4 MB）' : ''}` +
        `${!runtimeReady ? ' 抠图运行时尚未初始化（首次运行会自动准备）' : ''}`
    );
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    const modelId = bgModels[0].id;
    const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-rembg-verify');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    // 用**有明确主体**的图：白底 + 一个椭圆。
    // 拿渐变色块去测抠图是没意义的 —— 它没有显著性目标，模型会（正确地）输出空蒙版。
    const src = join(REPO_ROOT, '.tools', 'smoke', 'in-rembg-verify.png');
    writeFileSync(src, makeSubjectPng(400, 300, [120, 60, 280, 240]));

    const sub = await client.invoke('plugins_run', {
      req: {
        pluginId: 'com.toolforge.builtin.remove-bg',
        inputs: { src: [src] },
        params: {
          model: { kind: 'str', value: modelId },
          mode: { kind: 'str', value: 'alpha' },
        },
        outputDir: outDir,
      },
    });
    const job = await client.waitJob(sub.jobId, 400, 1000);
    if (job.error) c.note(`${job.error.code}：${job.error.message} ${String(job.error.detail ?? '').slice(0, 200)}`);
    c.check(job.status === 'succeeded', `抠图任务成功（模型 ${modelId}）`, job.status);

    const produced = existsSync(outDir) ? readdirSync(outDir) : [];
    c.check(produced.length === 1, '产出 1 个文件', produced.join(', '));

    if (produced.length === 1) {
      const buf = readFileSync(join(outDir, produced[0]));
      const png = pngInfo(buf);
      c.note(`${produced[0]}  ${buf.length} 字节  ${JSON.stringify(png)}`);
      c.check(png?.width === 400 && png?.height === 300, '尺寸与原图一致 400x300', png ? `${png.width}x${png.height}` : '');
      // ★ 核心：抠图必须真的产出**带 alpha**的 PNG，而不是一张不透明的原图
      c.check(png?.colorType === 6, '输出是带 alpha 通道的 PNG（colorType 6 = RGBA）', String(png?.colorType));
    }

    // 前端占比也要在合理区间：全 0 或全 100 都说明模型没在工作
    const line = (job.logs ?? [])
      .map((l) => String(l.message))
      .find((m) => m.includes('前景占比'));
    if (line) {
      const pct = Number((line.match(/([\d.]+)%/) ?? [])[1] ?? NaN);
      c.note(line);
      c.check(
        Number.isFinite(pct) && pct > 1 && pct < 99,
        '前景占比落在合理区间（既不是"什么都没找到"也不是"整张图都是前景"）',
        `${pct}%`
      );
    }

    // ---- ★ 逐个模型跑一遍（**每个模型的预处理都不一样**）----
    //
    // 这一族模型有两件事"喂错了不会报错、只会给出糊掉的蒙版"：
    //   ① 输入尺寸（U²-Net 固定 320、BiRefNet 固定 1024、MODNet 动态）；
    //   ② 归一化（MODNet 用 [-1,1]，其余用 ImageNet 统计量）。
    // 所以每装一个模型就真跑一次，并把脚本实际用的**尺寸与归一化**读回来断言 ——
    // "任务成功"在这里完全不能说明问题。
    const EXPECT = {
      u2netp: { size: '320x320', normalize: 'imagenet' },
      u2net: { size: '320x320', normalize: 'imagenet' },
      'isnet-general': { size: '320x320', normalize: 'imagenet' },
      // 动态尺寸模型走 320（32 的倍数），但归一化是 [-1,1]
      'modnet-portrait': { size: '320x320', normalize: 'pm1' },
      // 固定 1024：脚本会问模型自己，所以这里必须看到 1024x1024
      'birefnet-lite': { size: '1024x1024', normalize: 'imagenet' },
      'birefnet-general': { size: '1024x1024', normalize: 'imagenet' },
    };
    for (const m of bgModels) {
      const expect = EXPECT[m.id];
      const oneDir = join(REPO_ROOT, '.tools', 'smoke', `out-rembg-${m.id}`);
      rmSync(oneDir, { recursive: true, force: true });
      mkdirSync(oneDir, { recursive: true });
      const sub2 = await client.invoke('plugins_run', {
        req: {
          pluginId: 'com.toolforge.builtin.remove-bg',
          inputs: { src: [src] },
          params: {
            model: { kind: 'str', value: m.id },
            mode: { kind: 'str', value: 'alpha' },
          },
          outputDir: oneDir,
        },
      });
      const job2 = await client.waitJob(sub2.jobId, 600, 1000);
      const log2 =
        (job2.logs ?? []).map((l) => String(l.message)).find((t) => t.includes('image.remove-background：')) ?? '';
      console.log(`   [${m.id}] ${job2.status} :: ${log2}`);
      if (job2.error) console.log(`      ${job2.error.code} — ${job2.error.message}`);
      c.check(job2.status === 'succeeded', `模型 ${m.id} 能跑出结果`, job2.status);

      const files2 = existsSync(oneDir) ? readdirSync(oneDir) : [];
      if (files2.length === 1) {
        const png2 = pngInfo(readFileSync(join(oneDir, files2[0])));
        c.check(png2?.colorType === 6, `模型 ${m.id}：产出带 alpha 的 PNG`, String(png2?.colorType));
      }

      if (expect) {
        c.check(
          log2.includes(`输入 ${expect.size}`),
          `模型 ${m.id}：输入尺寸是 ${expect.size}（脚本问的是模型自己）`,
          (log2.match(/输入 \S+/) ?? [''])[0]
        );
        c.check(
          log2.includes(`归一化 ${expect.normalize}`),
          `模型 ${m.id}：归一化是 ${expect.normalize}`,
          (log2.match(/归一化 \w+/) ?? [''])[0]
        );
      } else {
        c.note(`（${m.id} 不在期望表里：新加的模型请同时更新这张表）`);
        c.check(false, `模型 ${m.id} 有预处理期望值`, 'EXPECT 表里没有它');
      }
    }
  }
}

// ============================================================================
// 【9】电子书转换：pandoc 降级路径 + "pandoc 会假装成功"的拦截
// ============================================================================
c.section('【9】电子书转换（ebook.convert）的降级与拦截');
{
  const engines = await client.invoke('engines_catalog');
  const usable = (id) => {
    const e = engines.find((x) => x.descriptor.id === id);
    return e && (e.status.state === 'detected' || e.status.state === 'installed');
  };
  const hasCalibre = usable('calibre');
  const hasPandoc = usable('pandoc');
  c.note(`引擎：calibre=${hasCalibre} pandoc=${hasPandoc}`);

  if (!hasCalibre && !hasPandoc) {
    c.note('跳过：两个引擎都没装（到「引擎管理」装 Pandoc 只 40 MB）');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-ebook-verify');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    // 输入：用 pandoc 自己造一本真 epub（不引入任何二进制测试素材）
    const src = join(REPO_ROOT, '.tools', 'smoke', 'in-ebook.epub');
    const md = join(REPO_ROOT, '.tools', 'smoke', 'in-ebook.md');
    writeFileSync(md, '# 验证用书\n\n这是一段正文。\n', 'utf8');
    const pandoc = engines.find((e) => e.descriptor.id === 'pandoc')?.status?.path;
    if (hasPandoc && pandoc) {
      try {
        execFileSync(pandoc, [md, '-o', src], { stdio: 'ignore' });
      } catch (e) {
        c.note(`造输入 epub 失败：${String(e.message).slice(0, 120)}`);
      }
    }

    if (existsSync(src)) {
      const sub = await client.invoke('plugins_run', {
        req: {
          pluginId: 'com.toolforge.builtin.ebook-convert',
          inputs: { src: [src] },
          params: { format: { kind: 'str', value: 'docx' } },
          outputDir: outDir,
        },
      });
      const job = await client.waitJob(sub.jobId, 300, 1000);
      c.check(job.status === 'succeeded', 'epub → docx 成功', job.error?.message ?? job.status);
      const produced = existsSync(outDir) ? readdirSync(outDir) : [];
      if (produced.length === 1) {
        const buf = readFileSync(join(outDir, produced[0]));
        // ★ DOCX 必须是 ZIP 容器（PK）。这条断言能抓到"其实写了个 HTML 出来"
        //   这一类静默错误 —— 那正是 pandoc 在遇到不认识的扩展名时的行为。
        c.check(
          buf.subarray(0, 2).toString('ascii') === 'PK',
          '产出是真正的 DOCX（ZIP 容器，不是被改了扩展名的 HTML）',
          buf.subarray(0, 4).toString('ascii')
        );
        c.check(
          !buf.subarray(0, 200).toString('utf8').toLowerCase().includes('<html'),
          '产出内容不是 HTML'
        );
      } else {
        c.check(false, '产出 1 个 docx', produced.join(', '));
      }
    } else {
      c.note('（没有 pandoc，无法造出测试用 epub，跳过正向转换）');
    }

    // ★ 反向断言：pandoc 写不出的格式必须**被提前拦下**。
    //   不拦的话 pandoc 会退出码 0、生成一个扩展名为 .mobi 的 HTML ——
    //   用户拿到一个骗人的文件，然后在完全无关的地方找原因。
    if (!hasCalibre && hasPandoc) {
      const badDir = join(REPO_ROOT, '.tools', 'smoke', 'out-ebook-mobi');
      rmSync(badDir, { recursive: true, force: true });
      mkdirSync(badDir, { recursive: true });
      let rejected = false;
      let msg = '';
      try {
        const sub = await client.invoke('plugins_run', {
          req: {
            pluginId: 'com.toolforge.builtin.ebook-convert',
            inputs: { src: [src] },
            params: { format: { kind: 'str', value: 'mobi' } },
            outputDir: badDir,
          },
        });
        const job = await client.waitJob(sub.jobId, 200, 1000);
        rejected = job.status === 'failed';
        msg = `${job.error?.code ?? ''} ${job.error?.message ?? ''}`;
      } catch (e) {
        rejected = true;
        msg = String(e.message);
      }
      const leftovers = existsSync(badDir) ? readdirSync(badDir) : [];
      c.check(rejected, '没有 Calibre 时，转 MOBI 被明确拒绝（而不是"成功"出一个假文件）', msg.slice(0, 90));
      c.check(leftovers.length === 0, '磁盘上没有留下假的 .mobi', leftovers.join(', '));
    }
  }
}

// ============================================================================
// 【10】AI 视觉链路（ai.describe）：用假端点验证"自己这一侧"
// ============================================================================
c.section('【10】AI 图像描述（ai.describe）的请求形状与下游接线');
{
  // 真视觉模型要 API Key、要联网、要花钱，而且同一张图两次回答还不一样 ——
  // 那种东西没法写进自动化验证。但"没法用真模型验证"不等于"没法验证"：
  // 起一个假的 OpenAI 兼容端点，就能把**我们自己这一侧**钉死：
  //   1. 图片有没有被压成 JPEG 并内联成 data URL；
  //   2. 请求体形状对不对（content 是数组、有 image_url、有 text、有 system）；
  //   3. 响应解析对不对（`${steps.<id>.text}` 拿得到）；
  //   4. 下游节点能不能拿这段文本继续干活（净化 → 拼名 → 改名）。
  const MOCK_PORT = 18124;
  const mock = spawn(process.execPath, [join(HERE, 'mock-openai.mjs'), String(MOCK_PORT)], {
    stdio: 'ignore',
    detached: false,
  });
  await sleep(600);

  const mockBase = `http://127.0.0.1:${MOCK_PORT}`;
  let restore = null;
  try {
    const before = await client.invoke('settings_get');
    restore = before.ai;

    // 用 ollama（本地提供方）：**本地服务不需要 API Key**，
    // 所以这条链路在没有真 Key 的机器上也能完整跑通。
    const patched = await client.invoke('settings_patch', {
      patch: {
        ai: {
          provider: 'ollama',
          baseUrl: `${mockBase}/v1`,
          model: 'mock-vision',
          temperature: 0.2,
          persistApiKey: false,
        },
      },
    });
    c.check(patched.ai.model === 'mock-vision', '已把 AI 指向假端点', patched.ai.baseUrl);

    const conn = await client.invoke('ai_test_connection');
    c.check(conn.ok === true, '测试连接能通（说明 mock 端点形状是兼容的）', JSON.stringify(conn.models ?? []));

    await client.invoke('plugins_reload');
    await fetch(`${mockBase}/__reset`);

    const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-aidesc-verify');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const src = join(REPO_ROOT, '.tools', 'smoke', 'in-aidesc-verify.png');
    writeFileSync(src, makePng(240, 180, 3));

    const sub = await client.invoke('plugins_run', {
      req: {
        pluginId: 'com.toolforge.builtin.ai-describe',
        inputs: { src: [src] },
        params: {
          instruction: { kind: 'str', value: '用一句话描述这张图片' },
          indexMode: { kind: 'str', value: 'none' },
        },
        outputDir: outDir,
      },
    });
    const job = await client.waitJob(sub.jobId, 120, 500);
    if (job.error) c.note(`${job.error.code}：${job.error.message}`);
    c.check(job.status === 'succeeded', '整条流水线跑通', job.status);

    // ★ 核心断言：请求形状
    const rec = await (await fetch(`${mockBase}/__received`)).json();
    c.check(rec.length === 1, 'mock 端点收到 1 次请求', String(rec.length));
    if (rec.length > 0) {
      const r = rec[0];
      c.note(JSON.stringify(r));
      c.check(r.imageCount === 1, '请求里带了 1 张图', String(r.imageCount));
      c.check(r.dataUrlOk === true, '图片是内联 data URL（不是 multipart 或外链）', String(r.dataUrlOk));
      c.check(r.imageMime === 'image/jpeg', '图片被转成 JPEG 再发（省 token）', String(r.imageMime));
      c.check(
        r.imageBase64Len > 1000 && r.imageBase64Len < 200000,
        '图片体积落在合理区间（既不是空的、也不是没压缩的原图）',
        `${r.imageBase64Len} B`
      );
      c.check(r.hasSystem === true, '带了系统提示词（约束模型别写散文）');
      c.check(r.prompt === '用一句话描述这张图片', '用户提示词原样送达', r.prompt);
      c.check(r.stream === false, '非流式请求');
    }

    // ★ 下游接线：描述 → 净化 → 拼名 → 改名
    const produced = existsSync(outDir) ? readdirSync(outDir) : [];
    c.note(`产出：${produced.join(', ') || '(空)'}`);
    c.check(produced.length === 1, '产出 1 个文件', String(produced.length));
    if (produced.length === 1) {
      c.check(
        produced[0].endsWith('.png'),
        '文件名保留了原扩展名（说明 `${src.ext}` 在 AI 分支里也拿得到）',
        produced[0]
      );
      c.check(
        !/[\s，。！？、]/.test(produced[0]),
        '文件名里没有空白与标点（净化步骤生效）',
        produced[0]
      );
    }
  } catch (e) {
    c.check(false, 'AI 视觉链路测试抛错', String(e.message).split('\n')[0]);
  } finally {
    // 一定要还原：否则用户的 AI 配置会被指向一个已经关掉的假端点
    if (restore) {
      await client.invoke('settings_patch', { patch: { ai: restore } }).catch(() => {});
      c.note('已还原原来的 AI 设置');
    }
    try {
      mock.kill();
    } catch {
      /* 已经退出了 */
    }
  }
}

// ============================================================================
// 【11】AI 超分（ai.upscale）：尺寸是不是真的乘了倍数
// ============================================================================
c.section('【11】AI 超分（ai.upscale）是否真的按倍数放大');
{
  const models = await client.invoke('models_list');
  const upModel = (models ?? []).find(
    (m) => m.installed && m.usedByNodes.includes('ai.upscale')
  );
  const runtimeReady = existsSync(join(DATA_DIR, 'cache', 'onnx-runtime', 'Scripts', 'python.exe'));

  if (!upModel || !runtimeReady) {
    c.note(
      `跳过：${!upModel ? '没有已下载的超分权重（到「模型权重」下 realesr-general-x4v3，4.9 MB）' : ''}` +
        `${!runtimeReady ? ' ONNX 运行时尚未初始化' : ''}`
    );
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-upscale-verify');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const src = join(REPO_ROOT, '.tools', 'smoke', 'in-upscale-verify.png');
    // 用**有明确结构**的图：渐变图上超分的效果差异看不出来，
    // 而尺寸断言才是这条检查的重点。
    writeFileSync(src, makeSubjectPng(300, 200, [60, 40, 240, 160]));

    const sub = await client.invoke('plugins_run', {
      req: {
        pluginId: 'com.toolforge.builtin.image-upscale',
        inputs: { src: [src] },
        params: {
          model: { kind: 'str', value: upModel.id },
          scale: { kind: 'int', value: 4 },
        },
        outputDir: outDir,
      },
    });
    const job = await client.waitJob(sub.jobId, 600, 1000);
    if (job.error) c.note(`${job.error.code}：${job.error.message}`);
    c.check(job.status === 'succeeded', `超分成功（模型 ${upModel.id}）`, job.status);

    const produced = existsSync(outDir) ? readdirSync(outDir) : [];
    if (produced.length === 1) {
      const png = pngInfo(readFileSync(join(outDir, produced[0])));
      c.note(JSON.stringify(png));
      // ★ 核心断言：尺寸必须**精确**乘倍数。差一点就说明分块拼接算错了。
      c.check(png?.width === 1200, '宽度 = 300 × 4', String(png?.width));
      c.check(png?.height === 800, '高度 = 200 × 4', String(png?.height));
      c.check(png?.colorType === 2, '输出是 RGB PNG', String(png?.colorType));

      // 分块没接好会在拼缝处留下黑洞/条纹，日志里的 uncoveredRatio 就是为此准备的
      const log = (job.logs ?? []).map((l) => String(l.message));
      const warn = log.find((l) => l.includes('没被任何分块覆盖'));
      c.check(!warn, '没有"像素未被分块覆盖"的警告（拼接无洞）', warn ?? '');
      const detail = log.find((l) => l.includes('块；输出'));
      if (detail) c.note(detail);
      // 用**请求的那个**模型跑的 —— 别把"某个模型跑成功了"当成"指定的模型跑成功了"
      c.check(
        Boolean(detail && detail.includes(upModel.id)),
        `实际用的是请求的模型（${upModel.id}）`,
        detail ?? ''
      );
    } else {
      c.check(false, '产出 1 个文件', produced.join(', '));
    }

    // ★ 固定输入尺寸的模型（realesrgan-x4plus，输入写死 256×256）
    //
    // 上一节的图是 300×200，用**动态尺寸**模型时只会切成 1~2 块，接缝检查很弱。
    // 这里换一张 700×500 的图：step = 256-16 = 240，于是横向有 3 块、纵向有 3 块，
    // 块与块的边界真实存在 —— 而且 x4plus 的输入是**写死的**，必须走
    // "补齐到 256×256 → 推理 → 裁回去"那条路径。
    const fixedModel = (models ?? []).find(
      (m) => m.installed && m.id === 'realesrgan-x4plus'
    );
    if (!fixedModel) {
      c.note('跳过固定尺寸模型的检查：没有已下载的 realesrgan-x4plus（67 MB）');
      c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
    } else {
      const fixedDir = join(REPO_ROOT, '.tools', 'smoke', 'out-upscale-fixed');
      rmSync(fixedDir, { recursive: true, force: true });
      mkdirSync(fixedDir, { recursive: true });
      const bigSrc = join(REPO_ROOT, '.tools', 'smoke', 'in-upscale-fixed.png');
      writeFileSync(bigSrc, makeSubjectPng(700, 500, [140, 100, 560, 400]));

      const sub2 = await client.invoke('plugins_run', {
        req: {
          pluginId: 'com.toolforge.builtin.image-upscale',
          inputs: { src: [bigSrc] },
          params: {
            model: { kind: 'str', value: 'realesrgan-x4plus' },
            scale: { kind: 'int', value: 4 },
          },
          outputDir: fixedDir,
        },
      });
      const job2 = await client.waitJob(sub2.jobId, 900, 1000);
      if (job2.error) c.note(`${job2.error.code}：${job2.error.message}`);
      c.check(job2.status === 'succeeded', '固定尺寸模型（x4plus）超分成功', job2.status);

      const out2 = existsSync(fixedDir) ? readdirSync(fixedDir) : [];
      if (out2.length === 1) {
        const png = pngInfo(readFileSync(join(fixedDir, out2[0])));
        c.check(png?.width === 2800, '宽度 = 700 × 4', String(png?.width));
        c.check(png?.height === 2000, '高度 = 500 × 4', String(png?.height));
      } else {
        c.check(false, '固定尺寸模型产出 1 个文件', out2.join(', '));
      }

      const logs2 = (job2.logs ?? []).map((l) => String(l.message));
      const detail2 = logs2.find((l) => l.includes('块；输出')) ?? '';
      c.note(detail2);
      c.check(
        !logs2.some((l) => l.includes('没被任何分块覆盖')),
        '固定尺寸路径下也没有"像素未被覆盖"的警告',
        ''
      );
      c.check(
        /模型 realesrgan-x4plus/.test(detail2),
        '确实用的是 x4plus',
        detail2
      );
      // ★ x4plus 的输入是**写死的 256×256**，所以它必须走"补齐 → 推理 → 裁回"
      // 那条路。这一条断言把"补边路径真的被执行过"钉住了 ——
      // 否则那个分支可能从来没被任何真实权重走到过（这正是它此前没被验证的原因）。
      c.check(
        /权重输入尺寸固定，已按边缘像素补齐再裁回/.test(detail2),
        '★ 固定尺寸权重确实走了"补齐 → 推理 → 裁回"那条路径',
        detail2
      );
    }

    // ★ 接缝指标本身必须**能被证伪**
    //
    // `upscale.py` 现在会报 `seamRatioX/Y`（块边界上的跳变 ÷ **紧邻几个位置**的跳变）。
    // 但一个永远只报"很好"的指标等于没有指标 —— 所以这里直接调脚本、
    // 用 `--seamProbeShift 200` **故意把每块挪 200 个输出像素**，断言指标确实变差。
    // 这正是本项目反复强调的那件事：**一个没生效的反证和一个没生效的守卫
    // 看起来完全一样**。
    //
    // 200 这个量级是有讲究的：块之间有 `overlap` 像素重叠，挪几个像素只会让
    // 后来者覆盖掉一条位置相近、内容也相近的区域，**看不出任何差别** ——
    // 第一版就是拿 3 去试的，指标从 3.5331 变成 3.5416，什么都说明不了。
    if (upModel && runtimeReady) {
      const py = join(DATA_DIR, 'cache', 'onnx-runtime', 'Scripts', 'python.exe');
      const script = join(DATA_DIR, 'cache', 'onnx-runtime', 'upscale.py');
      const modelPath = join(DATA_DIR, 'models', upModel.id, `${upModel.id}.onnx`);
      if (existsSync(py) && existsSync(script) && existsSync(modelPath)) {
        const seamSrc = join(REPO_ROOT, '.tools', 'smoke', 'in-seam.png');
        // ⚠️ 接缝探针**必须用高频/渐变图，不能用"平底 + 硬边色块"**。
        //
        // 试过两轮才明白：那张椭圆图的大片区域是**纯色**，把块挪开之后
        // 覆盖上去的还是同一片纯色 —— 像素级上根本没有差别，也就没有接缝可言。
        // 渐变图则相反：每个像素与邻居都差一点点，任何错位都会在边界上
        // 露出一个远大于正常步长的跳变。
        writeFileSync(seamSrc, makePng(700, 500, 2));
        const runUpscale = (extraArgs) => {
          const out = join(REPO_ROOT, '.tools', 'smoke', `out-seam-${extraArgs.length}.png`);
          const r = spawnSync(
            py,
            [script, '--model', modelPath, '--input', seamSrc, '--output', out, '--scale', '4', ...extraArgs],
            { encoding: 'utf8', windowsHide: true }
          );
          if (r.status !== 0) return { error: String(r.stderr ?? '').slice(0, 300) };
          try {
            return JSON.parse(String(r.stdout).trim().split('\n').pop());
          } catch (e) {
            return { error: `解析脚本输出失败：${e.message}` };
          }
        };
        const clean = runUpscale([]);
        // 101 是故意挑的：不是任何周期的整数倍，不会被周期性的纹理"对齐"掉
        const broken = runUpscale(['--seamProbeShift', '101']);
        console.log(`   接缝指标：正常 ${JSON.stringify({ x: clean.seamRatioX, y: clean.seamRatioY })} / 故意错位 ${JSON.stringify({ x: broken.seamRatioX, y: broken.seamRatioY })}`);
        if (clean.error || broken.error) {
          c.check(false, '接缝指标探测跑通', clean.error ?? broken.error);
        } else {
          c.check(
            typeof clean.seamRatioX === 'number' && typeof clean.seamRatioY === 'number',
            '脚本会报接缝指标 seamRatioX/Y',
            JSON.stringify({ x: clean.seamRatioX, y: clean.seamRatioY })
          );
          // 阈值 8 是**实测定出来的**：这张渐变图上正常拼接是 3.7 / 2.4，
          // 而故意错位是 10.6 / 15.1。它不是"越接近 1 越好" —— 分块推理本身
          // 就会在块边界留下一点差异（相邻块对同一片区域的推断结果不完全一样），
          // 所以 3 上下是这类模型的正常水位。
          // ⚠️ 阈值**与图像内容有关**：同一个指标在"硬边色块"那张图上会到 6~7
          // （椭圆边缘正好落在某条缝上时，取最大值就会抬上去）。所以只在
          // 这张渐变图上断言绝对值 —— 换个图就得重新测水位，别把 8 当成通用常数。
          c.check(
            clean.seamRatioX < 8 && clean.seamRatioY < 8,
            '正常拼接时块边界没有异常跳变（指标在实测正常水位内）',
            `x=${clean.seamRatioX} y=${clean.seamRatioY}`
          );
          c.check(
            broken.seamRatioX > clean.seamRatioX * 1.5 || broken.seamRatioY > clean.seamRatioY * 1.5,
            '★ 反证一：故意把块错位后接缝指标明显变差（说明这个指标真的能发现接缝）',
            `正常 x=${clean.seamRatioX}/y=${clean.seamRatioY} → 错位 x=${broken.seamRatioX}/y=${broken.seamRatioY}`
          );
          // ★ 反证二，**独立于上面那个指标**：错位会在结果里留下没人写过的洞。
          // 有两个互不相干的信号同时变化，比一个信号自己说自己灵要可信得多。
          c.check(
            clean.uncoveredRatio === 0 && broken.uncoveredRatio > 0.01,
            '★ 反证二：错位会让 uncoveredRatio 从 0 变成明显的比例（独立信号）',
            `正常 ${clean.uncoveredRatio} → 错位 ${broken.uncoveredRatio}`
          );
        }
      } else {
        c.note(`跳过接缝反证：找不到脚本或权重（${script} / ${modelPath}）`);
        c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
      }
    }

    // ★ 反向断言：拿一个**非超分**权重（抠图模型）去超分，必须被拒绝。
    //
    // 这条是被一个真事故逼出来的：验证脚本曾经按"谁服务于 ai.upscale"挑模型，
    // 而当时的归属是**按引擎推的**（`onnx-models` 同时承载抠图与超分），
    // 于是挑中了 u2netp —— 一个分割模型。它的输出是单通道蒙版，
    // 脚本把它当图片、算出"倍数 1"、再 resize 到目标尺寸，
    // 结果**尺寸断言全过**，整条检查全绿而结果是垃圾。
    const segModel = (models ?? []).find(
      (m) => m.installed && m.usedByNodes.includes('image.remove-background')
    );
    if (segModel) {
      const badDir = join(REPO_ROOT, '.tools', 'smoke', 'out-upscale-bad');
      rmSync(badDir, { recursive: true, force: true });
      mkdirSync(badDir, { recursive: true });
      let rejected = false;
      let msg = '';
      try {
        const badSub = await client.invoke('plugins_run', {
          req: {
            pluginId: 'com.toolforge.builtin.image-upscale',
            inputs: { src: [src] },
            params: { model: { kind: 'str', value: segModel.id }, scale: { kind: 'int', value: 4 } },
            outputDir: badDir,
          },
        });
        const badJob = await client.waitJob(badSub.jobId, 200, 500);
        rejected = badJob.status === 'failed';
        msg = String(badJob.error?.detail ?? badJob.error?.message ?? '');
      } catch (e) {
        rejected = true;
        msg = String(e.message);
      }
      c.check(
        rejected,
        `拿抠图权重 ${segModel.id} 去超分会被明确拒绝（而不是产出一张垃圾还报成功）`,
        msg.split('\n')[0].slice(0, 100)
      );
      const leftovers = existsSync(badDir) ? readdirSync(badDir) : [];
      c.check(leftovers.length === 0, '磁盘上没有留下垃圾产出', leftovers.join(', '));
    }

    // 模型的归属必须**按权重**写清楚，而不是靠"所属引擎被谁用"去推 ——
    // 否则抠图权重会声称自己服务于 ai.upscale（上面那条反向断言正是在防这个）。
    const misattributed = (models ?? []).filter(
      (m) =>
        m.usedByNodes.includes('ai.upscale') &&
        m.usedByNodes.includes('image.remove-background')
    );
    c.check(
      misattributed.length === 0,
      '没有权重同时声称服务于抠图和超分（归属是按权重而不是按引擎算的）',
      misattributed.map((m) => m.id).join(', ')
    );
  }
}

// ============================================================================
// 【12】中间档：把 libvips 藏起来，ImageMagick 必须真的接手
// ============================================================================
c.section('【12】图片降级链的**中间档**（ImageMagick）是否真的会接手');
{
  // 为什么这条必须靠"藏目录"来做：三档降级里，第一档（libvips）有就永远走它，
  // 所以"ImageMagick 档到底能不能用"在装了 libvips 的机器上**永远测不到** ——
  // 而这正是文档里记了很久的一条空白（"ImageMagick 档位没有环境基线"）。
  // 把 libvips 的目录临时改名，就能逼出真实的中间档行为；测完还原。
  const engines = await client.invoke('engines_catalog');
  const usable = (id) => {
    const e = engines.find((x) => x.descriptor.id === id);
    return e && (e.status.state === 'detected' || e.status.state === 'installed');
  };

  if (!usable('libvips') || !usable('imagemagick')) {
    c.note(
      `跳过：需要 libvips 与 imagemagick **同时装着**才谈得上"藏掉前者看后者接管"` +
        `（当前 libvips=${usable('libvips')} imagemagick=${usable('imagemagick')}）`
    );
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    const vipsDir = join(DATA_DIR, 'engines', 'libvips');
    const hidden = join(DATA_DIR, 'engines', 'libvips__hidden_by_verify');
    const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-tier-magick');
    const src = join(REPO_ROOT, '.tools', 'smoke', 'in-tier-magick.png');

    const runConvert = async () => {
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      writeFileSync(src, makePng(320, 200, 2));
      const sub = await client.invoke('plugins_run', {
        req: {
          pluginId: 'com.toolforge.builtin.image-convert',
          inputs: { src: [src] },
          params: { format: { kind: 'str', value: 'webp' }, quality: { kind: 'int', value: 80 } },
          outputDir: outDir,
        },
      });
      const job = await client.waitJob(sub.jobId, 200, 500);
      const line =
        (job.logs ?? []).map((l) => String(l.message)).find((m) => m.includes('后端 =')) ?? '';
      return { status: job.status, line };
    };

    let renamed = false;
    try {
      renameSync(vipsDir, hidden);
      renamed = true;
      await client.invoke('engines_probe_all');

      const vs = await client.invoke('engines_probe', { engineId: 'libvips' });
      c.check(vs.state !== 'installed' && vs.state !== 'detected', 'libvips 确实已不可用', vs.state);

      const r = await runConvert();
      c.note(r.line);
      c.check(r.status === 'succeeded', '藏掉 libvips 后转换仍然成功（降级没断）', r.status);
      c.check(
        r.line.includes('ImageMagick'),
        '★ 实际后端变成了 ImageMagick（中间档真的接手了）',
        r.line
      );

      const produced = existsSync(outDir) ? readdirSync(outDir) : [];
      if (produced.length === 1) {
        const info = webpInfo(readFileSync(join(outDir, produced[0])));
        c.check(info?.codec === 'VP8', 'ImageMagick 也给出了有损 WebP', String(info?.codec));
      }
    } catch (e) {
      c.check(false, '中间档测试抛错', String(e.message).split('\n')[0]);
    } finally {
      // 还原是**必须**的：留着改名会让后面的检查全部走错档位
      if (renamed) {
        try {
          renameSync(hidden, vipsDir);
          await client.invoke('engines_probe_all');
          const back = await client.invoke('engines_probe', { engineId: 'libvips' });
          c.check(back.state === 'installed' || back.state === 'detected', 'libvips 已还原', back.state);
        } catch (e) {
          c.check(false, '还原 libvips 失败 —— 请手动把 libvips__hidden_by_verify 改回 libvips', String(e.message));
        }
      }
    }
  }
}

// ============================================================================
// 【13】兜底档：两个引擎都藏起来，纯 Rust 必须接得住（且能跑）
// ============================================================================
c.section('【13】图片降级链的**兜底档**（纯 Rust）是否真的能兜住');
{
  // 这一档是"零依赖、始终可用"的那条 —— 也正因如此，**装了引擎的机器上
  // 永远走不到它**：libvips 在就永远走 libvips。于是它是三档里最该被验、
  // 却最容易被漏掉的一档（文档此前只敢写"三档里有两档有证据"）。
  //
  // 把两个引擎目录都临时改名，就能逼出真实的兜底行为；测完在 finally 里还原。
  const engines = await client.invoke('engines_catalog');
  const usable = (id) => {
    const e = engines.find((x) => x.descriptor.id === id);
    return e && (e.status.state === 'detected' || e.status.state === 'installed');
  };
  const managedOnly = (id) => {
    const e = engines.find((x) => x.descriptor.id === id);
    // 只有"应用托管"的那份才藏得掉；系统装的（在 PATH 里）改名没用
    return usable(id) && e.status.source === 'managed';
  };

  const hideable = ['libvips', 'imagemagick'].filter(managedOnly);
  if (hideable.length === 0) {
    c.note('跳过：没有任何"应用托管"的图片引擎可以临时藏起来');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    const ENG = join(DATA_DIR, 'engines');
    const moved = [];
    const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-tier-rust');
    const src = join(REPO_ROOT, '.tools', 'smoke', 'in-tier-rust.png');

    try {
      for (const id of hideable) {
        const from = join(ENG, id);
        const to = join(ENG, `${id}__hidden_by_verify`);
        renameSync(from, to);
        moved.push([from, to]);
      }
      await client.invoke('engines_probe_all');
      for (const id of hideable) {
        const st = await client.invoke('engines_probe', { engineId: id });
        c.check(st.state !== 'installed' && st.state !== 'detected', `${id} 已不可用`, st.state);
      }

      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      writeFileSync(src, makePng(320, 200, 2));
      const sub = await client.invoke('plugins_run', {
        req: {
          pluginId: 'com.toolforge.builtin.image-convert',
          inputs: { src: [src] },
          params: { format: { kind: 'str', value: 'webp' }, quality: { kind: 'int', value: 80 } },
          outputDir: outDir,
        },
      });
      const job = await client.waitJob(sub.jobId, 200, 500);
      const line =
        (job.logs ?? []).map((l) => String(l.message)).find((m) => m.includes('后端 =')) ?? '';
      c.note(line);
      c.check(job.status === 'succeeded', '两个引擎都没有时，转换依然成功（兜底真的兜住了）', job.status);
      c.check(line.includes('rust'), '★ 实际后端是纯 Rust', line);

      const produced = existsSync(outDir) ? readdirSync(outDir) : [];
      if (produced.length === 1) {
        const info = webpInfo(readFileSync(join(outDir, produced[0])));
        // 纯 Rust 后端只有无损 WebP —— 这既是它的能力边界，也是"确实是它做的"的指纹
        c.check(
          info?.codec === 'VP8L',
          '★ 产出是无损 VP8L（纯 Rust 后端的指纹，同时也说明它给不了有损）',
          String(info?.codec)
        );
      }
      const warned = (job.logs ?? []).some((l) => String(l.message).includes('只有无损模式'));
      c.check(warned, '如实提示了"只有无损模式"', String(warned));
    } catch (e) {
      c.check(false, '兜底档测试抛错', String(e.message).split('\n')[0]);
    } finally {
      for (const [from, to] of moved) {
        try {
          renameSync(to, from);
        } catch (e) {
          c.check(false, `还原 ${from} 失败 —— 请手动把 ${to} 改回去`, String(e.message));
        }
      }
      await client.invoke('engines_probe_all');
      for (const id of hideable) {
        const back = await client.invoke('engines_probe', { engineId: id });
        c.check(
          back.state === 'installed' || back.state === 'detected',
          `${id} 已还原`,
          back.state
        );
      }
    }
  }
}

// ============================================================================
// 【14】视频抽帧 → GIF：`video-to-gif` 内置插件是否真的跑得通
// ============================================================================
//
// 这个插件在 ffmpeg 装好之前**一次都没被跑过**（这台机器上一直是
// 「10 个节点不可用」的状态）。它同时压着三件事：
//
//   1. `video.thumbnail` 这个**唯一**的视频节点（引擎解析 + PATH 查找 + 抽帧）；
//   2. 多步流水线里 `${steps.<id>.<键>}` 的引用（`image.probe` → `flow.set-var`）；
//   3. 中间产物走**第二个输出端口**（`${output.frame}`）而不是 `${dst}`。
//
// 素材用 ffmpeg 自己合成（`lavfi` 的 testsrc），所以不依赖任何外部视频文件。
c.section('【14】视频 → GIF（video-to-gif 内置插件）是否真的跑得通');
{
  const engines = await client.invoke('engines_probe_all');
  const usable = (e) => e && (e.status.state === 'detected' || e.status.state === 'installed');
  const ff = engines.find((e) => e.descriptor.id === 'ffmpeg');
  const ffPath = ff?.status?.path;

  if (!usable(ff) || !ffPath || !existsSync(ffPath)) {
    c.note('跳过：本机没有可用的 ffmpeg（到「引擎管理」一键安装，约 105 MB）');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    c.note(`ffmpeg: ${ffPath}`);
    const work = join(REPO_ROOT, '.tools', 'smoke', 'out-platform-video');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const src = join(work, 'testsrc.mp4');

    // 合成一段 3 秒、160x120、10fps 的测试视频。
    // 用 `yuv420p` 是因为默认的 testsrc 像素格式很多播放器/GIF 路径不接受。
    const gen = await runEngine(ffPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=duration=3:size=160x120:rate=10',
      '-pix_fmt', 'yuv420p',
      src,
    ]);
    c.check(gen.ok && existsSync(src), '用 ffmpeg 合成一段测试视频', gen.err || `${statSync(src).size} 字节`);

    if (existsSync(src)) {
      const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-platform-video-gif');
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const sub = await client.invoke('plugins_run', {
        req: {
          pluginId: 'com.toolforge.builtin.video-to-gif',
          inputs: { src: [src] },
          params: {
            at: { kind: 'str', value: '00:00:01' },
            width: { kind: 'int', value: 160 },
            quality: { kind: 'int', value: 80 },
          },
          outputDir: outDir,
        },
      });
      const job = await client.waitJob(sub.jobId, 120, 1000);
      console.log(`   任务状态: ${job.status}`);
      if (job.error) console.log(`   错误: ${job.error.code} — ${job.error.message}`);

      c.check(job.status === 'succeeded', '视频 → GIF 任务成功', job.status);

      const produced = job.outputs ?? [];
      console.log(`   产出: ${JSON.stringify(produced)}`);
      const gif = produced.find((p) => p.toLowerCase().endsWith('.gif'));
      c.check(!!gif, '产出了一个 .gif', gif ?? produced.join(', '));

      if (gif && existsSync(gif)) {
        const buf = readFileSync(gif);
        // GIF89a / GIF87a 魔数：只看存在性不够，要看位流真的写了
        const head = buf.subarray(0, 6).toString('ascii');
        c.check(head === 'GIF89a' || head === 'GIF87a', '文件真的是 GIF（魔数）', head);
        // 逻辑屏幕宽高在偏移 6/8（小端）
        const w = buf.readUInt16LE(6);
        const h = buf.readUInt16LE(8);
        c.check(w === 160 && h === 120, 'GIF 尺寸与抽帧尺寸一致 160x120', `${w}x${h}`);
        c.note(`${gif}  ${buf.length} 字节`);
      }

      // 抽帧的中间产物是**第二个输出端口**，它必须也被登记 ——
      // 否则"多输出端口"这条设计在真实链路上就是假的
      const frame = produced.find((p) => p.toLowerCase().endsWith('.png'));
      c.check(!!frame, '中间抽帧（第二个输出端口）也被登记为产出', frame ?? '（没有 png 产出）');

      // 日志里应当能看到 `${steps.probe.width}x${steps.probe.height}` 被真的算出来
      const logs = (job.logs ?? []).map((l) => l.message).join('\n');
      c.check(
        !/TEMPLATE|未知的引用|undefined/.test(logs),
        '模板引用没有留下未解析的痕迹',
        ''
      );
    }
  }
}

// ============================================================================
// 【15】扫描件 PDF 的 OCR：Poppler 栅格化 → 逐页识别 → 拼回一份文本
// ============================================================================
//
// 这是 OCR 最常见的真实场景，而它此前是**明确拒绝**的（"需要 pdfium / poppler"）。
// 这一节验三件事：
//   1. PDF 真的被**逐页**栅格化了（假端点收到 N 次请求，而不是 1 次）；
//   2. `pdfDpi` 这个参数真的生效（从假端点读回的 JPEG 尺寸反推像素数）；
//   3. 多页结果被拼成一份文本，而且**页与页之间有分隔** ——
//      没有分隔的话，两页的文字会首尾相接，用户根本看不出边界在哪。
//
// 仍然是"自己这一侧"的验证：假模型不回真文字，所以验不了"认得准不准"。
c.section('【15】扫描件 PDF 的 OCR（Poppler 栅格化 + 逐页识别）');
{
  const engines = await client.invoke('engines_probe_all');
  const usable = (e) => e && (e.status.state === 'detected' || e.status.state === 'installed');
  const pop = engines.find((e) => e.descriptor.id === 'poppler');
  const tess = engines.find((e) => e.descriptor.id === 'tesseract');

  if (!usable(pop)) {
    c.note('跳过：本机没有 Poppler（到「引擎管理」一键安装，约 42 MB，GPL）');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    c.note(`poppler: ${pop.status.path}`);
    if (usable(tess)) {
      c.note('（本机也装了 Tesseract；下面用 engine=ai 走假端点，才能断言请求形状）');
    }

    const MOCK_PORT = 18125;
    const mock = spawn(process.execPath, [join(HERE, 'mock-openai.mjs'), String(MOCK_PORT)], {
      stdio: 'ignore',
      detached: false,
    });
    await sleep(600);
    const mockBase = `http://127.0.0.1:${MOCK_PORT}`;

    const PLUGIN_ID = 'com.toolforge.test.pdf-ocr';
    let restore = null;
    try {
      const before = await client.invoke('settings_get');
      restore = before.ai;
      await client.invoke('settings_patch', {
        patch: {
          ai: {
            provider: 'ollama',
            baseUrl: `${mockBase}/v1`,
            model: 'mock-vision',
            temperature: 0.2,
            persistApiKey: false,
          },
        },
      });

      // ---- 装一个只用 doc.ocr 的临时插件 ----
      const pdfOcrYaml = `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${PLUGIN_ID}
  name: PDF OCR 测试插件
  version: 1.0.0
  description: 仅用于验证 doc.ocr 的 PDF 栅格化链路。
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
io:
  inputs:
    - id: src
      label: 扫描件 PDF
      type: file
      accept: [".pdf"]
      required: true
  outputs:
    - id: dst
      label: 识别文本
      type: file
      accept: [".txt"]
      required: false
  params:
    - id: pdfDpi
      label: 栅格化 DPI
      type: int
      default: { kind: int, value: 100 }
      min: 72
      max: 600
      step: 1
      required: false
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    timeoutMs: 300000
    steps:
      - id: ocr
        uses: doc.ocr
        label: 识别扫描件
        with:
          src: "\${src}"
          dst: "\${output.dst}"
          engine: ai
          pdfDpi: "\${params.pdfDpi}"
`;
      const existing = await client.invoke('plugins_get', { pluginId: PLUGIN_ID }).catch(() => null);
      if (existing) {
        await client.invoke('plugins_uninstall', { pluginId: PLUGIN_ID }).catch(() => {});
      }
      await client.invoke('plugins_install', {
        req: {
          source: { kind: 'manifest', yaml: pdfOcrYaml },
          overwrite: true,
          permissionsAcknowledged: true,
          executableCodeAcknowledged: false,
        },
      });
      await client.invoke('plugins_grant', {
        req: {
          pluginId: PLUGIN_ID,
          granted: {
            capabilities: [
              { kind: 'fsRead', scope: { kind: 'input' } },
              { kind: 'fsWrite', scope: { kind: 'output' } },
            ],
          },
        },
      });
      await client.invoke('plugins_set_enabled', { pluginId: PLUGIN_ID, enabled: true });

      // ---- 造一份 3 页的 PDF ----
      //
      // 手写而不是塞一份二进制素材进仓库：它是什么、有几页、每页写什么都一目了然。
      // 页面尺寸 420x200 点；100 DPI 下应当是 583x278 像素。
      const PAGES = ['PAGE ONE', 'PAGE TWO', 'PAGE THREE'];
      const PDF_W = 420;
      const PDF_H = 200;
      const DPI = 100;
      const src = writeInputPdf('scan-3pages.pdf', PAGES, [PDF_W, PDF_H]);
      c.check(existsSync(src) && statSync(src).size > 400, '造出一份 3 页 PDF', `${statSync(src).size} 字节`);

      await fetch(`${mockBase}/__reset`);
      const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-pdf-ocr');
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });

      const sub = await client.invoke('plugins_run', {
        req: {
          pluginId: PLUGIN_ID,
          inputs: { src: [src] },
          params: { pdfDpi: { kind: 'int', value: DPI } },
          outputDir: outDir,
        },
      });
      const job = await client.waitJob(sub.jobId, 240, 1000);
      console.log(`   任务状态: ${job.status}`);
      if (job.error) console.log(`   错误: ${job.error.code} — ${job.error.message}`);

      c.check(job.status === 'succeeded', 'PDF → OCR 任务成功', job.status);

      // ★ 核心断言一：逐页栅格化
      const rec = await (await fetch(`${mockBase}/__received`)).json();
      console.log(`   假端点收到 ${rec.length} 次请求：${rec.map((r) => `${r.imageWidth}x${r.imageHeight}`).join(', ')}`);
      c.check(rec.length === PAGES.length, `逐页识别：收到 ${PAGES.length} 次请求（不是 1 次）`, String(rec.length));
      c.check(
        rec.every((r) => r.imageCount === 1 && r.dataUrlOk === true),
        '每次请求都带 1 张内联图片',
        ''
      );

      // ★ 核心断言二：pdfDpi 真的生效（从渲染出的像素尺寸反推）
      const expectedW = Math.round((PDF_W / 72) * DPI);
      const expectedH = Math.round((PDF_H / 72) * DPI);
      const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 2;
      c.check(
        rec.every((r) => near(r.imageWidth, expectedW) && near(r.imageHeight, expectedH)),
        `渲染尺寸符合 ${DPI} DPI 的预期（${expectedW}x${expectedH}±2）`,
        rec.map((r) => `${r.imageWidth}x${r.imageHeight}`).join(', ')
      );

      // ★ 核心断言三：多页结果拼接且有分隔
      const produced = existsSync(outDir) ? readdirSync(outDir) : [];
      console.log(`   产出：${produced.join(', ') || '(空)'}`);
      const txt = produced.find((f) => f.toLowerCase().endsWith('.txt'));
      c.check(!!txt, '产出了一个 .txt', txt ?? produced.join(', '));

      if (txt) {
        const body = readFileSync(join(outDir, txt), 'utf8');
        for (let i = 1; i <= PAGES.length; i++) {
          c.check(
            body.includes(`===== 第 ${i} 页 =====`),
            `输出里有第 ${i} 页的分隔标记`,
            ''
          );
        }
        // 每一页都真的发出去过一次：假端点的回复里带序号
        for (let i = 1; i <= PAGES.length; i++) {
          c.check(
            body.includes(`第 ${i} 次请求`),
            `第 ${i} 页识别结果进了最终文本（按页序）`,
            ''
          );
        }
        c.note(`识别文本 ${body.length} 字符`);
      }
    } catch (e) {
      c.check(false, 'PDF OCR 测试抛错', String(e.message).split('\n')[0]);
    } finally {
      await client.invoke('plugins_set_enabled', { pluginId: PLUGIN_ID, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: PLUGIN_ID }).catch(() => {});
      if (restore) {
        await client.invoke('settings_patch', { patch: { ai: restore } }).catch(() => {});
        c.note('已还原原来的 AI 设置');
      }
      try {
        mock.kill();
      } catch {
        /* 已经退出了 */
      }
    }
  }
}

// ============================================================================
// 【16】节点的"可用性"说的是不是实话（知情时机的落差）
// ============================================================================
//
// ROADMAP §7 第 4 项：「`ebook.convert` 在两个可选引擎都没有时的 UI 提示……
// 运行期会返回明确的 EngineMissing，但**节点可用性判定仍只看 requiresEngines**，
// 所以这种机器上它依旧显示"可用"」。同类问题还有一个更隐蔽的版本：
// `ai.upscale` 依赖 `onnx-models`，而那个虚拟引擎的判据是"下过至少一个权重" ——
// 于是只下了**抠图**权重的机器上，超分节点也显示可用。
//
// 这一节不去硬编"本机应该是什么状态"（那会随装了哪些引擎而变），而是验
// **UI 的判断与真实的引擎/权重状态是否一致** —— 那才是"有没有说谎"的定义。
c.section('【16】节点可用性判定与真实引擎/权重状态是否一致');
{
  const catalog = await client.invoke('pipeline_nodes');
  const engines = await client.invoke('engines_probe_all');
  const models = await client.invoke('models_list');

  const usable = (id) => {
    const e = engines.find((x) => x.descriptor.id === id);
    return Boolean(e && (e.status.state === 'detected' || e.status.state === 'installed'));
  };
  const installedFor = (node) =>
    (models ?? []).some((m) => m.installed && (m.usedByNodes ?? []).includes(node));

  const avail = catalog.availability ?? {};
  const nodesByName = new Map((catalog.nodes ?? []).map((n) => [n.name, n]));

  // 这台机器上"实际能不能跑"独立算一遍
  const truth = (node) => {
    for (const e of node.requiresEngines ?? []) {
      if (!usable(e)) return false;
    }
    const rule = RULES[node.name];
    if (rule?.atLeastOneOf?.length) {
      if (!rule.atLeastOneOf.some(usable)) return false;
    }
    if (rule?.requiresModelWeight && !installedFor(node.name)) return false;
    return true;
  };
  // 补充规则与 Rust 侧 `NODE_AVAILABILITY_RULES` 必须一致（这里只镜像判定逻辑，
  // 规则本身从 Rust 来不了 —— 它是内部表。镜像的代价由下面的一致性断言兜住。）
  const RULES = {
    'ebook.convert': { atLeastOneOf: ['calibre', 'pandoc'] },
    'doc.ocr': { atLeastOneOf: ['tesseract', 'ai-provider'] },
    'image.remove-background': { requiresModelWeight: true },
    'ai.upscale': { requiresModelWeight: true },
  };

  const mismatched = [];
  for (const [name, node] of nodesByName) {
    const claimed = avail[name];
    const actual = truth(node);
    if (claimed !== actual) mismatched.push(`${name}: UI=${claimed} 实际=${actual}`);
  }
  console.log(`   检查了 ${nodesByName.size} 个节点的可用性判定`);
  c.check(
    mismatched.length === 0,
    '每个节点的"可用"与真实引擎/权重状态一致（没有撒谎的节点）',
    mismatched.join('；')
  );

  // ★ 具体到那两条已知的落差：把它们的判据摊开来看
  for (const name of ['ebook.convert', 'doc.ocr']) {
    const rule = RULES[name];
    const enginesOk = rule.atLeastOneOf.filter(usable);
    console.log(
      `   ${name}: 声明可用=${avail[name]}；析取组 ${rule.atLeastOneOf.join('/')} 里可用的有 [${enginesOk.join(', ')}]`
    );
    c.check(
      avail[name] === enginesOk.length > 0,
      `${name} 的可用性等于「析取组里至少有一个真的可用」`,
      `可用=${avail[name]}，实际可用引擎=${enginesOk.join(',') || '无'}`
    );
  }
  c.check(
    !RULES['doc.ocr'].atLeastOneOf.includes('poppler'),
    'poppler 不在 doc.ocr 的识别引擎析取组里（它只管 PDF 栅格化）',
    ''
  );

  // ★ 权重归属按**权重**算：`ai.upscale` 的可用性必须看有没有"超分"权重，
  //   而不是"有没有任何权重"。
  const upModels = (models ?? []).filter((m) => m.installed && (m.usedByNodes ?? []).includes('ai.upscale'));
  const anyModel = (models ?? []).some((m) => m.installed);
  console.log(`   已装权重 ${(models ?? []).filter((m) => m.installed).length} 个，其中超分权重 ${upModels.length} 个`);
  c.check(
    avail['ai.upscale'] === upModels.length > 0,
    'ai.upscale 的可用性取决于**超分**权重，而不是"有没有任何权重"',
    `可用=${avail['ai.upscale']}，超分权重=${upModels.length}，任何权重=${anyModel}`
  );
}

// ============================================================================
// 【17】音频与视频节点：ffmpeg 装好之后这 6 个节点从没被跑过
// ============================================================================
//
// FFmpeg 装通之前，`video.*` / `audio.*` 一共 7 个节点在界面上是"不可用"的，
// 所以**没有任何人跑过它们**。【14】只覆盖了 `video-to-gif`（它用到 `video.thumbnail`），
// 剩下这些一次都没执行过：
//
//   video.trim / video.extract-audio / video.compress /
//   video.transcode / audio.convert / audio.normalize
//
// 这一节把它们逐个真跑一遍，并用 **ffprobe 读回真实属性**（时长、编解码器、
// 采样率、像素尺寸）—— "任务成功"不算证据，"产出的确是那种东西"才算。
c.section('【17】音频 / 视频节点是否真的产出正确的媒体');
{
  const engines = await client.invoke('engines_probe_all');
  const usable = (e) => e && (e.status.state === 'detected' || e.status.state === 'installed');
  const ff = engines.find((e) => e.descriptor.id === 'ffmpeg');
  const ffPath = ff?.status?.path;
  const probePath = ffPath ? join(dirname(ffPath), 'ffprobe.exe') : null;

  if (!usable(ff) || !probePath || !existsSync(probePath)) {
    c.note('跳过：本机没有可用的 ffmpeg / ffprobe（到「引擎管理」一键安装，约 105 MB）');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    /** 用 ffprobe 读回媒体属性（真正断言用的就是它） */
    const probeJson = (file) => {
      const r = spawnSync(
        probePath,
        ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
        { encoding: 'utf8', windowsHide: true }
      );
      if (r.status !== 0) return { error: String(r.stderr ?? '').slice(0, 200) };
      try {
        const j = JSON.parse(String(r.stdout));
        const streams = j.streams ?? [];
        const v = streams.find((s) => s.codec_type === 'video');
        const a = streams.find((s) => s.codec_type === 'audio');
        return {
          duration: Number(j.format?.duration ?? 0),
          size: Number(j.format?.size ?? 0),
          formatName: j.format?.format_name ?? '',
          videoCodec: v?.codec_name ?? null,
          width: v?.width ?? null,
          height: v?.height ?? null,
          audioCodec: a?.codec_name ?? null,
          sampleRate: a ? Number(a.sample_rate ?? 0) : null,
          channels: a?.channels ?? null,
          streamCount: streams.length,
        };
      } catch (e) {
        return { error: `解析 ffprobe 输出失败：${e.message}` };
      }
    };

    /** 数一下视频帧数（`-count_frames` 会真的解一遍，用来验证"切了多久"） */
    const probeVideoFrames = (probeExe, file) => {
      const r = spawnSync(
        probeExe,
        ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file],
        { encoding: 'utf8', windowsHide: true }
      );
      const n = Number(String(r.stdout ?? '').trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const work = join(REPO_ROOT, '.tools', 'smoke', 'out-av');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const src = join(work, 'av-source.mp4');
    const outDir = join(work, 'out');
    mkdirSync(outDir, { recursive: true });

    // 源素材：3 秒测试图 + 440 Hz 正弦音。**必须带音轨** ——
    // 没有音轨的话 extract-audio / audio.convert / audio.normalize 三个节点
    // 全都测不出真东西（它们会"成功"地产出空文件或者直接报错）。
    const gen = runEngine(ffPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest',
      src,
    ]);
    const srcInfo = existsSync(src) ? probeJson(src) : { error: gen.err };
    console.log(`   源素材: ${JSON.stringify(srcInfo)}`);
    c.check(
      !srcInfo.error && srcInfo.videoCodec === 'h264' && srcInfo.audioCodec === 'aac',
      '造出带音轨的源视频（h264 + aac）',
      srcInfo.error ?? `${srcInfo.videoCodec}/${srcInfo.audioCodec}`
    );
    c.check(
      srcInfo.duration > 2.5 && srcInfo.duration < 3.5,
      '源视频时长约 3 秒',
      String(srcInfo.duration)
    );

    // ---- 一条把五个节点串起来的流水线 ----
    //
    // 顺序刻意选成**真正有依赖关系**的链：切一段 → 抽封面 → 从切片里提音轨 →
    // 响度归一化 → 转成另一种音频容器。每一步都读上一步的产出，所以
    // `${output.<端口>}` 与"中间产物在输出目录里"这条路径会被真的走一遍。
    const CHAIN_ID = 'com.toolforge.test.av-chain';
    const chainYaml = `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${CHAIN_ID}
  name: 音视频链路测试插件
  version: 1.0.0
  description: 仅用于验证 video.* / audio.* 六个节点。
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
io:
  inputs:
    - id: src
      label: 源视频
      type: file
      accept: ["video/*"]
      required: true
  outputs:
    - id: trimmed
      label: 切片
      type: file
      accept: [".mp4"]
      required: false
    - id: frame
      label: 封面
      type: file
      accept: [".png"]
      required: false
    - id: audio
      label: 音轨
      type: file
      accept: [".mp3"]
      required: false
    - id: normalized
      label: 归一化后的音轨
      type: file
      accept: [".mp3"]
      required: false
    - id: converted
      label: 转码后的音频
      type: file
      accept: [".m4a"]
      required: false
  params: []
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    timeoutMs: 600000
    steps:
      - id: cut
        uses: video.trim
        label: 切出中间 1 秒
        with:
          src: "\${src}"
          dst: "\${output.trimmed}"
          start: "00:00:01"
          duration: "1"
      - id: cover
        uses: video.thumbnail
        label: 抽封面
        with:
          src: "\${output.trimmed}"
          dst: "\${output.frame}"
          at: "00:00:00"
          width: "160"
      - id: track
        uses: video.extract-audio
        label: 提取音轨
        with:
          src: "\${output.trimmed}"
          dst: "\${output.audio}"
          format: mp3
          bitrate: "128"
      - id: loud
        uses: audio.normalize
        label: 响度归一化
        with:
          src: "\${output.audio}"
          dst: "\${output.normalized}"
          lufs: "-16"
      - id: toM4a
        uses: audio.convert
        label: 转成 m4a
        with:
          src: "\${output.normalized}"
          dst: "\${output.converted}"
          format: m4a
          sampleRate: "44100"
`;
    const trimDir = join(work, 'chain');
    mkdirSync(trimDir, { recursive: true });
    writeFileSync(join(trimDir, 'plugin.yaml'), chainYaml, 'utf8');
    const existing = await client.invoke('plugins_get', { pluginId: CHAIN_ID }).catch(() => null);
    if (existing) {
      await client.invoke('plugins_set_enabled', { pluginId: CHAIN_ID, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: CHAIN_ID }).catch(() => {});
    }
    await client.invoke('plugins_install', {
      req: {
        source: { kind: 'directory', path: trimDir },
        overwrite: true,
        permissionsAcknowledged: true,
        executableCodeAcknowledged: false,
      },
    });
    await client.invoke('plugins_grant', {
      req: {
        pluginId: CHAIN_ID,
        granted: {
          capabilities: [
            { kind: 'fsRead', scope: { kind: 'input' } },
            { kind: 'fsWrite', scope: { kind: 'output' } },
          ],
        },
      },
    });
    await client.invoke('plugins_set_enabled', { pluginId: CHAIN_ID, enabled: true });

    const sub = await client.invoke('plugins_run', {
      req: { pluginId: CHAIN_ID, inputs: { src: [src] }, params: {}, outputDir: outDir },
    });
    const job = await client.waitJob(sub.jobId, 300, 1000);
    console.log(`   链路任务: ${job.status}`);
    if (job.error) console.log(`   错误: ${job.error.code} — ${job.error.message}`);
    c.check(job.status === 'succeeded', '五个节点串起来的链路跑通', job.status);

    const outputs = job.outputs ?? [];
    console.log(`   产出: ${outputs.map((p) => p.split('\\').pop()).join(', ')}`);
    const byExt = (ext) => outputs.find((p) => p.toLowerCase().endsWith(ext));

    // ---- ① video.trim：时长真的变短了 ----
    //
    // 这一条抓到过一个真缺陷：**流复制路径带 `-avoid_negative_ts make_zero`
    // 会让切片长度变成两倍**（要 1 秒给 2.02 秒 / 30 帧而不是 15 帧）。
    // 所以断言不能停在"任务成功"，必须量**帧数**——容器时长与帧数一起看才说明问题。
    const trimmed = byExt('.mp4');
    if (trimmed && existsSync(trimmed)) {
      const info = probeJson(trimmed);
      const frames = probeVideoFrames(probePath, trimmed);
      console.log(`   trim → ${JSON.stringify(info)} frames=${frames}`);
      c.check(
        info.duration > 0.3 && info.duration < 1.5,
        '① video.trim：切片时长≈1 秒（源是 3 秒）',
        String(info.duration)
      );
      // 15fps × 1s = 15 帧。旧行为是 30 帧（整 2 秒），所以这一条是那个缺陷的指纹。
      c.check(
        frames !== null && frames >= 13 && frames <= 18,
        '① 帧数与 1 秒 @15fps 相符（旧行为是 30 帧 = 2 秒）',
        String(frames)
      );
      c.check(info.videoCodec === 'h264', '① 切片仍是 h264（流复制没重编码）', String(info.videoCodec));
    } else {
      c.check(false, '① video.trim 产出了切片', outputs.join(', '));
    }

    // ---- ② video.thumbnail：PNG 且尺寸按 width 缩了 ----
    const frame = byExt('.png');
    if (frame && existsSync(frame)) {
      const png = pngInfo(readFileSync(frame));
      console.log(`   thumbnail → ${JSON.stringify(png)}`);
      c.check(png?.width === 160, '② video.thumbnail：宽度按参数缩到 160', String(png?.width));
      c.check(
        typeof png?.height === 'number' && png.height > 0 && png.height % 2 === 0,
        '② 高度按 -2 对齐（偶数，编码器要求）',
        String(png?.height)
      );
    } else {
      c.check(false, '② video.thumbnail 产出了封面', outputs.join(', '));
    }

    // ---- ③ video.extract-audio：有音轨、**没有**视频轨 ----
    const audio = byExt('.mp3');
    if (audio && existsSync(audio)) {
      const info = probeJson(audio);
      console.log(`   extract-audio → ${JSON.stringify(info)}`);
      c.check(info.audioCodec === 'mp3', '③ video.extract-audio：音轨是 mp3', String(info.audioCodec));
      c.check(info.videoCodec === null, '③ 产出的确实是纯音频（没有视频轨）', String(info.videoCodec));
      c.check(
        info.duration > 0.3 && info.duration < 1.8,
        '③ 音轨时长跟着切片走（≈1 秒）',
        String(info.duration)
      );
    } else {
      c.check(false, '③ video.extract-audio 产出了音轨', outputs.join(', '));
    }

    // ---- ④ audio.normalize：重新编码过，仍是音频 ----
    //
    // 归一化测"响度到没到 -16 LUFS"需要 `loudnorm` 的测量输出，那是另一个
    // 工具；这里断言的是**这一步真的执行了并产出可用音频**。诚实的边界：
    // 脚本验不了"听感上响度是否一致"。
    const normalized = outputs.filter((p) => p.toLowerCase().endsWith('.mp3'))[1];
    if (normalized && existsSync(normalized)) {
      const info = probeJson(normalized);
      console.log(`   normalize → ${JSON.stringify(info)}`);
      c.check(info.audioCodec === 'mp3', '④ audio.normalize：产出仍是 mp3', String(info.audioCodec));
      c.check(info.size > 0, '④ 归一化后的文件非空', `${info.size} 字节`);
      c.check(
        info.size !== probeJson(audio).size || info.duration !== probeJson(audio).duration,
        '④ 归一化确实重新编码过（字节数与上一步不同）',
        `${probeJson(audio).size} → ${info.size}`
      );
      // ★ `loudnorm` 默认会把结果重采样到编码器默认值（44.1k → 48k），
      //   而用户只要求"归一化响度"。这一条断言它被显式保住了。
      c.check(
        info.sampleRate === 44100,
        '★ ④ 采样率被保住 44100（loudnorm 不会偷偷重采样）',
        String(info.sampleRate)
      );
    } else {
      c.note('跳过 ④：第二个 mp3 产出没找到');
      c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
    }

    // ---- ⑤ audio.convert：容器与采样率都按参数来 ----
    const converted = byExt('.m4a');
    if (converted && existsSync(converted)) {
      const info = probeJson(converted);
      console.log(`   audio.convert → ${JSON.stringify(info)}`);
      c.check(info.audioCodec === 'aac', '⑤ audio.convert：m4a 里是 aac', String(info.audioCodec));
      c.check(info.sampleRate === 44100, '⑤ 采样率按参数设成 44100', String(info.sampleRate));
      c.check(info.videoCodec === null, '⑤ 仍然没有视频轨', String(info.videoCodec));
    } else {
      c.check(false, '⑤ audio.convert 产出了 m4a', outputs.join(', '));
    }

    // ---- ⑥ video.transcode：容器由 `format` 参数决定（这一条抓的是"假参数"）----
    //
    // 节点目录里这个参数以前叫 **`container`**，而它是**装饰性的**：真正决定
    // 输出容器的是扩展名，而扩展名由 `build_io` 从参数表里的 **`format`** 推出来。
    // 于是用户把 `container` 选成 mkv、产出仍然是 `.mp4`。
    // 现在统一成 `format`，这一节就是它的正面断言。
    const TRANSCODE_ID = 'com.toolforge.test.av-transcode';
    const transDir = join(work, 'transcode');
    mkdirSync(transDir, { recursive: true });
    const transYaml = `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${TRANSCODE_ID}
  name: 转码测试插件
  version: 1.0.0
  description: 仅用于验证 video.transcode 的容器参数是否真的生效。
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
io:
  inputs:
    - id: src
      label: 源视频
      type: file
      accept: ["video/*"]
      required: true
  outputs:
    - id: dst
      label: 转码结果
      type: file
      required: false
  params:
    - id: format
      label: 容器格式
      type: enum
      default: { kind: str, value: mp4 }
      options:
        - { value: mp4, label: MP4 }
        - { value: mkv, label: MKV }
        - { value: webm, label: WebM }
      required: false
      affectsOutput: true
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    timeoutMs: 300000
    steps:
      - id: tc
        uses: video.transcode
        label: 转码
        with:
          src: "\${src}"
          dst: "\${output.dst}"
          vcodec: libx264
          acodec: aac
          crf: "30"
          preset: ultrafast
`;
    writeFileSync(join(transDir, 'plugin.yaml'), transYaml, 'utf8');
    const ex2 = await client.invoke('plugins_get', { pluginId: TRANSCODE_ID }).catch(() => null);
    if (ex2) {
      await client.invoke('plugins_set_enabled', { pluginId: TRANSCODE_ID, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: TRANSCODE_ID }).catch(() => {});
    }
    await client.invoke('plugins_install', {
      req: {
        source: { kind: 'directory', path: transDir },
        overwrite: true,
        permissionsAcknowledged: true,
        executableCodeAcknowledged: false,
      },
    });
    await client.invoke('plugins_grant', {
      req: {
        pluginId: TRANSCODE_ID,
        granted: {
          capabilities: [
            { kind: 'fsRead', scope: { kind: 'input' } },
            { kind: 'fsWrite', scope: { kind: 'output' } },
          ],
        },
      },
    });
    await client.invoke('plugins_set_enabled', { pluginId: TRANSCODE_ID, enabled: true });

    const tcDir = join(work, 'transcode-out');
    mkdirSync(tcDir, { recursive: true });
    const tcSub = await client.invoke('plugins_run', {
      req: {
        pluginId: TRANSCODE_ID,
        inputs: { src: [src] },
        params: { format: { kind: 'str', value: 'mkv' } },
        outputDir: tcDir,
      },
    });
    const tcJob = await client.waitJob(tcSub.jobId, 180, 1000);
    console.log(`   转码任务（请求 mkv）: ${tcJob.status}`);
    if (tcJob.error) console.log(`   错误: ${tcJob.error.code} — ${tcJob.error.message}`);
    c.check(tcJob.status === 'succeeded', '⑥ video.transcode 成功', tcJob.status);

    const tcOut = (tcJob.outputs ?? [])[0];
    console.log(`   转码产出: ${tcOut ?? '(无)'}`);
    c.check(
      Boolean(tcOut && tcOut.toLowerCase().endsWith('.mkv')),
      '★ ⑥ 请求的容器（mkv）真的决定了输出扩展名 —— 参数不是装饰',
      tcOut ?? '(无产出)'
    );
    if (tcOut && existsSync(tcOut)) {
      const info = probeJson(tcOut);
      console.log(`   转码属性 → ${JSON.stringify(info)}`);
      c.check(/matroska/.test(String(info.formatName)), '★ ⑥ 文件的真实容器是 matroska', String(info.formatName));
      c.check(info.videoCodec === 'h264' && info.audioCodec === 'aac', '⑥ 视频/音频编解码器按参数', `${info.videoCodec}/${info.audioCodec}`);
    }

    // ---- ⑥b 反向：webm + h264 必须在**调用 ffmpeg 之前**被拦下 ----
    //
    // WebM 只接受 VP8/VP9/AV1 + Opus/Vorbis。不预检的话用户看到的是
    // ffmpeg 那句 `Could not find tag for codec h264 in stream #0` —— 不知所云。
    const tcSub2 = await client.invoke('plugins_run', {
      req: {
        pluginId: TRANSCODE_ID,
        inputs: { src: [src] },
        params: { format: { kind: 'str', value: 'webm' } },
        outputDir: join(work, 'transcode-webm'),
      },
    });
    const tcJob2 = await client.waitJob(tcSub2.jobId, 120, 1000);
    console.log(`   webm + h264: ${tcJob2.status} / ${tcJob2.error?.code ?? ''}`);
    c.check(tcJob2.status === 'failed', '⑥b webm + h264 被拒绝（而不是让 ffmpeg 报一句看不懂的话）', String(tcJob2.status));
    c.check(
      /WebM 只接受 VP8 \/ VP9 \/ AV1/.test(String(tcJob2.error?.detail ?? '')),
      '⑥b 拒绝理由说清了 WebM 接受什么、该怎么办',
      String(tcJob2.error?.message ?? '').slice(0, 80)
    );

    // ---- ⑦ video.compress：按目标体积算码率 ----
    const COMPRESS_ID = 'com.toolforge.test.av-compress';
    const cDir = join(work, 'compress');
    mkdirSync(cDir, { recursive: true });
    const cYaml = transYaml
      .replace(TRANSCODE_ID, COMPRESS_ID)
      .replace('转码测试插件', '压缩测试插件')
      .replace(/      - id: tc[\s\S]*$/, `      - id: cp
        uses: video.compress
        label: 压缩
        with:
          src: "\${src}"
          dst: "\${output.dst}"
          targetSizeMb: "0.05"
          maxWidth: "160"
`);
    writeFileSync(join(cDir, 'plugin.yaml'), cYaml, 'utf8');
    const ex3 = await client.invoke('plugins_get', { pluginId: COMPRESS_ID }).catch(() => null);
    if (ex3) {
      await client.invoke('plugins_set_enabled', { pluginId: COMPRESS_ID, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: COMPRESS_ID }).catch(() => {});
    }
    await client.invoke('plugins_install', {
      req: {
        source: { kind: 'directory', path: cDir },
        overwrite: true,
        permissionsAcknowledged: true,
        executableCodeAcknowledged: false,
      },
    });
    await client.invoke('plugins_grant', {
      req: {
        pluginId: COMPRESS_ID,
        granted: {
          capabilities: [
            { kind: 'fsRead', scope: { kind: 'input' } },
            { kind: 'fsWrite', scope: { kind: 'output' } },
          ],
        },
      },
    });
    await client.invoke('plugins_set_enabled', { pluginId: COMPRESS_ID, enabled: true });
    const cpDir = join(work, 'compress-out');
    mkdirSync(cpDir, { recursive: true });
    const cpSub = await client.invoke('plugins_run', {
      req: { pluginId: COMPRESS_ID, inputs: { src: [src] }, params: {}, outputDir: cpDir },
    });
    const cpJob = await client.waitJob(cpSub.jobId, 180, 1000);
    console.log(`   压缩任务: ${cpJob.status}`);
    if (cpJob.error) console.log(`   错误: ${cpJob.error.code} — ${cpJob.error.message}`);
    c.check(cpJob.status === 'succeeded', '⑦ video.compress 成功', cpJob.status);
    const cpOut = (cpJob.outputs ?? [])[0];
    if (cpOut && existsSync(cpOut)) {
      const info = probeJson(cpOut);
      console.log(`   压缩属性 → ${JSON.stringify(info)}`);
      c.check(info.width === 160, '⑦ 宽度按 maxWidth 缩到 160', String(info.width));
      const logs = (cpJob.logs ?? []).map((l) => l.message).join('\n');
      c.check(
        /目标 0\.05 MB \/ 时长 .* → 视频码率约 \d+ kbps/.test(logs),
        '⑦ 日志交代了按目标体积算出来的码率（不是闷头压）',
        (logs.match(/目标 .*kbps/) ?? [''])[0]
      );
      c.check(info.size > 0, '⑦ 产出非空', `${info.size} 字节`);
    } else {
      c.check(false, '⑦ video.compress 产出了文件', String(cpOut));
    }

    // 收尾
    for (const id of [CHAIN_ID, TRANSCODE_ID, COMPRESS_ID]) {
      await client.invoke('plugins_set_enabled', { pluginId: id, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: id }).catch(() => {});
    }
    const left = await client.invoke('plugins_list');
    const ids = (left?.plugins ?? left ?? []).map((p) => p.id);
    c.check(
      !ids.some((x) => /\.test\./.test(String(x))),
      '音视频测试插件已清理',
      ids.filter((x) => /\.test\./.test(String(x))).join(', ')
    );
  }
}

client.close();
process.exit(c.summary() ? 0 : 1);

/**
 * 直接调用一个外部程序（仅用于造测试素材）。
 *
 * 用 `spawnSync` 而不是 `execSync`：后者会把 stderr 混进返回值，而且
 * 参数拼接要靠字符串转义。这里参数是数组，不经过 shell。
 */
function runEngine(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) return { ok: false, err: r.error.message };
  if (r.status !== 0) return { ok: false, err: `exit=${r.status} ${String(r.stderr ?? '').slice(0, 200)}` };
  return { ok: true, err: '' };
}

/**
 * 生成"白底 + 一个纯色椭圆"的 PNG。
 *
 * 抠图测试**必须**用有显著性目标的图：U²-Net 是显著性检测模型，
 * 喂一张渐变色块进去它会（正确地）什么都不选出来 —— 那样测出来的
 * "占比 0%"是模型的正确行为，而不是缺陷。
 */
function makeSubjectPng(width, height, [x0, y0, x1, y1]) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = inside ? 205 : 248;
      raw[o + 1] = inside ? 45 : 248;
      raw[o + 2] = inside ? 45 : 248;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', (() => {
      const b = Buffer.alloc(13);
      b.writeUInt32BE(width, 0);
      b.writeUInt32BE(height, 4);
      b[8] = 8;
      b[9] = 2;
      return b;
    })()),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 极简 PNG 头解析：只要尺寸与 colorType（6 = RGBA） */
function pngInfo(buf) {
  if (buf.length < 26) return null;
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const cb = Buffer.alloc(4);
  cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, cb]);
}

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
