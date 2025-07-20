/**
 * Git Operations Module
 *
 * This module provides utilities for git operations including branch management,
 * diff analysis, and content retrieval from different branches or commits.
 */

import { execSync } from 'child_process';
import path from 'path';
import chalk from 'chalk';
import { execGitSafe } from './command.js';

/**
 * Check if a git branch exists locally
 *
 * @param {string} branchName - The name of the branch to check
 * @param {string} workingDir - Directory to run git commands in (optional, defaults to cwd)
 * @returns {boolean} True if the branch exists, false otherwise
 *
 * @example
 * const exists = checkBranchExists('feature-branch');
 * if (exists) {
 *   console.log('Branch exists locally');
 * }
 */
function checkBranchExists(branchName, workingDir = process.cwd()) {
  try {
    execGitSafe('git show-ref', ['--verify', '--quiet', `refs/heads/${branchName}`], { cwd: workingDir });
    return true;
  } catch {
    // Command returns non-zero exit code if branch doesn't exist
    return false;
  }
}

/**
 * Ensure a branch exists locally, fetching from remote if necessary
 *
 * @param {string} branchName - The name of the branch to ensure exists
 * @param {string} workingDir - Directory to run git commands in (optional, defaults to cwd)
 *
 * @example
 * await ensureBranchExists('main');
 * // Branch is now available locally for operations
 */
export function ensureBranchExists(branchName, workingDir = process.cwd()) {
  try {
    // Check if branch exists locally
    if (checkBranchExists(branchName, workingDir)) {
      console.log(chalk.gray(`Branch '${branchName}' exists locally`));
      return;
    }

    console.log(chalk.yellow(`Branch '${branchName}' not found locally, attempting to fetch...`));

    // Try to fetch the branch from origin
    try {
      execGitSafe('git fetch', ['origin', `${branchName}:${branchName}`], { stdio: 'pipe', cwd: workingDir });
      console.log(chalk.green(`Successfully fetched branch '${branchName}' from origin`));
    } catch {
      // If direct fetch fails, try fetching all branches and then checking
      console.log(chalk.yellow(`Direct fetch failed, trying to fetch all branches...`));
      execSync('git fetch origin', { stdio: 'pipe', cwd: workingDir });

      // Check if branch exists on remote
      try {
        execGitSafe('git show-ref', ['--verify', '--quiet', `refs/remotes/origin/${branchName}`], { cwd: workingDir });
        // Create local tracking branch
        execGitSafe('git checkout', ['-b', branchName, `origin/${branchName}`], { stdio: 'pipe', cwd: workingDir });
        console.log(chalk.green(`Successfully created local branch '${branchName}' tracking origin/${branchName}`));
      } catch {
        throw new Error(`Branch '${branchName}' not found locally or on remote origin`);
      }
    }
  } catch (error) {
    console.error(chalk.red(`Error ensuring branch '${branchName}' exists:`), error.message);
    throw error;
  }
}

/**
 * Find the base branch (main or master) that exists in the repository
 *
 * @param {string} workingDir - Directory to run git commands in (optional, defaults to cwd)
 * @returns {string} The name of the base branch (main, master, or develop)
 *
 * @example
 * const baseBranch = findBaseBranch();
 * console.log(`Using base branch: ${baseBranch}`);
 */
export function findBaseBranch(workingDir = process.cwd()) {
  const candidateBranches = ['main', 'master', 'develop'];

  for (const branch of candidateBranches) {
    if (checkBranchExists(branch, workingDir)) {
      return branch;
    }

    // Also check if it exists on remote
    try {
      execGitSafe('git show-ref', ['--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: workingDir });
      return branch;
    } catch {
      // Branch doesn't exist on remote either, continue to next candidate
    }
  }

  // Fallback to HEAD~1 if no standard base branch found
  console.warn(chalk.yellow('No standard base branch (main/master/develop) found, using HEAD~1 as fallback'));
  return 'HEAD~1';
}

/**
 * Get git diff content for a specific file between two branches/commits
 *
 * @param {string} filePath - Path to the file
 * @param {string} baseBranch - Base branch (e.g., 'main', 'master')
 * @param {string} targetBranch - Target branch (e.g., 'feature-branch')
 * @param {string} workingDir - Working directory for git commands
 * @returns {string} Git diff content for the file
 *
 * @example
 * const diff = getFileDiff('src/utils.js', 'main', 'feature-branch');
 * console.log('Changes:', diff);
 */
function getFileDiff(filePath, baseBranch, targetBranch, workingDir = process.cwd()) {
  try {
    // Use git diff to get changes for the specific file
    // Format: git diff base...target -- filepath
    const gitCommand = `git diff ${baseBranch}...${targetBranch} -- "${filePath}"`;
    const diffOutput = execSync(gitCommand, { cwd: workingDir, encoding: 'utf8' });

    return diffOutput;
  } catch (error) {
    console.error(chalk.red(`Error getting git diff for ${filePath}: ${error.message}`));
    return '';
  }
}

/**
 * Get changed lines info for a file between two branches
 *
 * @param {string} filePath - Path to the file
 * @param {string} baseBranch - Base branch
 * @param {string} targetBranch - Target branch
 * @param {string} workingDir - Working directory for git commands
 * @returns {Object} Object with added/removed lines info
 *
 * @example
 * const changes = getChangedLinesInfo('src/utils.js', 'main', 'feature-branch');
 * console.log(`Added ${changes.addedLines.length} lines, removed ${changes.removedLines.length} lines`);
 */
export function getChangedLinesInfo(filePath, baseBranch, targetBranch, workingDir = process.cwd()) {
  try {
    const diffOutput = getFileDiff(filePath, baseBranch, targetBranch, workingDir);

    if (!diffOutput) {
      return { hasChanges: false, addedLines: [], removedLines: [], contextLines: [] };
    }

    const lines = diffOutput.split('\n');
    const addedLines = [];
    const removedLines = [];
    const contextLines = [];

    let currentLineNumber = 0;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        // Parse line numbers from diff header like "@@ -10,7 +10,8 @@"
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (match) {
          currentLineNumber = parseInt(match[2]);
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        addedLines.push({ lineNumber: currentLineNumber, content: line.substring(1) });
        currentLineNumber++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removedLines.push({ content: line.substring(1) });
      } else if (line.startsWith(' ')) {
        contextLines.push({ lineNumber: currentLineNumber, content: line.substring(1) });
        currentLineNumber++;
      }
    }

    return {
      hasChanges: addedLines.length > 0 || removedLines.length > 0,
      addedLines,
      removedLines,
      contextLines,
      fullDiff: diffOutput,
    };
  } catch (error) {
    console.error(chalk.red(`Error parsing diff for ${filePath}: ${error.message}`));
    return { hasChanges: false, addedLines: [], removedLines: [], contextLines: [] };
  }
}

/**
 * Get the content of a file from a specific git branch/commit without checking it out
 *
 * @param {string} filePath - Absolute path to the file in the repository
 * @param {string} branchOrCommit - The branch or commit hash to get the file from
 * @param {string} workingDir - The git repository directory
 * @returns {string} The content of the file
 *
 * @example
 * const content = getFileContentFromGit('/path/to/file.js', 'main', '/repo');
 * console.log('File content from main branch:', content);
 */
export function getFileContentFromGit(filePath, branchOrCommit, workingDir) {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { cwd: workingDir }).toString().trim();
    const relativePath = path.relative(gitRoot, filePath);
    // Use forward slashes for git path
    const gitPath = relativePath.split(path.sep).join('/');

    // Command: git show <branch>:<path>
    // Use safe execution to prevent command injection
    return execGitSafe('git show', [`${branchOrCommit}:${gitPath}`], { cwd: workingDir, encoding: 'utf8' });
  } catch (error) {
    // Handle cases where the file might not exist in that commit (e.g., a new file in a feature branch)
    if (error.stderr && error.stderr.includes('exists on disk, but not in')) {
      // This case can be ignored if we are sure the file is new.
      // For a robust solution, you might need to check file status (new, modified, deleted).
      // For now, we return an empty string, assuming it's a new file not yet in the base.
      return '';
    }
    // Re-throw other errors
    throw new Error(`Failed to get content of ${filePath} from ${branchOrCommit}: ${error.message}`);
  }
}
