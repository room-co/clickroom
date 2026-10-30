import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000'

export default defineConfig({
  // react-grid-layout's DraggableCore reads `process.env.NODE_ENV` directly
  // (not `import.meta.env`) for a dev-only debug log — Vite doesn't polyfill
  // `process` in the browser, so without this it throws on first drag.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
  plugins: [
    // The React and Tailwind plugins are both required, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      // Proxy tRPC calls to the apps/api server to avoid cross-origin (CORS) issues.
      '/trpc': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      // Proxy the flags SSE endpoint to the same api server.
      '/flags/stream': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
})
