/**
 * CAG Review Module
 *
 * This module serves as the main entry point for the dynamic, context-augmented
 * code review process. It coordinates file discovery and analysis,
 * relying on dynamic context retrieval via embeddings.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { runAnalysis, gatherUnifiedContextForPR } from './cag-analyzer.js';
import { detectFileType, detectLanguageFromExtension, findBaseBranch, getChangedLinesInfo, shouldProcessFile } from './utils.js';

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
    const analyzeResult = await runAnalysis(filePath, options);

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

    // Use enhanced PR review with cross-file context
    return await reviewPullRequestWithCrossFileContext(filesToReview, options);
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

/**
 * Enhanced PR review with cross-file context and de-duplicated resources
 *
 * @param {Array<string>} filesToReview - Array of file paths to review
 * @param {Object} options - Review options
 * @returns {Promise<Object>} Aggregated review results
 */
async function reviewPullRequestWithCrossFileContext(filesToReview, options = {}) {
  try {
    const verbose = options.verbose || false;
    if (verbose) {
      console.log(chalk.blue(`Starting enhanced PR review with cross-file context for ${filesToReview.length} files...`));
    }

    // Step 1: Get the base branch and collect diff info for all files in the PR
    const workingDir = options.directory ? path.resolve(options.directory) : process.cwd();
    const baseBranch = findBaseBranch(workingDir);
    const targetBranch = options.diffWith || 'HEAD'; // The feature branch being reviewed

    // Get the actual branch name from options passed from index.js
    const actualTargetBranch = options.actualBranch || targetBranch;

    if (verbose) {
      console.log(chalk.gray(`Base branch: ${baseBranch}, Target branch: ${targetBranch}`));
    }

    const prFiles = [];
    for (const filePath of filesToReview) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const language = detectLanguageFromExtension(path.extname(filePath));
        const fileType = detectFileType(filePath, content);

        // Get the git diff for this file
        const diffInfo = getChangedLinesInfo(filePath, baseBranch, actualTargetBranch, workingDir);

        if (!diffInfo.hasChanges) {
          if (verbose) {
            console.log(chalk.yellow(`No changes detected in ${path.basename(filePath)}, skipping`));
          }
          continue;
        }

        // Create a summary of changes for context
        const changesSummary = `${diffInfo.addedLines.length} lines added, ${diffInfo.removedLines.length} lines removed`;

        prFiles.push({
          filePath,
          content, // Keep full content for context gathering
          diffContent: diffInfo.fullDiff, // The actual diff to review
          diffInfo: diffInfo, // Parsed diff info
          language,
          fileType,
          isTest: fileType.isTest,
          isComponent: content.includes('export default') || content.includes('export const') || content.includes('export function'),
          summary: `${language} ${fileType.isTest ? 'test' : 'source'} file: ${path.basename(filePath)} (${changesSummary})`,
          baseBranch,
          targetBranch,
        });
      } catch (error) {
        console.warn(chalk.yellow(`Error processing file ${filePath}: ${error.message}`));
      }
    }

    if (prFiles.length === 0) {
      console.log(chalk.yellow('No files with changes found for review'));
      return {
        success: true,
        results: [],
        prContext: { message: 'No changes to review' },
      };
    }

    // Step 2: Gather unified context for the entire PR
    if (verbose) {
      console.log(chalk.blue(`Performing unified context retrieval for ${prFiles.length} PR files...`));
    }
    const {
      codeExamples: deduplicatedCodeExamples,
      guidelines: deduplicatedGuidelines,
      prComments: deduplicatedPRComments,
    } = await gatherUnifiedContextForPR(prFiles, options);

    if (verbose) {
      console.log(
        chalk.green(
          `De-duplicated context: ${deduplicatedCodeExamples.length} code examples, ${deduplicatedGuidelines.length} guidelines, ${deduplicatedPRComments.length} PR comments`
        )
      );
    }

    // Step 3: Create PR context summary for LLM
    const prContext = {
      allFiles: prFiles.map((f) => ({
        path: path.relative(process.cwd(), f.filePath),
        language: f.language,
        isTest: f.isTest,
        isComponent: f.isComponent,
        summary: f.summary,
      })),
      totalFiles: prFiles.length,
      testFiles: prFiles.filter((f) => f.isTest).length,
      sourceFiles: prFiles.filter((f) => !f.isTest).length,
    };

    // Step 4: Perform holistic PR review with all files and unified context
    if (verbose) {
      console.log(chalk.blue(`Performing holistic PR review for all ${prFiles.length} files...`));
    }

    try {
      // Create a comprehensive review context with all files and their diffs
      const comprehensiveContext = {
        prFiles: prFiles.map((file) => ({
          path: path.relative(workingDir, file.filePath),
          language: file.language,
          isTest: file.isTest,
          isComponent: file.isComponent,
          summary: file.summary,
          diff: file.diffContent,
          baseBranch: file.baseBranch,
          targetBranch: file.targetBranch,
        })),
        unifiedContext: {
          codeExamples: deduplicatedCodeExamples,
          guidelines: deduplicatedGuidelines,
          prComments: deduplicatedPRComments,
        },
        prContext: prContext,
      };

      // Use the existing analyzeFile function with holistic PR context
      const holisticOptions = {
        ...options,
        isHolisticPRReview: true,
        prFiles: comprehensiveContext.prFiles,
        unifiedContext: comprehensiveContext.unifiedContext,
        prContext: comprehensiveContext.prContext,
      };

      // Create a synthetic "file" path for holistic analysis
      const holisticResult = await runAnalysis('PR_HOLISTIC_REVIEW', holisticOptions);

      // Convert holistic result to individual file results format for compatibility
      const results = prFiles.map((file) => {
        const relativePath = path.relative(workingDir, file.filePath);
        const baseName = path.basename(file.filePath);

        // Try multiple path formats to find file-specific issues
        let fileIssues = [];
        const possibleKeys = [
          relativePath, // Full relative path
          baseName, // Just filename
          file.filePath, // Absolute path
          path.posix.normalize(relativePath), // Normalized posix path
        ];

        // Find issues using any of the possible key formats
        for (const key of possibleKeys) {
          if (holisticResult?.results?.fileSpecificIssues?.[key]) {
            fileIssues = holisticResult.results.fileSpecificIssues[key];
            console.log(chalk.green(`✅ Found ${fileIssues.length} issues for ${baseName} using key: "${key}"`));
            break;
          }
        }

        console.log(chalk.gray(`🔍 Mapping issues for ${file.filePath}:`));
        console.log(chalk.gray(`  - Relative path: "${relativePath}"`));
        console.log(chalk.gray(`  - Tried keys: ${possibleKeys.map((k) => `"${k}"`).join(', ')}`));
        console.log(chalk.gray(`  - Final issues: ${fileIssues.length}`));

        return {
          success: true,
          filePath: file.filePath,
          language: file.language,
          results: {
            summary: `Part of holistic PR review covering ${prFiles.length} files`,
            issues: fileIssues,
          },
          context: {
            codeExamples: deduplicatedCodeExamples.length,
            guidelines: deduplicatedGuidelines.length,
            prComments: deduplicatedPRComments.length,
          },
        };
      });

      // Add holistic analysis to the first result
      if (results.length > 0 && holisticResult?.results) {
        results[0].holisticAnalysis = {
          crossFileIssues: holisticResult.results.crossFileIssues || [],
          overallSummary: holisticResult.results.summary,
          recommendations: holisticResult.results.recommendations || [],
        };
      }

      return {
        success: true,
        results: results,
        prContext: {
          ...prContext,
          holisticAnalysis: holisticResult,
          contextSummary: {
            codeExamples: deduplicatedCodeExamples.length,
            guidelines: deduplicatedGuidelines.length,
            prComments: deduplicatedPRComments.length,
          },
        },
      };
    } catch (error) {
      console.error(chalk.red(`Error in holistic PR review: ${error.message}`));

      // Fallback to individual file review if holistic review fails
      if (verbose) {
        console.log(chalk.yellow(`Falling back to individual file reviews...`));
      }

      const results = [];
      const concurrency = options.concurrency || 3;

      for (let i = 0; i < prFiles.length; i += concurrency) {
        const batch = prFiles.slice(i, i + concurrency);

        const batchPromises = batch.map(async (file) => {
          try {
            // Enhance options with shared context and diff-only analysis
            const enhancedOptions = {
              ...options,
              // Add PR context for cross-file awareness
              prContext: prContext,
              // Override context gathering to use shared/pre-gathered resources
              preGatheredContext: {
                codeExamples: deduplicatedCodeExamples,
                guidelines: deduplicatedGuidelines,
                prComments: deduplicatedPRComments,
              },
              // Flag to indicate this is part of a PR review
              isPRReview: true,
              // Add diff-specific options
              diffOnly: true,
              diffContent: file.diffContent,
              diffInfo: file.diffInfo,
              baseBranch: file.baseBranch,
              targetBranch: file.targetBranch,
              // Add context about all files in the PR
              allPRFiles: prContext.allFiles,
            };

            const result = await runAnalysis(file.filePath, enhancedOptions);
            return result;
          } catch (error) {
            console.error(chalk.red(`Error reviewing ${file.filePath}: ${error.message}`));
            return {
              filePath: file.filePath,
              success: false,
              error: error.message,
            };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      }

      // Return fallback results
      return {
        success: true,
        results: results,
        prContext: prContext,
        sharedContextStats: {
          codeExamples: deduplicatedCodeExamples.length,
          guidelines: deduplicatedGuidelines.length,
          prComments: deduplicatedPRComments.length,
        },
      };
    }
  } catch (error) {
    console.error(chalk.red(`Error in enhanced PR review: ${error.message}`));
    return {
      success: false,
      error: error.message,
      results: [],
    };
  }
}

// Export the core review functions
export { reviewFile, reviewFiles, reviewPullRequest };
