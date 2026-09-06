import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@editable-voice-input/core": fromRoot("./packages/core/src/index.ts"),
      "@editable-voice-input/react": fromRoot("./packages/react/src/index.ts"),
      "@editable-voice-input/server": fromRoot("./packages/server/src/index.ts"),
      "@editable-voice-input/provider-openai-compatible": fromRoot(
        "./packages/provider-openai-compatible/src/index.ts"
      )
    }
  },
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "packages/core/src/index.ts",
        "packages/provider-openai-compatible/src/index.ts",
        "packages/react/src/index.ts",
        "packages/server/src/index.ts"
      ],
      thresholds: {
        statements: 82,
        branches: 70,
        functions: 79,
        lines: 85
      }
    }
  }
});
