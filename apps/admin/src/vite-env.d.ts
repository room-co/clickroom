/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev fallback only; production uses `/config.js` (window.__CLICKROOM_CONFIG__). */
  readonly VITE_API_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
