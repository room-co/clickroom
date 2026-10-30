import { defineConfig } from 'vitest/config'

// `tsc` compiles `src/**/*.test.ts` into `dist/` as well, so without an explicit
// exclude every suite runs twice — once from source, once from its stale
// compiled copy — as soon as anything has built `dist/` (Docker, turbo, CI).
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
