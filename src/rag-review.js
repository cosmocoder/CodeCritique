/**
 * RAG Review Module
 *
 * This module serves as the main entry point for the dynamic, context-augmented
 * code review process. It coordinates file discovery and analysis,
 * relying on dynamic context retrieval via embeddings.
 */

import path from 'path';
import chalk from 'chalk';
import { runAnalysis, gatherUnifiedContextForPR } from './rag-analyzer.js';
import { shouldProcessFile } from './utils/file-validation.js';
import { findBaseBranch, getChangedLinesInfo, getFileContentFromGit } from './utils/git.js';
import { detectFileType, detectLanguageFromExtension } from './utils/language-detection.js';
import { shouldChunkPR, chunkPRFiles, combineChunkResults } from './utils/pr-chunking.js';

/**
 * Review a single file using RAG approach
 *
 * @param {string} filePath - Path to the file to review
 * @param {object} options - Review options
 * @returns {Promise<object>} Review result object
 */
async function reviewFile(filePath, options = {}) {
  try {
    console.log(chalk.blue(`Reviewing file: ${filePath}`));

    // Analyze the file using the RAG analyzer
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

    // No longer filter files here, as new files in a different branch won't exist locally.
    // The downstream functions are responsible for fetching content from git.
    const filesToReview = changedFilePaths;

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
        // Check if the file should be processed before fetching its content from git
        if (!shouldProcessFile(filePath, '', options)) {
          if (verbose) {
            console.log(chalk.yellow(`Skipping file due to exclusion rules: ${path.basename(filePath)}`));
          }
          continue;
        }

        const content = getFileContentFromGit(filePath, actualTargetBranch, workingDir);
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

    // Check if PR should be chunked based on size and complexity (skip if this is already a chunk)
    if (!options.skipChunking) {
      const chunkingDecision = shouldChunkPR(prFiles);
      if (verbose) {
        console.log(chalk.blue(`PR size assessment: ${chunkingDecision.estimatedTokens} tokens, ${prFiles.length} files`));
        if (chunkingDecision.shouldChunk) {
          console.log(chalk.yellow(`Large PR detected - will chunk into ~${chunkingDecision.recommendedChunks} chunks`));
        }
      }

      // If PR is too large, use chunked processing
      if (chunkingDecision.shouldChunk) {
        console.log(chalk.blue(`🔄 Using chunked processing for large PR (${chunkingDecision.estimatedTokens} tokens)`));
        return await reviewLargePRInChunks(prFiles, options);
      }
    }

    // Step 2: Gather unified context for the entire PR (for regular-sized PRs)
    if (verbose) {
      console.log(chalk.blue(`Performing unified context retrieval for ${prFiles.length} PR files...`));
    }
    const {
      codeExamples: deduplicatedCodeExamples,
      guidelines: deduplicatedGuidelines,
      prComments: deduplicatedPRComments,
      customDocChunks: deduplicatedCustomDocChunks,
    } = await gatherUnifiedContextForPR(prFiles, options);

    if (verbose) {
      console.log(
        chalk.green(
          `De-duplicated context: ${deduplicatedCodeExamples.length} code examples, ${deduplicatedGuidelines.length} guidelines, ${deduplicatedPRComments.length} PR comments, ${deduplicatedCustomDocChunks.length} custom doc chunks`
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
          fullContent: file.content, // Add full file content for context
          diff: file.diffContent,
          baseBranch: file.baseBranch,
          targetBranch: file.targetBranch,
        })),
        unifiedContext: {
          codeExamples: deduplicatedCodeExamples,
          guidelines: deduplicatedGuidelines,
          prComments: deduplicatedPRComments,
          customDocChunks: deduplicatedCustomDocChunks,
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
            customDocChunks: deduplicatedCustomDocChunks.length,
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
            customDocChunks: deduplicatedCustomDocChunks.length,
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
              fullFileContent: file.content, // Pass full file content for context awareness
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
          customDocChunks: deduplicatedCustomDocChunks.length,
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

/**
 * Reviews a large PR by splitting it into manageable chunks and processing them in parallel
 * @param {Array} prFiles - Array of PR files with diff content
 * @param {Object} options - Review options
 * @returns {Promise<Object>} Combined review results
 */
async function reviewLargePRInChunks(prFiles, options) {
  console.log(chalk.blue(`🔄 Large PR detected: ${prFiles.length} files. Splitting into chunks...`));

  // Step 1: Gather shared context once for all chunks
  console.log(chalk.cyan('📚 Gathering shared context for entire PR...'));
  const sharedContext = await gatherUnifiedContextForPR(prFiles, options);

  // Step 2: Split PR into manageable chunks
  // Each chunk includes both diff AND full file content, plus ~25k context overhead
  const chunks = chunkPRFiles(prFiles, 35000); // Conservative limit accounting for context overhead
  console.log(chalk.green(`✂️ Split PR into ${chunks.length} chunks`));

  chunks.forEach((chunk, i) => {
    console.log(chalk.gray(`  Chunk ${i + 1}: ${chunk.files.length} files (~${chunk.totalTokens} tokens)`));
  });

  // Step 3: Process chunks in parallel
  console.log(chalk.blue('🔄 Processing chunks in parallel...'));
  const chunkResults = await Promise.all(
    chunks.map((chunk, index) => reviewPRChunk(chunk, sharedContext, options, index + 1, chunks.length))
  );

  // Step 4: Combine results
  console.log(chalk.blue('🔗 Combining chunk results...'));
  return combineChunkResults(chunkResults, prFiles.length);
}

/**
 * Reviews a single chunk of files from a large PR
 * @param {Object} chunk - Chunk object with files array
 * @param {Object} sharedContext - Pre-gathered shared context
 * @param {Object} options - Review options
 * @param {number} chunkNumber - Current chunk number
 * @param {number} totalChunks - Total number of chunks
 * @returns {Promise<Object>} Chunk review results
 */
async function reviewPRChunk(chunk, sharedContext, options, chunkNumber, totalChunks) {
  console.log(chalk.cyan(`📝 Reviewing chunk ${chunkNumber}/${totalChunks} (${chunk.files.length} files)...`));

  // Create chunk-specific options
  const chunkOptions = {
    ...options,
    isChunkedReview: true,
    chunkNumber: chunkNumber,
    totalChunks: totalChunks,
    preGatheredContext: sharedContext, // Use shared context
    // Reduce context per chunk since we have multiple parallel reviews
    maxExamples: Math.max(3, Math.floor((options.maxExamples || 40) / totalChunks)),
  };

  // Review this chunk as a smaller PR - call the main function recursively but with chunked flag
  // to prevent infinite recursion
  const chunkFilePaths = chunk.files.map((f) => f.filePath);

  // Skip chunking decision for chunk reviews to prevent infinite recursion
  const skipChunkingOptions = { ...chunkOptions, skipChunking: true };

  return await reviewPullRequestWithCrossFileContext(chunkFilePaths, skipChunkingOptions);
}

// Export the core review functions
export { reviewFile, reviewFiles, reviewPullRequest };
