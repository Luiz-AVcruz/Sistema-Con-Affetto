import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

export default defineConfig({
  testDir: './tests/browser', workers: 1, fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3334', viewport: { width: 1366, height: 900 },
    launchOptions: { executablePath: process.env['BROWSER_PATH'] ?? (existsSync('/usr/bin/brave-browser') ? '/usr/bin/brave-browser' : undefined) },
    screenshot: 'only-on-failure' },
  webServer: { command: 'node scripts/test-server.mjs', url: 'http://127.0.0.1:3334/api/health', reuseExistingServer: false, timeout: 30000 }
});
