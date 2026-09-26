//! 图标生成器（零依赖）。
//!
//! `tauri build` 需要 `src-tauri/icons/` 下存在真实图标文件；`cargo check` 阶段的
//! `tauri-build` 也会引用 `.ico` 来生成 Windows 资源。仓库里不放二进制素材的好处是
//! 审查 diff 时不会看到一大坨 base64 —— 图标由本脚本即时生成。
//!
//! 用法：`node scripts/gen-icon.mjs`
//! 之后可用 `pnpm icons`（含 `tauri icon`）从 `assets/icon-source.png` 生成全平台图标。

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- PNG 编码

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 把 RGBA 像素数组编码成 PNG（Truecolor + Alpha，8bit） */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  // 每行前面加一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 图形

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 画一个"熔炉里的锤砧"意象：深色圆角底 + 青紫渐变斜切 + 中心高光。
 * 用纯数学画，不依赖任何图形库。
 */
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const nx = (x - c) / c;
      const ny = (y - c) / c;
      const r = Math.hypot(nx, ny);

      // 圆角方形遮罩（squircle 近似）
      const mask = clamp01((1.02 - Math.pow(Math.abs(nx), 4) - Math.pow(Math.abs(ny), 4)) * 6);

      // 对角渐变：深靛 -> 亮青
      const t = clamp01((nx + ny + 2) / 4);
      let cr = lerp(24, 56, t);
      let cg = lerp(28, 189, t);
      let cb = lerp(58, 248, t);

      // 中心辉光
      const glow = Math.exp(-Math.pow(r * 2.1, 2)) * 0.55;
      cr = lerp(cr, 255, glow * 0.9);
      cg = lerp(cg, 255, glow * 0.9);
      cb = lerp(cb, 255, glow * 0.75);

      // 内部"锻打"线条：45° 斜纹
      const stripe = Math.sin((nx + ny) * Math.PI * 5.5);
      if (stripe > 0.86 && r < 0.72) {
        const k = (stripe - 0.86) / 0.14;
        cr = lerp(cr, 255, k * 0.35);
        cg = lerp(cg, 255, k * 0.35);
        cb = lerp(cb, 255, k * 0.35);
      }

      // 外圈描边
      const ring = Math.exp(-Math.pow((r - 0.86) * 12, 2)) * 0.5;
      cr = lerp(cr, 255, ring);
      cg = lerp(cg, 255, ring);
      cb = lerp(cb, 255, ring);

      rgba[i] = Math.round(clamp01(cr / 255) * 255);
      rgba[i + 1] = Math.round(clamp01(cg / 255) * 255);
      rgba[i + 2] = Math.round(clamp01(cb / 255) * 255);
      rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return rgba;
}

/** ICO 容器：Vista 以后支持直接内嵌 PNG，比 BMP 简单得多 */
function encodeIco(pngBuffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(pngBuffers.length, 4);

  const entries = [];
  let offset = 6 + pngBuffers.length * 16;
  for (const { size, data } of pngBuffers) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 256 用 0 表示
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)]);
}

// ---------------------------------------------------------------- 主流程

const ICON_DIR = join(ROOT, 'apps', 'desktop', 'src-tauri', 'icons');
const ASSET_DIR = join(ROOT, 'assets');
mkdirSync(ICON_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256];
const rendered = new Map();
for (const s of sizes) rendered.set(s, encodePng(s, s, render(s)));

// Tauri 约定的文件名
writeFileSync(join(ICON_DIR, '32x32.png'), rendered.get(32));
writeFileSync(join(ICON_DIR, '128x128.png'), rendered.get(128));
writeFileSync(join(ICON_DIR, '128x128@2x.png'), rendered.get(256));
writeFileSync(join(ICON_DIR, 'icon.png'), rendered.get(256));
writeFileSync(
  join(ICON_DIR, 'icon.ico'),
  encodeIco(sizes.map((s) => ({ size: s, data: rendered.get(s) })))
);

// 源图（给 `tauri icon` 用，可以生成 .icns 等全平台图标）
writeFileSync(join(ASSET_DIR, 'icon-source.png'), encodePng(512, 512, render(512)));

console.log('图标已生成：');
console.log('  apps/desktop/src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png');
console.log('  apps/desktop/src-tauri/icons/icon.ico');
console.log('  assets/icon-source.png');
console.log('');
console.log('提示：macOS 的 .icns 需要 `pnpm icons`（会调用 `tauri icon`）生成。');
