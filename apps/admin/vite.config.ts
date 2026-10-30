import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Ports 3000/3001/3002/4322/5177/5180 are already taken across the repo's
    // port map (api/capture/ingest/marketing dev/marketing/web) — 5181 is free.
    port: 5181,
    strictPort: true,
    proxy: {
      // Proxy tRPC calls to apps/api to avoid cross-origin (CORS) issues in dev,
      // same pattern as apps/web/vite.config.ts.
      '/trpc': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
})
