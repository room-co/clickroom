import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:5273',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Chrome's Private/Local Network Access blocks fetches from a page to a
        // more-private address space (e.g. `loopback`). surveys-exposure.spec.ts
        // route-fulfills a synthetic-origin harness page (no real resolved IP, so
        // Chrome classifies it `public`) that must call the capture service on
        // `localhost` (`loopback`) — which LNA denies. Disable the checks so the
        // harness SDK can reach capture. Test-only; does not affect app code.
        launchOptions: {
          args: [
            '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
          ],
        },
      },
    },
  ],
  webServer: {
    command:
      'cross-env VITE_API_PROXY_TARGET=http://localhost:3100 pnpm vite --port 5273 --strictPort',
    url: 'http://localhost:5273',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
