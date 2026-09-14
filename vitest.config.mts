import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20_000,
    // The first run downloads a MongoDB binary for the in-memory database.
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
