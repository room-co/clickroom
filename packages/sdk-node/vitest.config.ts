import { defineConfig } from 'vitest/config'

// Pure-logic + transport tests — Node env only, no browser globals.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
