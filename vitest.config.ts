/**
 * Single Vitest entry point for the whole repo.
 *
 * Every workspace package under `packages/` and every application under `apps/`
 * is picked up as a project, so `pnpm test` at the root runs the same suites a
 * package runs on its own — there is no second, drifting copy of the test
 * configuration.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Point at package configs, not only their directories: the daemon config
    // sets fileParallelism=false so fixed-port API lifecycle tests cannot race
    // each other or spawned process tests.
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    // The daemon owns one fixed production port (127.0.0.1:18700). Running
    // daemon test files concurrently lets two real servers race that port even
    // though package-level config requests file serialization.
    fileParallelism: false,
    passWithNoTests: false,
  },
});
