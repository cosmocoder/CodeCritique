/**
 * File Validation Module
 *
 * This module provides utilities for validating, filtering, and determining
 * if files should be processed based on various criteria such as file type,
 * size, patterns, and gitignore rules.
 */

import fs from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';
import { execGitSafe } from './command.js';
import {
  CODE_EXTENSIONS,
  DOCUMENTATION_EXTENSIONS,
  BINARY_EXTENSIONS,
  SKIP_DIRECTORIES,
  SKIP_FILENAMES,
  SKIP_FILE_PATTERNS,
} from './constants.js';

/**
 * Checks if a file path looks like a test file based on common patterns.
 * Tries to be relatively language/framework agnostic.
 *
 * @param {string} filePath - Path to the file.
 * @returns {boolean} True if the path matches test patterns, false otherwise.
 *
 * @example
 * isTestFile('src/components/__tests__/Button.test.js'); // true
 * isTestFile('test/unit/validator.spec.js'); // true
 * isTestFile('src/utils.js'); // false
 */
export function isTestFile(filePath) {
  if (!filePath) return false;
  const lowerPath = filePath.toLowerCase();
  // Common patterns: /__tests__/, /tests/, /specs/, _test., _spec., .test., .spec.
  // Ensure delimiters are present or it's in a specific test directory.
  // Checks for directory names or common patterns immediately preceding the file extension.
  const testPattern = /(\/__tests__\/|\/tests?\/|\/specs?\/|_test\.|_spec\.|\.test\.|\.spec\.)/i;
  return testPattern.test(lowerPath);
}

/**
 * Checks if a file is a documentation file based on extension, path patterns, and filename
 *
 * @param {string} filePath - Path to the file
 * @returns {boolean} True if the file is documentation, false otherwise
 *
 * @example
 * isDocumentationFile('README.md'); // true
 * isDocumentationFile('docs/api.md'); // true
 * isDocumentationFile('src/utils.js'); // false
 */
export function isDocumentationFile(filePath) {
  const lowerPath = filePath.toLowerCase();
  const filename = lowerPath.split('/').pop();
  const extension = path.extname(lowerPath);

  // 1. Explicitly identify common code file extensions as NOT documentation
  if (CODE_EXTENSIONS.includes(extension)) {
    return false;
  }

  // 2. Check for specific documentation extensions
  if (DOCUMENTATION_EXTENSIONS.includes(extension)) {
    return true;
  }

  // 3. Check for universally accepted file names (case-insensitive)
  const docFilenames = ['readme', 'license', 'contributing', 'changelog', 'copying'];
  const filenameWithoutExt = filename.substring(0, filename.length - (extension.length || 0));
  if (docFilenames.includes(filenameWithoutExt)) {
    return true;
  }

  // 4. Check for common documentation directories (less reliable but useful)
  const docDirs = ['/docs/', '/documentation/', '/doc/', '/wiki/', '/examples/', '/guides/'];
  if (docDirs.some((dir) => lowerPath.includes(dir))) {
    return true;
  }

  // 5. Check for other common documentation terms in filename (lowest priority)
  const docTerms = ['guide', 'tutorial', 'manual', 'howto'];
  if (docTerms.some((term) => filename.includes(term))) {
    return true;
  }

  // 6. Special case for plain text files that look like docs
  if (extension === '.txt') {
    if (docFilenames.includes(filenameWithoutExt) || docTerms.some((term) => filename.includes(term))) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a file should be processed based on its path and content
 *
 * @param {string} filePath - Path to the file
 * @param {string} content - Content of the file (optional, unused but kept for API compatibility)
 * @param {Object} options - Additional options
 * @param {Array<string>} options.excludePatterns - Patterns to exclude
 * @param {boolean} options.respectGitignore - Whether to respect .gitignore files
 * @param {string} options.baseDir - Base directory for relative paths
 * @returns {boolean} Whether the file should be processed
 *
 * @example
 * const shouldProcess = shouldProcessFile('src/utils.js', '', {
 *   excludePatterns: ['*.test.js'],
 *   respectGitignore: true
 * });
 */
export function shouldProcessFile(filePath, _, options = {}) {
  const { excludePatterns = [], respectGitignore = true, baseDir = process.cwd() } = options;

  // Skip files that are too large (>1MB)
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) {
      return false;
    }
  } catch {
    // If we can't get file stats, assume it's processable
  }

  // Skip binary files
  const extension = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.includes(extension)) {
    return false;
  }

  // Skip node_modules, dist, build directories
  if (SKIP_DIRECTORIES.some((dir) => filePath.includes(`/${dir}/`))) {
    return false;
  }

  // Skip specific filenames like lock files
  if (SKIP_FILENAMES.includes(path.basename(filePath))) {
    return false;
  }

  // Skip files that are likely to be generated
  if (SKIP_FILE_PATTERNS.some((pattern) => pattern.test(filePath))) {
    return false;
  }

  // Check custom exclude patterns
  if (excludePatterns.length > 0) {
    const relativePath = path.relative(baseDir, filePath);
    if (excludePatterns.some((pattern) => minimatch(relativePath, pattern, { dot: true }))) {
      return false;
    }
  }

  // Check gitignore patterns if enabled
  if (respectGitignore) {
    try {
      // Calculate relative path from baseDir for git check-ignore
      const relativePath = path.relative(baseDir, filePath);

      // Use git check-ignore to determine if a file is ignored
      // This is the most accurate way to check as it uses Git's own ignore logic
      // Use baseDir as cwd to ensure git runs in the correct context
      execGitSafe('git check-ignore', ['-q', relativePath], {
        stdio: 'ignore',
        cwd: baseDir,
      });

      // If we get here, the file is ignored by git
      return false;
    } catch {
      // If git check-ignore exits with non-zero status, the file is not ignored
      // This is expected behavior, so we continue processing
    }
  }

  return true;
}
