/**
 * Package-level Vitest configuration.
 *
 * `@soul-harness/persistence` is aliased to its TypeScript source so the unit
 * tests do not depend on a prior `build`. The *process* tests deliberately do
 * the opposite: they spawn a real Node process, which resolves the package
 * through `node_modules` → `dist/`, so the published boundary is exercised too.
 */

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@soul-harness/persistence': fileURLToPath(
        new URL('../../packages/persistence/src/index.ts', import.meta.url),
      ),
      '@soul-harness/runtime': fileURLToPath(
        new URL('../../packages/runtime/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Process tests spawn real daemons; keep files serial to avoid noisy port/dir reuse.
    fileParallelism: false,
  },
});
