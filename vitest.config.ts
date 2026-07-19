import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: ["tests/stress.test.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
})
