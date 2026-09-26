/**
 * 噪点叠层：消除大块渐变在深色下的"色带"（banding）。
 *
 * 用 SVG `feTurbulence` 内联成 data URI —— 一次生成、零请求、
 * 且 `opacity` 极低（0.025）时不会影响文字清晰度。
 */
const NOISE_DATA_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <filter id="n">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/>
        <feColorMatrix type="saturate" values="0"/>
      </filter>
      <rect width="160" height="160" filter="url(#n)" opacity="0.5"/>
    </svg>`,
  );

export function NoiseOverlay() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 mix-blend-overlay"
      style={{
        backgroundImage: `url("${NOISE_DATA_URI}")`,
        opacity: 0.035,
      }}
    />
  );
}
