/**
 * 展示层格式化。全部是纯函数（无副作用、无 IPC），因此可以放心在渲染里直接调用。
 *
 * 约定：**后端不做人类可读格式化**（`JobProgress.speed` 是唯一的例外，那是
 * 引擎自己给的字符串）；字节 / 时长 / 速度 / 百分比都在这里转。
 */

const KB = 1024;
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** 1024 进制，保留 1 位小数（不足 10 时多给一位，避免 "1.0 GB" 这种噪声） */
export function formatBytes(bytes: number | null | undefined, fractionDigits?: number): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= KB && unit < UNITS.length - 1) {
    value /= KB;
    unit += 1;
  }
  const digits = fractionDigits ?? (unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0);
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** MB 数字（引擎描述里的 `approxSizeMb`）→ 人类可读 */
export function formatMegabytes(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return "—";
  if (mb <= 0) return "无需下载";
  return formatBytes(mb * KB * KB);
}

/** 传输速率：后端给的是 B/s（f64） */
export function formatSpeed(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps) || bps <= 0) return "—";
  return `${formatBytes(bps)}/s`;
}

/** 秒 → `1 小时 3 分` / `3 分 12 秒` / `12 秒` */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest === 0 ? `${m} 分` : `${m} 分 ${rest} 秒`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h} 小时` : `${h} 小时 ${mm} 分`;
}

/** 毫秒（步骤耗时） */
export function formatMillis(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return formatDuration(ms / 1000);
}

/** 0..1 → `42%`；`undefined`（总量未知）→ `—` */
export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(Math.max(0, Math.min(1, value)) * 100).toFixed(digits)}%`;
}

/** 预估剩余时间（`JobProgress.etaSeconds`） */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "剩余时间未知";
  if (seconds <= 0) return "即将完成";
  return `剩余约 ${formatDuration(seconds)}`;
}

/** ISO-8601 → 本地时间 `2024-05-01 12:03:44` */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** ISO-8601 → 本地时分秒（日志行用，短） */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** ISO-8601 → `刚刚` / `3 分钟前` / `2 小时前` / 绝对时间 */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  return formatDateTime(iso);
}

/**
 * 时间跨度（已用时）：从 created/started 到 now 或 finishedAt。
 *
 * 参数是 `string | null | undefined`：生成类型里 `startedAt` / `finishedAt` 是
 * `Option<String>` + `skip_serializing_if`，TS 相位因此是 `string | null`。
 * 展示层直接容忍 null，省得每个调用点都写 `?? undefined`。
 */
export function formatElapsed(
  startIso?: string | null,
  endIso?: string | null,
): string {
  if (!startIso) return "—";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  return formatDuration(Math.max(0, (end - start) / 1000));
}

/** 路径中段省略：`D:\a\b\...\file.png` */
export function truncateMiddle(text: string, max = 48): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** 只取文件名（兼容 Windows 与 POSIX 分隔符） */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 只取目录部分 */
export function dirName(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

/** 扩展名（小写，不含点） */
export function extensionOf(path: string): string {
  const base = baseName(path);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : "";
}

/** 数量 + 单位（中文不加复数） */
export function formatCount(n: number | null | undefined, unit = "项"): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return `0 ${unit}`;
  return `${n} ${unit}`;
}

/** 大数字缩写：12345 → `1.2 万` */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) < 10000) return String(n);
  return `${(n / 10000).toFixed(1)} 万`;
}
