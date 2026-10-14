import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // vitest 5 defaults clearMocks to true (v4 was false); pin v4 behaviour (29257).
    clearMocks: false,
    exclude: ["tests/stress.test.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
})
