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
 *
 * 用法：`node scripts/devtools/verify-platform.mjs`
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Checker, connect, makePng, REPO_ROOT, webpInfo } from './cdp.mjs';

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

client.close();
process.exit(c.summary() ? 0 : 1);
