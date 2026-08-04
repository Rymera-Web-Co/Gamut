import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Pin the timezone so formatTimestampMs (#301) tests can assert an exact
    // expected string regardless of the runner's local timezone. Note this is
    // global — it applies to every test file, so a test asserting local-time
    // rendering will be UTC-only.
    env: { TZ: "UTC" },
  },
});
