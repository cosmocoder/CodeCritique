#!/usr/bin/env node

/**
 * AI Code Review Tool - Command Line Interface
 *
 * Main entry point for the AI code review tool using the CAG approach.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { program } from 'commander';
import { Spinner } from 'cli-spinner';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

import * as embeddings from './embeddings.js';
import {
  checkBranchExists,
  detectFileType,
  detectLanguageFromExtension,
  ensureBranchExists,
  findBaseBranch,
  getSupportedFileExtensions,
  shouldProcessFile,
} from './utils.js';

// Import the refactored CAG review functions
import {
  reviewDirectory as cagReviewDirectory,
  reviewFile as cagReviewFile,
  reviewFiles as cagReviewFiles,
  reviewPullRequest as cagReviewPullRequest,
} from './cag-review.js';

// Import PR history analyzer and CLI utilities
import { cleanupClassifier } from './src/pr-history/database.js';
import {
  displayAnalysisResults,
  displayDatabaseStats,
  displayProgress,
  displayStatus,
  getRepositoryAndProjectPath,
  validateGitHubToken,
} from './src/pr-history/cli-utils.js';
import { PRHistoryAnalyzer } from './src/pr-history/analyzer.js';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Package info
import { readFileSync } from 'fs';
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Configure command-line interface
program.name('ai-code-review').description('CLI tool for AI-powered code review using the CAG approach').version(packageJson.version);

// Analyze command (restored from previous state if necessary, or kept as is)
program
  .command('analyze')
  .description('Analyze code using dynamic context (CAG approach)')
  .option('-b, --diff-with <branch>', 'Analyze files changed compared to a branch (triggers PR review mode)')
  .option('-f, --files <files...>', 'Specific files or glob patterns to review')
  .option('--file <file>', 'Analyze a single file')
  .option('-d, --directory <dir>', 'Working directory for git operations (use with --diff-with)')
  .option('-o, --output <format>', 'Output format (text, json, markdown)', 'text')
  .option('--no-color', 'Disable colored output')
  .option('--verbose', 'Show verbose output')
  .option('--provider <provider>', 'LLM provider to use (anthropic, openai)', 'anthropic')
  .option('--model <model>', 'LLM model to use (e.g., claude-3-5-sonnet-20240620)')
  .option('--temperature <number>', 'LLM temperature', parseFloat, 0.2)
  .option('--max-tokens <number>', 'LLM max tokens', parseInt, 2048)
  .option('--similarity-threshold <number>', 'Threshold for finding similar code examples', parseFloat, 0.6)
  .option('--max-examples <number>', 'Max similar code examples to use', parseInt, 5)
  .option('--concurrency <number>', 'Concurrency for processing multiple files', parseInt, 3)
  .action(runCodeReview); // Assumes runCodeReview function exists and is correct

// Existing Embeddings commands (ensure they are present and correct)
program
  .command('embeddings:generate')
  .description('Generate embeddings for the codebase')
  .option('-d, --directory <dir>', 'Directory to process', '.')
  .option('-f, --files <files...>', 'Specific files or patterns to process')
  .option('-c, --concurrency <number>', 'Number of concurrent embedding requests', '10') // Default concurrency 10
  .option('--verbose', 'Show verbose output')
  .option('--exclude <patterns...>', 'Patterns to exclude (e.g., "**/*.test.js" "docs/**")')
  .option('--exclude-file <file>', 'File containing patterns to exclude (one per line)')
  .option('--no-gitignore', 'Disable automatic exclusion of files in .gitignore')
  .action(generateEmbeddings); // Assumes generateEmbeddings function exists and is correct

program
  .command('embeddings:clear')
  .description('Clear stored embeddings for the current project')
  .option('-d, --directory <dir>', 'Directory of the project to clear embeddings for', '.')
  .action(clearEmbeddings);

program
  .command('embeddings:clear-all')
  .description('Clear ALL stored embeddings (affects all projects - use with caution)')
  .action(async () => {
    try {
      console.log(chalk.red('WARNING: This will clear embeddings for ALL projects on this machine!'));
      console.log(chalk.cyan('Clearing all embeddings...'));
      await embeddings.clearAllEmbeddings();
      console.log(chalk.green('All embeddings have been cleared.'));
      await embeddings.cleanup();
    } catch (err) {
      console.error(chalk.red('Error clearing all embeddings:'), err.message);
      try {
        await embeddings.cleanup();
      } catch (cleanupErr) {
        console.error(chalk.red('Error during cleanup:'), cleanupErr.message);
      }
      process.exit(1);
    }
  });

program
  .command('embeddings:stats')
  .description('Show statistics about stored embeddings')
  .option('-d, --directory <dir>', 'Directory of the project to show stats for (shows all projects if not specified)')
  .action(showEmbeddingStats);

// PR History Analysis commands
program
  .command('pr-history:analyze')
  .description('Analyze PR comment history for the current project or specified repository')
  .option('-d, --directory <dir>', 'Project directory to analyze (auto-detects GitHub repo)', '.')
  .option('-r, --repository <repo>', 'GitHub repository in format "owner/repo" (overrides auto-detection)')
  .option('-t, --token <token>', 'GitHub API token (or set GITHUB_TOKEN env var)')
  .option('--since <date>', 'Only analyze PRs since this date (ISO format)')
  .option('--until <date>', 'Only analyze PRs until this date (ISO format)')
  .option('--limit <number>', 'Limit number of PRs to analyze', parseInt)
  .option('--resume', 'Resume interrupted analysis')
  .option('--clear', 'Clear existing data before analysis')
  .option('--concurrency <number>', 'Number of concurrent requests', parseInt, 2)
  .option('--batch-size <number>', 'Batch size for processing', parseInt, 50)
  .option('--verbose', 'Show verbose output')
  .action(analyzePRHistory);

program
  .command('pr-history:status')
  .description('Check PR analysis status for the current project or specified repository')
  .option('-d, --directory <dir>', 'Project directory to check status for', '.')
  .option('-r, --repository <repo>', 'GitHub repository in format "owner/repo" (overrides auto-detection)')
  .action(getPRHistoryStatus);

program
  .command('pr-history:clear')
  .description('Clear PR analysis data for the current project or specified repository')
  .option('-d, --directory <dir>', 'Project directory to clear data for', '.')
  .option('-r, --repository <repo>', 'GitHub repository in format "owner/repo" (overrides auto-detection)')
  .option('--force', 'Skip confirmation prompts')
  .action(clearPRHistory);

// Add examples to the help text (simplified analyze examples)
program.on('--help', () => {
  console.log(`
Examples:
  $ ai-code-review analyze --directory src/components
  $ ai-code-review analyze --file src/utils/validation.ts
  $ ai-code-review analyze --files "src/**/*.tsx" "lib/*.js"
  $ ai-code-review analyze -b main
  $ ai-code-review analyze --diff-with feature-branch -d /path/to/repo
  $ ai-code-review analyze --output json > review-results.json
  $ ai-code-review embeddings:generate --directory src
  $ ai-code-review embeddings:generate --exclude "**/*.test.js" "**/*.spec.js"
  $ ai-code-review embeddings:generate --exclude-file .embedignore
  $ ai-code-review embeddings:generate --no-gitignore
  $ ai-code-review embeddings:stats
  $ ai-code-review embeddings:stats --directory /path/to/project
  $ ai-code-review embeddings:clear
  $ ai-code-review embeddings:clear --directory /path/to/project
  $ ai-code-review embeddings:clear-all
  $ ai-code-review pr-history:analyze
  $ ai-code-review pr-history:analyze --repository owner/repo --token ghp_xxx
  $ ai-code-review pr-history:analyze --directory /path/to/project --since 2024-01-01
  $ ai-code-review pr-history:status
  $ ai-code-review pr-history:status --repository owner/repo
  $ ai-code-review pr-history:clear
  $ ai-code-review pr-history:clear --repository owner/repo --force
`);
});

// For backward compatibility with the old command format
const hasCommand = process.argv
  .slice(2)
  .some(
    (arg) =>
      arg === 'analyze' ||
      arg === 'embeddings:generate' ||
      arg === 'embeddings:clear' ||
      arg === 'embeddings:clear-all' ||
      arg === 'embeddings:stats' ||
      arg === 'pr-history:analyze' ||
      arg === 'pr-history:status' ||
      arg === 'pr-history:clear'
  );

if (!hasCommand && process.argv.length > 2) {
  // If no command is specified but there are arguments, default to 'analyze'
  program.parse(['node', 'index.js', 'analyze', ...process.argv.slice(2)]);
} else {
  program.parse();
}

// Register process event handlers for cleanup (embeddings cleanup primarily)
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\nReceived SIGINT. Attempting graceful shutdown...'));
  // Set a timeout to force exit if cleanup hangs
  const forceExitTimeout = setTimeout(() => {
    console.error(chalk.red('Cleanup timed out after 10 seconds. Forcing exit...'));
    process.exit(1); // Force exit with error code
  }, 10000); // 10 seconds timeout

  try {
    console.log(chalk.cyan('SIGINT handler: Attempting embeddings.cleanup()...'));
    await embeddings.cleanup();
    console.log(chalk.green('embeddings.cleanup() completed.'));
    clearTimeout(forceExitTimeout); // Cleanup finished, clear the timeout
    console.log(chalk.cyan('SIGINT handler: Exiting normally (code 0).'));
    process.exit(0); // Exit normally
  } catch (err) {
    console.error(chalk.red('Error during embeddings.cleanup():'), err.message);
    clearTimeout(forceExitTimeout);
    console.log(chalk.cyan('SIGINT handler: Exiting after error (code 1).'));
    process.exit(1); // Exit with error code
  }
});

process.on('SIGTERM', async () => {
  console.log(chalk.yellow('\nReceived SIGTERM. Attempting graceful shutdown...'));
  // Set a timeout to force exit if cleanup hangs
  const forceExitTimeout = setTimeout(() => {
    console.error(chalk.red('Cleanup timed out after 10 seconds. Forcing exit...'));
    process.exit(1); // Force exit with error code
  }, 10000);

  try {
    console.log(chalk.cyan('SIGTERM handler: Attempting embeddings.cleanup()...'));
    await embeddings.cleanup();
    console.log(chalk.green('embeddings.cleanup() completed.'));
    clearTimeout(forceExitTimeout); // Cleanup finished, clear the timeout
    console.log(chalk.cyan('SIGTERM handler: Exiting normally (code 0).'));
    process.exit(0); // Exit normally
  } catch (err) {
    console.error(chalk.red('Error during embeddings.cleanup():'), err.message);
    clearTimeout(forceExitTimeout);
    console.log(chalk.cyan('SIGTERM handler: Exiting after error (code 1).'));
    process.exit(1); // Exit with error code
  }
});

// Ensure cleanup on normal exit
process.on('exit', () => {
  // Note: Async cleanup might not fully complete here
  console.log(chalk.cyan('Exiting...'));
});

// REMOVED: Old options processing logic for ignore/severity

// REMOVED: Old LLM import
// import * as llm from './llm.js';

// Main function to run the code review (Refactored to use cag-review.js)
async function runCodeReview(options) {
  let reviewTask = null;
  let operationDescription = '';
  const startTime = Date.now();

  // Determine the project directory for embedding searches
  // If --directory is specified, use that as the project directory
  // Otherwise, use the current working directory
  const projectPath = options.directory ? path.resolve(options.directory) : process.cwd();
  console.log(chalk.gray(`Using project path for analysis: ${projectPath}`));

  // Consolidate review options to pass down
  const reviewOptions = {
    verbose: options.verbose,
    provider: options.provider,
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    similarityThreshold: options.similarityThreshold,
    maxExamples: options.maxExamples,
    concurrency: options.concurrency,
    projectPath: projectPath, // Add project path for embedding searches
    directory: options.directory, // Also pass the directory option
    // Add any other relevant options here
  };

  try {
    console.log(chalk.bold.blue('AI Code Review (CAG Approach) - Starting analysis...'));

    // Determine the review mode based on options
    // Only support: single file, specific files, or diff with branch
    if (options.diffWith) {
      // Use directory option as working directory for git commands if specified
      const gitWorkingDir = options.directory ? path.resolve(options.directory) : process.cwd();
      const changedFiles = getChangedFiles(options.diffWith, gitWorkingDir);
      if (changedFiles.length === 0) {
        console.log(chalk.yellow(`No changed files found compared to branch '${options.diffWith}'. Exiting.`));
        return;
      }
      operationDescription = `${changedFiles.length} files changed vs ${options.diffWith}`;
      // Add the actual branch name to reviewOptions
      const enhancedReviewOptions = {
        ...reviewOptions,
        actualBranch: options.diffWith,
        diffWith: options.diffWith,
      };
      reviewTask = cagReviewPullRequest(changedFiles, enhancedReviewOptions);
    } else if (options.file) {
      operationDescription = `single file: ${options.file}`;
      if (!fs.existsSync(options.file)) {
        throw new Error(`File not found: ${options.file}`);
      }
      reviewTask = cagReviewFile(options.file, reviewOptions);
    } else if (options.files && options.files.length > 0) {
      const filesToAnalyze = await expandFilePatterns(options.files);
      if (filesToAnalyze.length === 0) {
        console.log(chalk.yellow('No files found matching the specified patterns. Exiting.'));
        return;
      }
      operationDescription = `${filesToAnalyze.length} specific files/patterns`;
      reviewTask = cagReviewFiles(filesToAnalyze, reviewOptions);
    } else {
      // No valid options provided - show error and exit
      console.error(chalk.red('Error: You must specify one of the following:'));
      console.error(chalk.yellow('  --file <file>                    Analyze a single file'));
      console.error(chalk.yellow('  --files <files...>               Analyze specific files or glob patterns'));
      console.error(chalk.yellow('  -b, --diff-with <branch>         Analyze files changed in a branch'));
      console.error(chalk.gray('\nOptional:'));
      console.error(chalk.gray('  -d, --directory <dir>            Working directory (for git operations with --diff-with)'));
      console.error(chalk.gray('\nExamples:'));
      console.error(chalk.gray('  ai-code-review analyze --file src/component.tsx'));
      console.error(chalk.gray('  ai-code-review analyze --files "src/**/*.ts"'));
      console.error(chalk.gray('  ai-code-review analyze -b feature-branch'));
      console.error(chalk.gray('  ai-code-review analyze -b feature-branch -d /path/to/repo'));
      process.exit(1);
    }

    console.log(chalk.cyan(`Starting review for ${operationDescription}...`));

    // Execute the selected review task
    const reviewResult = await reviewTask;

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    if (options.verbose) {
      console.log(chalk.blue(`Review process took ${duration} seconds.`));
    }

    // Process and output results
    if (reviewResult && reviewResult.success) {
      if (reviewResult.results && reviewResult.results.length > 0) {
        console.log(chalk.green(`Found ${reviewResult.results.length} result items to display`));
        // Determine output function based on format option
        const outputFn = options.output === 'json' ? outputJson : options.output === 'markdown' ? outputMarkdown : outputText;
        // Pass the detailed results array to the output function
        outputFn(reviewResult.results, options);
        console.log(chalk.bold.green(`\nAnalysis complete for ${operationDescription}! (${duration}s)`));
      } else {
        console.log(chalk.yellow('No results to display. Review result structure:'));
        console.log(chalk.yellow('reviewResult.results exists?'), reviewResult.results ? 'Yes' : 'No');
        if (reviewResult.results) {
          console.log(chalk.yellow('reviewResult.results type:'), typeof reviewResult.results);
          console.log(chalk.yellow('reviewResult.results is array?'), Array.isArray(reviewResult.results));
          if (!Array.isArray(reviewResult.results)) {
            console.log(
              chalk.yellow('reviewResult.results content:'),
              JSON.stringify(reviewResult.results, null, 2).substring(0, 500) + '...'
            );
          }
        }
        console.log(chalk.yellow(reviewResult.message || 'Review completed, but no results to display.'));
      }
    } else {
      console.error(chalk.red('\nCode review process failed.'));
      if (reviewResult && reviewResult.error) {
        console.error(chalk.red(`Error: ${reviewResult.error}`));
      }
    }

    // Clean up resources
    console.log(chalk.cyan('Cleaning up resources...'));
    try {
      await embeddings.cleanup();
      await cleanupClassifier();
      console.log(chalk.green('All resources cleaned up successfully'));
    } catch (cleanupErr) {
      console.error(chalk.yellow('Error during cleanup:'), cleanupErr.message);
      process.exit(1);
    }
  } catch (err) {
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.error(chalk.red(`\nError during code review (${operationDescription}):`), err.message);
    console.error(err.stack);
    // Clean up resources even on error
    try {
      await embeddings.cleanup();
      await cleanupClassifier();
      console.log(chalk.green('All resources cleaned up successfully'));
    } catch (cleanupErr) {
      console.error(chalk.red('Error during cleanup:'), cleanupErr.message);
    }
    process.exit(1);
  }
}

// --- Embeddings commands remain largely unchanged --- //

/**
 * Generate embeddings for the codebase
 *
 * @param {Object} options - Command options
 */
async function generateEmbeddings(options) {
  try {
    console.log(chalk.bold.blue('AI Code Review - Generating embeddings...'));
    const startTime = Date.now();

    // Determine the working directory for project separation
    // If --directory is specified, use that as the project directory
    // Otherwise, use the current working directory
    const projectDir = options.directory ? path.resolve(options.directory) : process.cwd();
    const baseDir = path.resolve(options.directory || '.'); // For file processing

    console.log(chalk.cyan(`Project directory for embeddings: ${projectDir}`));
    console.log(chalk.cyan(`Base directory for file processing: ${baseDir}`));

    // Get the project embeddings interface with the correct project directory
    console.log(chalk.cyan('Initializing project embeddings interface...'));
    const projectEmbeddings = embeddings.getProjectEmbeddings(projectDir);
    console.log(chalk.green('Embeddings interface initialized.'));

    // Process exclusion patterns BEFORE file discovery
    console.log(chalk.cyan('Processing exclusion patterns...'));
    let excludePatterns = options.exclude || [];

    // Add patterns from exclude file if specified
    if (options.excludeFile) {
      const excludeFilePath = path.resolve(options.excludeFile);
      if (fs.existsSync(excludeFilePath)) {
        console.log(chalk.cyan(`Loading exclusion patterns from: ${excludeFilePath}`));
        const excludeFileContent = fs.readFileSync(excludeFilePath, 'utf8');
        const filePatterns = excludeFileContent
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
        excludePatterns = [...excludePatterns, ...filePatterns];
      } else {
        console.warn(chalk.yellow(`Exclude file not found: ${excludeFilePath}`));
      }
    }

    if (excludePatterns.length > 0) {
      console.log(chalk.cyan(`Using ${excludePatterns.length} exclusion patterns.`));
    }

    // Log gitignore status
    if (options.gitignore === false) {
      console.log(chalk.yellow('Automatic .gitignore exclusion is disabled.'));
    } else {
      console.log(chalk.cyan('Respecting .gitignore patterns (if present).'));
    }
    console.log(chalk.green('Exclusion pattern processing complete.'));

    // Get files to process
    let filesToProcess = [];

    if (options.files && options.files.length > 0) {
      console.log(chalk.cyan('Processing specified files/patterns...'));
      filesToProcess = await expandFilePatterns(options.files, baseDir);
      console.log(chalk.green(`Expanded specified files/patterns to ${filesToProcess.length} files.`));
    } else {
      console.log(chalk.cyan(`Scanning directory for supported files: ${baseDir}`));
      // Show spinner during file discovery
      const scanSpinner = new Spinner('Scanning files... %s');
      scanSpinner.setSpinnerString('|/-\\');
      scanSpinner.start();
      // Pass the processed exclusion patterns to findSupportedFiles
      filesToProcess = await findSupportedFiles(baseDir, {
        ...options,
        excludePatterns, // Pass the processed patterns
      });
      scanSpinner.stop(true);
      console.log(chalk.green(`Found ${filesToProcess.length} potential files in directory.`));
    }

    const fileDiscoveryTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(chalk.gray(`File discovery took ${fileDiscoveryTime} seconds.`));

    if (filesToProcess.length === 0) {
      console.log(chalk.yellow('No files to process. Exiting.'));
      return;
    }

    // Process files in batches
    const concurrency = parseInt(options.concurrency || '10', 10); // Default concurrency
    console.log(chalk.cyan(`Starting embedding generation for ${filesToProcess.length} files with concurrency: ${concurrency}`));
    // Initialize spinner for live progress with more detailed information
    const spinner = new Spinner('%s Processing files...');
    spinner.setSpinnerString('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'); // Use a more modern spinner
    spinner.start();

    // Track progress state
    let processedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let excludedCount = 0;

    // Update spinner with detailed progress information
    const updateSpinner = () => {
      const totalProcessed = processedCount + skippedCount + failedCount + excludedCount;
      const pct = Math.floor((totalProcessed / filesToProcess.length) * 100);
      spinner.setSpinnerTitle(
        `%s Embedding progress: ${pct}% (${totalProcessed}/${filesToProcess.length}) ` +
          `[${chalk.green(`✓ ${processedCount}`)} | ` +
          `${chalk.yellow(`↷ ${skippedCount + excludedCount}`)} | ` +
          `${chalk.red(`✗ ${failedCount}`)}]`
      );
    };

    // Start the progress update interval
    const progressInterval = setInterval(updateSpinner, 100);

    const results = await projectEmbeddings.generateEmbeddings(filesToProcess, {
      concurrency,
      verbose: options.verbose,
      excludePatterns,
      respectGitignore: options.gitignore !== false,
      baseDir: baseDir,
      batchSize: 100, // Set a reasonable batch size
      onProgress: (status, file) => {
        // Update counters based on status
        if (status === 'processed') {
          processedCount++;
        } else if (status === 'skipped') {
          skippedCount++;
        } else if (status === 'failed') {
          failedCount++;
        } else if (status === 'excluded') {
          excludedCount++;
        }

        // Update the spinner with new progress information
        updateSpinner();
      },
    });

    // Clean up the progress display
    clearInterval(progressInterval);
    spinner.stop(true);

    console.log(chalk.green(`\nEmbedding generation complete!`));
    console.log(chalk.cyan(`Processed: ${results.processed} files`));
    console.log(chalk.yellow(`Skipped: ${results.skipped} files (binary, too large, etc.)`));
    console.log(chalk.yellow(`Excluded: ${results.excluded} files (gitignore, patterns)`));

    if (results.failed > 0) {
      console.log(chalk.red(`Failed: ${results.failed} files`));
    }

    // Clean up resources to allow the process to exit naturally
    console.log(chalk.cyan('Cleaning up resources...'));
    await embeddings.cleanup();
    console.log(chalk.green('Cleanup successful.'));
  } catch (err) {
    console.error(chalk.red('Error generating embeddings:'), err.message);
    console.error(err.stack);
    // Clean up resources even on error
    try {
      console.log(chalk.cyan('Cleaning up resources after error...'));
      await embeddings.cleanup();
      console.log(chalk.green('Cleanup successful.'));
    } catch (cleanupErr) {
      console.error(chalk.red('Error during cleanup:'), cleanupErr.message);
    }
    process.exit(1);
  }
}

/**
 * Clear stored embeddings for the current project
 */
async function clearEmbeddings(options) {
  try {
    // Determine the working directory for project separation
    // If --directory is specified, use that as the project directory
    // Otherwise, use the current working directory
    const projectDir = options.directory ? path.resolve(options.directory) : process.cwd();
    console.log(chalk.cyan(`Clearing embeddings for project: ${projectDir}`));

    // Call clearEmbeddings() with the determined project directory
    await embeddings.clearEmbeddings(projectDir);

    console.log(chalk.green('Project embeddings have been cleared.'));

    // Clean up resources
    console.log(chalk.cyan('Cleaning up resources...'));
    await embeddings.cleanup();
  } catch (err) {
    console.error(chalk.red('Error clearing embeddings:'), err.message);
    console.error(err.stack);
    // Clean up resources even on error
    try {
      await embeddings.cleanup();
    } catch (cleanupErr) {
      console.error(chalk.red('Error during cleanup:'), cleanupErr.message);
    }
    process.exit(1);
  }
}

/**
 * Show statistics about stored embeddings
 */
async function showEmbeddingStats(options) {
  try {
    // Determine the working directory for project separation
    // If --directory is specified, use that as the project directory
    // Otherwise, use the current working directory (shows all projects)
    const projectDir = options.directory ? path.resolve(options.directory) : process.cwd();

    if (options.directory) {
      console.log(chalk.cyan(`Fetching embedding statistics for project: ${projectDir}`));
    } else {
      console.log(chalk.cyan('Fetching embedding statistics for all projects...'));
    }

    const projectEmbeddings = embeddings.getProjectEmbeddings(projectDir);
    const stats = await projectEmbeddings.getStats();

    console.log(chalk.bold.blue('\nEmbedding Statistics:'));

    if (!stats || Object.keys(stats).length === 0 || stats.totalCount === 0) {
      console.log(chalk.yellow('No embeddings found or database is empty.'));
    } else {
      console.log(` ${chalk.cyan('Total Embeddings:')} ${chalk.green(stats.totalCount)}`);
      if (stats.dimensions) {
        console.log(` ${chalk.cyan('Vector Dimensions:')} ${chalk.green(stats.dimensions)}`);
      }
      if (stats.tables) {
        console.log(` ${chalk.cyan('Tables/Collections:')}`);
        for (const [table, count] of Object.entries(stats.tables)) {
          console.log(`  - ${chalk.cyan(table)}: ${chalk.green(count)} entries`);
        }
      }
      if (stats.lastUpdated) {
        console.log(` ${chalk.cyan('Last Updated:')} ${chalk.green(new Date(stats.lastUpdated).toLocaleString())}`);
      }
    }

    // Clean up resources
    // console.log(chalk.cyan('Cleaning up resources...'));
    // await embeddings.cleanup();
  } catch (err) {
    console.error(chalk.red('Error fetching embedding statistics:'), err.message);
    console.error(err.stack);
    // Clean up resources even on error
    // try {
    //   await embeddings.cleanup();
    // } catch (cleanupErr) {
    //   console.error(chalk.red('Error during cleanup:'), cleanupErr.message);
    // }
    process.exit(1);
  }
}

// --- Helper Functions --- //

/**
 * Find all supported code files in a directory (using utils.shouldProcessFile)
 *
 * @param {string} directory - Directory to search
 * @param {object} options - Options from generateEmbeddings command
 * @returns {Promise<Array<string>>} Array of file paths
 */
async function findSupportedFiles(directory, options = {}) {
  const verbose = options.verbose || false;
  const baseDir = path.resolve(directory);

  // Default patterns match common code files - adjust as needed
  const defaultPatterns = [
    '**/*.js',
    '**/*.jsx',
    '**/*.ts',
    '**/*.tsx',
    '**/*.py',
    '**/*.rb',
    '**/*.java',
    '**/*.go',
    '**/*.php',
    '**/*.cs',
    '**/*.c',
    '**/*.cpp',
    '**/*.h',
    '**/*.hpp',
    '**/*.html',
    '**/*.css',
    '**/*.scss',
    '**/*.json',
    '**/*.md',
    '**/*.yml',
    '**/*.yaml',
    '**/*.kt',
    '**/*.sh',
    '**/*.gradle',
    // Add or remove patterns as appropriate for general projects
  ];

  // Combine default patterns with any user-provided pattern (though typically not used in directory mode)
  const patternsToUse = options.filePattern ? [options.filePattern] : defaultPatterns;

  // Define standard exclusions
  const defaultExcludes = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.*/**',
    '**/*.min.*',
    '**/vendor/**',
    '**/tmp/**',
    '**/coverage/**',
    '**/__pycache__/**',
    // Add common large file types or directories often not needed for analysis
    '**/*.log',
    '**/*.lock',
    '**/*.bak',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/assets/**',
    '**/images/**',
    '**/fonts/**',
  ];

  // Combine default exclusions with user-provided ones
  const excludePatterns = options.excludePatterns ? [...defaultExcludes, ...options.excludePatterns] : defaultExcludes;

  const globOptions = {
    cwd: baseDir,
    ignore: excludePatterns,
    absolute: true, // Get absolute paths
    nodir: true, // Exclude directories
    dot: false, // Exclude dotfiles/dotdirectories unless explicitly included
    follow: false, // Don't follow symlinks to avoid potential loops/issues
    stat: true, // Get stats to check if it's a file
    withFileTypes: false, // Not needed with stat:true
    signal: AbortSignal.timeout(120000), // Add a timeout (e.g., 2 minutes) to prevent infinite hangs
  };

  // Note: We don't use glob's gitignore option because it's not working correctly
  // Instead, we rely on the shouldProcessFile check in embeddings.js which uses git check-ignore
  globOptions.ignore = [...excludePatterns]; // Use only explicit excludes

  if (verbose) {
    console.log(chalk.cyan('Using async glob to find files...'));
    console.log(chalk.gray(`  Patterns: ${patternsToUse.join(', ')}`));
    console.log(chalk.gray(`  Options:`), globOptions);
  }

  try {
    // Use asynchronous glob
    const files = await glob.glob(patternsToUse, globOptions);

    if (verbose) {
      console.log(chalk.green(`Glob found ${files.length} potential files.`));
    }

    // Filter results to ensure they are actual files (glob with stat should mostly handle this)
    // And apply the final utilsShouldProcessFile check (e.g., for binary content if needed)
    // const finalFiles = [];
    // for (const file of files) {
    //   // The file path from glob should already be absolute
    //   try {
    //      // Basic check if it's a file (glob should have done this with nodir:true)
    //      // The `stat:true` option in glob might make fs.statSync redundant,
    //      // but double-checking is safe. However, let's rely on glob's filtering first.
    //     // Final check with utilsShouldProcessFile if it adds more filtering (e.g., content checks)
    //     // Pass baseDir for context if needed by exclusion logic
    //     if (utilsShouldProcessFile(file, '', { exclusionOptions: options.exclusionOptions, baseDir })) {
    //       finalFiles.push(file);
    //     }
    //   } catch (statError) {
    //      if (verbose) {
    //          console.warn(chalk.yellow(`Skipping file due to stat error ${path.relative(baseDir, file)}: ${statError.message}`));
    //      }
    //   }
    // }

    // Rely directly on glob results since it handles gitignore and exclusions
    const finalFiles = files;

    // Add log after the filtering loop (now just assignment)
    if (verbose) {
      console.log(chalk.green(`Finished filtering glob results. ${finalFiles.length} files remain.`));
    }
    return finalFiles;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(chalk.red('Glob operation timed out. The directory might be too large or complex.'));
    } else {
      console.error(chalk.red(`Error during glob file search: ${err.message}`));
    }
    console.error(err.stack); // Log stack for debugging
    return []; // Return empty array on error
  }
}

/**
 * Expand file patterns to actual file paths, ensuring they exist.
 *
 * @param {Array<string>} patterns - File patterns to expand
 * @param {string} baseDir - The base directory for resolving relative patterns
 * @returns {Array<string>} Array of absolute file paths
 */
async function expandFilePatterns(patterns, baseDir = process.cwd()) {
  try {
    const files = new Set(); // Use a Set to avoid duplicates
    for (const pattern of patterns) {
      // Resolve the pattern relative to the base directory
      const absolutePattern = path.resolve(baseDir, pattern);

      // Check if it's a direct file path first
      if (fs.existsSync(absolutePattern) && fs.statSync(absolutePattern).isFile()) {
        files.add(absolutePattern);
      } else {
        // Treat as a glob pattern
        // Use the original pattern with baseDir as cwd for correct globbing
        const matchedFiles = await glob.glob(pattern, { cwd: baseDir, absolute: true, nodir: true });
        matchedFiles.forEach((file) => {
          // Final check if file exists and is a file
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            files.add(file);
          }
        });
      }
    }
    return Array.from(files);
  } catch (err) {
    console.error(chalk.red('Error expanding file patterns:'), err.message);
    return [];
  }
}

/**
 * Get list of files changed in a branch compared to the base branch (main/master).
 * This shows what changes the specified branch has compared to the base.
 *
 * @param {string} branch - Branch to analyze (the feature/target branch)
 * @param {string} workingDir - Directory to run git commands in (optional, defaults to cwd)
 * @returns {Array<string>} Array of changed file paths relative to git root
 */
function getChangedFiles(branch, workingDir = process.cwd()) {
  try {
    // Get git root directory
    const gitRoot = execSync('git rev-parse --show-toplevel', { cwd: workingDir }).toString().trim();
    console.log(chalk.gray(`Git repository: ${gitRoot}`));

    // Ensure the branch exists locally (fetch if needed)
    ensureBranchExists(branch, workingDir);

    // Find the base branch (main/master)
    const baseBranch = findBaseBranch(workingDir);

    console.log(chalk.gray(`Comparing ${branch} against ${baseBranch}...`));

    // Use three-dot notation to get changes in branch compared to base
    // This shows commits that are in 'branch' but not in 'baseBranch'
    const gitOutput = execSync(`git diff --name-only ${baseBranch}...${branch}`, { cwd: gitRoot }).toString();

    // Split, filter empty lines, resolve paths, and check existence
    const changedFiles = gitOutput
      .split('\n')
      .filter((file) => file)
      .map((file) => path.resolve(gitRoot, file)) // Get absolute path
      .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile()); // Ensure it exists and is a file

    if (changedFiles.length > 0) {
      console.log(chalk.gray(`Found ${changedFiles.length} changed files in ${branch} vs ${baseBranch}`));
    }

    return changedFiles;
  } catch (err) {
    console.error(chalk.red('Error getting git diff:'), err.message);
    return [];
  }
}

// REMOVED: getFileDiff function - Diffing handled within LLM or specific review modes if needed.
// REMOVED: checkBranchExists function - Moved to utils.js

// --- Output Formatting Functions --- //
// These need to be adapted to the structure returned by cag-review.js functions

/**
 * Output results in JSON format
 *
 * @param {Array<Object>} reviewResults - Array of individual file review results from cag-review
 * @param {Object} cliOptions - Command line options
 */
function outputJson(reviewResults, cliOptions) {
  // Structure the output to be informative
  const output = {
    summary: {
      totalFilesReviewed: reviewResults.length,
      filesWithIssues: reviewResults.filter((r) => r.success && !r.skipped && r.results?.issues?.length > 0).length,
      totalIssues: reviewResults.reduce((sum, r) => sum + (r.results?.issues?.length || 0), 0),
      skippedFiles: reviewResults.filter((r) => r.skipped).length,
      errorFiles: reviewResults.filter((r) => !r.success).length,
    },
    details: reviewResults.map((r) => {
      if (!r.success) {
        return { filePath: r.filePath, success: false, error: r.error };
      }
      if (r.skipped) {
        return { filePath: r.filePath, success: true, skipped: true };
      }
      // Include key details from the successful analysis
      return {
        filePath: r.filePath,
        success: true,
        language: r.language,
        review: r.results, // Contains summary, issues, positives from LLM
        // Optionally include similar examples if needed
        // similarExamplesUsed: r.similarExamples
      };
    }),
  };
  console.log(JSON.stringify(output, null, 2));
}

/**
 * Output results in Markdown format
 *
 * @param {Array<Object>} reviewResults - Array of individual file review results
 * @param {Object} cliOptions - Command line options
 */
function outputMarkdown(reviewResults, cliOptions) {
  console.log('# AI Code Review Results (CAG Approach)\n');

  const totalFiles = reviewResults.length;
  const filesWithIssues = reviewResults.filter((r) => r.success && !r.skipped && r.results?.issues?.length > 0).length;
  const totalIssues = reviewResults.reduce((sum, r) => sum + (r.results?.issues?.length || 0), 0);
  const skippedFiles = reviewResults.filter((r) => r.skipped).length;
  const errorFiles = reviewResults.filter((r) => !r.success).length;

  console.log('## Summary\n');
  console.log(`- **Files Analyzed:** ${totalFiles}`);
  console.log(`- **Files with Issues:** ${filesWithIssues}`);
  console.log(`- **Total Issues Found:** ${totalIssues}`);
  if (skippedFiles > 0) console.log(`- **Files Skipped:** ${skippedFiles}`);
  if (errorFiles > 0) console.log(`- **Errors:** ${errorFiles}`);
  console.log('\n');

  console.log('## Detailed Review per File\n');

  reviewResults.forEach((fileResult) => {
    console.log(`### ${fileResult.filePath}\n`);
    if (!fileResult.success) {
      console.log(`**Error:** ${fileResult.error}\n`);
      return;
    }
    if (fileResult.skipped) {
      console.log(`*Skipped (based on exclusion patterns or file type).*\n`);
      return;
    }
    if (!fileResult.results || (!fileResult.results.issues?.length && !fileResult.results.positives?.length)) {
      console.log(`*No significant findings or issues reported.*\n`);
      if (fileResult.results?.summary) {
        console.log(`**Summary:** ${fileResult.results.summary}\n`);
      }
      return;
    }

    const review = fileResult.results;
    if (review.summary) {
      console.log(`**Summary:** ${review.summary}\n`);
    }

    if (review.issues && review.issues.length > 0) {
      console.log(`**Issues Found (${review.issues.length}):**\n`);
      review.issues.forEach((issue) => {
        const severityEmoji = getSeverityEmoji(issue.severity);
        console.log(
          `- **[${issue.severity.toUpperCase()}] ${severityEmoji} (Lines: ${issue.lineNumbers?.join(', ') || 'N/A'})**: ${
            issue.description
          }`
        );
      });
    }

    if (review.positives && review.positives.length > 0) {
      console.log(`**Positives Found (${review.positives.length}):**\n`);
      review.positives.forEach((positive) => {
        console.log(`  - ${positive}\n`);
      });
    }
  });
}

/**
 * Output results in text format with colors
 *
 * @param {Array<Object>} reviewResults - Array of individual file review results
 * @param {Object} cliOptions - Command line options
 */
function outputText(reviewResults, cliOptions) {
  const totalFiles = reviewResults.length;
  const filesWithIssues = reviewResults.filter((r) => r.success && !r.skipped && r.results?.issues?.length > 0).length;
  const totalIssues = reviewResults.reduce((sum, r) => sum + (r.results?.issues?.length || 0), 0);
  const skippedFiles = reviewResults.filter((r) => r.skipped).length;
  const errorFiles = reviewResults.filter((r) => !r.success).length;

  console.log(chalk.bold.blue('\n===== AI Code Review Summary ====='));
  console.log(`Files Analyzed: ${chalk.bold(totalFiles)}`);
  console.log(`Files with Issues: ${chalk.bold(filesWithIssues)}`);
  console.log(`Total Issues Found: ${chalk.bold(totalIssues)}`);
  if (skippedFiles > 0) console.log(`Files Skipped: ${chalk.yellow(skippedFiles)}`);
  if (errorFiles > 0) console.log(`Errors: ${chalk.red(errorFiles)}`);
  console.log(chalk.bold.blue('================================================'));

  reviewResults.forEach((fileResult) => {
    if (!fileResult.success) {
      console.log(chalk.bold.red(`\n===== Error reviewing ${fileResult.filePath} =====`));
      console.log(chalk.red(fileResult.error));
      console.log(chalk.bold.red('================================================'));
      return;
    }
    if (fileResult.skipped) {
      if (cliOptions.verbose) {
        console.log(chalk.yellow(`\nSkipped: ${fileResult.filePath}`));
      }
      return;
    }
    if (!fileResult.results || (!fileResult.results.issues?.length && !fileResult.results.positives?.length)) {
      if (cliOptions.verbose) {
        console.log(chalk.green(`\nNo findings for: ${fileResult.filePath}`));
        if (fileResult.results?.summary) {
          console.log(chalk.green(`  Summary: ${fileResult.results.summary}`));
        }
      }
      return;
    }

    console.log(chalk.bold.underline(`\n===== Review for ${fileResult.filePath} =====`));
    const review = fileResult.results;

    if (review.summary) {
      console.log(chalk.bold.cyan(`Summary: ${review.summary}`));
    }

    if (review.issues && review.issues.length > 0) {
      console.log(chalk.bold.yellow('\nIssues:'));
      review.issues.forEach((issue) => {
        const severityColor = getSeverityColor(issue.severity);
        console.log(`  ${severityColor(`[${issue.severity.toUpperCase()}]`)} (Lines: ${issue.lineNumbers?.join(', ') || 'N/A'})`);
        console.log(`    ${issue.description}`);
        if (issue.suggestion) {
          console.log(`    ${chalk.green(`Suggestion: ${issue.suggestion}`)}`);
        }
        console.log(''); // Add spacing
      });
    }

    if (review.positives && review.positives.length > 0) {
      console.log(chalk.bold.green('\nPositives:'));
      review.positives.forEach((positive) => {
        console.log(`  - ${positive}`);
      });
      console.log('');
    }
    console.log(chalk.gray(`========================================${'='.repeat(fileResult.filePath.length)}`));
  });
}

// --- Severity Helpers (Remain Unchanged) --- //

/**
 * Get color function for severity level
 *
 * @param {string} severity - Severity level
 * @returns {Function} Chalk color function
 */
function getSeverityColor(severity = 'low') {
  // Add default
  switch (severity.toLowerCase()) {
    case 'critical':
      return chalk.bold.red;
    case 'high':
      return chalk.red;
    case 'medium':
      return chalk.bold.yellow;
    case 'low':
      return chalk.yellow;
    case 'info':
      return chalk.bold.blue;
    default:
      return chalk.blue;
  }
}

/**
 * Get emoji for severity level (for markdown output)
 *
 * @param {string} severity - Severity level
 * @returns {string} Emoji representing severity
 */
function getSeverityEmoji(severity = 'low') {
  // Add default
  switch (severity.toLowerCase()) {
    case 'critical':
      return '🚨'; // Critical
    case 'high':
      return '🔥'; // High
    case 'medium':
      return '⚠️'; // Medium
    case 'low':
      return '💡'; // Low / Info
    case 'info':
      return 'ℹ️'; // Explicit Info
    default:
      return '•';
  }
}

// ============================================================================
// PR HISTORY ANALYSIS FUNCTIONS
// ============================================================================

/**
 * Analyze PR comment history for a repository
 * @param {Object} options - CLI options
 */
async function analyzePRHistory(options) {
  const startTime = Date.now();

  try {
    console.log(chalk.bold.blue('AI Code Review - PR History Analysis'));

    // Get repository and project path using utility functions
    const { repository, projectPath } = getRepositoryAndProjectPath(options);
    console.log(chalk.cyan(`Project directory: ${projectPath}`));

    // Validate GitHub token
    const token = validateGitHubToken(options);

    // Initialize analyzer
    const analyzer = new PRHistoryAnalyzer({
      concurrency: options.concurrency || 2,
      batchSize: options.batchSize || 50,
      skipDependabot: true,
      includeDrafts: false,
    });

    analyzer.initialize(token);

    // Prepare analysis options
    const analysisOptions = {
      since: options.since,
      until: options.until,
      limit: options.limit,
      resume: options.resume,
      clearExisting: options.clear,
      projectPath,
      onProgress: (progress) => displayProgress(progress, options.verbose),
    };

    console.log(chalk.blue(`Starting analysis for ${repository}...`));

    // Run analysis
    const results = await analyzer.analyzeRepository(repository, analysisOptions);

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    // Display results using utility function
    displayAnalysisResults(results, duration);
    console.log(chalk.bold.green(`\nPR history analysis complete for ${repository}!`));
  } catch (error) {
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.error(chalk.red(`\nError during PR history analysis (${duration}s):`), error.message);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Get PR analysis status for a repository
 * @param {Object} options - CLI options
 */
async function getPRHistoryStatus(options) {
  try {
    console.log(chalk.bold.blue('AI Code Review - PR History Status'));

    // Get repository and project path using utility functions
    const { repository, projectPath } = getRepositoryAndProjectPath(options);
    console.log(chalk.cyan(`Project directory: ${projectPath}`));

    // Create analyzer instance to get status
    const analyzer = new PRHistoryAnalyzer();
    const status = await analyzer.getProgressStatus(repository);

    // Display status using utility function
    displayStatus(status);

    // Check database for stored comments
    const { hasPRComments, getPRCommentsStats } = await import('./src/pr-history/database.js');
    const hasComments = await hasPRComments(repository, projectPath);

    if (hasComments) {
      const stats = await getPRCommentsStats(repository, projectPath);
      displayDatabaseStats(stats, hasComments);
    } else {
      displayDatabaseStats(null, hasComments);
    }
  } catch (error) {
    console.error(chalk.red('Error getting PR history status:'), error.message);
    process.exit(1);
  }
}

/**
 * Clear PR analysis data for a repository
 * @param {Object} options - CLI options
 */
async function clearPRHistory(options) {
  try {
    console.log(chalk.bold.blue('AI Code Review - Clear PR History Data'));

    // Get repository and project path using utility functions
    const { repository, projectPath } = getRepositoryAndProjectPath(options);
    console.log(chalk.cyan(`Project directory: ${projectPath}`));
    console.log(chalk.cyan(`Repository: ${repository}`));

    // Check if data exists before confirmation
    const { hasPRComments, getPRCommentsStats } = await import('./src/pr-history/database.js');
    const hasComments = await hasPRComments(repository, projectPath);

    if (!hasComments) {
      console.log(chalk.yellow(`No PR analysis data found for ${repository}`));
      return;
    }

    // Get stats for confirmation message
    const stats = await getPRCommentsStats(repository, projectPath);
    console.log(chalk.yellow('\nData to be cleared:'));
    console.log(chalk.yellow(`  - ${stats.totalComments} comments`));
    console.log(chalk.yellow(`  - ${stats.totalPRs} pull requests`));
    console.log(chalk.yellow(`  - ${stats.uniqueAuthors} unique authors`));
    console.log(chalk.yellow(`  - Date range: ${stats.dateRange.earliest} to ${stats.dateRange.latest}`));

    // Confirmation prompt (unless --force flag is used)
    if (!options.force) {
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise((resolve) => {
        rl.question(chalk.red('\nThis will permanently delete all PR analysis data. Continue? (y/N): '), resolve);
      });

      rl.close();

      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(chalk.cyan('Operation cancelled.'));
        return;
      }
    }

    // Clear the data
    const { clearPRComments } = await import('./src/pr-history/database.js');
    console.log(chalk.blue('Clearing PR analysis data...'));

    const cleared = await clearPRComments(repository, projectPath);

    if (cleared) {
      console.log(chalk.bold.green(`\nPR analysis data cleared successfully for ${repository}`));
    } else {
      console.log(chalk.yellow('No data was found to clear.'));
    }
  } catch (error) {
    console.error(chalk.red('Error clearing PR history data:'), error.message);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}
