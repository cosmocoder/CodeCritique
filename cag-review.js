/**
 * CAG Review Module
 *
 * This module serves as the main entry point for the dynamic, context-augmented
 * code review process. It coordinates file discovery and analysis,
 * relying on dynamic context retrieval via embeddings.
 */

import * as glob from 'glob';
import { analyzeFile } from './cag-analyzer.js';
import { fileURLToPath } from 'url';
import { shouldProcessFile } from './utils.js';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Review a single file using CAG approach
 *
 * @param {string} filePath - Path to the file to review
 * @param {object} options - Review options
 * @returns {Promise<object>} Review result object
 */
async function reviewFile(filePath, options = {}) {
  try {
    console.log(chalk.blue(`Reviewing file: ${filePath}`));

    // Analyze the file using the CAG analyzer
    const analyzeResult = await analyzeFile(filePath, options);

    // If analysis successful, return the result
    if (analyzeResult.success) {
      // Convert object results to array format expected by the output functions
      if (analyzeResult.results && !Array.isArray(analyzeResult.results)) {
        console.log(chalk.blue('Converting results object to array format'));

        // Create a new array with one entry containing the object results
        const resultArray = [
          {
            filePath: analyzeResult.filePath,
            language: analyzeResult.language,
            success: true,
            results: analyzeResult.results,
          },
        ];

        return {
          success: true,
          results: resultArray,
        };
      }

      return analyzeResult;
    }

    // If analysis failed, return the error
    return analyzeResult;
  } catch (error) {
    console.error(chalk.red(`Error reviewing file ${filePath}:`), error.message);
    return {
      success: false,
      error: error.message,
      filePath,
    };
  }
}

/**
 * Review multiple files using dynamic context retrieval.
 *
 * @param {Array<string>} filePaths - Paths to the files to review
 * @param {Object} options - Review options (passed to each reviewFile call)
 * @returns {Promise<Object>} Aggregated review results { success: boolean, results: Array<Object>, message: string, error?: string }
 */
async function reviewFiles(filePaths, options = {}) {
  try {
    const verbose = options.verbose || false;
    if (verbose) {
      console.log(chalk.blue(`Reviewing ${filePaths.length} files...`));
    }

    // Review files concurrently
    const results = [];
    const concurrency = options.concurrency || 3; // Limit concurrency for API calls/CPU usage

    // Process files in batches to limit concurrency
    for (let i = 0; i < filePaths.length; i += concurrency) {
      const batch = filePaths.slice(i, i + concurrency);

      if (verbose) {
        console.log(
          chalk.blue(
            `Processing review batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(filePaths.length / concurrency)} (${
              batch.length
            } files)`
          )
        );
      }

      // Pass options down to reviewFile
      const batchPromises = batch.map((filePath) => reviewFile(filePath, options));
      const batchResults = await Promise.all(batchPromises);

      results.push(...batchResults);
    }

    // Filter out potential null results if any step could return null/undefined (though analyzeFile should always return an object)
    const validResults = results.filter((r) => r != null);
    const successCount = validResults.filter((r) => r.success && !r.skipped).length;
    const skippedCount = validResults.filter((r) => r.skipped).length;
    const errorCount = validResults.filter((r) => !r.success).length;

    let finalMessage = `Review completed for ${filePaths.length} files. `;
    finalMessage += `Success: ${successCount}, Skipped: ${skippedCount}, Errors: ${errorCount}.`;

    console.log(chalk.green(finalMessage));

    return {
      success: errorCount === 0,
      results: validResults, // Return array of individual file results
      message: finalMessage,
    };
  } catch (error) {
    console.error(chalk.red(`Error reviewing multiple files: ${error.message}`));
    console.error(error.stack);
    return {
      success: false,
      error: error.message,
      results: [],
      message: 'Failed to review files due to an unexpected error',
    };
  }
}

/**
 * Review a directory using dynamic context retrieval.
 *
 * @param {string} dirPath - Path to the directory to review
 * @param {Object} options - Review options (includes filePattern, excludePatterns, and options for reviewFiles)
 * @returns {Promise<Object>} Aggregated review results
 */
async function reviewDirectory(dirPath, options = {}) {
  try {
    const verbose = options.verbose || false;
    if (verbose) {
      console.log(chalk.blue(`Reviewing directory: ${dirPath}`));
    }

    // Check if directory exists
    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    // Find files to review using glob
    // Default patterns match common code files, excluding node_modules etc.
    const filePattern = options.filePattern || '**/*.{js,jsx,ts,tsx,py,rb,java,go,php,cs,c,cpp,html,css,scss,json,md,yml,yaml}';
    const defaultExcludes = [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.*/**',
      '**/*.min.*',
      '**/vendor/**',
      '**/tmp/**',
      '**/coverage/**',
    ];
    const excludePatterns = options.excludePatterns ? [...defaultExcludes, ...options.excludePatterns] : defaultExcludes;

    const filePaths = await findFiles(dirPath, filePattern, excludePatterns, verbose);

    if (filePaths.length === 0) {
      const message = 'No files found matching the pattern in the specified directory (respecting exclusions).';
      console.log(chalk.yellow(message));
      return {
        success: true,
        message: message,
        results: [],
      };
    }

    if (verbose) {
      console.log(chalk.green(`Found ${filePaths.length} files to review in directory`));
    }

    // Review the found files, passing options down
    return await reviewFiles(filePaths, options);
  } catch (error) {
    console.error(chalk.red(`Error reviewing directory ${dirPath}: ${error.message}`));
    console.error(error.stack);
    return {
      success: false,
      error: error.message,
      message: 'Failed to review directory',
      results: [],
    };
  }
}

/**
 * Find files in a directory matching a pattern using glob.
 *
 * @param {string} dirPath - Directory path
 * @param {string} pattern - File pattern (glob syntax)
 * @param {Array<string>} excludePatterns - Patterns to exclude
 * @param {boolean} verbose - Log detailed output
 * @returns {Promise<Array<string>>} Array of absolute file paths
 */
function findFiles(dirPath, pattern, excludePatterns = [], verbose = false) {
  return new Promise((resolve, reject) => {
    const globOptions = {
      cwd: dirPath,
      ignore: excludePatterns,
      absolute: true, // Get absolute paths
      nodir: true, // Exclude directories
      dot: false, // Exclude dotfiles/dotdirectories by default (can be overridden in pattern)
    };

    if (verbose) {
      console.log(`Glob pattern: ${pattern}`);
      console.log(`Glob options:`, globOptions);
    }

    glob
      .glob(pattern, globOptions)
      .then((files) => {
        if (verbose) {
          console.log(`Glob found ${files.length} initial matches.`);
        }
        // Filter files based on shouldProcessFile (e.g., binary check)
        // This ensures we don't try to read/analyze unsuitable files found by glob
        const filteredFiles = files.filter((file) => {
          try {
            // Basic check: Does the file exist and is it a file?
            const stat = fs.statSync(file);
            if (!stat.isFile()) return false;

            // Content check using shouldProcessFile
            const content = fs.readFileSync(file, 'utf8');
            const shouldProcess = shouldProcessFile(file, content);
            if (!shouldProcess && verbose) {
              console.log(`Excluding file based on content check: ${file}`);
            }
            return shouldProcess;
          } catch (error) {
            // Handle potential read errors gracefully
            console.warn(chalk.yellow(`Skipping file due to read error ${file}: ${error.message}`));
            return false;
          }
        });

        if (verbose) {
          console.log(`Found ${filteredFiles.length} processable files after filtering.`);
        }
        resolve(filteredFiles);
      })
      .catch((err) => {
        console.error(chalk.red(`Glob error: ${err.message}`));
        reject(err);
      });
  });
}

/**
 * Review files changed in a pull request (requires changed file paths).
 *
 * @param {Array<string>} changedFilePaths - Array of file paths changed in the PR.
 * @param {Object} options - Review options (passed to reviewFiles).
 * @returns {Promise<Object>} Aggregated review results.
 */
async function reviewPullRequest(changedFilePaths, options = {}) {
  try {
    const verbose = options.verbose || false;
    if (verbose) {
      console.log(chalk.blue(`Reviewing ${changedFilePaths.length} changed files from PR...`));
    }

    // Filter out files that might not exist or shouldn't be processed
    const filesToReview = changedFilePaths.filter((filePath) => {
      if (!fs.existsSync(filePath)) {
        if (verbose) console.warn(chalk.yellow(`Changed file not found locally: ${filePath}`));
        return false;
      }
      // Add other checks if needed (e.g., based on status from PR data if available)
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        return shouldProcessFile(filePath, content);
      } catch (error) {
        console.warn(chalk.yellow(`Skipping changed file due to read error ${filePath}: ${error.message}`));
        return false;
      }
    });

    if (filesToReview.length === 0) {
      const message = 'No processable files found among the changed files provided for PR review.';
      console.log(chalk.yellow(message));
      return {
        success: true,
        message: message,
        results: [],
      };
    }

    if (verbose) {
      console.log(chalk.green(`Reviewing ${filesToReview.length} existing and processable changed files`));
    }

    // Review the filtered list of changed files
    // Pass options down to reviewFiles
    return await reviewFiles(filesToReview, options);
  } catch (error) {
    console.error(chalk.red(`Error reviewing pull request files: ${error.message}`));
    console.error(error.stack);
    return {
      success: false,
      error: error.message,
      message: 'Failed to review pull request files',
      results: [],
    };
  }
}

// Export the core review functions
export { reviewFile, reviewFiles, reviewDirectory, reviewPullRequest };
