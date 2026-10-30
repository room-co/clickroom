import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'prisma/config'

// Load the monorepo-root .env (two levels up) so DATABASE_URL is available even
// when a command doesn't export it. An already-set process env still wins.
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

// Prisma 7 moved the datasource connection URL out of schema.prisma into this
// config file. The URL is read from DATABASE_URL (loaded from the repo-root .env
// by dotenv, or from the process env when exported directly for CLI commands).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
})
