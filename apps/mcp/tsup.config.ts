import { defineConfig } from 'tsup'

// Publishable `npx clickroom-mcp` stdio bridge. `@clickroom/agent-tools`
// is inlined (noExternal) so the published npm package carries no workspace
// deps at runtime; the MCP SDK / tRPC / zod stay external and must be real
// `dependencies` in package.json so `npx` installs them.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  noExternal: [/^@clickroom\//],
  external: ['@modelcontextprotocol/sdk', '@trpc/client', 'zod'],
  // `src/main.ts` already starts with `#!/usr/bin/env node` — esbuild (via
  // tsup) hoists/preserves a leading shebang from the entry file itself, so
  // no extra `banner` is needed here (adding one would duplicate the line).
})
