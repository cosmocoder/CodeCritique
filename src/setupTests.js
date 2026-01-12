/**
 * Global test setup for Vitest
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
// Test Lifecycle Hooks
// ============================================================================

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
globalThis.mockConsole = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
};

// Helper to mock only specific console methods
// Usage: mockConsoleSelective('log', 'error')
globalThis.mockConsoleSelective = (...methods) => {
  for (const method of methods) {
    if (['log', 'warn', 'error', 'info', 'debug'].includes(method)) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  }
};
