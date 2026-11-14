import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test builds its own app (no globals), so files may run in parallel.
    restoreMocks: true,
  },
});
