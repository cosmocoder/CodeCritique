/**
 * CLI Utilities for PR History Analysis
 *
 * Provides utility functions for GitHub repository detection,
 * project path handling, and CLI integration.
 */

import { execSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';

/**
 * Detect GitHub repository from git remote origin
 * @param {string} projectPath - Project directory path
 * @returns {string|null} Repository in format "owner/repo" or null if not found
 */
function detectGitHubRepository(projectPath) {
  try {
    const gitDir = path.join(projectPath, '.git');
    if (!fs.existsSync(gitDir)) {
      return null;
    }

    // Get remote origin URL
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: projectPath,
      encoding: 'utf8',
    }).trim();

    // Parse GitHub repository from various URL formats
    const patterns = [
      /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/, // SSH or HTTPS
      /github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/, // HTTPS
    ];

    for (const pattern of patterns) {
      const match = remoteUrl.match(pattern);
      if (match) {
        return `${match[1]}/${match[2]}`;
      }
    }

    return null;
  } catch (error) {
    console.warn(chalk.yellow(`Warning: Could not detect GitHub repository: ${error.message}`));
    return null;
  }
}

/**
 * Get GitHub token from options or environment
 * @param {Object} options - CLI options
 * @returns {string|null} GitHub token or null if not found
 */
function getGitHubToken(options) {
  return options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

/**
 * Resolve project path following the same strategy as embeddings.js
 * @param {string} directory - Directory option from CLI
 * @returns {string} Resolved project path
 */
function resolveProjectPath(directory) {
  return directory ? path.resolve(directory) : process.cwd();
}

/**
 * Validate GitHub repository format
 * @param {string} repository - Repository string
 * @returns {boolean} True if valid format
 */
function isValidRepositoryFormat(repository) {
  if (!repository || typeof repository !== 'string') {
    return false;
  }

  // Check for "owner/repo" format
  const parts = repository.split('/');
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

/**
 * Get repository and project path from CLI options
 * @param {Object} options - CLI options
 * @returns {Object} Object with repository and projectPath
 */
export function getRepositoryAndProjectPath(options) {
  // Determine project path using the same strategy as embeddings.js
  const projectPath = resolveProjectPath(options.directory);

  // Determine repository
  let repository = options.repository;
  if (!repository) {
    repository = detectGitHubRepository(projectPath);
    if (!repository) {
      throw new Error(
        'Could not detect GitHub repository. Please specify repository with --repository option or ensure you are in a Git repository with GitHub remote.'
      );
    }
    console.log(chalk.green(`Auto-detected repository: ${repository}`));
  } else {
    if (!isValidRepositoryFormat(repository)) {
      throw new Error('Invalid repository format. Please use "owner/repo" format.');
    }
    console.log(chalk.cyan(`Using specified repository: ${repository}`));
  }

  return { repository, projectPath };
}

/**
 * Validate GitHub token
 * @param {Object} options - CLI options
 * @returns {string} GitHub token
 * @throws {Error} If token is not found
 */
export function validateGitHubToken(options) {
  const token = getGitHubToken(options);
  if (!token) {
    throw new Error('GitHub token is required. Please provide token with --token option or set GITHUB_TOKEN environment variable.');
  }
  return token;
}

/**
 * Display progress information
 * @param {Object} progress - Progress object
 * @param {boolean} verbose - Whether to show verbose output
 */
export function displayProgress(progress, verbose) {
  if (verbose) {
    console.log(chalk.blue(`[${progress.stage}] ${progress.message} (${progress.current}/${progress.total})`));
  }
}

/**
 * Display analysis results summary
 * @param {Object} results - Analysis results
 * @param {number} duration - Duration in seconds
 */
export function displayAnalysisResults(results, duration) {
  console.log(chalk.green(`\nAnalysis completed in ${duration}s`));
  console.log(chalk.green(`Repository: ${results.repository}`));
  console.log(chalk.green(`Total PRs: ${results.total_prs}`));
  console.log(chalk.green(`Total Comments: ${results.total_comments}`));

  if (results.patterns && results.patterns.length > 0) {
    console.log(chalk.blue('\nTop Patterns:'));
    results.patterns.slice(0, 10).forEach((pattern) => {
      console.log(chalk.cyan(`  ${pattern.type}: ${pattern.name} (${pattern.count} - ${pattern.percentage}%)`));
    });
  }

  if (results.top_authors && results.top_authors.length > 0) {
    console.log(chalk.blue('\nTop Authors:'));
    results.top_authors.slice(0, 5).forEach((author) => {
      console.log(chalk.cyan(`  ${author.author}: ${author.count} comments`));
    });
  }
}

/**
 * Display status information
 * @param {Object} status - Status object
 */
export function displayStatus(status) {
  console.log(chalk.blue('\nAnalysis Status:'));
  console.log(chalk.cyan(`Repository: ${status.repository}`));
  console.log(chalk.cyan(`Status: ${status.status}`));

  if (status.status !== 'not_started') {
    console.log(chalk.cyan(`PRs: ${status.prs}`));
    console.log(chalk.cyan(`Comments: ${status.comments}`));

    if (status.failed_comments > 0) {
      console.log(chalk.yellow(`Failed Comments: ${status.failed_comments}`));
    }

    if (status.errors > 0) {
      console.log(chalk.red(`Errors: ${status.errors}`));
    }

    if (status.elapsed) {
      console.log(chalk.cyan(`Elapsed Time: ${status.elapsed}`));
    }
  }
}

/**
 * Display database statistics
 * @param {Object} stats - Database statistics
 * @param {boolean} hasComments - Whether comments exist in database
 */
export function displayDatabaseStats(stats, hasComments) {
  if (hasComments) {
    console.log(chalk.blue('\nStored Data:'));
    console.log(chalk.cyan(`Total Comments in Database: ${stats.total_comments}`));
    console.log(chalk.cyan(`Comment Types: ${Object.keys(stats.comment_types).join(', ')}`));
  } else {
    console.log(chalk.yellow('\nNo PR comments found in database for this repository.'));
  }
}
