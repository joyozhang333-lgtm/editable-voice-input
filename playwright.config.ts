import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", fullyParallel: false, workers: 1,
  timeout: 30_000, expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:5187", permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    screenshot: "only-on-failure", trace: "retain-on-failure"
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 800 } } },
    { name: "touch", use: { browserName: "chromium", isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 } }
  ],
  webServer: [
    { command: "pnpm --filter editable-voice-input-example-vite-react exec vite --host 127.0.0.1 --port 5187 --strictPort", url: "http://127.0.0.1:5187", reuseExistingServer: false },
    { command: "node scripts/serve-examples.mjs", url: "http://127.0.0.1:5188/examples/vanilla/index.html", reuseExistingServer: false }
  ]
});
