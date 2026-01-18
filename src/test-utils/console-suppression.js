/**
 * Console suppression utilities for tests
 *
 * Provides functions to suppress or enable console output during test execution.
 * By default, console output is suppressed, but can be enabled via DEBUG_CONSOLE
 * environment variable or helper functions.
 */

// Check if console output should be enabled (for debugging)
// Set DEBUG_CONSOLE=true or SHOW_CONSOLE=true to see all console output
const enableConsoleOutput = process.env.DEBUG_CONSOLE === 'true' || process.env.SHOW_CONSOLE === 'true';

// Console methods to spy on
export const CONSOLE_METHODS = ['log', 'warn', 'error', 'info', 'debug'];

// Store references to console spies for later restoration
const consoleSpies = {};

/**
 * Setup console spies - always creates spies so tests can assert on console calls
 * If suppression is enabled, mocks the implementation to suppress output
 * If DEBUG_CONSOLE is enabled, spies but calls through to original (shows output)
 */
export function setupConsoleSpies() {
  // Check if spies need to be created or recreated (they may have been restored)
  const needsSpies = !consoleSpies.log || !vi.isMockFunction(console.log);

  if (needsSpies) {
    CONSOLE_METHODS.forEach((method) => {
      if (enableConsoleOutput) {
        // Spy but call through to original - shows output but allows assertions
        consoleSpies[method] = vi.spyOn(console, method);
      } else {
        // Spy and suppress output
        consoleSpies[method] = vi.spyOn(console, method).mockImplementation(() => {});
      }
    });
  }
}

/**
 * Suppress console output by mocking console methods
 * This prevents logs from code under test from appearing
 * Always suppresses, regardless of DEBUG_CONSOLE flag (for disableConsole() helper)
 */
export function suppressConsole() {
  setupConsoleSpies();
  // Force suppression by mocking implementation
  CONSOLE_METHODS.forEach((method) => {
    if (consoleSpies[method]) {
      consoleSpies[method].mockImplementation(() => {});
    }
  });
}

/**
 * Restore console output (useful for debugging specific tests)
 * This allows console.log statements in test files to work normally
 * Restores spies to call through to original implementation
 */
export function restoreConsole() {
  CONSOLE_METHODS.forEach((method) => {
    if (consoleSpies[method]) {
      // Restore to call through to original (remove mock implementation)
      consoleSpies[method].mockRestore();
      // Re-spy but call through (no mockImplementation)
      consoleSpies[method] = vi.spyOn(console, method);
    }
  });
}
