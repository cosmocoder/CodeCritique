/**
 * PR History Utilities
 *
 * Utility functions for PR history analysis including repository detection
 * and project path management.
 */

import { execSync } from 'child_process';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Extract GitHub repository information from a project directory
 * @param {string} projectDir - Project directory path
 * @returns {Promise<string|null>} Repository in format "owner/repo" or null if not found
 */
export async function extractRepositoryFromDirectory(projectDir) {
  try {
    const resolvedDir = path.resolve(projectDir);

    // Check if directory exists
    try {
      await fs.access(resolvedDir);
    } catch {
      throw new Error(`Directory not found: ${resolvedDir}`);
    }

    // Method 1: Try to get remote origin from git
    try {
      const gitRemote = execSync('git remote get-url origin', {
        cwd: resolvedDir,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      const repository = parseGitRemoteUrl(gitRemote);
      if (repository) {
        console.log(chalk.green(`Detected repository from git remote: ${repository}`));
        return repository;
      }
    } catch (gitError) {
      console.log(chalk.yellow('Could not detect repository from git remote'));
    }

    // Method 2: Try to read from package.json
    try {
      const packageJsonPath = path.join(resolvedDir, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      if (packageJson.repository) {
        const repository = parseRepositoryField(packageJson.repository);
        if (repository) {
          console.log(chalk.green(`Detected repository from package.json: ${repository}`));
          return repository;
        }
      }
    } catch (packageError) {
      console.log(chalk.yellow('Could not detect repository from package.json'));
    }

    // Method 3: Try to read from .git/config
    try {
      const gitConfigPath = path.join(resolvedDir, '.git', 'config');
      const gitConfig = await fs.readFile(gitConfigPath, 'utf8');

      const remoteMatch = gitConfig.match(/\[remote "origin"\][\s\S]*?url = (.+)/);
      if (remoteMatch) {
        const repository = parseGitRemoteUrl(remoteMatch[1].trim());
        if (repository) {
          console.log(chalk.green(`Detected repository from .git/config: ${repository}`));
          return repository;
        }
      }
    } catch (configError) {
      console.log(chalk.yellow('Could not detect repository from .git/config'));
    }

    return null;
  } catch (error) {
    console.warn(chalk.yellow(`Warning: Could not extract repository from directory: ${error.message}`));
    return null;
  }
}

/**
 * Parse git remote URL to extract owner/repo
 * @private
 * @param {string} remoteUrl - Git remote URL
 * @returns {string|null} Repository in format "owner/repo" or null
 */
function parseGitRemoteUrl(remoteUrl) {
  if (!remoteUrl) return null;

  // Handle different Git URL formats
  const patterns = [
    // SSH format: git@github.com:owner/repo.git
    /git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    // HTTPS format: https://github.com/owner/repo.git
    /https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
    // HTTP format: http://github.com/owner/repo.git
    /http:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = remoteUrl.match(pattern);
    if (match) {
      const owner = match[1];
      const repo = match[2];
      return `${owner}/${repo}`;
    }
  }

  return null;
}

/**
 * Parse repository field from package.json
 * @private
 * @param {string|Object} repository - Repository field from package.json
 * @returns {string|null} Repository in format "owner/repo" or null
 */
function parseRepositoryField(repository) {
  if (!repository) return null;

  let url;
  if (typeof repository === 'string') {
    url = repository;
  } else if (repository.url) {
    url = repository.url;
  } else {
    return null;
  }

  // Handle github: shorthand
  if (url.startsWith('github:')) {
    return url.replace('github:', '');
  }

  // Handle git+ prefixes
  if (url.startsWith('git+')) {
    url = url.substring(4);
  }

  return parseGitRemoteUrl(url);
}

/**
 * Get project identifier for database isolation
 * @param {string} projectDir - Project directory path
 * @returns {string} Project identifier for database isolation
 */
export function getProjectIdentifier(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  const projectName = path.basename(resolvedDir);

  // Create a stable identifier based on the absolute path
  // This ensures different projects with the same name are isolated
  const pathHash = Buffer.from(resolvedDir).toString('base64').replace(/[/+=]/g, '').substring(0, 8);

  return `${projectName}-${pathHash}`;
}

/**
 * Resolve repository and project information
 * @param {string|null} repository - Explicit repository or null to auto-detect
 * @param {string} directory - Project directory
 * @returns {Promise<Object>} Repository and project information
 */
export async function resolveRepositoryInfo(repository, directory = '.') {
  const projectDir = path.resolve(directory);
  const projectId = getProjectIdentifier(projectDir);

  let resolvedRepository = repository;

  if (!resolvedRepository) {
    resolvedRepository = await extractRepositoryFromDirectory(projectDir);
  }

  if (!resolvedRepository) {
    throw new Error(
      `Could not determine GitHub repository. Please specify it explicitly or ensure the project directory contains git remote information.`
    );
  }

  // Validate repository format
  if (!resolvedRepository.match(/^[^/]+\/[^/]+$/)) {
    throw new Error(`Invalid repository format: ${resolvedRepository}. Expected format: owner/repo`);
  }

  return {
    repository: resolvedRepository,
    projectDir,
    projectId,
  };
}
