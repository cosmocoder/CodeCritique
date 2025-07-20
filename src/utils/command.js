/**
 * Command Execution Module
 *
 * This module provides utilities for safely executing shell commands,
 * particularly focused on git operations with proper argument escaping
 * to prevent command injection attacks.
 */

import { execSync } from 'child_process';

/**
 * Safely escape shell arguments to prevent command injection
 *
 * @param {string} arg - The argument to escape
 * @returns {string} The safely escaped argument
 *
 * @example
 * const safeArg = escapeShellArg("user's file.txt");
 * // Returns: 'user'\''s file.txt'
 */
function escapeShellArg(arg) {
  if (!arg || typeof arg !== 'string') {
    return "''";
  }

  // For POSIX shells, single quotes preserve everything literally
  // We escape single quotes by ending the quoted string, adding an escaped quote, and starting a new quoted string
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Safely execute git commands by escaping all arguments
 *
 * @param {string} baseCommand - The base git command (e.g., 'git show')
 * @param {Array<string>} args - Array of arguments to escape and append
 * @param {Object} options - Options to pass to execSync
 * @returns {string} The command output
 *
 * @example
 * const result = execGitSafe('git show', ['HEAD~1', 'src/file.js'], { cwd: '/path/to/repo' });
 *
 * @throws {Error} If the command execution fails
 */
export function execGitSafe(baseCommand, args = [], options = {}) {
  const escapedArgs = args.map((arg) => escapeShellArg(arg)).join(' ');
  const fullCommand = escapedArgs ? `${baseCommand} ${escapedArgs}` : baseCommand;
  return execSync(fullCommand, options);
}
