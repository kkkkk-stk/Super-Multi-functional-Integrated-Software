/// <reference types="vite/client" />

/** Tauri 注入到 window 上的内部对象（有的地方需要探测"是否跑在 Tauri 里"） */
interface Window {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}
