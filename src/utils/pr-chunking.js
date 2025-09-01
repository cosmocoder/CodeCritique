import chalk from 'chalk';

/**
 * Determines if a PR should be chunked based on estimated token usage
 * @param {Array} prFiles - Array of PR files with diffContent
 * @returns {Object} Decision object with shouldChunk flag and estimates
 */
export function shouldChunkPR(prFiles) {
  const totalEstimatedTokens = prFiles.reduce((sum, file) => sum + Math.ceil(file.diffContent.length / 3), 0);

  const MAX_SINGLE_REVIEW_TOKENS = 120000; // Conservative limit

  return {
    shouldChunk: totalEstimatedTokens > MAX_SINGLE_REVIEW_TOKENS || prFiles.length > 30,
    estimatedTokens: totalEstimatedTokens,
    recommendedChunks: Math.ceil(totalEstimatedTokens / 45000),
  };
}

/**
 * Chunks PR files into manageable groups based on token limits and logical grouping
 * @param {Array} prFiles - Array of PR files with diffContent
 * @param {number} maxTokensPerChunk - Maximum tokens per chunk
 * @returns {Array} Array of chunks with files and metadata
 */
export function chunkPRFiles(prFiles, maxTokensPerChunk = 50000) {
  // Calculate change complexity for each file (works for any language)
  const filesWithMetrics = prFiles.map((file) => ({
    ...file,
    changeSize: calculateChangeSize(file.diffContent),
    fileComplexity: calculateFileComplexity(file),
    estimatedTokens: Math.ceil(file.diffContent.length / 3),
  }));

  // Sort by directory + change importance for logical grouping
  const sortedFiles = filesWithMetrics.sort((a, b) => {
    const dirA = getDirectoryDepth(a.filePath);
    const dirB = getDirectoryDepth(b.filePath);

    // Primary: Directory structure (keep related files together)
    if (dirA !== dirB) return dirA.localeCompare(dirB);

    // Secondary: Change importance (larger changes first)
    return b.changeSize - a.changeSize;
  });

  // Chunk files based on token budget
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;

  for (const file of sortedFiles) {
    // Start new chunk if adding this file exceeds budget
    if (currentTokens + file.estimatedTokens > maxTokensPerChunk && currentChunk.length > 0) {
      chunks.push({
        files: [...currentChunk],
        totalTokens: currentTokens,
        chunkId: chunks.length + 1,
      });
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(file);
    currentTokens += file.estimatedTokens;
  }

  // Add final chunk
  if (currentChunk.length > 0) {
    chunks.push({
      files: [...currentChunk],
      totalTokens: currentTokens,
      chunkId: chunks.length + 1,
    });
  }

  return chunks;
}

/**
 * Language-agnostic change size calculation
 * @param {string} diffContent - The diff content
 * @returns {number} Total number of additions and deletions
 */
function calculateChangeSize(diffContent) {
  if (!diffContent) return 0;
  const lines = diffContent.split('\n');
  const additions = lines.filter((line) => line.startsWith('+')).length;
  const deletions = lines.filter((line) => line.startsWith('-')).length;
  return additions + deletions;
}

/**
 * Language-agnostic file complexity scoring
 * @param {Object} file - File object with filePath and diffContent
 * @returns {number} Complexity score
 */
function calculateFileComplexity(file) {
  let complexity = 0;

  // File size factor
  complexity += Math.min(file.diffContent ? file.diffContent.length / 1000 : 0, 20);

  // Path-based heuristics (works for any language)
  const path = file.filePath.toLowerCase();
  if (path.includes('/src/') || path.includes('/lib/')) complexity += 10;
  if (path.includes('/test/') || path.includes('/spec/')) complexity += 5;
  if (path.includes('/config/') || path.includes('/settings/')) complexity += 8;
  if (path.includes('/main.') || path.includes('/index.')) complexity += 15;

  // Change type heuristics
  if (file.diffContent) {
    if (file.diffContent.includes('new file mode')) complexity += 12;
    if (file.diffContent.includes('deleted file mode')) complexity += 8;
  }

  return complexity;
}

/**
 * Gets directory path for grouping related files
 * @param {string} filePath - The file path
 * @returns {string} Directory path without filename
 */
function getDirectoryDepth(filePath) {
  return filePath.split('/').slice(0, -1).join('/'); // Directory path without filename
}

/**
 * Combines results from multiple chunk reviews into a single result
 * @param {Array} chunkResults - Array of chunk review results
 * @param {number} totalFiles - Total number of files in the PR
 * @returns {Object} Combined result object
 */
export function combineChunkResults(chunkResults, totalFiles) {
  const combinedResult = {
    success: true,
    results: [],
    prContext: {
      totalFiles: totalFiles,
      chunkedReview: true,
      chunks: chunkResults.length,
    },
  };

  // Combine file-specific results
  chunkResults.forEach((chunkResult, chunkIndex) => {
    if (chunkResult.success && chunkResult.results) {
      chunkResult.results.forEach((fileResult) => {
        // Add chunk context to each result
        const enhancedResult = {
          ...fileResult,
          chunkInfo: {
            chunkNumber: chunkIndex + 1,
            totalChunks: chunkResults.length,
          },
        };
        combinedResult.results.push(enhancedResult);
      });
    }
  });

  // Create combined summary
  combinedResult.combinedSummary = createCombinedSummary(chunkResults);

  // Detect and merge cross-chunk issues
  combinedResult.crossChunkIssues = detectCrossChunkIssues(chunkResults);

  console.log(chalk.green(`✅ Combined results from ${chunkResults.length} chunks: ${combinedResult.results.length} file reviews`));

  return combinedResult;
}

/**
 * Creates a summary from combined chunk results
 * @param {Array} chunkResults - Array of chunk review results
 * @returns {string} Combined summary text
 */
function createCombinedSummary(chunkResults) {
  const totalIssues = chunkResults.reduce((sum, chunk) => {
    if (!chunk.results) return sum;
    return (
      sum +
      chunk.results.reduce((fileSum, file) => {
        return fileSum + (file.results?.issues?.length || 0);
      }, 0)
    );
  }, 0);

  const successfulChunks = chunkResults.filter((c) => c.success).length;

  return `Chunked PR review completed: ${successfulChunks}/${chunkResults.length} chunks processed successfully. Total issues found: ${totalIssues}. Review performed in parallel chunks to optimize token usage.`;
}

/**
 * Detects issues that span across multiple chunks
 * @param {Array} chunkResults - Array of chunk review results
 * @returns {Array} Array of cross-chunk issues
 */
function detectCrossChunkIssues(chunkResults) {
  const crossChunkIssues = [];

  // Simple heuristic: Look for similar issues across chunks that might indicate patterns
  const allIssues = chunkResults.flatMap(
    (chunk) =>
      chunk.results?.flatMap((file) =>
        (file.results?.issues || []).map((issue) => ({
          ...issue,
          chunkId: chunk.chunkId,
          filePath: file.filePath,
        }))
      ) || []
  );

  // Group by issue type and description similarity
  const issueGroups = new Map();
  allIssues.forEach((issue) => {
    const key = `${issue.type}-${issue.description ? issue.description.substring(0, 50) : ''}`;
    if (!issueGroups.has(key)) {
      issueGroups.set(key, []);
    }
    issueGroups.get(key).push(issue);
  });

  // Identify patterns that appear across multiple chunks
  issueGroups.forEach((issues) => {
    const uniqueChunks = new Set(issues.map((i) => i.chunkId));
    if (uniqueChunks.size > 1) {
      crossChunkIssues.push({
        type: 'pattern',
        severity: 'medium',
        description: `Similar issue pattern detected across ${uniqueChunks.size} chunks: ${issues[0].description || 'Pattern issue'}`,
        affectedFiles: issues.map((i) => i.filePath),
        suggestion: `This issue appears in multiple parts of the PR. Consider addressing it consistently across all affected files.`,
      });
    }
  });

  return crossChunkIssues;
}
