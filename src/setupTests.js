/* eslint-disable vitest/no-commented-out-tests */
import { setupConsoleSpies, suppressConsole, restoreConsole, CONSOLE_METHODS } from './test-utils/console-suppression.js';

/**
 * Global test setup for Vitest
 *
 * Console Suppression:
 * By default, console output from code under test is suppressed to keep test output clean.
 * However, you can enable console output for debugging in several ways:
 *
 * 1. Environment Variable (for all tests):
 *    DEBUG_CONSOLE=true npm test
 *    or
 *    SHOW_CONSOLE=true npm test
 *
 * 2. Per-test helper functions:
 *    enableConsole()  - Enable console output for the current test
 *    disableConsole() - Disable console output again
 *
 *    Example:
 *    it('debug test', () => {
 *      enableConsole();
 *      console.log('This will be visible');
 *      // ... test code ...
 *    });
 *
 * 3. Restore console in specific tests:
 *    vi.restoreAllMocks() - Restores all mocks including console
 */

// ============================================================================
// Global Mocks - Available in all test files without explicit vi.mock() calls
// ============================================================================

// Mock chalk - commonly used across all test files for console output
// This mock makes all chalk methods pass-through (return input unchanged)
vi.mock('chalk', () => ({
  default: {
    blue: vi.fn((s) => s),
    green: vi.fn((s) => s),
    yellow: vi.fn((s) => s),
    red: vi.fn((s) => s),
    cyan: vi.fn((s) => s),
    gray: vi.fn((s) => s),
    magenta: vi.fn((s) => s),
    white: vi.fn((s) => s),
    bold: vi.fn((s) => s),
  },
}));

// Mock dotenv - prevent loading .env files during tests
vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
}));

// ============================================================================
// Console Suppression - Mock console methods to prevent output from code under test
// Can be disabled via DEBUG_CONSOLE environment variable for debugging
// ============================================================================

// Setup console spies immediately (before any modules are imported)
// This ensures spies exist for tests that assert on console calls
// Output suppression depends on enableConsoleOutput flag
setupConsoleSpies();

// ============================================================================
// Test Lifecycle Hooks
// ============================================================================

// Ensure console spies exist before each test
// Respects DEBUG_CONSOLE/SHOW_CONSOLE environment variable for output suppression
beforeEach(() => {
  // Always ensure spies exist (they may have been restored in a previous test)
  setupConsoleSpies();
});

// Clean up after each test
afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// Global Helper Functions
// ============================================================================

// Helper to create mock embedding vectors (384 dimensions for BGE-Small)
globalThis.createMockEmbedding = (dim = 384, value = 0.1) => new Array(dim).fill(value);

// Helper to create a mock file stats object
globalThis.createMockStats = (overrides = {}) => ({
  size: 1000,
  isFile: () => true,
  isDirectory: () => false,
  mtime: new Date(),
  ...overrides,
});

// Helper to mock all console methods - suppresses output during tests
// Usage: Call in beforeEach() to suppress console output
// NOTE: Console is already suppressed by default. Use this only if you need
// to re-suppress after calling enableConsole()
globalThis.mockConsole = () => {
  suppressConsole();
};

// Helper to restore console output for debugging
// Usage: enableConsole() in a test to see console.log statements
// Example:
//   it('debug test', () => {
//     enableConsole();
//     console.log('This will be visible');
//   });
globalThis.enableConsole = () => {
  restoreConsole();
};

// Helper to disable console output again after enabling it
// Usage: disableConsole() to re-suppress console output
globalThis.disableConsole = () => {
  suppressConsole();
};

// Helper to mock only specific console methods
// Usage: mockConsoleSelective('log', 'error')
globalThis.mockConsoleSelective = (...methods) => {
  methods.forEach((method) => {
    if (CONSOLE_METHODS.includes(method)) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
};
