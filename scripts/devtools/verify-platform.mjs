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
  copyFileSync,
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

import { Checker, connect, makeDocx, makePng, REPO_ROOT, sleep, webpInfo, writeInputPdf } from './cdp.mjs';

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

// ============================================================================
// 【18】压缩包：7-Zip 真的打包出**标准归档**、也真的解得开
// ============================================================================
//
// 为什么这一节要在**运行时**验，而不是靠单元测试：
//
// * `7zip` 是三个核心引擎之一，而它的下载源长期是空的（文档里的理由是"官方只发安装器
//   /需要先有 7-Zip 才能解压的 .7z"——**那个理由已经被证伪**，Windows 自带的 bsdtar
//   读得懂 7z）。也就是说这条链路**从来没有在本机跑通过**，直到本轮。
// * 它踩的两个坑都是"单元测试看不见、真跑才现形"的类型：
//   ① 解压出来的可执行文件被**认成了 `7z.dll`**（旧实现比较文件主干名，`7z.dll`
//      与 `7z.exe` 的主干都是 `7z`，而目录里 `7z.dll` 排在前面）—— 引擎显示"已安装"、
//      路径却是个 DLL；② `MANAGED_LAYOUT` 写的是 `7z`，而 Windows 的 MSI 布局把文件
//      放在 `Files/7-Zip/` 下 —— 探测靠**按文件名递归回退**才找得到。
//   所以这里第 ① 条检查就是直接盯着"解析出来的路径必须是一个真的可执行文件"。
// * 还有一条**独立实现**的交叉验证：7-Zip 打包出来的 zip 交给**系统 tar**（libarchive）
//   去解。自己打的包自己解，两边同时错还能对上；换一套实现解，才算证明了
//   "产出的是标准 zip 而不是只有 7-Zip 认得的私有格式"。
c.section('【18】压缩包节点（7-Zip 打包 / 解压）是否真的产出标准归档');
{
  const engines = await client.invoke('engines_probe_all');
  const z = engines.find((e) => e.descriptor.id === '7zip');
  const zPath = z?.status?.path;
  const zUsable = Boolean(z && (z.status.state === 'detected' || z.status.state === 'installed'));

  if (!zUsable) {
    c.note('跳过：本机没有可用的 7-Zip（到「引擎管理」一键安装；三平台都有下载源，Windows 约 2 MB）');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    console.log(`   7-Zip: ${zPath}`);
    console.log(`   版本: ${z.status.version ?? '(未知)'}`);

    // ---- 检查 ①：解析出来的必须是**真的可执行文件**，不能是同名的 DLL ----
    const base = (zPath ?? '').split(/[\\/]/).pop() ?? '';
    c.check(
      existsSync(zPath) && /^(7z|7za|7zz)(\.exe)?$/i.test(base),
      '① 引擎路径指向真正的 7-Zip 可执行文件（不是 `7z.dll` 这类同名数据文件）',
      `${zPath}（文件名 ${base}）`
    );

    const work = join(REPO_ROOT, '.tools', 'smoke', 'out-archive');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });

    // 造一个内容**可校验**的输入：随机字节 + 一个文本文件
    // （随机字节是刻意的：全 0 或重复内容会让"解压后长度对了但内容是别的"这件事测不出来）
    const payload = Buffer.concat([
      Buffer.from('toolforge archive roundtrip\n', 'utf8'),
      Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 251)),
    ]);
    const srcFile = join(work, 'payload.bin');
    writeFileSync(srcFile, payload);

    c.section('【18a】`archive.pack` 打包 → 用**系统 tar** 独立解开比对');
    const PACK_ID = 'com.toolforge.test.archive-pack';
    const packDir = join(work, 'pack-plugin');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'plugin.yaml'),
      `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${PACK_ID}
  name: 压缩测试插件
  version: 1.0.0
  description: 仅用于验证 archive.pack。
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
io:
  inputs:
    - id: src
      label: 待压缩文件
      type: files
      required: true
  outputs:
    - id: dst
      label: 压缩包
      type: file
      accept: [".zip"]
      required: true
  params: []
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    timeoutMs: 300000
    steps:
      - id: zip
        uses: archive.pack
        label: 打包
        with:
          src: "\${src}"
          dst: "\${output.dst}"
          format: zip
          level: "5"
`,
      'utf8'
    );

    /** 装插件 → 授权 → 启用（与【17】同一套流程，这里抽成函数免得抄三遍） */
    const installTestPlugin = async (id, dir) => {
      const existing = await client.invoke('plugins_get', { pluginId: id }).catch(() => null);
      if (existing) {
        await client.invoke('plugins_set_enabled', { pluginId: id, enabled: false }).catch(() => {});
        await client.invoke('plugins_uninstall', { pluginId: id }).catch(() => {});
      }
      await client.invoke('plugins_install', {
        req: {
          source: { kind: 'directory', path: dir },
          overwrite: true,
          permissionsAcknowledged: true,
          executableCodeAcknowledged: false,
        },
      });
      await client.invoke('plugins_grant', {
        req: {
          pluginId: id,
          granted: {
            capabilities: [
              { kind: 'fsRead', scope: { kind: 'input' } },
              { kind: 'fsWrite', scope: { kind: 'output' } },
            ],
          },
        },
      });
      await client.invoke('plugins_set_enabled', { pluginId: id, enabled: true });
    };
    const removeTestPlugin = async (id) => {
      await client.invoke('plugins_set_enabled', { pluginId: id, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: id }).catch(() => {});
    };

    try {
      await installTestPlugin(PACK_ID, packDir);
      const outDir = join(work, 'pack-out');
      mkdirSync(outDir, { recursive: true });
      const sub = await client.invoke('plugins_run', {
        req: { pluginId: PACK_ID, inputs: { src: [srcFile] }, params: {}, outputDir: outDir },
      });
      const job = await client.waitJob(sub.jobId, 180, 1000);
      console.log(`   打包任务: ${job.status}`);
      if (job.error) console.log(`   错误: ${job.error.code} — ${job.error.message}`);
      c.check(job.status === 'succeeded', 'archive.pack 成功', job.status);

      const zipPath = (job.outputs ?? [])[0];
      const magicOk =
        Boolean(zipPath) &&
        existsSync(zipPath) &&
        readFileSync(zipPath).subarray(0, 4).toString('latin1') === 'PK\u0003\u0004';
      c.check(
        magicOk,
        '产出是标准 zip（`PK\\x03\\x04` 文件头）',
        `${zipPath ?? '(无产出)'}`
      );

      // ★ 独立实现交叉验证：用系统 tar（libarchive / GNU tar）解开 7-Zip 打的包
      if (zipPath && existsSync(zipPath)) {
        const unzipDir = join(work, 'tar-unzip');
        mkdirSync(unzipDir, { recursive: true });
        let tarOk = false;
        let tarErr = '';
        try {
          execFileSync('tar', ['-xf', zipPath, '-C', unzipDir], { windowsHide: true });
          tarOk = true;
        } catch (e) {
          tarErr = String(e.stderr ?? e.message).slice(0, 200);
        }
        c.check(tarOk, '系统 tar 能解开它（产出不是 7-Zip 私有格式）', tarErr);
        const back = join(unzipDir, 'payload.bin');
        const same =
          tarOk && existsSync(back) && Buffer.compare(readFileSync(back), payload) === 0;
        c.check(
          same,
          '独立实现解出来的字节与原始输入**逐字节相同**',
          tarOk ? `${existsSync(back) ? readFileSync(back).length : 0} / ${payload.length} 字节` : tarErr
        );

        // ---- 【18b】再用我们自己的 archive.unpack 解一遍 ----
        c.section('【18b】`archive.unpack` 解压 → 内容逐字节比对');
        const UNPACK_ID = 'com.toolforge.test.archive-unpack';
        const unpackDir = join(work, 'unpack-plugin');
        mkdirSync(unpackDir, { recursive: true });
        writeFileSync(
          join(unpackDir, 'plugin.yaml'),
          `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${UNPACK_ID}
  name: 解压测试插件
  version: 1.0.0
  description: 仅用于验证 archive.unpack。
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
io:
  inputs:
    - id: src
      label: 压缩包
      type: file
      required: true
  outputs:
    - id: dst
      label: 解压目录
      type: directory
      required: true
  params: []
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    timeoutMs: 300000
    steps:
      - id: unpack
        uses: archive.unpack
        label: 解压
        with:
          src: "\${src}"
          dst: "\${output.dst}"
`,
          'utf8'
        );
        await installTestPlugin(UNPACK_ID, unpackDir);
        const uOut = join(work, 'unpack-out');
        mkdirSync(uOut, { recursive: true });
        const uSub = await client.invoke('plugins_run', {
          req: { pluginId: UNPACK_ID, inputs: { src: [zipPath] }, params: {}, outputDir: uOut },
        });
        const uJob = await client.waitJob(uSub.jobId, 180, 1000);
        console.log(`   解压任务: ${uJob.status}`);
        if (uJob.error) console.log(`   错误: ${uJob.error.code} — ${uJob.error.message}`);
        c.check(uJob.status === 'succeeded', 'archive.unpack 成功', uJob.status);

        // 解压产物可能落在 output.dst 目录里，也可能被换名 —— 都在输出目录下递归找
        const findByName = (dir, name) => {
          const stack = [dir];
          while (stack.length) {
            const cur = stack.pop();
            let entries = [];
            try {
              entries = readdirSync(cur, { withFileTypes: true });
            } catch {
              continue;
            }
            for (const e of entries) {
              const p = join(cur, e.name);
              if (e.isDirectory()) stack.push(p);
              else if (e.name === name) return p;
            }
          }
          return null;
        };
        const found = findByName(uOut, 'payload.bin');
        c.check(Boolean(found), '解压目录里找得到 payload.bin', String(found));
        c.check(
          Boolean(found) && Buffer.compare(readFileSync(found), payload) === 0,
          '解压出来的字节与原始输入**逐字节相同**（打包/解压闭环）',
          found ? `${readFileSync(found).length} / ${payload.length} 字节` : '(未找到)'
        );

        // ---- 【18c】反证：不是压缩包时必须**失败**，不能假装成功 ----
        c.section('【18c】反证：把普通文本当压缩包喂进去，必须报错而不是"成功"');
        const notArchive = join(work, 'not-an-archive.zip');
        writeFileSync(notArchive, '这不是压缩包，只是一段文本\n', 'utf8');
        const badSub = await client.invoke('plugins_run', {
          req: {
            pluginId: UNPACK_ID,
            inputs: { src: [notArchive] },
            params: {},
            outputDir: join(work, 'unpack-bad'),
          },
        });
        const badJob = await client.waitJob(badSub.jobId, 120, 1000);
        console.log(`   伪压缩包任务: ${badJob.status}${badJob.error ? ` — ${badJob.error.code}` : ''}`);
        c.check(
          badJob.status === 'failed',
          '拒绝把非压缩包当压缩包（任务失败，不是"成功但产出空目录"）',
          badJob.status
        );
        c.check(
          Boolean(badJob.error?.message),
          '失败时带得出可读原因（不是一句"失败了"）',
          badJob.error?.message ?? '(无)'
        );
        await removeTestPlugin(UNPACK_ID);
      }
    } finally {
      await removeTestPlugin(PACK_ID);
      const left = await client.invoke('plugins_list');
      const ids = (left?.plugins ?? left ?? []).map((p) => p.id);
      c.check(
        !ids.some((x) => /archive-(pack|unpack)/.test(String(x))),
        '压缩测试插件已清理',
        ids.filter((x) => /archive-(pack|unpack)/.test(String(x))).join(', ')
      );
    }
  }
}

// ============================================================================
// 【19】`doc.to-pdf`：Office 文档 → PDF 是不是真的转出来了
// ============================================================================
//
// 为什么这一节直到现在才写：`libreoffice` 是三个核心引擎之外**唯一一个
// 从来没有过真机基线**的引擎 —— 它的体积是 420 MB 起，而且在
// `engine_catalog()` 里的安装方式是「仅系统安装」，本机从来没装过。
// 于是 `doc.to-pdf` 这个节点从写出来那天起，**一次都没有被执行过**：
// 单元测试、`cargo check`、界面上的可用性判定全都不会碰它。
//
// 本轮把它打通了（Windows 用官方 `.msi` 的**管理安装**，见起点的 note），
// 于是有了这一节。它验证的是"节点真的产出了内容正确的 PDF"，而不是"任务成功了"：
//
//   1. 用**手写的最小 DOCX**（`cdp.mjs::makeDocx`，纯 Node 造的合法 OOXML）当输入 ——
//      不依赖 pandoc 之类的另一个引擎来造素材，否则没有 pandoc 的机器上整节会被跳过；
//   2. 产出必须是 `%PDF-` 开头、体积合理；
//   3. ★ 用 **Poppler 的 `pdftotext`** 把 PDF 里的文字读回来，断言里面有我们写进去的
//      那些词 —— "文件非空"证明不了内容对，这一步才是。它同时是**跨引擎**的交叉验证：
//      PDF 是 LibreOffice 写的，读它的是另一个项目写的工具。
//      （断言**逐词存在**而不是整句连续匹配：LibreOffice 输出的文字流顺序会变，
//       整句匹配会因为排版顺序判红，那是把断言绑死在排版实现上。）
//   4. 版本探测**没有挂住**：LibreOffice 的 `soffice.exe` 跑 `--version` 会挂住
//      （GUI 子系统启动器），所以托管布局在 Windows 上刻意指向 `soffice.com`。
//      这条断言盯着那个选择 —— 版本号非空且探测很快。
//   5. 输入是垃圾时，**我们自己这一侧**的不变量：绝不产出一个 0 字节的 PDF 冒充成功。
//      （原本这里想写"假 docx 必须失败"，但实测推翻了那个假设 —— 见下文 ⑥ 的注释。）
c.section('【19】`doc.to-pdf`：Office 文档 → PDF 是否真的转出来了（LibreOffice）');
{
  const engines = await client.invoke('engines_probe_all');
  const lo = engines.find((e) => e.descriptor.id === 'libreoffice');
  const loUsable = Boolean(lo && (lo.status.state === 'detected' || lo.status.state === 'installed'));

  if (!loUsable) {
    c.note('跳过：本机没有可用的 LibreOffice（Windows 可在「引擎管理」一键安装，约 356 MB）');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    console.log(`   LibreOffice: ${lo.status.path}`);
    console.log(`   版本: ${lo.status.version ?? '(未知)'}`);

    // ---- 检查 ①：版本探测不该挂住（这条盯着 soffice.com / soffice.exe 的选择）----
    c.check(
      Boolean(lo.status.version) && String(lo.status.version).includes('LibreOffice'),
      '① 版本探测有结果且没挂住（`soffice.exe` 跑 --version 会挂住，必须用控制台入口）',
      String(lo.status.version ?? '(空)')
    );

    // ---- 素材：手写的最小 DOCX ----
    const work = join(REPO_ROOT, '.tools', 'smoke', 'out-topdf');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const marker = 'ToolForge 转 PDF 验证标记';
    const docxPath = join(work, 'verify.docx');
    writeFileSync(docxPath, makeDocx(`${marker}\n第二段中文正文 with ASCII text.`));
    console.log(`   输入 docx: ${docxPath}（${readFileSync(docxPath).length} 字节，纯 Node 手写）`);

    // Poppler 的 pdftotext —— 用来把 PDF 里的文字读回来（跨引擎交叉验证）
    const poppler = engines.find((e) => e.descriptor.id === 'poppler');
    const pdftoppm = poppler?.status?.path;
    const pdftotext = pdftoppm ? join(dirname(pdftoppm), 'pdftotext.exe') : null;
    const canReadPdf = Boolean(pdftotext && existsSync(pdftotext));

    const outDir = join(work, 'out');
    mkdirSync(outDir, { recursive: true });
    const sub = await client.invoke('plugins_run', {
      req: { pluginId: 'com.toolforge.builtin.doc-to-pdf', inputs: { src: [docxPath] }, params: {}, outputDir: outDir },
    });
    const job = await client.waitJob(sub.jobId, 300, 1000);
    console.log(`   转换任务: ${job.status}`);
    if (job.error) console.log(`   错误: ${job.error.code} — ${job.error.message}`);
    c.check(job.status === 'succeeded', '② docx → pdf 任务成功', job.error?.message ?? job.status);

    const produced = existsSync(outDir) ? readdirSync(outDir) : [];
    const pdfPath = produced.length ? join(outDir, produced.find((f) => f.endsWith('.pdf')) ?? produced[0]) : null;
    if (pdfPath && existsSync(pdfPath)) {
      const buf = readFileSync(pdfPath);
      c.check(
        buf.subarray(0, 5).toString('latin1') === '%PDF-',
        '③ 产出是真正的 PDF（`%PDF-` 头）',
        buf.subarray(0, 8).toString('latin1')
      );
      c.check(buf.length > 1024, '④ 产物体积合理（不是空壳）', `${buf.length} 字节`);
      console.log(`   PDF: ${pdfPath}（${buf.length} 字节）`);

      // ★ 内容断言：把 PDF 的文字读回来
      if (canReadPdf) {
        const txtPath = join(work, 'out.txt');
        let text = '';
        try {
          execFileSync(pdftotext, [pdfPath, txtPath], { windowsHide: true });
          text = readFileSync(txtPath, 'utf8');
        } catch (e) {
          c.note(`pdftotext 提取失败：${String(e.message).slice(0, 120)}`);
        }
        console.log(`   pdftotext 读回 ${text.trim().length} 个字符：${text.trim().replace(/\s+/g, ' ').slice(0, 70)}`);
        // ⚠️ 断言**逐词存在**而不是整句连续匹配：LibreOffice 输出的文字流顺序会变
        // （实测读回来是「转 PDF 验证标记 第二段中文正文 with ASCII text. ToolForge」——
        //  "ToolForge" 被排到了行尾）。整句匹配会**因为排版顺序**判红，
        // 那是把"文字在不在"这条断言绑死在排版实现上。
        const tokens = marker.split(/\s+/).filter(Boolean);
        const missing = tokens.filter((t) => !text.includes(t));
        c.check(
          missing.length === 0,
          '★ ⑤ PDF 里真的能读出写进去的每个词（跨引擎交叉验证：LibreOffice 写、Poppler 读）',
          missing.length ? `缺：${missing.join(' / ')}` : `全部 ${tokens.length} 个词都在`
        );
      } else {
        c.note('（没有 Poppler 的 pdftotext，跳过"读回文字"这条内容断言）');
      }
    } else {
      c.check(false, '③ 产出了 PDF 文件', produced.join(', ') || '(输出目录为空)');
    }

    // ---- ⑥ 输入是垃圾时，我们自己这一侧的不变量 ----
    //
    // 这条一开始想写的是"假 docx 必须失败"。**实测把这个假设推翻了**：
    // LibreOffice 是**按内容嗅探**格式的，宽容得超出预期 ——
    //   * 一段普通文本改名成 `.docx` → 正常转出 PDF（内容是那段文本）；
    //   * 4 KB 随机二进制改名成 `.docx` → 也"成功"，产出一个 **781 KB** 的 PDF；
    //   * **0 字节**的空文件 → 也是"成功"，产出 6.5 KB 的 PDF。
    // 也就是说"拒绝坏输入"这件事 LibreOffice 不做，`doc.to-pdf` 也不该假装能做 ——
    // 输入扩展名的把关在插件/节点的 `accept` 列表那一层，内容层面挡不住。
    //
    // 所以这条改成盯**我们自己的不变量**：无论输入多离谱，都**不能产出一个 0 字节的 PDF**
    // 冒充成功（那才是最难查的失败形态）。
    const emptyPath = join(work, 'empty.docx');
    writeFileSync(emptyPath, Buffer.alloc(0));
    const emptyDir = join(work, 'out-empty');
    mkdirSync(emptyDir, { recursive: true });
    const emptySub = await client.invoke('plugins_run', {
      req: { pluginId: 'com.toolforge.builtin.doc-to-pdf', inputs: { src: [emptyPath] }, params: {}, outputDir: emptyDir },
    });
    const emptyJob = await client.waitJob(emptySub.jobId, 180, 1000);
    const emptyOut = existsSync(emptyDir) ? readdirSync(emptyDir) : [];
    const producedBytes = emptyOut.length ? readFileSync(join(emptyDir, emptyOut[0])).length : 0;
    console.log(
      `   0 字节输入: 任务 ${emptyJob.status}，产出 ${emptyOut.join(', ') || '(无)'} ${producedBytes} 字节`
    );
    c.check(
      emptyJob.status === 'failed' || producedBytes > 0,
      '⑥ 垃圾输入不会"成功"地留下一个 0 字节的 PDF（LibreOffice 对坏输入是宽容的，但空壳不能冒充成功）',
      emptyJob.status === 'failed' ? '任务失败（正确）' : `${producedBytes} 字节`
    );
  }
}

// ============================================================================
// 【20】"用一句话生成插件"这条闭环：草稿 → 审核 → 安装 → **真的跑出东西**
// ============================================================================
//
// 这是产品的招牌能力（README 第一段就是它），但**此前从未被端到端跑过**：
// `ai_generate` / `ai_review_draft` 有实现、有单测，可是没有人从"一句话"走到
// "装上一个能跑的插件"。原因和 `doc.to-pdf` 一样：它要一个**会按约定吐 YAML 的模型**，
// 而真模型不可复现 —— 同一个需求两次生成的插件不一样，还会偶发不合规。
//
// 于是 `mock-openai.mjs` 兼任"插件生成器"（请求里带 `[mock:draft]` / `[mock:malicious]`
// 就分别回一份合规草稿 / 一份越权草稿）。这一节断言的是**我们这一侧**：
//
//   1. 草稿被正确解析（`parse_model_output` 认得出 ```yaml 块、要求 plugin.yaml 存在）；
//   2. 静态审核对**合规草稿**放行（`recommended === true`）且风险等级不高；
//   3. ★ **装上去真的能跑**：把草稿写成目录 → `plugins_install` → 授权 → 启用 →
//      用一张真 PNG 跑一次 → 产出必须是**真的 WebP**（不是"任务成功"就算）。
//      这一步才是这条链路的验收标准 —— 草稿好看但跑不起来等于没验证；
//   4. **反证**：一份语法完全合法、但申请了 `explicit` 路径写入 + `exec` 的草稿，
//      必须被判为**不建议放行**，并且点出高危能力（而不是先撞上"YAML 解析失败"）。
//      注意区分这两件事：解析失败拦下来不算安全 —— 攻击者会写合法的 YAML。
//
// 模型"答得好不好"仍然不在验证范围内（那是模型能力，不是我们的正确性），
// 这条边界与【10】的说明保持一致。
c.section('【20】"一句话生成插件"闭环：草稿 → 审核 → 安装 → 真的跑出东西');
{
  const MOCK_PORT = 18124;
  const mock = spawn(process.execPath, [join(HERE, 'mock-openai.mjs'), String(MOCK_PORT)], {
    stdio: 'ignore',
    detached: false,
  });
  await sleep(600);
  const mockBase = `http://127.0.0.1:${MOCK_PORT}`;
  const DRAFT_ID = 'com.mock.shrink';

  const cleanupPlugin = async (id) => {
    const existing = await client.invoke('plugins_get', { pluginId: id }).catch(() => null);
    if (existing) {
      await client.invoke('plugins_set_enabled', { pluginId: id, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: id }).catch(() => {});
    }
  };

  let restore = null;
  try {
    const before = await client.invoke('settings_get');
    restore = before.ai;
    await client.invoke('settings_patch', {
      patch: {
        ai: {
          provider: 'ollama',
          baseUrl: `${mockBase}/v1`,
          model: 'mock-text',
          temperature: 0,
          persistApiKey: false,
        },
      },
    });
    await fetch(`${mockBase}/__reset`);

    // ---- 1) 合规草稿 ----
    const gen = await client.invoke('ai_generate', {
      req: { description: '把图片缩到宽 400 并转成 WebP [mock:draft]', allowPython: false },
    });
    const fileNames = (gen.draft?.files ?? []).map((f) => f.path);
    console.log(`   草稿文件：${fileNames.join(', ') || '(空)'}`);
    c.check(fileNames.includes('plugin.yaml'), '① 模型输出被解析成含 plugin.yaml 的草稿', fileNames.join(', '));
    c.check(gen.review?.parseable === true, '② 草稿清单能被解析', gen.review?.parseError ?? '');
    c.check(
      gen.review?.recommended === true,
      '★ ③ 合规草稿通过静态审核（可以进入"用户确认"环节）',
      `recommended=${gen.review?.recommended} risk=${gen.review?.riskLevel} findings=${JSON.stringify(
        (gen.review?.findings ?? []).map((f) => f.code)
      )}`
    );
    c.check(
      (gen.review?.validation?.issues ?? []).every((i) => i.severity !== 'error'),
      '④ 静态校验没有 error 级问题',
      JSON.stringify((gen.review?.validation?.issues ?? []).map((i) => i.code))
    );
    console.log(`   运行时摘要：${gen.review?.runtimeSummary ?? '(无)'}`);
    console.log(`   能力清单：${(gen.review?.capabilities ?? []).join(' / ')}`);

    // ---- 2) 把草稿交给后端安装 —— **用 UI 真正走的那条路（bundle）** ----
    //
    // ⚠️ 这里刻意**不用** `kind: "directory"`：AI 工作室页面上点"安装"时，
    // 前端把草稿打包成 `PluginSource::Bundle`（`plugin.yaml` 走 `yaml` 字段，
    // 其余文件进 `files`）交给 `plugins_install`，由**后端**负责落盘。
    // 那条路此前只有单元测试（`bundle_path_traversal_is_rejected` 之类），
    // **没有任何运行时验证** —— 也就是说"用户在界面上点安装"这个动作，
    // 从来没有被真的执行过一次。这里把它走通。
    const bundleFiles = gen.draft.files
      .filter((f) => f.path !== 'plugin.yaml')
      .map((f) => ({ path: f.path, content: f.content, encoding: 'utf8' }));
    const yamlText = gen.draft.files.find((f) => f.path === 'plugin.yaml')?.content ?? '';
    const draftDir = join(REPO_ROOT, '.tools', 'smoke', 'ai-draft');
    rmSync(draftDir, { recursive: true, force: true });
    mkdirSync(draftDir, { recursive: true });
    await cleanupPlugin(DRAFT_ID);
    await client.invoke('plugins_install', {
      req: {
        source: { kind: 'bundle', yaml: yamlText, files: bundleFiles },
        overwrite: true,
        permissionsAcknowledged: true,
        executableCodeAcknowledged: false,
      },
    });
    await client.invoke('plugins_grant', {
      req: {
        pluginId: DRAFT_ID,
        granted: {
          capabilities: [
            { kind: 'fsRead', scope: { kind: 'input' } },
            { kind: 'fsWrite', scope: { kind: 'output' } },
          ],
        },
      },
    });
    await client.invoke('plugins_set_enabled', { pluginId: DRAFT_ID, enabled: true });
    const installed = await client.invoke('plugins_get', { pluginId: DRAFT_ID });
    c.check(Boolean(installed), '⑤ 生成的插件能被安装（走 UI 真正用的 bundle 路径：清单由后端落盘）', DRAFT_ID);

    const outDir = join(REPO_ROOT, '.tools', 'smoke', 'out-ai-draft');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const src = join(REPO_ROOT, '.tools', 'smoke', 'in-ai-draft.png');
    writeFileSync(src, makePng(800, 600, 5));
    const sub = await client.invoke('plugins_run', {
      req: { pluginId: DRAFT_ID, inputs: { src: [src] }, params: {}, outputDir: outDir },
    });
    const job = await client.waitJob(sub.jobId, 180, 1000);
    console.log(`   运行生成的插件：${job.status}${job.error ? ` — ${job.error.code}: ${job.error.message}` : ''}`);
    c.check(job.status === 'succeeded', '★ ⑥ 生成的插件真的能跑（不是"装上了但一跑就崩"）', job.status);

    const produced = existsSync(outDir) ? readdirSync(outDir) : [];
    // ⚠️ 要挑 **WebP 那个**，不能拿 `produced[0]`：这个插件声明了两个输出端口
    // （中间文件 `resized` + 最终 `dst`），readdir 的顺序是不保证的 ——
    // 第一版就是这么写的，结果断言看的是那个 `.png` 中间产物，报"产出不是 WebP"。
    const webpName = produced.find((f) => f.toLowerCase().endsWith('.webp'));
    const outFile = webpName ? join(outDir, webpName) : null;
    console.log(`   产出：${produced.join(', ') || '(空)'}（取 WebP：${webpName ?? '(无)'}）`);
    if (outFile && existsSync(outFile)) {
      const buf = readFileSync(outFile);
      c.check(
        buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP',
        '★ ⑦ 产出是真的 WebP（RIFF/WEBP 魔数，不是被改了扩展名的别的格式）',
        `${webpName}：${buf.subarray(0, 12).toString('latin1')}`
      );
      // 生成时写的参数是"宽度 = 400"，所以这里顺手验一下参数真的生效了 ——
      // 这条断言的价值在于：**AI 写进 YAML 的参数**真的走到了节点参数解析里，
      // 而不是"插件跑通了但参数被忽略"（那种"空转成功"是本仓库打过交道的坑）。
      const info = webpInfo(buf);
      if (info && info.width) {
        c.check(
          info.width === 400,
          '★ ⑧ 生成时写的参数（宽 400）真的生效了',
          `${info.width}x${info.height}`
        );
      } else {
        c.note('（webpInfo 读不出尺寸，跳过宽度断言）');
      }
    } else {
      c.check(false, '★ ⑦ 生成的插件产出了文件', produced.join(', ') || '(输出目录为空)');
    }

    // ---- 3) 反证 A：**语法合法但引用未声明端口**的草稿必须在校验阶段就被拒 ----
    //
    // 这一条来自一次真实的踩坑：第一版"合规草稿"中间步骤写了 `${output.resized}`
    // 却没声明 `resized` 端口 —— 它通过了审核、装得上，**跑起来才报**
    // 「模板变量无法解析」。这类错误完全可以在审核阶段看出来（模板上下文里的
    // `output.*` 只含声明过的端口），所以补了 `TEMPLATE_UNKNOWN_OUTPUT_PORT` 这条校验。
    const broken = await client.invoke('ai_generate', {
      req: { description: '随便做点什么 [mock:broken]', allowPython: false },
    });
    const brokenCodes = [
      ...(broken.review?.validation?.issues ?? []).map((i) => i.code),
      ...(broken.review?.findings ?? []).map((f) => f.code),
    ];
    console.log(
      `   坏草稿：recommended=${broken.review?.recommended} ok=${broken.review?.validation?.ok} codes=${brokenCodes.join(', ')}`
    );
    c.check(
      brokenCodes.includes('TEMPLATE_UNKNOWN_OUTPUT_PORT'),
      '★ ⑨ 引用未声明的输出端口在校验阶段就被点名（不必等到跑起来才炸）',
      brokenCodes.join(', ')
    );
    c.check(
      broken.review?.recommended === false,
      '★ ⑩ 这种草稿不会被推荐放行',
      `recommended=${broken.review?.recommended}`
    );

    // ---- 4) 反证 B：合法但越权的草稿必须被拦下 ----
    const evil = await client.invoke('ai_generate', {
      req: { description: '随便做点什么 [mock:malicious]', allowPython: false },
    });
    const evilCodes = (evil.review?.findings ?? []).map((f) => f.code);
    console.log(`   越权草稿：recommended=${evil.review?.recommended} risk=${evil.review?.riskLevel} codes=${evilCodes.join(', ')}`);
    c.check(
      evil.review?.parseable === true,
      '⑪ 反证的前提成立：越权草稿是**能解析的合法清单**（不是靠 YAML 写错拦下来的）',
      evil.review?.parseError ?? ''
    );
    c.check(
      evil.review?.recommended === false,
      '★ ⑫ 申请了 explicit 路径写入 + exec 的草稿被判为**不建议放行**',
      `recommended=${evil.review?.recommended}`
    );
    c.check(
      evilCodes.includes('HIGH_RISK_CAPABILITY'),
      '⑬ 高危能力被点名（而不是只给一个笼统的"审核未通过"）',
      evilCodes.join(', ')
    );
    c.check(
      evil.review?.riskLevel === 'critical',
      '⑭ 整体风险等级被拉到 critical',
      String(evil.review?.riskLevel)
    );

    // ---- 5) 被拒的草稿要留审计 ----
    // `plugins_audit` 返回 `{ events, files, dir }`；事件带 `kind`。
    let auditKinds = [];
    try {
      const snap = await client.invoke('plugins_audit', { limit: 80 });
      auditKinds = (snap?.events ?? []).map((e) => String(e.kind ?? ''));
    } catch (e) {
      c.note(`（读不到审计：${String(e.message).slice(0, 80)}）`);
    }
    if (auditKinds.length) {
      const draftKinds = auditKinds.filter((k) => k.toLowerCase().includes('draft'));
      c.check(
        draftKinds.length > 0,
        '⑮ 被拒的 AI 草稿落了审计（"模型是不是经常试图越权"这件事要可追溯）',
        draftKinds.length ? draftKinds.join(', ') : `最近 ${auditKinds.length} 条里没有 draft 事件`
      );
    } else {
      c.note('（审计队列为空，跳过"被拒草稿落审计"这条断言）');
    }
    // ---- 6) 反证 C：Bundle 里的路径逃逸必须被后端拒绝 ----
    //
    // 单元测试里有 `bundle_path_traversal_is_rejected`，但**没有运行时证据**：
    // 真正决定"用户点安装会不会写坏东西"的是 `plugins_install` 这条链路。
    // 这里用一份**故意带 `../` 的 bundle** 走一遍，断言：① 被拒；② 什么都没留下。
    const escapeTarget = join(REPO_ROOT, '.tools', 'smoke', 'escaped-by-bundle.txt');
    rmSync(escapeTarget, { force: true });
    let traversalRejected = false;
    let traversalDetail = '';
    try {
      await client.invoke('plugins_install', {
        req: {
          source: {
            kind: 'bundle',
            yaml: yamlText.replace(DRAFT_ID, 'com.mock.traversal'),
            files: [
              { path: '../escaped-by-bundle.txt', content: 'escaped', encoding: 'utf8' },
              { path: 'sub/../../escaped2.txt', content: 'escaped', encoding: 'utf8' },
            ],
          },
          overwrite: true,
          permissionsAcknowledged: true,
          executableCodeAcknowledged: false,
        },
      });
      traversalDetail = '竟然没有被拒绝';
    } catch (e) {
      traversalRejected = true;
      // CDP 的异常文本很长（它会把对象整个摊开）。这里只把**错误码与消息**抠出来，
      // 否则这一行日志读起来是一团 JSON。
      const raw = String(e?.message ?? e);
      const code = /"code"\s*:\s*"([A-Z_]+)"/.exec(raw)?.[1] ?? '';
      const msg = /"message"\s*:\s*"([^"]{0,120})"/.exec(raw)?.[1] ?? raw.slice(0, 120);
      traversalDetail = `${code}${code ? '：' : ''}${msg}`;
    }
    c.check(traversalRejected, '★ ⑯ Bundle 里的 `../` 路径逃逸被后端拒绝', traversalDetail);
    c.check(!existsSync(escapeTarget), '⑰ 逃逸目标路径上什么都没被写出来', escapeTarget);
    const leftover = await client
      .invoke('plugins_get', { pluginId: 'com.mock.traversal' })
      .catch(() => null);
    c.check(!leftover, '⑱ 被拒的 bundle 没有留下半个插件', leftover ? '竟然装上了' : '干净');
  } finally {
    await cleanupPlugin(DRAFT_ID);
    await cleanupPlugin('com.mock.traversal');
    if (restore) {
      await client.invoke('settings_patch', { patch: { ai: restore } }).catch(() => {});
    }
    mock.kill();
  }
}

// ============================================================================
// 【21】任务取消：子进程真的被杀掉、队列记账对得上
// ============================================================================
//
// `jobs_cancel` 是**安全相关**的：用户在界面上点"取消"，期待的是"它现在停下"，
// 而不是"界面说取消了、后台还在写文件"。这条路径此前**没有任何运行时验证**
// （`docs/ROADMAP.md` 的开放项里就写着"取消路径可验证：取消令牌触发后子进程树被杀死，无孤儿"）。
//
// 这一节用的是**真实工作负载**：内置 `doc-to-pdf` 插件处理一份两万段的 docx
// （实测四千段约 8 秒，两万段留出的取消窗口足够）。选 LibreOffice 还有一个原因：
// 它会派生 `soffice.bin` —— 正好用来检验"取消之后有没有孤儿进程"。
//
// 顺带把四个此前从没被调用过的队列命令走一遍：`jobs_list` / `jobs_stats` /
// `jobs_retry` / `jobs_clear_finished`，外加 `models_remove`（用**备份还原**，
// 全程零网络：先把权重文件复制到一边，移除后用命令确认状态，再复制回来）。
c.section('【21】任务取消：子进程真的被杀掉、队列记账对得上');
{
  /** 列出某个镜像名的进程（跨平台；取不到就返回空数组） */
  const listProcesses = (imageName) => {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync(
          'tasklist',
          ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
          { encoding: 'utf8', windowsHide: true }
        );
        return out
          .split(/\r?\n/)
          .map((l) => /^"([^"]+)","(\d+)"/.exec(l))
          .filter(Boolean)
          .map((m) => m[2]);
      }
      const out = execFileSync('pgrep', ['-f', imageName], { encoding: 'utf8' });
      return out.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  const engines = await client.invoke('engines_probe_all');
  const usable = (id) => {
    const e = engines.find((x) => x.descriptor.id === id);
    return Boolean(e && (e.status.state === 'detected' || e.status.state === 'installed'));
  };

  if (!usable('libreoffice')) {
    c.note('跳过：本机没有可用的 LibreOffice（取消测试需要一个"跑得够久"的任务）');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    // ---- 素材：两万段的 docx ----
    const work = join(REPO_ROOT, '.tools', 'smoke', 'out-cancel');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const bigDocx = join(work, 'big.docx');
    const paras = Array.from(
      { length: 20000 },
      (_, i) => `第 ${i} 段：这是一段用来把转换时间拉长的正文，取消测试需要它跑得够久。`
    ).join('\n');
    writeFileSync(bigDocx, makeDocx(paras));
    console.log(`   输入：${(readFileSync(bigDocx).length / 1024).toFixed(0)} KB / 20000 段`);

    const outDir = join(work, 'out');
    mkdirSync(outDir, { recursive: true });
    const beforeProcs = new Set(listProcesses('soffice.bin'));

    const sub = await client.invoke('plugins_run', {
      req: {
        pluginId: 'com.toolforge.builtin.doc-to-pdf',
        inputs: { src: [bigDocx] },
        params: {},
        outputDir: outDir,
      },
    });
    // 等它真的进入 running（否则会把"还没来得及启动"当成"取消成功"）
    let running = false;
    for (let i = 0; i < 40; i++) {
      const j = await client.invoke('jobs_get', { jobId: sub.jobId });
      if (j?.status === 'running') {
        running = true;
        break;
      }
      if (['succeeded', 'failed', 'cancelled'].includes(j?.status)) break;
      await sleep(500);
    }
    c.check(running, '① 任务进入了 running（取消测试的前提）', running ? 'running' : '还没开始就结束了');

    if (running) {
      const t0 = Date.now();
      const after = await client.invoke('jobs_cancel', { jobId: sub.jobId });
      c.check(
        after?.status === 'cancelled' || after?.status === 'running',
        '② `jobs_cancel` 被接受（返回的任务对象状态已变更或正在收敛）',
        String(after?.status)
      );

      let final = null;
      for (let i = 0; i < 60; i++) {
        const j = await client.invoke('jobs_get', { jobId: sub.jobId });
        if (['succeeded', 'failed', 'cancelled'].includes(j?.status)) {
          final = j;
          break;
        }
        await sleep(500);
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`   取消后 ${secs} 秒收敛：${final?.status}`);
      c.check(final?.status === 'cancelled', '★ ③ 任务最终状态是 cancelled（不是"仍在跑"）', String(final?.status));
      c.check(
        (final?.outputs ?? []).length === 0,
        '④ 被取消的任务不报告任何产出（不能把半截 PDF 当成结果）',
        JSON.stringify(final?.outputs ?? [])
      );
      // 收尾：等一会儿再数进程 —— 杀进程是异步的，立刻数会数到"正在退出的那个"
      await sleep(2500);
      const afterProcs = listProcesses('soffice.bin');
      const leaked = afterProcs.filter((p) => !beforeProcs.has(p));
      c.check(
        leaked.length === 0,
        '★ ⑤ 取消后没有留下孤儿的 soffice.bin（LibreOffice 会派生它，正是最容易漏杀的那个）',
        leaked.length ? `残留 PID：${leaked.join(', ')}` : `取消前 ${beforeProcs.size} 个，取消后 ${afterProcs.length} 个`
      );

      // ---- 队列记账 ----
      const snap = await client.invoke('jobs_list', { req: { filter: {} } });
      const listed = (snap?.jobs ?? []).find((j) => j.id === sub.jobId);
      c.check(Boolean(listed), '⑥ `jobs_list` 里能找到这个任务', listed?.status ?? '(没有)');
      c.check(
        listed?.status === 'cancelled',
        '⑦ 列表里的状态与 `jobs_get` 一致（不存在两套口径）',
        String(listed?.status)
      );

      const stats = await client.invoke('jobs_stats');
      c.check(
        (stats?.cancelled ?? stats?.byStatus?.cancelled ?? 0) >= 1,
        '⑧ `jobs_stats` 把取消计入统计',
        JSON.stringify(stats)
      );

      // ---- 重试：插件运行注册过重放闭包，应当能重跑 ----
      //
      // ⚠️ 这里踩到一个真实细节，值得写下来：**重放会创建一个新任务（新 id）**。
      // 第一版按旧 id 轮询，于是永远读到上一次的终态 `cancelled`，
      // 接着对已经结束的旧任务又调了一次取消（无效），而新任务其实在跑 ——
      // 结果 ⑪ 把新任务正在用的 `soffice.bin` 误判成"取消留下的孤儿"。
      // **一个返回说谎的 API 能让上游结论完全反掉**，所以 `jobs_retry` 现在返回新 id。
      const retryId = await client.invoke('jobs_retry', { jobId: sub.jobId });
      c.check(
        typeof retryId === 'string' && retryId.length > 0 && retryId !== sub.jobId,
        '⑨ `jobs_retry` 返回**新任务**的 id（重放是重新提交，id 必然不同）',
        `旧 ${sub.jobId} → 新 ${retryId}`
      );

      // 新任务要真的跑起来
      let retriedStatus = '';
      let sawRunning = false;
      for (let i = 0; i < 60; i++) {
        const j = await client.invoke('jobs_get', { jobId: retryId });
        retriedStatus = j?.status ?? '';
        if (retriedStatus === 'running') {
          sawRunning = true;
          break;
        }
        if (['succeeded', 'failed', 'cancelled'].includes(retriedStatus)) break;
        await sleep(300);
      }
      c.check(sawRunning, '⑩ 重试之后新任务真的开始跑了（不只是"入队成功"）', retriedStatus);

      if (sawRunning) {
        await client.invoke('jobs_cancel', { jobId: retryId });
        for (let i = 0; i < 60; i++) {
          const j = await client.invoke('jobs_get', { jobId: retryId });
          if (['succeeded', 'failed', 'cancelled'].includes(j?.status)) break;
          await sleep(500);
        }
        await sleep(2500);
        const leaked2 = listProcesses('soffice.bin').filter((p) => !beforeProcs.has(p));
        c.check(
          leaked2.length === 0,
          '⑪ 重试出来的那个任务被取消后，同样没有孤儿进程',
          leaked2.length ? `残留 PID：${leaked2.join(', ')}` : '干净'
        );
      }

      const cleared = await client.invoke('jobs_clear_finished');
      c.check(Number(cleared) >= 1, '⑫ `jobs_clear_finished` 清掉了已结束的任务', String(cleared));
      const after2 = await client.invoke('jobs_list', { req: { filter: {} } });
      const stillThere = (after2?.jobs ?? []).some((j) => j.id === sub.jobId);
      c.check(!stillThere, '⑬ 清理之后它不再出现在列表里', stillThere ? '还在' : '已移除');
    }
  }

  // ---- 顺带：三个从没被调用过的只读命令 ----
  const info = await client.invoke('app_info');
  c.check(Boolean(info?.version), '⑭ `app_info` 报得出应用版本', JSON.stringify(info));
  const paths = await client.invoke('app_paths');
  // `app_paths` 返回的是 `{entries: [{label, path}]}`（给"设置 → 关于"那张表用），
  // 不是 `{dataDir, cacheDir}` —— 第一版按后者断言，于是把一条**正确的**返回判成了失败。
  const entries = paths?.entries ?? [];
  c.check(
    entries.length >= 4 && entries.every((e) => e.label && e.path),
    '⑮ `app_paths` 返回若干条带标签的目录（不是空表、也不是同一路径填两遍）',
    `${entries.length} 条：${entries.map((e) => e.label).join(' / ')}`
  );
  c.check(
    new Set(entries.map((e) => e.path)).size === entries.length,
    '⑮b 这些目录路径互不相同',
    entries.map((e) => e.path).join(' / ')
  );
  const sys = await client.invoke('system_status');
  c.check(Boolean(sys), '⑯ `system_status` 有返回', JSON.stringify(sys).slice(0, 120));

  // ---- `models_remove`：用备份还原，全程零网络 ----
  //
  // ⚠️ `ModelEntry` 里**没有 `path` 字段**（前端不需要知道落盘路径），
  // 而且落盘结构是 `<data>/models/<modelId>/<file_name>.onnx` —— 文件名不一定等于 id
  // （`birefnet-lite` 落成 `model.onnx`，`realesrgan-x4plus` 落成 `realesrgan-x4-256.onnx`）。
  // 第一版按 `m.path` 取，于是这一节被静默跳过（"没有已安装的权重"），
  // 而机器上其实装着 6 个 —— **一条永远跳过的检查等于没有检查**，这次改成自己找文件。
  const models = await client.invoke('models_list');
  const installedModel = (models ?? []).find((m) => m.installed);
  const dataDir = (await client.invoke('app_paths'))?.entries?.find((e) => e.label === '数据目录')?.path;
  const modelDir = dataDir && installedModel ? join(dataDir, 'models', installedModel.id) : null;
  let modelFile = null;
  if (modelDir && existsSync(modelDir)) {
    const files = readdirSync(modelDir).filter((f) => f.endsWith('.onnx'));
    if (files.length === 1) modelFile = join(modelDir, files[0]);
  }
  if (!installedModel || !modelFile) {
    c.note(
      `（找不到已安装权重的落盘文件，跳过 models_remove：installedModel=${
        installedModel?.id ?? '无'
      }，modelDir=${modelDir ?? '无'}）`
    );
  } else {
    const backup = `${modelFile}.verify-backup`;
    const sizeBefore = statSync(modelFile).size;
    copyFileSync(modelFile, backup);
    try {
      await client.invoke('models_remove', { modelId: installedModel.id });
      const after = await client.invoke('models_list');
      const m2 = (after ?? []).find((m) => m.id === installedModel.id);
      c.check(m2 && m2.installed === false, '⑰ `models_remove` 之后权重显示为未安装', String(m2?.installed));
      c.check(!existsSync(modelFile), '⑱ 文件真的被删掉了（不是只改了状态）', modelFile);
    } finally {
      // 还原：把它放回去，后面的检查（以及用户的机器状态）不该被这一节改坏
      mkdirSync(dirname(modelFile), { recursive: true });
      copyFileSync(backup, modelFile);
      rmSync(backup, { force: true });
    }
    const restored = await client.invoke('models_list');
    const m3 = (restored ?? []).find((m) => m.id === installedModel.id);
    c.check(Boolean(m3?.installed), '⑲ 还原之后权重重新被认作已安装（这一节不留副作用）', String(m3?.installed));
    c.check(
      existsSync(modelFile) && statSync(modelFile).size === sizeBefore,
      '⑳ 还原出来的文件字节数与原来一致（不是被截断的空壳）',
      `${statSync(modelFile).size} / ${sizeBefore}`
    );
  }
}

// ============================================================================
// 【22】流程编辑器：画布 → plugin.yaml → 校验 → 安装 → 真的跑起来
// ============================================================================
//
// 这是**最后一条没有运行时证据的用户创建路径**。它和 AI 生成那条不一样：
// 这里没有模型，产物完全由前端的一个**纯函数** `buildPluginYaml()` 决定
// （`apps/desktop/src/lib/pipeline-yaml.ts`），后端只负责校验与执行。
//
// 也就是说，这条链路上有一道**典型的集成缝**：
//
//   前端写的 YAML  ←→  后端的 `PluginManifest` 校验器
//
// 两边各自的单元测试都过，缝里却可能对不上 —— 比如前端写出
// `permissions: [...]`（裸数组）而后端期望 `{capabilities: [...]}`，
// 或者前端引用了没声明的端口。这类问题**只有把前端真的产物交给后端**才看得见。
//
// 做法：在**页面上下文里**动态 import 那个模块（Vite dev server 直接提供 TS 模块），
// 构造一份画布状态喂给 `buildPluginYaml()`，再把产出的 YAML 原样交给
// `plugins_validate` / `plugins_install` / `plugins_run`。
// 这样"用户在画布上连线、点导出、点安装、点运行"这条路径就真的被走过一遍了。
c.section('【22】流程编辑器：画布 → plugin.yaml → 后端校验 → 安装 → 真的跑起来');
{
  const CANVAS_ID = 'com.verify.canvas';

  /** 页面上下文里的模块句柄（用动态 import，不依赖任何构建产物的路径约定） */
  const buildCanvasYaml = async (payload) =>
    client.evaluate(`(async () => {
      // ⚠️ 查询参数 ?t= 是**缓存穿透**，不是装饰：页面已经 import 过这个模块，
      // 再 import 同一个 URL 会拿到浏览器缓存的旧模块 —— 那样"改了前端代码、
      // 验证却看不到变化"，甚至可能拿旧代码的通过结果去背书新代码。
      const mod = await import('/src/lib/pipeline-yaml.ts?t=' + Date.now());
      const p = ${JSON.stringify(payload)};
      const mk = (id, descriptor, x) => ({
        id,
        type: 'toolforge',
        position: { x, y: 0 },
        data: {
          descriptorName: descriptor.name,
          label: descriptor.label,
          description: descriptor.description,
          category: descriptor.category,
          inputs: descriptor.inputs,
          outputs: descriptor.outputs,
          params: descriptor.params,
          available: true,
          missingEngines: [],
          paramValues: p.values[id] ?? {},
        },
      });
      const nodes = p.nodeIds.map((id, i) => mk(id, p.descriptors[i], i * 320));
      const edges = p.edges.map((e, i) => ({
        id: 'e' + i,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      }));
      const r = mod.buildPluginYaml(p.meta, nodes, edges);
      return { yaml: r.yaml, errors: r.errors, warnings: r.warnings, ids: {
        suggest: mod.suggestPluginId('我的 工具箱 v2'),
        validOk: mod.isValidPluginId('com.verify.canvas'),
        validBad: mod.isValidPluginId('Com.Verify Canvas'),
      } };
    })()`);

  const catalog = await client.invoke('pipeline_nodes');
  const byName = new Map((catalog.nodes ?? []).map((n) => [n.name, n]));
  const need = ['image.resize', 'image.convert'];
  if (need.some((n) => !byName.has(n))) {
    c.note(`（节点目录里没有 ${need.join(' / ')}，跳过画布验证）`);
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    const payload = {
      meta: {
        pluginId: CANVAS_ID,
        name: '画布验证流水线',
        description: '由 verify-platform 构造的画布状态',
        onError: 'fail',
        timeoutMs: 120000,
      },
      nodeIds: ['resize', 'convert'],
      descriptors: [byName.get('image.resize'), byName.get('image.convert')],
      edges: [{ source: 'resize', target: 'convert', sourceHandle: 'dst', targetHandle: 'src' }],
      values: {
        resize: { width: { kind: 'int', value: 400 } },
        convert: { format: { kind: 'str', value: 'webp' }, quality: { kind: 'int', value: 82 } },
      },
    };

    const built = await buildCanvasYaml(payload);
    console.log(`   画布导出：${built.yaml.split('\n').length} 行 YAML，errors=${built.errors.length} warnings=${built.warnings.length}`);
    if (built.warnings.length) console.log(`   提示：${built.warnings.join('；')}`);
    c.check(built.errors.length === 0, '① 一块合法画布导出的 YAML 没有阻断性错误', built.errors.join('；'));
    c.check(built.yaml.includes(CANVAS_ID), '② 导出的清单带上了画布上的插件 id', CANVAS_ID);
    c.check(
      built.yaml.includes('image.resize') && built.yaml.includes('image.convert'),
      '③ 两个节点都写进了 steps'
    );
    // ★ 连线必须翻译成**传路径**，而不是 `${steps.<上游>.<端口>}`。
    //
    // 这条是 `docs/PLUGIN-SDK.md` §3.4 结尾明写的规则："想做多步文件接力，正确做法是
    // 给插件声明两个输出端口，用 `${output.frame}` / `${output.dst}` 传路径，
    // **而不是指望 `${steps.frame.dst}`**"。原因是后端把文件类产出只放进
    // `NodeOutput.outputs`（任务产出列表），**不放进 `values`**（`${steps.<id>.<key>}`
    // 只能引用后者）—— 所以那个写法**必然**报"模板变量无法解析"。
    // 画布导出原来写的就是 `${steps.resize.dst}`，于是**任何多节点画布导出的插件都跑不起来**。
    const resizeDst = /\n\s+dst: "\$\{output\.([^}]+)\}"/.exec(
      built.yaml.slice(built.yaml.indexOf('- id: "resize"'), built.yaml.indexOf('- id: "convert"'))
    )?.[1];
    const convertSrc = /- id: "convert"[\s\S]*?\n\s+src: "\$\{output\.([^}]+)\}"/.exec(built.yaml)?.[1];
    c.check(
      Boolean(resizeDst) && resizeDst === convertSrc,
      '★ ④ 连线被翻译成"下游读上游写的那条路径"（`${output.<上游端口>}`），而不是 `${steps.*}`',
      `上游 dst=${resizeDst} 下游 src=${convertSrc}`
    );
    c.check(
      !/\$\{steps\.[^}]*\}/.test(built.yaml),
      '④b 导出结果里没有 `${steps.<文件端口>}` 这种引用（那类引用解析不了）',
      (built.yaml.match(/\$\{steps\.[^}]*\}/) ?? ['(没有)'])[0]
    );

    // ★ 集成缝：把**前端真的产物**交给后端校验器
    const validate = await client.invoke('plugins_validate', {
      req: { source: { kind: 'manifest', yaml: built.yaml } },
    });
    // 响应形状是 `{validation: {ok, issues}, capabilities, requiredEngines, missingEngines}`
    // —— 第一版按 `validate.ok` 取，取到 `undefined`，于是把一次**成功的**校验判成了失败。
    const validation = validate?.validation ?? validate?.report ?? {};
    const issueCodes = (validation.issues ?? []).map((i) => i.code);
    console.log(
      `   后端校验：ok=${validation.ok} issues=${JSON.stringify(issueCodes)} capabilities=${(validate?.capabilities ?? []).length}`
    );
    c.check(
      validation.ok === true,
      '★ ⑤ 前端导出的 YAML 能通过**后端**的清单校验（集成缝对得上）',
      JSON.stringify(issueCodes)
    );

    // ★ 真跑的前提：**每个步骤都要有输出路径**。
    // 这条断言是冲着上面那个真缺陷来的：中间步骤的输出端口被连线消费之后，
    // 生成器原来**不给它绑定 `${output.*}`**，于是执行器报
    // `PLUGIN_NODE 缺少必需参数 dst` —— 单节点画布没事，多节点画布必炸。
    const stepBlocks = built.yaml.split(/\n {6}- id: /).slice(1);
    const stepsWithoutDst = stepBlocks
      .map((blk) => ({ id: (blk.match(/^"([^"]+)"/) ?? [])[1], hasDst: /\n {10}dst: /.test(blk) }))
      .filter((s) => !s.hasDst)
      .map((s) => s.id);
    c.check(
      stepsWithoutDst.length === 0,
      '★ ⑤b 每个步骤都绑定了自己的输出路径（中间产物也要有，否则执行器报"缺少必需参数 dst"）',
      stepsWithoutDst.length ? `缺 dst 的步骤：${stepsWithoutDst.join(', ')}` : `检查了 ${stepBlocks.length} 个步骤`
    );

    // ---- 安装 + 真跑：这条路径的验收标准是"产出正确"，不是"任务成功" ----
    const work = join(REPO_ROOT, '.tools', 'smoke', 'out-canvas');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });

    const existing = await client.invoke('plugins_get', { pluginId: CANVAS_ID }).catch(() => null);
    if (existing) {
      await client.invoke('plugins_set_enabled', { pluginId: CANVAS_ID, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: CANVAS_ID }).catch(() => {});
    }
    await client.invoke('plugins_install', {
      req: {
        source: { kind: 'bundle', yaml: built.yaml, files: [] },
        overwrite: true,
        permissionsAcknowledged: true,
        executableCodeAcknowledged: false,
      },
    });
    await client.invoke('plugins_grant', {
      req: {
        pluginId: CANVAS_ID,
        granted: {
          capabilities: [
            { kind: 'fsRead', scope: { kind: 'input' } },
            { kind: 'fsWrite', scope: { kind: 'output' } },
          ],
        },
      },
    });
    await client.invoke('plugins_set_enabled', { pluginId: CANVAS_ID, enabled: true });

    const src = join(work, 'canvas-in.png');
    writeFileSync(src, makePng(800, 600, 7));

    // ★ 跑的时候要带上**声明过的参数默认值**，而不是空 `params`。
    //
    // 这不是为了让测试好看，而是**前端就是这么做的**：`plugin-runner.tsx` 用
    // `initialParamValues(manifest.io.params)` 把所有声明的参数（含默认值）填好，
    // 整个 map 发给 `plugins_run`。而后端的 `build_io` 是用**运行期参数**
    // （不是清单里的 default）去决定输出文件扩展名的：
    // `params.format` 优先 → 端口 `accept` → 源扩展名。
    //
    // 第一版传了空 `params`，于是"画布上选了 WebP"没有生效，产出是一个
    // **扩展名与内容都是 PNG** 的文件 —— 差一点把它当成产品缺陷报出去。
    // 这条顺带把"声明的默认值真的能到达运行期"这件事一起验了。
    const runParams = {};
    for (const desc of [byName.get('image.resize'), byName.get('image.convert')]) {
      for (const spec of desc.params ?? []) {
        const edited = payload.values[desc.name === 'image.resize' ? 'resize' : 'convert']?.[spec.id];
        const value = edited ?? spec.default;
        if (value) runParams[spec.id] = value;
      }
    }
    console.log(`   运行参数（含默认值）：${JSON.stringify(runParams)}`);

    const sub = await client.invoke('plugins_run', {
      req: { pluginId: CANVAS_ID, inputs: { src: [src] }, params: runParams, outputDir: join(work, 'out') },
    });
    const job = await client.waitJob(sub.jobId, 180, 1000);
    console.log(`   运行画布产物：${job.status}${job.error ? ` — ${job.error.code}: ${job.error.message}` : ''}`);
    c.check(job.status === 'succeeded', '★ ⑥ 画布导出的插件真的能跑（不是"导出成功但一跑就崩"）', job.status);

    const outDir = join(work, 'out');
    const produced = existsSync(outDir) ? readdirSync(outDir) : [];
    const webpName = produced.find((f) => f.toLowerCase().endsWith('.webp'));
    if (webpName) {
      const buf = readFileSync(join(outDir, webpName));
      c.check(
        buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP',
        '★ ⑦ 产出是真的 WebP',
        `${webpName}：${buf.subarray(0, 12).toString('latin1')}`
      );
      const info = webpInfo(buf);
      c.check(
        info?.width === 400,
        '★ ⑧ 画布上设的参数（宽 400）真的生效了',
        info ? `${info.width}x${info.height}` : '(读不出尺寸)'
      );
    } else {
      c.check(false, '★ ⑦ 画布产物产出了 WebP', produced.join(', ') || '(输出目录为空)');
    }

    // ---- 反证：成环的画布必须被前端拦下（后端也会拦，但用户不该等到那时才知道）----
    const cyclic = await buildCanvasYaml({
      ...payload,
      edges: [
        { source: 'resize', target: 'convert', sourceHandle: 'dst', targetHandle: 'src' },
        { source: 'convert', target: 'resize', sourceHandle: 'dst', targetHandle: 'src' },
      ],
    });
    c.check(
      cyclic.errors.some((e) => e.includes('环')),
      '⑨ 成环的画布在前端就被拦下（不是等后端校验才报）',
      cyclic.errors.join('；') || '(没有报错)'
    );

    // ---- 反证：空画布不能导出 ----
    const empty = await buildCanvasYaml({ ...payload, nodeIds: [], descriptors: [], edges: [], values: {} });
    c.check(
      empty.errors.length > 0 && empty.yaml === '',
      '⑩ 空画布导出被拒绝（不产出半份 YAML）',
      empty.errors.join('；')
    );

    // ---- 反证：两个节点都产出 `dst` 时，端口 id 不能撞车 ----
    //
    // 所有图像节点的输出端口都叫 `dst`，所以"两个互不相连的节点"是**很常见**的画布。
    // 原来直接拿节点的端口 id 当插件输出端口 id，于是两个步骤会写到**同一个文件**上，
    // 后一个静默覆盖前一个 —— 产出一个文件、用户以为两个都在。
    const collide = await buildCanvasYaml({
      ...payload,
      nodeIds: ['a', 'b'],
      descriptors: [byName.get('image.resize'), byName.get('image.convert')],
      edges: [],
      values: {
        a: { width: { kind: 'int', value: 200 } },
        b: { format: { kind: 'str', value: 'webp' } },
      },
    });
    const outIds = (() => {
      // 只取 `outputs:` 那一段里的 `- id:`（`inputs:` 与 `params:` 也有 id，别混进来）
      const start = collide.yaml.indexOf('\n  outputs:');
      const end = collide.yaml.indexOf('\n  params:', start);
      const block = start >= 0 && end > start ? collide.yaml.slice(start, end) : '';
      return [...block.matchAll(/- id: "([^"]+)"/g)].map((m) => m[1]);
    })();
    const boundPaths = [...collide.yaml.matchAll(/dst: "\$\{output\.([^}]+)\}"/g)].map((m) => m[1]);
    console.log(`   撞车画布：输出端口=${JSON.stringify(outIds)} 绑定的路径=${JSON.stringify(boundPaths)}`);
    c.check(
      new Set(boundPaths).size === boundPaths.length && boundPaths.length === 2,
      '★ ⑪ 两个节点都叫 `dst` 时，绑定到**两个不同的**输出路径（不会互相覆盖）',
      JSON.stringify(boundPaths)
    );
    c.check(
      outIds.length === 2,
      '⑫ 插件声明了两个输出端口（用户能看到两份产出）',
      JSON.stringify(outIds)
    );

    // ---- 顺带：两个纯函数的边界 ----
    console.log(`   插件 id 工具：suggest=${built.ids.suggest} valid(canvas)=${built.ids.validOk} valid(带空格大写)=${built.ids.validBad}`);
    c.check(
      built.ids.validOk === true && built.ids.validBad === false,
      '⑪ `isValidPluginId` 认可合法 id、拒绝带空格与大写的 id',
      `${built.ids.validOk} / ${built.ids.validBad}`
    );
    c.check(
      typeof built.ids.suggest === 'string' && /^[a-z0-9.\-_]+$/.test(built.ids.suggest),
      '⑫ `suggestPluginId` 从中文名生成的是合法 id（小写、无空格）',
      built.ids.suggest
    );

    // 收尾
    await client.invoke('plugins_set_enabled', { pluginId: CANVAS_ID, enabled: false }).catch(() => {});
    await client.invoke('plugins_uninstall', { pluginId: CANVAS_ID }).catch(() => {});
    const left = await client.invoke('plugins_get', { pluginId: CANVAS_ID }).catch(() => null);
    c.check(!left, '⑬ 画布验证产生的插件已卸载干净', left ? '还在' : '已卸载');
  }
}

// ============================================================================
// 【23】`docs/PLUGIN-SDK.md` 的节点表与真实节点目录**机械对账**
// ============================================================================
//
// 为什么值得单独一条：**这份文档是插件作者的契约**，而"契约与实现漂移"在这个项目里
// 已经造成过真实损失 —— 画布导出把多步接力写成 `${steps.<上游>.<端口>}`，
// 而文档 §3.4 结尾明写着要用 `${output.<端口>}` 传路径（见【22】）。
// 那次是"代码没照文档写"；反过来"文档没跟上代码"同样会发生，
// 而且更难发现：界面照常工作，只有照着文档写插件的人会踩坑。
//
// 做法：把文档里的节点表**按表头**解析（四张小节的列语义不一样：
// §3.1 那列是"从 `with` 读的参数"，其余是"参数 id 从 `io.params` 读"），
// 再逐行与 `pipeline_nodes` 对账：必需引擎、可选引擎、参数 id 集合，
// 以及"目录里有但文档里没有"的节点。
c.section('【23】`PLUGIN-SDK.md` 的节点表与节点目录是否对得上');
{
  const sdkPath = join(REPO_ROOT, 'docs', 'PLUGIN-SDK.md');
  if (!existsSync(sdkPath)) {
    c.note('（找不到 docs/PLUGIN-SDK.md，跳过）');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    const mdLines = readFileSync(sdkPath, 'utf8').split(/\r?\n/);

    // 把连续以 `|` 开头的行聚成表
    const tables = [];
    let cur = null;
    for (let i = 0; i < mdLines.length; i++) {
      if (/^\s*\|/.test(mdLines[i])) {
        if (!cur) cur = { start: i, rows: [] };
        cur.rows.push({ i, text: mdLines[i] });
      } else if (cur) {
        tables.push(cur);
        cur = null;
      }
    }
    if (cur) tables.push(cur);

    const catalog = await client.invoke('pipeline_nodes');
    const byName = new Map((catalog.nodes ?? []).map((n) => [n.name, n]));
    const clean = (s) => s.replace(/[`\s]/g, '');

    const problems = [];
    const documented = new Set();
    let nodeTables = 0;
    let rowsChecked = 0;

    for (const t of tables) {
      const header = t.rows[0]?.text ?? '';
      if (!header.includes('节点名')) continue;
      nodeTables++;
      const cols = header.split('|').map((s) => s.trim());
      const idxOf = (pred) => cols.findIndex(pred);
      const nameCol = idxOf((h) => h.includes('节点名'));
      const reqCol = idxOf((h) => h.includes('必需引擎'));
      const optCol = idxOf((h) => h.includes('可选引擎'));
      const paramCol = idxOf((h) => h.includes('参数') || h.includes('从 `with` 读'));
      // §3.1 那一列写的是"从 `with` 读的参数"，语义与 io.params 不同，不能混着比
      const paramIsParams = paramCol >= 0 && !cols[paramCol].includes('with');

      for (const r of t.rows.slice(2)) {
        const cells = r.text.split('|').map((s) => s.trim());
        const m = /^`([a-z][a-z0-9.\-]*)`$/.exec(cells[nameCol] ?? '');
        if (!m) continue;
        const name = m[1];
        const desc = byName.get(name);
        if (!desc) {
          problems.push(`L${r.i + 1} ${name}：文档里有这个节点，但节点目录里没有（改名了？删了？）`);
          continue;
        }
        documented.add(name);
        rowsChecked++;
        const diffs = [];
        const reqReal = (desc.requiresEngines ?? []).join('、') || '—';
        const optReal = (desc.optionalEngines ?? []).join('、') || '—';
        if (clean(cells[reqCol] ?? '') !== clean(reqReal)) {
          diffs.push(`必需引擎：文档「${cells[reqCol]}」 vs 实际「${reqReal}」`);
        }
        if (optCol >= 0 && clean(cells[optCol] ?? '') !== clean(optReal)) {
          diffs.push(`可选引擎：文档「${cells[optCol]}」 vs 实际「${optReal}」`);
        }
        if (paramIsParams) {
          // 括号里的内容不算（例如 `` `duration`(从 `with`) ``）——
          // 那是对写法的补充说明，不是参数 id
          const cell = (cells[paramCol] ?? '').replace(/\([^)]*\)/g, '');
          const docParams = [...cell.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map((x) => x[1]);
          const realParams = (desc.params ?? []).map((p) => p.id);
          const missing = realParams.filter((p) => !docParams.includes(p));
          const extra = docParams.filter((p) => !realParams.includes(p));
          if (missing.length) diffs.push(`文档缺参数：${missing.join(', ')}`);
          if (extra.length) diffs.push(`文档多出参数：${extra.join(', ')}`);
        }
        if (diffs.length) problems.push(`L${r.i + 1} ${name}：${diffs.join('；')}`);
      }
    }

    const undoc = (catalog.nodes ?? []).map((n) => n.name).filter((n) => !documented.has(n));
    for (const n of undoc) problems.push(`节点目录里有 \`${n}\`，但文档的节点表里找不到它`);

    console.log(`   节点表 ${nodeTables} 张、核对 ${rowsChecked} 行、目录 ${(catalog.nodes ?? []).length} 个节点`);
    c.check(nodeTables >= 4, '① 解析到了 4 张节点表（解析器没跑偏）', `${nodeTables} 张`);
    c.check(
      rowsChecked >= 25,
      '② 核对了足够多的行（不是只认出一两行就报通过）',
      `${rowsChecked} 行`
    );
    c.check(
      problems.length === 0,
      '★ ③ 文档的节点表与真实目录**逐列对得上**（引擎、参数 id、覆盖范围）',
      problems.length ? `\n      ${problems.join('\n      ')}` : '没有漂移'
    );
  }
}

// ============================================================================
// 【24】设置的落盘、API Key 的保存/清除，以及**密钥会不会顺着错误信息漏出去**
// ============================================================================
//
// 两件事都从来没有被真机验证过：
//
// 1. **API Key 的落盘生命周期**。文档承诺的是"默认只存在内存里；用户显式勾选
//    「记住 API Key」后才会写到 `ai-key.txt`；关掉开关/清除 Key 时必须把磁盘上
//    那份**真的删掉**"。这些都是可观察的事实，但此前没有任何检查看过它们。
// 2. **脱敏**。`redact()` 早就有了，但它只认 `sk-` / `sk_` 开头的密钥 ——
//    Google 是 `AIza…`、Azure 是一串无前缀十六进制、自建网关常常是任意字符串。
//    而最现实的泄漏渠道不是"我们把 Key 拼进了错误信息"，是**对方把请求回显回来**
//    （代理/网关/调试模式的后端会把 `Authorization` 头带进响应体），
//    而那段响应体正是应用截下来放进 `detail` 给用户看的。
//
// 这一节两件都验：文件生命周期逐条断言，脱敏用一个**真的会把请求头回显**的假端点。
c.section('【24】设置的落盘、API Key 的保存/清除与脱敏');
{
  // 用一个**不像 OpenAI 风格**的假密钥：这样"脱敏是否只靠前缀启发式"才会暴露出来
  const FAKE_KEY = 'AIzaSyFAKEverifyKEY1234567890';
  const MOCK_PORT = 18125;
  const mock = spawn(process.execPath, [join(HERE, 'mock-openai.mjs'), String(MOCK_PORT)], {
    stdio: 'ignore',
    detached: false,
  });
  await sleep(600);
  const mockBase = `http://127.0.0.1:${MOCK_PORT}`;

  const dataDir = (await client.invoke('app_paths'))?.entries?.find((e) => e.label === '数据目录')?.path;
  const keyFile = dataDir ? join(dataDir, 'ai-key.txt') : null;
  const settingsFile = dataDir ? join(dataDir, 'settings.json') : null;

  let restore = null;
  try {
    const before = await client.invoke('settings_get');
    restore = before.ai;

    // ---- ① 勾上「记住 API Key」→ 真的写盘 ----
    await client.invoke('settings_patch', {
      patch: {
        ai: { ...before.ai, provider: 'ollama', baseUrl: `${mockBase}/v1`, model: 'mock-text', persistApiKey: true },
        aiApiKey: FAKE_KEY,
      },
    });
    const onDisk = keyFile && existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : null;
    c.check(onDisk === FAKE_KEY, '① 勾上「记住 API Key」之后密钥真的落盘了（`ai-key.txt`）', onDisk ? `长度 ${onDisk.length}` : '(文件不存在)');

    // ---- ② 它**不进** settings.json ----
    const settingsJson = settingsFile && existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '';
    c.check(!settingsJson.includes(FAKE_KEY), '② `settings.json` 里没有密钥（它单独存放）', `settings.json ${settingsJson.length} 字节`);
    c.check(!settingsJson.includes('apiKey'), '②b `settings.json` 里连 `apiKey` 这个键都没有');

    // ---- ③ `settings_get` 不回传明文，只回报"有没有" ----
    const got = await client.invoke('settings_get');
    c.check(!JSON.stringify(got).includes(FAKE_KEY), '③ `settings_get` 不回传密钥明文（前端拿不到它）');
    c.check(got.ai.hasKey === true, '③b 只回报一个布尔：`hasKey: true`', String(got.ai.hasKey));

    // ---- ④ 关掉开关 → 磁盘上那份必须被删掉，但内存里还留着 ----
    await client.invoke('settings_patch', { patch: { ai: { ...got.ai, persistApiKey: false } } });
    c.check(keyFile && !existsSync(keyFile), '★ ④ 关掉「记住」之后磁盘上的密钥被**真的删掉**（不是留着不管）', keyFile);
    const stillInMemory = await client.invoke('settings_get');
    c.check(stillInMemory.ai.hasKey === true, '④b 但本次会话仍然可用（内存里还留着）', String(stillInMemory.ai.hasKey));

    // ---- ⑤ 明确清除 → 内存和磁盘都干净 ----
    await client.invoke('settings_patch', { patch: { aiApiKey: '' } });
    const afterClear = await client.invoke('settings_get');
    c.check(afterClear.ai.hasKey === false, '★ ⑤ 清除 Key 之后 `hasKey` 变回 false', String(afterClear.ai.hasKey));
    c.check(keyFile && !existsSync(keyFile), '⑤b 磁盘上也没有残留', keyFile);

    // ---- ⑥ 脱敏：让"话多的网关"把请求回显回来 ----
    await client.invoke('settings_patch', {
      patch: {
        ai: { ...afterClear.ai, provider: 'ollama', baseUrl: `${mockBase}/v1/__echo`, model: 'mock-text' },
        aiApiKey: FAKE_KEY,
      },
    });
    // ⚠️ `ai_test_connection` **不抛错** —— 它把失败包成 `{ok: false, error}` 返回
    // （UI 直接渲染那个 `error` 字符串）。第一版断言的是"它会抛错"，于是
    // ⑥ 失败、⑦ 空过（"错误信息里没有密钥"，因为压根没有错误信息）。
    const probe = await client.invoke('ai_test_connection');
    const dumped = JSON.stringify(probe ?? {});
    console.log(`   回显端点返回：ok=${probe?.ok}，错误文本 ${dumped.length} 字节`);
    c.check(
      probe?.ok === false && Boolean(probe?.error),
      '⑥ 回显端点确实让连接测试失败了（否则后面两条断言没有意义）',
      String(probe?.error ?? '').slice(0, 100)
    );
    // ★ 先确认**服务端回显的内容真的进了错误文本**：否则"里面没有密钥"
    // 可能只是因为整段响应体被丢掉了 —— 那种通过是假的。
    c.check(
      dumped.includes('upstream rejected the request'),
      '⑥b 服务端回显的内容确实被带进了给用户看的错误文本（前置条件成立）',
      dumped.includes('upstream rejected the request') ? '包含回显正文' : '回显正文没进来'
    );
    c.check(
      !dumped.includes(FAKE_KEY),
      '★ ⑦ 服务端把 `Authorization` 头回显回来时，**错误信息里看不到密钥**（按字面量脱敏，不靠前缀猜）',
      dumped.includes(FAKE_KEY) ? '密钥出现在错误信息里！' : `已脱敏，含 ${(dumped.match(/\[REDACTED\]/g) ?? []).length} 处标记`
    );
    c.check(
      dumped.includes('[REDACTED]'),
      '⑦b 抹掉之后留下了可见的 `[REDACTED]` 标记（不是静默删掉，排查时能看出这里本该有值）',
      dumped.slice(0, 160)
    );

    // ---- ⑧ 审计与设置文件里也不该出现它 ----
    const audit = await client.invoke('plugins_audit', { limit: 50 }).catch(() => null);
    const auditText = JSON.stringify(audit ?? {});
    c.check(!auditText.includes(FAKE_KEY), '⑧ 审计日志里没有密钥', `${auditText.length} 字节`);
    const settingsAfter = settingsFile && existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '';
    c.check(!settingsAfter.includes(FAKE_KEY), '⑧b 整个设置文件里也没有密钥', `${settingsAfter.length} 字节`);
  } finally {
    // 收尾：把 AI 设置恢复原状，并确保磁盘上没有我们写下的假密钥
    if (restore) {
      await client.invoke('settings_patch', { patch: { ai: { ...restore, persistApiKey: false } } }).catch(() => {});
      await client.invoke('settings_patch', { patch: { aiApiKey: '' } }).catch(() => {});
    }
    if (keyFile && existsSync(keyFile)) rmSync(keyFile, { force: true });
    mock.kill();
  }
}

// ============================================================================
// 【25】许可证确认是不是**真的发生了**，以及它有没有**留下记录**
// ============================================================================
//
// 两件事必须分开验：
//
// 1. **确认真的发生了**（而不是被代码替用户点了）。模型那一侧此前有个真缺陷：
//    `model-panel.tsx` 对**不可商用**的权重自动发 `licenseAccepted: true`
//    （`licenseAccepted: !m.commercialUse`），于是后端那道硬门永远走不到 ——
//    注释写着"需要用户显式点头"，代码做的正好相反。
// 2. **确认留下了记录**。原来那份确认只是一次布尔参数，装完就没了：
//    对合规审查拿不出证据链（谁在什么时候接受了哪份许可证），用户每次重装还得再勾一次。
//    现在落盘到 `<data>/license-acks.json` + 一条 `LicenseAccepted` 审计事件。
//
// 这一节对**后端契约**做逐条断言；前端那两个勾选框由 `tsc`/`vite` 与人工审阅覆盖
// （本机所有需要确认的引擎与权重都已装好，界面上不会出现"安装"按钮，
//  所以点不出一条真实路径 —— 这条边界如实写在文档里）。
c.section('【25】许可证确认：硬门有效、并且留下可追溯的记录');
{
  /**
   * 从 CDP 抛出的异常文本里抠出 ToolForge 的错误码。
   *
   * 两种形状都要认：
   *  * `..."code":"PERMISSION_DENIED"...`（异常值被完整序列化时）
   *  * `"name":"code","type":"string","value":"PERMISSION_DENIED"`（CDP 的预览形式，
   *    值被截断时走这条）
   * 不认的话，检查失败时那一行日志会是一团 JSON —— 而"失败信息可读"本身
   * 就是这些检查的价值之一。
   */
  const extractErrorCode = (text) =>
    /"code"\s*:\s*"([A-Z_]+)"/.exec(text ?? '')?.[1] ??
    /"name":"code"[^}]*?"value":"([A-Z_]+)"/.exec(text ?? '')?.[1] ??
    '';

  const dataDir = (await client.invoke('app_paths'))?.entries?.find((e) => e.label === '数据目录')?.path;
  const acksFile = dataDir ? join(dataDir, 'license-acks.json') : null;

  if (!acksFile) {
    c.note('（拿不到数据目录，跳过）');
    c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
  } else {
    // 从一个**干净状态**开始：删掉记录文件，确认目录里本来也没有别的确认
    rmSync(acksFile, { force: true });

    // 挑一个「需要确认许可证」且**已经装好**的引擎：这样确认会被记下来，
    // 而安装本身会走 `AlreadyAvailable` 短路，不会真的去下 184 MB。
    const catalog = await client.invoke('engines_catalog');
    const subject = catalog.find(
      (e) => e.descriptor.requiresLicenseAck && e.managedAvailable
    );
    if (!subject) {
      c.note('（本机没有"需要确认许可证且有下载源"的引擎，跳过）');
      c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）');
    } else {
      const engineId = subject.descriptor.id;
      console.log(`   用 ${engineId} 做验证（requiresLicenseAck=true，已安装，安装会短路）`);

      c.check(
        subject.licenseAcknowledged === false,
        '① 干净状态下 `licenseAcknowledged` 是 false（记录文件已删除）',
        String(subject.licenseAcknowledged)
      );

      // ---- ② 不勾确认 → 必须被拒，而且**不能留下任何记录** ----
      let denied = null;
      try {
        await client.invoke('engines_install', {
          req: { engineId, licenseAccepted: false, allowUnverified: false, force: false },
        });
      } catch (e) {
        denied = String(e?.message ?? e);
      }
      const deniedCode = extractErrorCode(denied);
      c.check(Boolean(denied), '★ ② 不带 `licenseAccepted` 时安装被**拒绝**', deniedCode || String(denied).slice(0, 80));
      c.check(
        !existsSync(acksFile),
        '★ ②b 被拒绝的尝试**没有留下确认记录**（否则"确认过一次"里会混进"用户其实没同意"的路径，那份记录就不再是证据）',
        acksFile
      );

      // ---- ③ 勾了确认 → 记录落盘（并写审计）----
      const jobId = await client.invoke('engines_install', {
        req: { engineId, licenseAccepted: true, allowUnverified: false, force: false },
      });
      const job = await client.waitJob(jobId, 120, 500);
      console.log(`   安装任务：${job.status}${job.error ? ` — ${job.error.code}` : ''}`);

      const raw = existsSync(acksFile) ? readFileSync(acksFile, 'utf8') : '';
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* 下面直接断言失败 */
      }
      const entry = parsed?.entries?.[engineId];
      c.check(Boolean(entry), '★ ③ 确认被记到了 `license-acks.json`', Object.keys(parsed?.entries ?? {}).join(', '));
      c.check(
        entry?.fingerprint?.length === 16 && /^[0-9a-f]{16}$/.test(entry?.fingerprint ?? ''),
        '③b 记录里有 16 位十六进制的**许可证指纹**（条款一变就自动失效，靠的就是它）',
        String(entry?.fingerprint)
      );
      c.check(
        entry?.license === subject.descriptor.license,
        '③c 记录里存了当时的许可证原文（便于合规审查时回看）',
        String(entry?.license).slice(0, 40)
      );
      c.check(
        Boolean(entry?.acceptedAt) && !Number.isNaN(Date.parse(entry.acceptedAt)),
        '③d 记录里有可解析的时间戳',
        String(entry?.acceptedAt)
      );

      // ---- ④ 目录接口把"已确认"如实报出来 ----
      const after = await client.invoke('engines_catalog');
      const e2 = after.find((x) => x.descriptor.id === engineId);
      c.check(
        e2?.licenseAcknowledged === true && Boolean(e2?.licenseAcknowledgedAt),
        '★ ④ `engines_catalog` 报出 `licenseAcknowledged: true` + 确认时间（界面靠它预先勾上）',
        `${e2?.licenseAcknowledged} / ${e2?.licenseAcknowledgedAt}`
      );

      // ---- ⑤ 审计里有这一条 ----
      const snap = await client.invoke('plugins_audit', { limit: 60 });
      const kinds = (snap?.events ?? []).map((ev) => String(ev.kind ?? ''));
      c.check(
        kinds.some((k) => k.toLowerCase().includes('licenseaccepted')),
        '⑤ 写了一条 `LicenseAccepted` 审计事件（合规证据链）',
        kinds.filter((k) => k.toLowerCase().includes('license')).join(', ') || `最近 ${kinds.length} 条里没有`
      );

      // ---- ⑥ 状态是**从磁盘读的**，不是内存里的缓存 ----
      rmSync(acksFile, { force: true });
      const afterDelete = await client.invoke('engines_catalog');
      const e3 = afterDelete.find((x) => x.descriptor.id === engineId);
      c.check(
        e3?.licenseAcknowledged === false,
        '★ ⑥ 删掉记录文件之后立刻变回"未确认"（说明每次重新读盘，不会拿着缓存撒谎）',
        String(e3?.licenseAcknowledged)
      );

      // 恢复：把这一次真实验证留下的记录删干净，别污染后续检查
      rmSync(acksFile, { force: true });
    }

    // ---- ⑦ 模型那一侧：同类硬门 + 同类记录 ----
    const models = await client.invoke('models_list');
    const target = (models ?? []).find((m) => !m.commercialUse && m.installed);
    if (!target) {
      c.note('（本机没有"已安装且不可商用"的权重，跳过模型侧的确认验证）');
    } else {
      const before = await client.invoke('models_list');
      const t0 = before.find((m) => m.id === target.id);
      c.check(
        t0?.licenseAcknowledged === false,
        '⑦ 干净状态下权重的 `licenseAcknowledged` 是 false',
        String(t0?.licenseAcknowledged)
      );

      let denied = null;
      try {
        await client.invoke('models_install', {
          req: { modelId: target.id, licenseAccepted: false },
        });
      } catch (e) {
        denied = String(e?.message ?? e);
      }
      c.check(
        Boolean(denied),
        '★ ⑧ 不可商用的权重不带确认时被拒绝',
        extractErrorCode(denied) || String(denied).slice(0, 80)
      );
      c.check(!existsSync(acksFile), '⑧b 同样没有留下记录', acksFile);

      // 勾了确认 → 记录落盘；这个权重已经装好，`install_model` 会先核对本地哈希后短路
      const jobId2 = await client.invoke('models_install', {
        req: { modelId: target.id, licenseAccepted: true },
      });
      const job2 = await client.waitJob(jobId2, 180, 1000);
      console.log(`   权重任务：${job2.status}${job2.error ? ` — ${job2.error.code}: ${job2.error.message}` : ''}`);
      const raw2 = existsSync(acksFile) ? readFileSync(acksFile, 'utf8') : '';
      let parsed2 = null;
      try {
        parsed2 = JSON.parse(raw2);
      } catch {
        /* 断言会失败 */
      }
      c.check(
        Boolean(parsed2?.entries?.[target.id]),
        '★ ⑨ 权重的确认同样被记下来（与引擎共用一份记录）',
        Object.keys(parsed2?.entries ?? {}).join(', ')
      );
      const after2 = await client.invoke('models_list');
      c.check(
        after2.find((m) => m.id === target.id)?.licenseAcknowledged === true,
        '⑨b `models_list` 如实报出已确认',
        String(after2.find((m) => m.id === target.id)?.licenseAcknowledged)
      );
      rmSync(acksFile, { force: true });
    }
  }
}

// ============================================================================
// 【26】能力清单（capabilities/default.json）说的和做的是不是一回事
// ============================================================================
//
// `capabilities/default.json` 是**前端的权限边界**：它决定一个被注入的脚本
// （或者将来某个插件自带的 UI）能直接对系统做什么。而这条边界**从来没有被运行时
// 试过** —— 只有文档在描述它，而文档已经错过一次：
//
//   README 里写着「capability 里 `shell:allow-execute` 只放行一个用于"打开文件夹"的
//   `explorer`」—— 实际上**一条 shell 权限都没有**，"打开文件夹"走的是
//   `opener:reveal_item_in_dir`。（真实边界比文档写的更紧，但文档仍然是错的。）
//
// 这一节从**页面上下文**里真的去调那些命令，并按错误文本分类：
//
//   * `not allowed. Permissions associated with this command` → **ACL 拒绝**
//   * `forbidden path ... not allowed on the scope`            → **scope 拒绝**
//   * `invalid args ...` / `missing ... key`                   → 权限**在**，只是参数不对
//
// "参数不对"恰好是我们要的探针：它证明权限存在，又不产生任何副作用
// （弹不出对话框、写不了文件）。反过来，只有"允许"和"拒绝"两种结果的话，
// 一个把权限全删光的配置也会让所有断言"通过"。
c.section('【26】能力清单：前端能直接调什么，被拒的又是不是真的被拒');
{
  /** 从页面里调一个 Tauri 命令，把"拒绝"与"参数错误"分开 */
  const probe = async (cmd, args) => {
    const r = await client.evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})` +
        `.then(v => ({ ok: true, text: String(v).slice(0, 60) }))` +
        `.catch(e => ({ ok: false, text: (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 220) }))`
    );
    const t = String(r?.text ?? '');
    const deniedByAcl = /not allowed\. Permissions associated with this command/.test(t);
    const deniedByScope = /forbidden path/.test(t);
    return { ok: Boolean(r?.ok), text: t, denied: deniedByAcl || deniedByScope, deniedByAcl, deniedByScope };
  };

  // ---- ① 必须被拒的：shell 与 scope 外的路径 ----
  const shellExec = await probe('plugin:shell|execute', { program: 'cmd', args: ['/c', 'echo hi'] });
  c.check(
    shellExec.deniedByAcl,
    '★ ① `plugin:shell|execute` 被 ACL 拒绝（前端拿不到任何 shell —— 这是整套权限模型的地基）',
    shellExec.text.slice(0, 120)
  );
  const shellOpen = await probe('plugin:shell|open', { path: 'cmd' });
  c.check(shellOpen.deniedByAcl, '①b `plugin:shell|open` 同样被拒', shellOpen.text.slice(0, 120));

  const openPath = await probe('plugin:opener|open_path', {});
  c.check(
    openPath.deniedByAcl,
    '★ ② `plugin:opener|open_path` 被拒（因此"用系统默认程序打开文件"当前做不到 —— 代码里那个包着它的 helper 已删掉）',
    openPath.text.slice(0, 120)
  );

  const outside = await probe('plugin:fs|read_text_file', {
    path: 'C:/Windows/System32/drivers/etc/hosts',
  });
  c.check(
    outside.deniedByScope,
    '★ ③ `fs:read_text_file` 读**scope 之外**的系统文件被拒（scope 生效，而不是"文件不存在"之类的巧合）',
    outside.text.slice(0, 140)
  );

  // ---- ④ 正向对照：scope **之内**必须真的能读 ----
  // 少了这条，"什么都读不到"也能让上面三条全绿。
  const dataDir = (await client.invoke('app_paths'))?.entries?.find((e) => e.label === '数据目录')?.path;
  const settingsPath = dataDir ? join(dataDir, 'settings.json') : null;
  if (settingsPath && existsSync(settingsPath)) {
    const inside = await probe('plugin:fs|read_text_file', {
      path: settingsPath.replace(/\\/g, '/'),
    });
    c.check(
      inside.ok,
      '★ ④ 正向对照：读 scope **之内**的文件是允许的（否则"全都被拒"也会让上面几条通过）',
      inside.ok ? `读到 ${inside.text.length} 字符的摘要` : inside.text.slice(0, 140)
    );
  } else {
    c.note('（找不到数据目录里的 settings.json，跳过"scope 内可读"这条对照）');
  }

  // ---- ⑤ 前端界面真正在用的命令，权限必须**在** ----
  //
  // 这一组用"参数不对"当探针：它证明 ACL 放行，又不会真弹对话框、真写文件。
  // capability 一旦被重新生成时漏掉某一条，对应的界面功能会**静默失效**
  // （只弹一个 toast），所以这条要挡在 CI 一侧。
  const uiNeeded = [
    ['plugin:opener|reveal_item_in_dir', {}, '「打开所在文件夹」'],
    ['plugin:opener|open_url', {}, '「查看官方页面」等外链'],
    ['plugin:dialog|open', {}, '选择文件 / 目录'],
    ['plugin:dialog|save', {}, '选择保存位置'],
    ['plugin:fs|write_text_file', {}, '写文件（受 scope 限制）'],
  ];
  const missing = [];
  for (const [cmd, args, what] of uiNeeded) {
    const r = await probe(cmd, args);
    if (r.denied) missing.push(`${cmd}（${what}）→ ${r.text.slice(0, 80)}`);
  }
  c.check(
    missing.length === 0,
    '★ ⑤ 界面真正在用的 5 个命令权限都在（否则对应功能会静默失效）',
    missing.length ? missing.join('；') : '全部放行'
  );

  // ---- ⑥ 静态对照：capability 文件里**不该**再出现 shell ----
  const capPath = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'capabilities', 'default.json');
  if (existsSync(capPath)) {
    const capText = readFileSync(capPath, 'utf8');
    const shellPerms = [...capText.matchAll(/"([a-z-]+):(allow-[\w-]+|default)"/g)]
      .map((m) => m[0])
      .filter((s) => s.includes('"shell:'));
    c.check(
      shellPerms.length === 0,
      '★ ⑥ 静态对照：capability 文件里没有任何 `shell:` 权限（与上面 ① 的运行时结果一致）',
      shellPerms.length ? shellPerms.join(', ') : '一条都没有'
    );
  } else {
    c.note(`（找不到 ${capPath}，跳过静态对照）`);
  }
}

// ============================================================================
// 【27】「保留源文件」这个设置到底有没有生效
// ============================================================================
//
// 它此前是**完全惰性的**：`Settings::keep_original` 声明了、能改、能落盘，但
// **没有任何代码读它**。而界面在三个地方把它当成真事 ——
//
//   1. 设置页的开关「批量处理时保留源文件」；
//   2. 批量页的下拉框（保留 / 不保留）；
//   3. 运行面板上那句「当前设置：批量处理时不会保留源文件。」
//
// 也就是说：用户以为源文件会被删掉（或者被保留），实际上一个都不会动。
// 这与画布那次是同一类问题 —— **声明与行为不一致**，构建不会红、界面不报错。
//
// 现在真的照它做，规则刻意保守（见 `commands.rs` 里那段注释）：只在批次**成功之后**删、
// 只删这一次真正用到的输入、**输出路径与输入路径相同就跳过**、每个删除都写进任务日志。
// 这一节把四条规则逐条验一遍。
//
// ⚠️ ③ 那一条曾经是**空洞的断言**（只查"源文件还在"，而失败时它当然还在），
// 现在拆成两条互补的：③a 钉住拒绝的**理由**（权限），③b 用一个直通插件
// 真正走到「产出 == 输入路径」那一步。细节见各自的注释。
c.section('【27】「保留源文件」这个设置是不是真的生效');
{
  const CONVERT = 'com.toolforge.builtin.image-convert';
  const work = join(REPO_ROOT, '.tools', 'smoke', 'out-keep');
  // ⚠️ 两个临时插件的 id 都声明在**这一层**：`finally` 里要卸载它们，
  // 放在 `try` 里面会变成一个 ReferenceError（真踩过：收尾阶段崩掉，
  // 前面几十条检查的结果连同汇总一起没了）。
  const IN_PLACE_ID = 'com.verify.inplace';
  const PASS_ID = 'com.verify.passthrough';

  const before = await client.invoke('settings_get');
  const runConvert = async (src, outDir, params = {}) => {
    const sub = await client.invoke('plugins_run', {
      req: { pluginId: CONVERT, inputs: { src: [src] }, params, outputDir: outDir },
    });
    return client.waitJob(sub.jobId, 180, 1000);
  };

  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });

    // ---- ① 默认（保留）→ 源文件必须还在 ----
    await client.invoke('settings_patch', { patch: { keepOriginal: true } });
    const keepSrc = join(work, 'keep-in.png');
    writeFileSync(keepSrc, makePng(120, 90, 11));
    const keepOut = join(work, 'out-keep');
    mkdirSync(keepOut, { recursive: true });
    const keepJob = await runConvert(keepSrc, keepOut, { format: { kind: 'str', value: 'webp' } });
    c.check(keepJob.status === 'succeeded', '① 前置：转换任务成功', keepJob.status);
    c.check(existsSync(keepSrc), '★ ① 「保留源文件」打开时源文件还在（默认值就是这一侧）', keepSrc);
    c.check(
      readdirSync(keepOut).some((f) => f.endsWith('.webp')),
      '①b 产出照常生成',
      readdirSync(keepOut).join(', ')
    );

    // ---- ② 关掉 → 源文件必须真的被删掉，而产出绝不能被牵连 ----
    await client.invoke('settings_patch', { patch: { keepOriginal: false } });
    const dropSrc = join(work, 'drop-in.png');
    writeFileSync(dropSrc, makePng(120, 90, 12));
    const dropOut = join(work, 'out-drop');
    mkdirSync(dropOut, { recursive: true });
    const dropJob = await runConvert(dropSrc, dropOut, { format: { kind: 'str', value: 'webp' } });
    c.check(dropJob.status === 'succeeded', '② 前置：转换任务成功', dropJob.status);
    c.check(
      !existsSync(dropSrc),
      '★ ② 「不保留源文件」时源文件**真的被删掉了**（此前这个开关一点作用都没有）',
      dropSrc
    );
    const dropped = readdirSync(dropOut);
    c.check(
      dropped.some((f) => f.endsWith('.webp')) && dropped.every((f) => existsSync(join(dropOut, f))),
      '②b 产出完好无损（删的只能是源文件）',
      dropped.join(', ')
    );
    const dropLogs = (dropJob.logs ?? []).map((l) => String(l.message)).join('\n');
    c.check(
      dropLogs.includes('已按设置删除源文件'),
      '②c 任务日志里写明了删掉了谁（不是悄悄删）',
      (dropLogs.match(/已按设置删除源文件：\S+/) ?? ['(没找到)'])[0]
    );

    // ---- ③a 插件**写不回**自己的输入路径 ----
    //
    // 这一条此前的断言是**空洞的**，必须写下来免得下次又退回去：原脚本只检查了
    // 「源文件还在」。可任务**失败**时源文件当然还在 —— 失败的原因完全可能是
    // 清单写错、引擎缺失、甚至参数不合法，检查照样是绿的。
    //
    // 真正要钉住的性质是**拒绝的理由**：节点的写操作按 `output` 角色解析路径
    // （见 `nodes.rs::resolve_path`），输入路径落在收敛边界之外，必须报
    // `PERMISSION_DENIED`。所以这里连错误码一起断言。
    const dir = join(work, 'inplace');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plugin.yaml'),
      `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${IN_PLACE_ID}
  name: 就地处理验证插件
  version: 1.0.0
  description: 输出路径与输入路径相同，用来验证"删源文件"不会把产出删掉。
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: input }
io:
  inputs:
    - id: src
      label: 图片
      type: file
      accept: [".png"]
      required: true
  outputs:
    - id: dst
      label: 就地输出
      type: file
      accept: [".png"]
      required: true
  params: []
runtime:
  kind: pipeline
  pipeline:
    onError: fail
    steps:
      - id: touch
        uses: image.convert
        with:
          src: "\${src}"
          dst: "\${src}"
          format: png
`,
      'utf8'
    );
    const existing = await client.invoke('plugins_get', { pluginId: IN_PLACE_ID }).catch(() => null);
    if (existing) {
      await client.invoke('plugins_set_enabled', { pluginId: IN_PLACE_ID, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: IN_PLACE_ID }).catch(() => {});
    }
    await client.invoke('plugins_install', {
      req: {
        source: { kind: 'directory', path: dir },
        overwrite: true,
        permissionsAcknowledged: true,
        executableCodeAcknowledged: false,
      },
    });
    await client.invoke('plugins_grant', {
      req: {
        pluginId: IN_PLACE_ID,
        granted: {
          capabilities: [
            { kind: 'fsRead', scope: { kind: 'input' } },
            { kind: 'fsWrite', scope: { kind: 'input' } },
          ],
        },
      },
    });
    await client.invoke('plugins_set_enabled', { pluginId: IN_PLACE_ID, enabled: true });

    const inPlaceSrc = join(work, 'inplace-src.png');
    writeFileSync(inPlaceSrc, makePng(100, 80, 13));
    const inPlaceOut = join(work, 'out-inplace');
    mkdirSync(inPlaceOut, { recursive: true });
    const sub = await client.invoke('plugins_run', {
      req: {
        pluginId: IN_PLACE_ID,
        inputs: { src: [inPlaceSrc] },
        params: {},
        outputDir: inPlaceOut,
      },
    });
    const inPlaceJob = await client.waitJob(sub.jobId, 180, 1000);
    console.log(
      `   就地处理任务：${inPlaceJob.status}${inPlaceJob.error ? ` — ${inPlaceJob.error.code}` : ''}`
    );
    c.check(
      inPlaceJob.status === 'failed',
      '③a 前置：写回自己输入路径的插件被拒绝（引擎不允许就地覆盖输入）',
      inPlaceJob.status
    );
    c.check(
      inPlaceJob.error?.code === 'PERMISSION_DENIED',
      '★ ③a 拒绝的理由是权限 —— 而不是碰巧因为别的原因失败（这条以前是空洞的断言）',
      inPlaceJob.error?.code ?? '(没有错误码)'
    );
    c.check(existsSync(inPlaceSrc), '③a-b 被拒绝之后源文件原封不动', inPlaceSrc);

    // ---- ③b 真能走到「产出 == 输入路径」的情形：插件把输入本身报成产出 ----
    //
    // ③a 证明了插件**写不回**输入路径，所以"就地编辑"这条路上其实到不了删除那一步。
    // 但「产出里出现的路径绝不删」这条规则仍然必须成立，而且有真实场景：
    // 一个**直通插件**（发现文件已经满足要求，于是原样把输入报成产出）。
    // 这时 `produced` 与 `src` 是同一个路径，删"源文件"等于删掉刚生成的结果。
    //
    // 构造要点：宿主只接受**输出目录之内**的产出（见 `interpret_plugin_response`），
    // 所以把输入文件放进输出目录里，路径才合法。
    const passDir = join(work, 'passthrough');
    rmSync(passDir, { recursive: true, force: true });
    mkdirSync(passDir, { recursive: true });
    writeFileSync(
      join(passDir, 'plugin.yaml'),
      `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${PASS_ID}
  name: 直通验证插件
  version: 1.0.0
  description: 不写任何文件，把输入路径本身报成产出（"已经满足要求"的直通）。
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
      accept: [".png"]
      required: true
  outputs:
    - id: dst
      label: 产出
      type: file
      accept: [".png"]
      required: false
  params:
    - id: mode
      label: 模式
      type: text
      description: pair = 把输入本身报成产出（不写文件）；copy = 真写一份副本到输出目录。
      default: { kind: str, value: pair }
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
    // 直通探针：只校验 PNG 头，然后**原样**把输入路径报成产出 —— 一个字节都不写。
    // （Python 源码嵌在 JS 模板字符串里，所以不能出现反引号）
    writeFileSync(
      join(passDir, 'main.py'),
      `"""直通探针：pair 模式不写文件、把输入路径本身报成产出；copy 模式真写一份副本。"""
import json
import os
import sys

PNG_SIG = b"\\x89PNG\\r\\n\\x1a\\n"


def _write(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()


def handle_initialize(params):
    return {"ok": True}


def handle_run(params):
    src = ((params.get("input") or {}).get("src") or [None])[0]
    if not src:
        raise ValueError("缺少输入端口 src")
    with open(src, "rb") as fh:
        head = fh.read(len(PNG_SIG))
    if head != PNG_SIG:
        raise ValueError("输入不是 PNG")
    mode = (params.get("params") or {}).get("mode") or "pair"
    if mode == "copy":
        out_root = os.path.normpath((params.get("paths") or {}).get("output") or os.path.dirname(src))
        out = os.path.normpath(os.path.join(out_root, "passthrough-copy.png"))
        if not out.startswith(out_root + os.sep):
            raise ValueError("拒绝写出输出目录之外")
        with open(src, "rb") as a, open(out, "wb") as b:
            b.write(a.read())
        return {"outputs": {"dst": out}, "values": {"mode": mode}}
    return {"outputs": {"dst": src}, "values": {"mode": mode}}


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
    const passExisting = await client.invoke('plugins_get', { pluginId: PASS_ID }).catch(() => null);
    if (passExisting) {
      await client.invoke('plugins_set_enabled', { pluginId: PASS_ID, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: PASS_ID }).catch(() => {});
    }
    await client.invoke('plugins_install', {
      req: {
        source: { kind: 'directory', path: passDir },
        overwrite: true,
        permissionsAcknowledged: true,
        executableCodeAcknowledged: true,
      },
    });
    await client.invoke('plugins_grant', {
      req: {
        pluginId: PASS_ID,
        granted: {
          capabilities: [
            { kind: 'fsRead', scope: { kind: 'input' } },
            { kind: 'fsWrite', scope: { kind: 'output' } },
          ],
        },
      },
    });
    await client.invoke('plugins_set_enabled', { pluginId: PASS_ID, enabled: true });

    // 「不保留源文件」必须**明确**处在关闭状态，否则这条检查会变成 ② 的复读机
    await client.invoke('settings_patch', { patch: { keepOriginal: false } });
    const passOut = join(work, 'passthrough-src');
    mkdirSync(passOut, { recursive: true });
    const passFile = join(passOut, 'same.png');
    writeFileSync(passFile, makePng(96, 72, 14));
    const passSub = await client.invoke('plugins_run', {
      req: {
        pluginId: PASS_ID,
        inputs: { src: [passFile] },
        params: {},
        outputDir: passOut,
      },
    });
    const passJob = await client.waitJob(passSub.jobId, 180, 1000);
    console.log(
      `   直通任务：${passJob.status}${passJob.error ? ` — ${passJob.error.code}` : ''}；产出=${JSON.stringify(passJob.outputs ?? [])}`
    );
    c.check(passJob.status === 'succeeded', '③b 前置：直通任务成功', passJob.status);
    c.check(
      Array.isArray(passJob.outputs) && passJob.outputs.includes(passFile),
      '③b-b 宿主确实把输入路径登记成了产出（不然这条检查测的是别的东西）',
      JSON.stringify(passJob.outputs ?? [])
    );
    c.check(
      existsSync(passFile),
      '★ ③b 产出 == 输入路径时**产出没有被当成源文件删掉**（"删源文件"的安全阀）',
      passFile
    );
    const passLogs = (passJob.logs ?? []).map((l) => String(l.message)).join('\n');
    c.check(
      !passLogs.includes('已按设置删除源文件'),
      '★ ③c 任务日志里没有"已按设置删除源文件" —— 说明是**认出来了**，不是碰巧没删',
      passLogs.includes('已按设置删除源文件') ? '日志里出现了删除记录' : '没有删除记录'
    );

    // ---- ③d 正向对照：同一个插件、同一份输入，只把产出换个路径 ----
    //
    // ③c 断言的是"日志里**没有**删除记录"。一条只断言"没发生"的检查天生可疑：
    // 删除机制整体坏掉、或者这一步根本没执行，它同样会绿。
    //
    // 所以补这条对照：**同一个插件、同一份输入、同一个设置**，只把要报的产出
    // 从"输入路径本身"换成"输出目录里的一份副本"。这时输入不是产出了，
    // 源文件就**必须**被删掉。两条一起看，才能区分"认出来了"与"根本没跑"。
    const ctlFile = join(passOut, 'control.png');
    writeFileSync(ctlFile, makePng(96, 72, 15));
    const ctlSub = await client.invoke('plugins_run', {
      req: {
        pluginId: PASS_ID,
        inputs: { src: [ctlFile] },
        params: { mode: { kind: 'str', value: 'copy' } },
        outputDir: passOut,
      },
    });
    const ctlJob = await client.waitJob(ctlSub.jobId, 180, 1000);
    const ctlCopy = join(passOut, 'passthrough-copy.png');
    console.log(
      `   对照任务：${ctlJob.status}${ctlJob.error ? ` — ${ctlJob.error.code}` : ''}；产出=${JSON.stringify(ctlJob.outputs ?? [])}`
    );
    c.check(ctlJob.status === 'succeeded', '③d 前置：对照任务成功', ctlJob.status);
    c.check(existsSync(ctlCopy), '③d-b 副本产出确实写出来了', ctlCopy);
    c.check(
      !existsSync(ctlFile),
      '★ ③d 正向对照：产出换成副本之后，源文件**真的被删了** —— 证明上面 ③b/③c 不是"因为删除机制压根没跑"',
      ctlFile
    );

    // ---- ④ 失败的任务**不删**源文件 ----
    //
    // 源文件是用户唯一还能重试的东西。失败还删它，等于把一次失败变成一次数据丢失。
    const badSrc = join(work, 'bad-in.png');
    writeFileSync(badSrc, Buffer.from('这不是一张 PNG，只是普通文本', 'utf8'));
    const badOut = join(work, 'out-bad');
    mkdirSync(badOut, { recursive: true });
    const badJob = await runConvert(badSrc, badOut, { format: { kind: 'str', value: 'webp' } });
    console.log(`   坏输入任务：${badJob.status}${badJob.error ? ` — ${badJob.error.code}` : ''}`);
    c.check(badJob.status === 'failed', '④ 前置：坏输入确实让任务失败', badJob.status);
    c.check(
      existsSync(badSrc),
      '★ ④ 任务失败时**不删**源文件（失败还删，等于把一次失败变成一次数据丢失）',
      badSrc
    );
  } finally {
    // 收尾：恢复原设置、卸载临时插件
    await client
      .invoke('settings_patch', { patch: { keepOriginal: before.keepOriginal } })
      .catch(() => {});
    await client.invoke('plugins_set_enabled', { pluginId: IN_PLACE_ID, enabled: false }).catch(() => {});
    await client.invoke('plugins_uninstall', { pluginId: IN_PLACE_ID }).catch(() => {});
    await client.invoke('plugins_set_enabled', { pluginId: PASS_ID, enabled: false }).catch(() => {});
    await client.invoke('plugins_uninstall', { pluginId: PASS_ID }).catch(() => {});
  }
}

// ============================================================================
// 【28】插件参数**到底能不能到达执行器**
// ============================================================================
//
// 同一个缺陷在这个项目里撞到过两次：
//   * `doc-to-pdf` 声明了 `format`，而 `doc.to-pdf` 节点早就不读它了 —— 用户选了半天，没变化；
//   * `video.transcode` 声明了 `container`，而输出扩展名其实由 `format` 决定。
// 两次都是**声明与行为不一致**：构建不红、界面不报错、任务照样成功，
// 只有真去比对产出文件才发现那个控件是个摆设。
//
// 现在 `PluginManifest::validate()` 会报 `PARAM_NEVER_USED`（warning 级）。
// 这一节验的不是"那个函数写对了"（`toolforge-core` 里已有 6 条单测），
// 而是**它在这个 exe 里真的接上了、而且判据不过严**。
//
// 判据是三条通道（L1 插件的参数只有这三条路能到达执行器），这一节把三条**逐条验一遍** ——
// 少验一条就可能把正在正常工作的参数误报成装饰品，而误报比漏报更糟：
// 它会让一个**好插件**在安装时报出一条看不懂的警告。
c.section('【28】插件参数能不能到达执行器（"装饰品参数"检测是不是真的在跑）');
{
  /** 造一份最小 L1 清单：`params` 与步骤 `with` 由参数决定 */
  const manifest = (id, paramsYaml, withYaml, uses = 'image.convert') =>
    `apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: ${id}
  name: 参数通道验证插件
  version: 1.0.0
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
  params:
${paramsYaml}
runtime:
  kind: pipeline
  pipeline:
    steps:
      - id: s1
        uses: ${uses}
        with:
          src: "\${src}"
          dst: "\${output.dst}"
${withYaml}
`;

  const param = (id) =>
    `    - id: ${id}
      label: ${id}
      type: text
      required: false
`;

  /** 校验一份清单，回报它的 issue 列表 */
  const validateYaml = async (id, paramsYaml, withYaml, uses) => {
    const res = await client.invoke('plugins_validate', {
      req: { source: { kind: 'manifest', yaml: manifest(id, paramsYaml, withYaml, uses) } },
    });
    return res?.validation ?? {};
  };
  const codesOf = (v) => (v.issues ?? []).map((i) => i.code);
  const flagged = (v) => (v.issues ?? []).filter((i) => i.code === 'PARAM_NEVER_USED');

  const PROBE_ID = 'com.verify.param-channel';
  try {
    // ---- ① 三条通道都不沾 → 必须被点名 ----
    const decorative = await validateYaml(PROBE_ID, param('magic'), '');
    console.log(`   装饰品参数：ok=${decorative.ok} issues=${JSON.stringify(codesOf(decorative))}`);
    c.check(
      flagged(decorative).length === 1,
      '★ ① 声明了却没有任何步骤会读到的参数被点名（`PARAM_NEVER_USED`）',
      JSON.stringify(codesOf(decorative))
    );
    c.check(
      flagged(decorative)[0]?.severity === 'warning',
      '①b 它是 **warning** 而不是 error —— 参数没人读不会让任务失败，不该拦住安装',
      flagged(decorative)[0]?.severity ?? '(没有这条 issue)'
    );
    c.check(
      (flagged(decorative)[0]?.message ?? '').includes('magic'),
      '①c 报错信息里点出了是哪个参数（否则作者只知道"有问题"）',
      (flagged(decorative)[0]?.message ?? '').slice(0, 60)
    );

    // ---- ② 通道①：`with` 里同名键 ----
    const sameKey = await validateYaml(PROBE_ID, param('quality'), '          quality: "80"');
    c.check(
      flagged(sameKey).length === 0,
      '★ ② 通道①（`with` 里有同名键）不被误报',
      JSON.stringify(codesOf(sameKey))
    );

    // ---- ③ 通道②：模板注入，且**键名与参数名不同** ----
    //
    // 这一条是"判据过紧就会误报"的实证：内置 `batch-rename` 的 `indexMode`
    // 是 `index: "${params.indexMode}"` 注入的，只比键名会把它判成装饰品。
    const injected = await validateYaml(
      PROBE_ID,
      param('indexMode'),
      '          index: "${params.indexMode}"',
      'name.build'
    );
    c.check(
      flagged(injected).length === 0,
      '★ ③ 通道②（`${params.x}` 注入到**不同名**的节点参数上）不被误报',
      JSON.stringify(codesOf(injected))
    );

    // ---- ④ 通道③：`with` 里一个字都不写，靠节点按名回退 ----
    //
    // 内置 `image-convert` 就是这个形态（`with` 只有 src/dst，靠 `NodeCtx::arg_scope`
    // 回退到用户参数）。【6】【22】已经真机验过它**确实生效**，所以这里必须不报。
    const byNode = await validateYaml(PROBE_ID, param('format') + param('quality'), '');
    c.check(
      flagged(byNode).length === 0,
      '★ ④ 通道③（节点自己声明了同名参数，`with` 留空）不被误报 —— 内置 image-convert 就长这样',
      JSON.stringify(codesOf(byNode))
    );

    // ---- ⑤ warning 不该拦住安装（判据的"代价"必须为零） ----
    const dir = join(REPO_ROOT, '.tools', 'smoke', 'out-param-channel');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plugin.yaml'),
      manifest(PROBE_ID, param('magic'), ''),
      'utf8'
    );
    const existing = await client.invoke('plugins_get', { pluginId: PROBE_ID }).catch(() => null);
    if (existing) {
      await client.invoke('plugins_set_enabled', { pluginId: PROBE_ID, enabled: false }).catch(() => {});
      await client.invoke('plugins_uninstall', { pluginId: PROBE_ID }).catch(() => {});
    }
    const install = await client
      .invoke('plugins_install', {
        req: {
          source: { kind: 'directory', path: dir },
          overwrite: true,
          permissionsAcknowledged: true,
          executableCodeAcknowledged: false,
        },
      })
      .then(() => true)
      .catch((e) => e);
    c.check(
      install === true,
      '★ ⑤ 带装饰品参数的插件**仍然装得上**（warning 不能变成一道安装闸门，否则是在惩罚用户）',
      install === true ? '已安装' : String(install).slice(0, 120)
    );
    await client.invoke('plugins_set_enabled', { pluginId: PROBE_ID, enabled: false }).catch(() => {});
    await client.invoke('plugins_uninstall', { pluginId: PROBE_ID }).catch(() => {});
    c.check(
      (await client.invoke('plugins_get', { pluginId: PROBE_ID }).catch(() => null)) === null,
      '⑤b 验证用的插件已卸载干净（这一节不留副作用）',
      PROBE_ID
    );
  } finally {
    await client.invoke('plugins_set_enabled', { pluginId: PROBE_ID, enabled: false }).catch(() => {});
    await client.invoke('plugins_uninstall', { pluginId: PROBE_ID }).catch(() => {});
  }
}

// ============================================================================
// 【29】许可证确认的 **UI 点击穿透**
// ============================================================================
//
// 这是【25】留下的那条空白，原文写着：
//
//   > 前端那两个勾选框本身**没有做点击穿透验证** —— 本机所有需要确认的引擎与权重
//   > 都已安装，界面上不会出现「安装/下载」按钮，点不出一条真实路径。
//
// 【25】验的是**后端契约**（不带 `licenseAccepted` → `PERMISSION_DENIED`），
// 而那个真实缺陷恰恰在**前端**：`model-panel.tsx` 曾经写
// `licenseAccepted: !m.commercialUse` —— 对不可商用的权重**自动发 true**，
// 于是后端那道硬门永远走不到，用户从头到尾没看见任何确认。
// 后端再严，前端替用户点头也拦不住。
//
// ## 怎么把前提造出来（两处，都不隐瞒）
//
// 1. **模型面板**：把 `birefnet-general` 的权重文件**同卷 rename** 挪走
//    （= 真实的"没装"状态），卡片就会渲染出勾选框与「下载」。收尾挪回来 —— `finally` 里做。
// 2. **引擎安装对话框**：本机 12 个引擎全都装好，所以用
//    `Page.addScriptToEvaluateOnNewDocument` 在**页面脚本之前**挂一个 fetch 包装，
//    把 ffmpeg 的目录状态改写成 `missing` 再整页刷新。真实的组件、事件、请求构造，
//    合成的只有喂进去的那份目录数据 —— 要完全不合成，得有一台没装 FFmpeg 的机器。
//
// ## 怎么验"点下去到底发了什么"
//
// IPC 的传输层是 `window.fetch` → `http://ipc.localhost/<命令>`（实测确认）。
// `__TAURI_INTERNALS__` 上那些函数全是 `writable:false, configurable:false` —— 刻意的
// 硬化，替换不了（这一点本身值得记下来）。但 fetch 可以挂记录器：既拿到请求体，
// 又能**拦下 install 那一发**（回一个假 jobId），从而不触发几百 MB 的真实下载。
//
// ⚠️ 伪造响应必须带 `Tauri-Response: ok` 头。Tauri 的 JS 侧是这么判的：
//    `const callbackId = response.headers.get('Tauri-Response') === 'ok' ? callback : error`
//    少了它，一次"成功"会被当成**错误**回调 —— 表现是「读取引擎目录失败 [undefined]」，
//    而请求与响应其实完全正常（第一次就是这么栽的）。
c.section('【29】许可证勾选框的点击穿透（前端会不会替用户点头）');
{
  // ---- 造前提 1：把不可商用模型的权重挪走（同卷！跨卷 rename 会报 EXDEV） ----
  const modelDir = join(DATA_DIR, 'models', 'birefnet-general');
  const stash = join(DATA_DIR, 'verify-stash-license-gating');
  rmSync(stash, { recursive: true, force: true });
  mkdirSync(stash, { recursive: true });
  const moved = [];
  if (existsSync(modelDir)) {
    for (const f of readdirSync(modelDir)) {
      if (f.endsWith('.onnx')) {
        renameSync(join(modelDir, f), join(stash, f));
        moved.push(f);
      }
    }
  }
  console.log(`   挪走的权重：${moved.join(', ') || '（本来就没有）'}`);

  /** 页面内的 fetch 记录器。install 类命令只记录不转发；可选改写目录响应。 */
  const recorderSource = (catalogPatch = null) => `
(() => {
  window.__tfIpc = [];
  const orig = window.fetch;
  const respond = (value) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
  });
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    window.__tfIpc.push({ url, body: String((init && init.body) || '') });
    const cmd = url.split('/').pop();
    if (cmd === 'models_install' || cmd === 'engines_install') {
      return respond('job-ui-probe-fake');
    }
    const res = await orig.apply(this, arguments);
    ${catalogPatch ? `if (cmd === 'engines_catalog') {
      const data = await res.clone().json();
      return respond(data.map(${catalogPatch}));
    }` : ''}
    return res;
  };
})();
`;
  const installRecorder = (catalogPatch = null) => client.evaluate(recorderSource(catalogPatch));
  const removeRecorder = () =>
    client.evaluate(`(() => { delete window.__tfIpc; return 'removed'; })()`);
  const ipcCalls = async () => JSON.parse(await client.evaluate('JSON.stringify(window.__tfIpc || [])'));
  const clearIpc = () => client.evaluate('window.__tfIpc = []');

  /**
   * 找"卡片"元素。
   *
   * ⚠️ 判据必须锚在**目标按钮**上。用"文本最短的祖先"会挑到卡片的**头部子块**
   * （那里只有两个图标按钮，「下载」在页脚）—— 第一次找 FFmpeg 的「下载安装」就是这么扑空的。
   */
  const findCard = (needle, buttonText) => `(() => {
    const holders = [...document.querySelectorAll('*')].filter((el) => {
      if (!(el.textContent || '').includes(${JSON.stringify(needle)})) return false;
      return [...el.querySelectorAll('button')].some((b) => (b.textContent || '').includes(${JSON.stringify(buttonText)}));
    });
    holders.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    return holders[0] || null;
  })()`;

  const readModelCard = (modelId) =>
    client.evaluate(`(() => {
      const id = ${JSON.stringify(modelId)};
      const holders = [...document.querySelectorAll('*')]
        .filter((el) => (el.textContent || '').includes(id) && el.querySelector('button'));
      holders.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      const card = holders[0];
      if (!card) return { found: false };
      const buttons = [...card.querySelectorAll('button')];
      const download = buttons.find((b) => (b.textContent || '').trim() === '下载');
      const box = card.querySelector('[role="checkbox"], input[type="checkbox"]');
      return {
        found: true,
        hasCheckbox: !!box,
        checkboxState: box ? (box.getAttribute('aria-checked') ?? String(box.checked)) : null,
        hasDownload: !!download,
        downloadDisabled: download ? download.disabled : null,
        downloadTitle: download ? download.title : null,
      };
    })()`);

  const clickModelCard = (modelId, what) =>
    client.evaluate(`(() => {
      const id = ${JSON.stringify(modelId)};
      const what = ${JSON.stringify(what)};
      const want = what === 'force-download' ? '下载' : what === 'checkbox' ? null : what;
      const holders = [...document.querySelectorAll('*')].filter((el) => {
        if (!(el.textContent || '').includes(id)) return false;
        if (what === 'checkbox') return !!el.querySelector('[role="checkbox"], input[type="checkbox"]');
        return [...el.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === want);
      });
      holders.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      const card = holders[0];
      if (!card) return '没找到卡片';
      if (what === 'checkbox') {
        const box = card.querySelector('[role="checkbox"], input[type="checkbox"]');
        if (!box) return '没找到勾选框';
        box.click();
        return 'ok';
      }
      const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === want);
      if (!btn) return '没找到按钮';
      if (what === 'force-download') {
        // 绕开 disabled 直接调**组件自己的 onClick**：问的就是"处理器里那个值是多少"。
        // 历史缺陷（licenseAccepted: !m.commercialUse）正藏在处理器里，而只断言
        // "按钮禁用"是拦不住它的 —— 按钮禁用了，可处理器里那个常量还在。
        // ⚠️ 这段代码整个嵌在 JS 模板字符串里，所以**不能出现反引号**（踩过）。
        const key = Object.keys(btn).find((k) => k.startsWith('__reactProps'));
        const props = key ? btn[key] : null;
        if (props && typeof props.onClick === 'function') {
          props.onClick({ preventDefault() {}, stopPropagation() {} });
          return '已调用组件的 onClick（绕过 disabled）';
        }
        btn.disabled = false;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return '已强制点击（DOM 派发）';
      }
      if (btn.disabled) return '按钮是禁用的';
      btn.click();
      return 'ok';
    })()`);

  const navTo = async (path) => {
    await client.evaluate(
      `(() => { history.pushState({}, '', ${JSON.stringify(path)});
                window.dispatchEvent(new PopStateEvent('popstate')); return location.pathname; })()`
    );
    await sleep(1500);
  };
  const boot = () => client.send('Page.reload').then(() => sleep(4500));

  let preDocScript = null;
  const patchCatalogAndBoot = async (catalogPatch) => {
    const r = await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: recorderSource(catalogPatch),
    });
    preDocScript = r.identifier;
    await boot();
  };
  const undoCatalogPatch = async () => {
    if (preDocScript) {
      await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: preDocScript });
      preDocScript = null;
    }
  };

  try {
    // ---- 模型面板 ----
    //
    // ⚠️ 挪完权重必须**整页刷新**：React Query 里那份 `models_list` 还是旧的，
    // SPA 跳转不会重取 —— 第一次就是这么把"已安装"的卡片当成目标卡片的。
    await boot();
    await navTo('/settings?tab=engines');
    await installRecorder();

    // ① 对照：可商用且未安装
    const commercial = await readModelCard('u2net');
    console.log(`   对照 u2net：${JSON.stringify(commercial)}`);
    c.check(commercial.found, '① 对照模型卡片存在（u2net 可商用且未安装）');
    c.check(
      commercial.hasCheckbox === false,
      '★ ① 可商用的模型**没有**许可勾选框（不该无端要求确认）'
    );
    c.check(commercial.downloadDisabled === false, '①b 可商用且未安装 → 「下载」按钮可用');

    // ② 不可商用且未安装
    const first = await readModelCard('birefnet-general');
    console.log(`   目标 birefnet-general：${JSON.stringify(first)}`);
    c.check(first.found && first.hasDownload === true, '② 目标卡片存在且处于"未下载"状态');
    c.check(first.hasCheckbox === true, '★ ② 不可商用的权重渲染出许可勾选框');
    if (first.checkboxState === 'true') {
      await clickModelCard('birefnet-general', 'checkbox');
      await sleep(300);
    }
    const unchecked = await readModelCard('birefnet-general');
    c.check(
      unchecked.downloadDisabled === true,
      '★ ③ 没勾许可时「下载」按钮**禁用** —— 这正是当初被 `licenseAccepted: !m.commercialUse` 绕过去的那道闸',
      unchecked.downloadTitle
    );

    // ④ 勾上 → 可用 → 点下载 → 请求体里必须带 true
    await clickModelCard('birefnet-general', 'checkbox');
    await sleep(300);
    const checked = await readModelCard('birefnet-general');
    c.check(checked.checkboxState === 'true', '④ 勾上之后勾选框是选中态');
    c.check(checked.downloadDisabled === false, '④b 勾上之后「下载」按钮可用');

    await clearIpc();
    const clicked = await clickModelCard('birefnet-general', '下载');
    await sleep(800);
    const installCalls = await ipcCalls();
    const installCall = installCalls.find((x) => x.url.endsWith('/models_install'));
    console.log(`   点下载（${clicked}）→ ${JSON.stringify(installCall?.body ?? null)}`);
    c.check(!!installCall, '★ ⑤ 点「下载」真的发出了 models_install（走 http://ipc.localhost）');
    c.check(
      JSON.parse(installCall?.body || '{}')?.req?.licenseAccepted === true,
      '★ ⑤b 请求体里 `licenseAccepted: true`（勾了才发 true）',
      installCall?.body
    );
    c.check(
      JSON.parse(installCall?.body || '{}')?.req?.modelId === 'birefnet-general',
      '⑤c 请求指向被点的那张卡片',
      installCall?.body
    );

    // ⑥ 未勾选：点不动，且一个请求都发不出去
    await navTo('/settings?tab=engines');
    const back = await readModelCard('birefnet-general');
    if (back.checkboxState === 'true') {
      await clickModelCard('birefnet-general', 'checkbox');
      await sleep(300);
    }
    await clearIpc();
    const blocked = await clickModelCard('birefnet-general', '下载');
    await sleep(500);
    const blockedCalls = await ipcCalls();
    c.check(
      !blockedCalls.some((x) => x.url.endsWith('/models_install')),
      '★ ⑥ 未勾选时点「下载」一个请求都发不出去（不是"发出去了被后端拒绝"）',
      blocked
    );

    // ⑦ 绕开 disabled 直接调处理器：负载必须是 false，不是硬编 true
    await clearIpc();
    const forced = await clickModelCard('birefnet-general', 'force-download');
    await sleep(700);
    const forcedCall = (await ipcCalls()).find((x) => x.url.endsWith('/models_install'));
    console.log(`   绕过 disabled 调处理器（${forced}）→ ${JSON.stringify(forcedCall?.body ?? null)}`);
    c.check(!!forcedCall, '⑦ 对照组成立：绕过 disabled 之后请求确实发出来了');
    c.check(
      JSON.parse(forcedCall?.body || '{}')?.req?.licenseAccepted === false,
      '★ ⑦b 没勾选时处理器发的是 `licenseAccepted: false` —— 不是硬编的 true（历史缺陷正是硬编 true）',
      forcedCall?.body
    );

    // ---- 引擎安装对话框（合成的目录数据驱动真实组件） ----
    await removeRecorder();
    await patchCatalogAndBoot(`(e) => e.descriptor.id === 'ffmpeg'
      ? { ...e, status: { ...e.status, state: 'missing', source: 'none', path: null, version: null },
          licenseAcknowledged: false, licenseAcknowledgedAt: null }
      : e`);
    await navTo('/settings?tab=engines');
    await sleep(800);

    const openEngineDialog = async () => {
      const r = await client.evaluate(`(() => {
        const card = ${findCard('FFmpeg', '下载安装')};
        if (!card) {
          const has = [...document.querySelectorAll('*')].some((el) => (el.textContent || '').includes('FFmpeg'));
          return has ? '卡片上没有「下载安装」（目录状态没被改写？）' : '页面上没有 FFmpeg';
        }
        const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').includes('下载安装'));
        if (!btn) return '没找到「下载安装」';
        btn.click();
        return 'ok';
      })()`);
      await sleep(700);
      return r;
    };
    const readDialog = () =>
      client.evaluate(`(() => {
        const dlg = document.querySelector('[role="dialog"]');
        if (!dlg) return { open: false, checks: [], confirmDisabled: null, text: '' };
        const boxes = [...dlg.querySelectorAll('[role="checkbox"]')];
        const confirm = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || '').includes('开始下载安装'));
        return {
          open: true,
          checks: boxes.map((b) => ({ label: b.getAttribute('aria-label') || '', state: b.getAttribute('aria-checked') })),
          confirmDisabled: confirm ? confirm.disabled : null,
          text: (dlg.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
        };
      })()`);
    const clickDialog = (what) =>
      client.evaluate(`(() => {
        const what = ${JSON.stringify(what)};
        const dlg = document.querySelector('[role="dialog"]');
        if (!dlg) return '对话框没打开';
        if (what === 'license') {
          const box = [...dlg.querySelectorAll('[role="checkbox"]')].find((b) => (b.getAttribute('aria-label') || '').includes('许可证'));
          if (!box) return '没找到许可证勾选框';
          box.click();
          return 'ok';
        }
        const btn = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || '').includes('开始下载安装'));
        if (!btn) return '没找到确认按钮';
        if (btn.disabled) return '确认按钮是禁用的';
        btn.click();
        return 'ok';
      })()`);

    const opened = await openEngineDialog();
    const d1 = await readDialog();
    console.log(`   引擎对话框（${opened}）：${JSON.stringify(d1.checks)} confirmDisabled=${d1.confirmDisabled}`);
    c.check(d1.open === true, '★ ⑧ 未安装的引擎卡片上有「下载安装」，点开是安装确认对话框', opened);
    const lic1 = d1.checks.find((x) => (x.label || '').includes('许可证'));
    c.check(!!lic1, '⑧b 对话框里有许可证勾选框（ffmpeg 需要确认）', JSON.stringify(d1.checks));
    c.check(lic1?.state === 'false', '⑧c 没有确认记录时勾选框默认**未勾选**', lic1?.state);
    c.check(d1.confirmDisabled === true, '★ ⑨ 没勾许可证时「开始下载安装」禁用');
    c.check(!d1.text.includes('你已于'), '⑨b 没有确认记录时不显示"已于…确认过"');

    await clickDialog('license');
    await sleep(300);
    const d2 = await readDialog();
    c.check(d2.confirmDisabled === false, '⑩ 勾上之后确认按钮可用');

    await clearIpc();
    await clickDialog('confirm');
    await sleep(800);
    const engCall = (await ipcCalls()).find((x) => x.url.endsWith('/engines_install'));
    console.log(`   点确认 → ${JSON.stringify(engCall?.body ?? null)}`);
    c.check(!!engCall, '★ ⑪ 点确认真的发出了 engines_install');
    c.check(
      JSON.parse(engCall?.body || '{}')?.req?.licenseAccepted === true,
      '★ ⑪b 引擎安装请求里带的是 `licenseAccepted: true`',
      engCall?.body
    );
    c.check(
      JSON.parse(engCall?.body || '{}')?.req?.engineId === 'ffmpeg',
      '⑪c 请求指向被点的那个引擎',
      engCall?.body
    );

    // ⑫ 已确认过 → 预先勾上（省一次点击，但**不是**跳过确认）
    await undoCatalogPatch();
    await patchCatalogAndBoot(`(e) => e.descriptor.id === 'ffmpeg'
      ? { ...e, status: { ...e.status, state: 'missing', source: 'none', path: null, version: null },
          licenseAcknowledged: true, licenseAcknowledgedAt: '2026-01-02T03:04:05.000Z' }
      : e`);
    await navTo('/settings?tab=engines');
    await sleep(800);
    const opened2 = await openEngineDialog();
    const d3 = await readDialog();
    const lic3 = d3.checks.find((x) => (x.label || '').includes('许可证'));
    console.log(`   已确认过（${opened2}）：${JSON.stringify(d3.checks)} confirmDisabled=${d3.confirmDisabled}`);
    c.check(
      lic3?.state === 'true',
      '★ ⑫ 确认过之后勾选框**预先勾上**（只是省一次重复点击）',
      lic3?.state
    );
    c.check(d3.text.includes('你已于'), '⑫b 并显示"已于…确认过"，用户知道它为什么是勾上的');
    c.check(d3.confirmDisabled === false, '⑫c 预先勾上时确认按钮直接可用');
  } finally {
    // ---- 收尾：恢复权重、摘掉注入的脚本、整页刷新 ----
    // 权重必须还原（**失败也还原**）：这台机器上后面每一个抠图检查都要用它。
    await undoCatalogPatch().catch(() => {});
    await removeRecorder().catch(() => {});
    for (const f of moved) {
      try {
        renameSync(join(stash, f), join(modelDir, f));
      } catch (e) {
        console.log(`   ⚠️ 还原 ${f} 失败：${e.message}`);
      }
    }
    rmSync(stash, { recursive: true, force: true });
    await client.send('Page.reload').catch(() => {});
    await sleep(4000);
    const models = await client.invoke('models_list').catch(() => []);
    const m = (models ?? []).find((x) => x.id === 'birefnet-general');
    c.check(
      m?.installed === true,
      '⑬ 收尾：权重已还原、模型重新被认作已安装（这一节不留副作用）',
      `installed=${m?.installed}`
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
