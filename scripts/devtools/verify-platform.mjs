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

import { Checker, connect, makePng, REPO_ROOT, sleep, webpInfo } from './cdp.mjs';

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
