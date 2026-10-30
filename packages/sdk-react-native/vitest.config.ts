import { defineConfig } from 'vitest/config'

// Pure-logic + transport tests — Node env only, no RN runtime.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
