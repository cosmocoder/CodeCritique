/**
 * Logging Module
 *
 * This module provides debugging and logging utilities with support
 * for environment-based and command-line argument-based log level control.
 */

import chalk from 'chalk';

/**
 * Determine whether verbose logging is enabled.
 *
 * @param {Object|boolean} [options] - Options object or boolean verbose flag
 * @returns {boolean} True when verbose logging should be emitted
 */
export function isVerboseEnabled(options = {}) {
  const cliVerboseEnabled = process.env.VERBOSE === 'true' || process.argv.includes('--verbose');
  const optionVerboseEnabled = typeof options === 'boolean' ? options : Boolean(options?.verbose);

  return Boolean(cliVerboseEnabled || optionVerboseEnabled);
}

/**
 * Determine whether debug logging is enabled.
 *
 * @returns {boolean} True when debug logging should be emitted
 */
export function isDebugEnabled() {
  return Boolean(process.env.DEBUG);
}

/**
 * Log only when verbose output is enabled.
 *
 * @param {Object|boolean} options - Options object or boolean verbose flag
 * @param {...any} args - Arguments to pass to console.log
 */
export function verboseLog(options, ...args) {
  if (isVerboseEnabled(options)) {
    console.log(...args);
  }
}

/**
 * Debug function for conditional logging based on environment variables and command line arguments
 *
 * @param {string} message - Debug message to log
 *
 * @example
 * debug('Processing file: example.js');
 * // Only logs if DEBUG=true
 */
export function debug(message) {
  if (isDebugEnabled()) {
    console.log(chalk.cyan(`[DEBUG] ${message}`));
  }
}
