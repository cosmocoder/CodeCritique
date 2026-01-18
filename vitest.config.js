import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.js', '.github/actions/**/*.test.js'],
    exclude: ['node_modules'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.js', '.github/actions/**/*.js'],
      exclude: [
        'src/**/*.test.js',
        '.github/actions/**/*.test.js',
        'src/index.js',
        'src/setupTests.js',
        'src/test-utils/**/*.js',
        'src/**/constants.js',
        'src/embeddings/types.js', // JSDoc type definitions only
        'src/review-keywords.json',
        'src/technology-keywords.json',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 82,
        statements: 90,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['./src/setupTests.js'],
    pool: 'threads',
    maxWorkers: 8,
  },
});
