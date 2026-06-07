import chalk from 'chalk';
import { verboseLog } from './logging.js';

const CHARS_PER_ESTIMATED_TOKEN = 3;
const FULL_CONTENT_CONTEXT_TOKEN_RATIO = 0.25;

function estimateTokens(text) {
  return Math.ceil((text?.length || 0) / CHARS_PER_ESTIMATED_TOKEN);
}

/**
 * Determines if a PR should be chunked based on estimated token usage
 * @param {Array} prFiles - Array of PR files with diffContent and content
 * @param {Object} options - Logging options
 * @param {boolean} [options.verbose=false] - Enable verbose token breakdown logging
 * @returns {Object} Decision object with shouldChunk flag and estimates
 */
export function shouldChunkPR(prFiles, options = {}) {
  // IMPORTANT: The holistic PR prompt includes BOTH full file content AND diff content
  // for each file, plus context (code examples, guidelines, PR comments, custom docs)

  // Calculate tokens for diff content
  const diffTokens = prFiles.reduce((sum, file) => {
    return sum + estimateTokens(file.diffContent);
  }, 0);

  // Calculate tokens for full file content (included in prompt for context awareness)
  const fullContentTokens = prFiles.reduce((sum, file) => {
    return sum + estimateTokens(file.content);
  }, 0);

  // Total file-related tokens (both diff AND full content are sent)
  const fileTokens = diffTokens + fullContentTokens;

  // Estimate context overhead (code examples, guidelines, PR comments, custom docs, project summary)
  // This is typically 10-30k tokens depending on project size
  const CONTEXT_OVERHEAD_TOKENS = 25000;

  // Total estimated prompt tokens
  const totalEstimatedTokens = fileTokens + CONTEXT_OVERHEAD_TOKENS;

  // Claude's limit is 200k tokens. Leave buffer for response and safety margin.
  // Max safe prompt size ~150k tokens to be conservative
  const MAX_SINGLE_REVIEW_TOKENS = 100000;

  const shouldChunk = totalEstimatedTokens > MAX_SINGLE_REVIEW_TOKENS || prFiles.length > 30;

  verboseLog(
    options,
    chalk.gray(
      `  Token breakdown: ${diffTokens} diff + ${fullContentTokens} full content + ${CONTEXT_OVERHEAD_TOKENS} context overhead = ${totalEstimatedTokens} total`
    )
  );

  return {
    shouldChunk,
    estimatedTokens: totalEstimatedTokens,
    diffTokens,
    fullContentTokens,
    contextOverhead: CONTEXT_OVERHEAD_TOKENS,
    recommendedChunks: Math.ceil(totalEstimatedTokens / 35000), // More aggressive chunking
  };
}

/**
 * Chunks PR files into manageable groups based on token limits and logical grouping
 * @param {Array} prFiles - Array of PR files with diffContent and content
 * @param {number} maxTokensPerChunk - Maximum tokens per chunk
 * @returns {Array} Array of chunks with files and metadata
 */
export function chunkPRFiles(prFiles, maxTokensPerChunk = 35000) {
  // Calculate change complexity for each file (works for any language)
  // IMPORTANT: Token estimate must include BOTH diff AND full content since both are sent
  const filesWithMetrics = prFiles.flatMap((file) => {
    const fileWithMetrics = {
      ...file,
      changeSize: calculateChangeSize(file.diffContent),
      fileComplexity: calculateFileComplexity(file),
      // Estimate tokens for BOTH diff content AND full file content (both are included in prompt)
      estimatedTokens: estimateTokens(file.diffContent) + estimateTokens(file.content),
    };

    return splitOversizedFileForChunk(fileWithMetrics, maxTokensPerChunk);
  });

  // Sort by directory + change importance for logical grouping
  const sortedFiles = filesWithMetrics.sort((a, b) => {
    const dirA = getDirectoryDepth(a.filePath);
    const dirB = getDirectoryDepth(b.filePath);

    // Primary: Directory structure (keep related files together)
    if (dirA !== dirB) {
      return dirA.localeCompare(dirB);
    }

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

function splitOversizedFileForChunk(file, maxTokensPerChunk) {
  if (file.estimatedTokens <= maxTokensPerChunk) {
    return [file];
  }

  const diffTokens = estimateTokens(file.diffContent);
  if (diffTokens <= maxTokensPerChunk) {
    return [capFileContentForChunk(file, maxTokensPerChunk, diffTokens)];
  }

  const contentBudget = Math.floor(maxTokensPerChunk * FULL_CONTENT_CONTEXT_TOKEN_RATIO);
  const diffBudget = Math.max(maxTokensPerChunk - contentBudget, 1);
  const diffParts = splitDiffToTokenBudget(file.diffContent, diffBudget);
  const cappedContent = truncateToTokenBudget(file.content, contentBudget, 'file content');

  return diffParts.map((diffPart, index) => ({
    ...file,
    diffContent: diffPart,
    content: cappedContent,
    estimatedTokens: estimateTokens(diffPart) + estimateTokens(cappedContent),
    truncatedForChunk: cappedContent !== file.content,
    diffSplitForChunk: true,
    chunkPart: index + 1,
    chunkParts: diffParts.length,
    originalEstimatedTokens: file.estimatedTokens,
    originalDiffEstimatedTokens: diffTokens,
    summary: `${file.summary || pathBasename(file.filePath)} (diff part ${index + 1}/${diffParts.length})`,
  }));
}

function capFileContentForChunk(file, maxTokensPerChunk, diffTokens) {
  const contentBudget = Math.max(maxTokensPerChunk - diffTokens, 0);
  const cappedContent = truncateToTokenBudget(file.content, contentBudget, 'file content');

  return {
    ...file,
    content: cappedContent,
    estimatedTokens: diffTokens + estimateTokens(cappedContent),
    truncatedForChunk: cappedContent !== file.content,
    originalEstimatedTokens: file.estimatedTokens,
  };
}

function splitDiffToTokenBudget(diffContent, tokenBudget) {
  if (!diffContent || estimateTokens(diffContent) <= tokenBudget) {
    return [diffContent || ''];
  }

  const maxChars = tokenBudget * CHARS_PER_ESTIMATED_TOKEN;
  const lines = diffContent.split('\n');
  const firstHunkIndex = lines.findIndex((line) => line.startsWith('@@'));
  const headerLines = firstHunkIndex > 0 ? lines.slice(0, firstHunkIndex) : [];
  const bodyLines = firstHunkIndex >= 0 ? lines.slice(firstHunkIndex) : lines;
  const headerText = headerLines.join('\n');
  const units = splitDiffIntoUnits(bodyLines);
  const parts = [];
  let currentBody = '';

  for (const unit of units) {
    const candidateBody = currentBody ? `${currentBody}\n${unit}` : unit;
    if (formatDiffPart(headerText, candidateBody, parts.length > 0).length <= maxChars) {
      currentBody = candidateBody;
      continue;
    }

    if (currentBody) {
      parts.push(formatDiffPart(headerText, currentBody, parts.length > 0));
      currentBody = '';
    }

    if (formatDiffPart(headerText, unit, parts.length > 0).length <= maxChars) {
      currentBody = unit;
      continue;
    }

    parts.push(...splitLargeDiffUnit(headerText, unit, maxChars, parts.length > 0));
  }

  if (currentBody) {
    parts.push(formatDiffPart(headerText, currentBody, parts.length > 0));
  }

  return parts.length > 0 ? parts : [diffContent];
}

function splitDiffIntoUnits(lines) {
  const hasHunks = lines.some((line) => line.startsWith('@@'));
  if (!hasHunks) {
    return [lines.join('\n')];
  }

  const units = [];
  let currentUnit = [];

  for (const line of lines) {
    if (line.startsWith('@@') && currentUnit.length > 0) {
      units.push(currentUnit.join('\n'));
      currentUnit = [];
    }
    currentUnit.push(line);
  }

  if (currentUnit.length > 0) {
    units.push(currentUnit.join('\n'));
  }

  return units;
}

function splitLargeDiffUnit(headerText, unit, maxChars, hasPreviousPart) {
  const parts = [];

  for (let offset = 0; offset < unit.length; ) {
    const prefix = buildBoundedDiffPrefix(headerText, hasPreviousPart || parts.length > 0, maxChars);
    const sliceChars = Math.max(maxChars - prefix.length, 1);
    const slice = unit.slice(offset, offset + sliceChars);
    parts.push(`${prefix}${slice}`);
    offset += sliceChars;
  }

  return parts;
}

function buildBoundedDiffPrefix(headerText, isContinuation, maxChars) {
  const prefixText = [headerText, isContinuation ? splitMarker() : ''].filter(Boolean).join('\n');
  if (!prefixText || maxChars <= 1) {
    return '';
  }

  const maxPrefixChars = Math.max(maxChars - 2, 0);
  const boundedPrefix = prefixText.length > maxPrefixChars ? prefixText.slice(0, maxPrefixChars) : prefixText;
  return boundedPrefix ? `${boundedPrefix}\n` : '';
}

function formatDiffPart(headerText, bodyText, isContinuation) {
  return [headerText, isContinuation ? splitMarker() : '', bodyText].filter(Boolean).join('\n');
}

function splitMarker() {
  return '... (diff split for PR review token budget; continued from another part) ...';
}

function pathBasename(filePath) {
  return (
    String(filePath || '')
      .split('/')
      .pop() || 'file'
  );
}

function truncateToTokenBudget(text, tokenBudget, label) {
  if (!text || tokenBudget <= 0) {
    return '';
  }

  const maxChars = tokenBudget * CHARS_PER_ESTIMATED_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }

  const marker = `\n... (${label} truncated for PR review token budget; original length ${text.length} characters) ...\n`;
  if (maxChars <= marker.length + 20) {
    return text.slice(0, Math.max(maxChars, 0));
  }

  const availableChars = maxChars - marker.length;
  const headChars = Math.ceil(availableChars * 0.7);
  const tailChars = Math.max(availableChars - headChars, 0);

  return `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ''}`;
}

/**
 * Language-agnostic change size calculation
 * @param {string} diffContent - The diff content
 * @returns {number} Total number of additions and deletions
 */
function calculateChangeSize(diffContent) {
  if (!diffContent) {
    return 0;
  }
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
  if (path.includes('/src/') || path.includes('/lib/')) {
    complexity += 10;
  }
  if (path.includes('/test/') || path.includes('/spec/')) {
    complexity += 5;
  }
  if (path.includes('/config/') || path.includes('/settings/')) {
    complexity += 8;
  }
  if (path.includes('/main.') || path.includes('/index.')) {
    complexity += 15;
  }

  // Change type heuristics
  if (file.diffContent) {
    if (file.diffContent.includes('new file mode')) {
      complexity += 12;
    }
    if (file.diffContent.includes('deleted file mode')) {
      complexity += 8;
    }
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
 * @param {Object} options - Logging options
 * @param {boolean} [options.verbose=false] - Enable verbose chunk combination logging
 * @returns {Object} Combined result object
 */
export function combineChunkResults(chunkResults, totalFiles, options = {}) {
  const combinedResult = {
    success: true,
    results: [],
    prContext: {
      totalFiles: totalFiles,
      chunkedReview: true,
      chunks: chunkResults.length,
    },
  };

  const mergedResultsByFile = new Map();

  // Combine file-specific results, merging split-file review parts back into one file result.
  chunkResults.forEach((chunkResult, chunkIndex) => {
    if (chunkResult.success && chunkResult.results) {
      chunkResult.results.forEach((fileResult, resultIndex) => {
        mergeChunkFileResult(mergedResultsByFile, fileResult, {
          chunkNumber: chunkIndex + 1,
          totalChunks: chunkResults.length,
          resultIndex,
        });
      });
    }
  });

  combinedResult.results = Array.from(mergedResultsByFile.values());

  // Create combined summary
  combinedResult.combinedSummary = createCombinedSummary(combinedResult.results, chunkResults);

  // Detect and merge cross-chunk issues
  combinedResult.crossChunkIssues = detectCrossChunkIssues(chunkResults);

  verboseLog(options, chalk.green(`✅ Combined results from ${chunkResults.length} chunks: ${combinedResult.results.length} file reviews`));

  return combinedResult;
}

function mergeChunkFileResult(mergedResultsByFile, fileResult, chunkInfo) {
  const key = fileResult.filePath || `chunk-${chunkInfo.chunkNumber}-result-${chunkInfo.resultIndex}`;
  const resultWithChunkInfo = {
    ...fileResult,
    chunkInfo: {
      chunkNumber: chunkInfo.chunkNumber,
      totalChunks: chunkInfo.totalChunks,
    },
    chunkInfos: [
      {
        chunkNumber: chunkInfo.chunkNumber,
        totalChunks: chunkInfo.totalChunks,
      },
    ],
  };

  if (!mergedResultsByFile.has(key)) {
    mergedResultsByFile.set(key, resultWithChunkInfo);
    return;
  }

  const existing = mergedResultsByFile.get(key);
  const existingIssues = existing.results?.issues || [];
  const newIssues = fileResult.results?.issues || [];
  existing.results = {
    ...existing.results,
    ...fileResult.results,
    issues: mergeIssues(existingIssues, newIssues),
  };
  existing.chunkInfos.push({
    chunkNumber: chunkInfo.chunkNumber,
    totalChunks: chunkInfo.totalChunks,
  });
  existing.chunkInfo = {
    chunkNumber: existing.chunkInfo.chunkNumber,
    totalChunks: chunkInfo.totalChunks,
    chunkNumbers: [...new Set(existing.chunkInfos.map((info) => info.chunkNumber))],
  };
}

function mergeIssues(existingIssues, newIssues) {
  const mergedIssues = [...existingIssues];
  const seenIssueKeys = new Set(existingIssues.map(issueKey));

  for (const issue of newIssues) {
    const key = issueKey(issue);
    if (!seenIssueKeys.has(key)) {
      mergedIssues.push(issue);
      seenIssueKeys.add(key);
    }
  }

  return mergedIssues;
}

function issueKey(issue) {
  return JSON.stringify({
    type: issue.type,
    severity: issue.severity,
    description: issue.description,
    suggestion: issue.suggestion,
    lineNumbers: issue.lineNumbers,
    codeSuggestion: issue.codeSuggestion,
  });
}

/**
 * Creates a summary from combined chunk results
 * @param {Array} chunkResults - Array of chunk review results
 * @returns {string} Combined summary text
 */
function createCombinedSummary(results, chunkResults) {
  const totalIssues = results.reduce((sum, file) => {
    return sum + (file.results?.issues?.length || 0);
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
    const uniqueFiles = new Set(issues.map((i) => i.filePath));
    if (uniqueChunks.size > 1 && uniqueFiles.size > 1) {
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
