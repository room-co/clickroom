import { defineConfig } from 'vitest/config'

// Pure-logic parity tests — Node env, no DB, no browser globals required.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
