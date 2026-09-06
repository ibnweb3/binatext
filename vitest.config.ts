import { defineConfig } from "vitest/config";

// Plain Node environment. Pure-logic smoke tests (policy guard, state machine
// with fakes) run here. Worker/Durable-Object integration tests will move to
// @cloudflare/vitest-pool-workers once the DO exists.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
