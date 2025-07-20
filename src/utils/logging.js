/**
 * Logging Module
 *
 * This module provides debugging and logging utilities with support
 * for environment-based and command-line argument-based log level control.
 */

import chalk from 'chalk';

/**
 * Debug function for conditional logging based on environment variables and command line arguments
 *
 * @param {string} message - Debug message to log
 *
 * @example
 * debug('Processing file: example.js');
 * // Only logs if DEBUG=true, VERBOSE=true, or --verbose flag is present
 */
export function debug(message) {
  const DEBUG = process.env.DEBUG || false;
  if (DEBUG || process.env.VERBOSE === 'true' || process.argv.includes('--verbose')) {
    console.log(chalk.cyan(`[DEBUG] ${message}`));
  }
}
