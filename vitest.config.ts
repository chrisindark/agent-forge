/**
 * Vitest configuration.
 *
 * Tests are hermetic: the gateway is mocked (`tests/smoke.test.ts`,
 * `tests/health.test.ts`), so no live Echo Gate instance is needed.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Explicit so a stray file in `dist/` or `node_modules/` can never be collected.
    include: ["tests/**/*.test.ts"],
    // Tests import `describe`/`it`/`expect` from "vitest" explicitly, so no globals.
    globals: false,
    environment: "node",
  },
});