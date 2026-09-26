import { defineConfig } from "vitest/config";

// Windows はファイル操作が遅く、重いテストが既定のタイムアウトを超えることがある。
const isWindows = process.platform === "win32";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    passWithNoTests: true,
    testTimeout: isWindows ? 30_000 : 5_000,
    hookTimeout: isWindows ? 30_000 : 10_000,
  },
});
