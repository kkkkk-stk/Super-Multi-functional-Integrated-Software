import { motion, useReducedMotion } from "framer-motion";

import { useUiStore } from "@/stores/ui-store";

/**
 * 极光背景：3 个大的模糊径向渐变斑块缓慢浮动。
 *
 * 几个刻意的决定：
 * 1. **`filter: blur(80px)` + `mix-blend-mode`** 而不是贴图 —— 任何分辨率都清晰，
 *    也没有额外网络请求（桌面应用不该为背景加载图片）。
 * 2. `prefers-reduced-motion` 时**完全静止**（framer 的 `useReducedMotion`），
 *    前庭敏感用户不该被背景晃到。
 * 3. 设置里 `ambientEffects` 关掉时**直接不渲染**（不是 opacity:0）——
 *    低配机器上省掉一整层合成开销。
 * 4. 颜色取自 CSS 变量 `--glow`（强调色的 RGB 三元组），
 *    所以换强调色时背景会跟着变。
 */
export function AuroraBackground() {
  const ambientEffects = useUiStore((s) => s.ambientEffects);
  const reduced = useReducedMotion();

  if (!ambientEffects) return null;

  const blobs = [
    {
      key: "a",
      className: "-left-[12%] -top-[18%] h-[46rem] w-[46rem]",
      color: "rgb(var(--glow) / 0.28)",
      duration: 26,
      delay: 0,
    },
    {
      key: "b",
      className: "-right-[16%] top-[6%] h-[38rem] w-[38rem]",
      color: "rgb(139 92 246 / 0.22)",
      duration: 32,
      delay: 3,
    },
    {
      key: "c",
      className: "bottom-[-24%] left-[22%] h-[42rem] w-[42rem]",
      color: "rgb(56 189 248 / 0.18)",
      duration: 38,
      delay: 6,
    },
  ];

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {blobs.map((blob) => (
        <motion.div
          key={blob.key}
          className={`absolute rounded-full ${blob.className}`}
          style={{
            background: `radial-gradient(circle at 50% 50%, ${blob.color}, transparent 68%)`,
            filter: "blur(80px)",
            mixBlendMode: "screen",
          }}
          animate={
            reduced
              ? undefined
              : { x: [0, 40, -30, 0], y: [0, -30, 25, 0], scale: [1, 1.1, 0.95, 1] }
          }
          transition={
            reduced
              ? undefined
              : {
                  duration: blob.duration,
                  delay: blob.delay,
                  repeat: Infinity,
                  ease: "easeInOut",
                }
          }
        />
      ))}
    </div>
  );
}
