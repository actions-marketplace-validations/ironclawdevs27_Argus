import { defineConfig } from 'vitest/config';

// Root Vitest config. Test behaviour stays at Vitest defaults (npm run test:unit is
// unaffected); the coverage block only applies when --coverage is passed
// (npm run coverage:unit). The unit half of the merged coverage gate is written here
// as coverage/unit/coverage-final.json and combined with the c8 harness half by
// scripts/coverage-gate.mjs.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.js'],
      reporter: ['json', 'text-summary'],
      reportsDirectory: 'coverage/unit',
    },
  },
});
