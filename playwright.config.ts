import { defineConfig } from '@playwright/test';

// UI tests on the built site (vite preview), in headless Chromium with software WebGL.
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:4173/',
    acceptDownloads: true,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  // Chrome and Safari's engine: the site must work the same in both.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit', launchOptions: {} } },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
