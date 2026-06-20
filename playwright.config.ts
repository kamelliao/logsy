import { defineConfig, devices } from "@playwright/test";

// Logsy is a Tauri desktop app, but tauri-driver (the official WebDriver bridge)
// has no macOS support, so end-to-end here drives the *frontend* in a real
// browser with the Tauri IPC layer mocked (see e2e/support/tauri-mock.ts). This
// covers all the product logic, which lives in React; the thin Rust side
// (file read/encoding, write, window controls) is guarded by Rust unit tests.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Headroom for cold Vite module compiles when several workers hit the dev
  // server at once (the default 30s can be tight under that contention).
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Tauri uses WKWebView on macOS; uncomment for higher-fidelity runs.
    // { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  // Reuse the Vite dev server locally; start a fresh one in CI.
  webServer: {
    command: "bun run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
