/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev fallback only; production uses `/config.js` (window.__CLICKROOM_CONFIG__). */
  readonly VITE_API_ORIGIN?: string
  readonly VITE_CLICKROOM_WRITE_KEY?: string
  readonly VITE_CLICKROOM_API_HOST?: string
  readonly VITE_CLICKROOM_DEPLOYMENT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
