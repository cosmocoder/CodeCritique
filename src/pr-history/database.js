/**
 * PR History Database Integration
 *
 * This module provides PR comment storage and retrieval functionality
 * by reusing the database infrastructure from embeddings.js.
 * All database connection, table management, and indexing is handled by embeddings.js.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { pipeline } from '@huggingface/transformers';
import chalk from 'chalk';
import stopwords from 'stopwords-iso/stopwords-iso.json' with { type: 'json' };
import { calculateQueryEmbedding, CONSTANTS, getPRCommentsTable, updatePRCommentsIndex } from '../embeddings.js';

// Import constants from embeddings.js to avoid duplication
const { EMBEDDING_DIMENSIONS, PR_COMMENTS_TABLE } = CONSTANTS;

/**
 * Store multiple PR comments in batch
 * @param {Array<Object>} commentsData - Array of processed comment data
 * @param {string} projectPath - Project path for isolation (optional, defaults to cwd)
 * @returns {Promise<number>} Number of successfully stored comments
 */
export async function storePRCommentsBatch(commentsData, projectPath = process.cwd()) {
  if (!Array.isArray(commentsData) || commentsData.length === 0) {
    return 0;
  }

  let successCount = 0;
  const batchSize = 100;
  const resolvedProjectPath = path.resolve(projectPath);

  try {
    const table = await getPRCommentsTable();

    if (!table) {
      throw new Error(`Table ${PR_COMMENTS_TABLE} not found`);
    }

    for (let i = 0; i < commentsData.length; i += batchSize) {
      const batch = commentsData.slice(i, i + batchSize);
      const validRecords = [];

      for (const commentData of batch) {
        try {
          // Validate and prepare record
          if (!commentData.id || !commentData.comment_text || !commentData.comment_embedding) {
            console.warn(chalk.yellow(`Skipping comment with missing required fields: ${commentData.id || 'unknown'}`));
            continue;
          }

          if (commentData.comment_embedding.length !== EMBEDDING_DIMENSIONS) {
            console.warn(chalk.yellow(`Skipping comment with invalid embedding dimensions: ${commentData.id}`));
            continue;
          }

          const record = {
            id: commentData.id,
            pr_number: commentData.pr_number || 0,
            repository: commentData.repository || '',
            project_path: resolvedProjectPath,
            comment_type: commentData.comment_type || 'issue',
            comment_text: commentData.comment_text,
            comment_embedding: commentData.comment_embedding,

            file_path: commentData.file_path || null,
            line_number: commentData.line_number || null,
            line_range_start: commentData.line_range_start || null,
            line_range_end: commentData.line_range_end || null,
            original_code: commentData.original_code || null,
            suggested_code: commentData.suggested_code || null,
            diff_hunk: commentData.diff_hunk || null,

            code_embedding: commentData.code_embedding || null,
            combined_embedding: commentData.combined_embedding || commentData.comment_embedding,

            author: commentData.author || 'unknown',
            created_at: commentData.created_at || new Date().toISOString(),
            updated_at: commentData.updated_at || null,
            review_id: commentData.review_id || null,
            review_state: commentData.review_state || null,

            issue_category: commentData.issue_category || 'general',
            severity: commentData.severity || 'minor',
            pattern_tags: JSON.stringify(commentData.pattern_tags || []),
          };

          validRecords.push(record);
        } catch (recordError) {
          console.warn(chalk.yellow(`Error preparing record for ${commentData.id}: ${recordError.message}`));
        }
      }

      if (validRecords.length > 0) {
        try {
          await table.add(validRecords);
          successCount += validRecords.length;
          console.log(chalk.green(`Stored batch of ${validRecords.length} PR comments`));
        } catch (batchError) {
          console.error(chalk.red(`Error storing batch: ${batchError.message}`));
        }
      }
    }
    if (successCount > 0) {
      await updatePRCommentsIndex();
    }
  } catch (error) {
    console.error(chalk.red(`Error in batch storage: ${error.message}`));
  }

  return successCount;
}

/**
 * Get statistics about stored PR comments
 * @param {string} repository - Repository to get stats for (optional)
 * @param {string} projectPath - Project path for filtering (optional, defaults to cwd)
 * @returns {Promise<Object>} Statistics object
 */
export async function getPRCommentsStats(repository = null, projectPath = process.cwd()) {
  try {
    const table = await getPRCommentsTable();

    const defaultStats = {
      total_comments: 0,
      comment_types: {},
      issue_categories: {},
      severity_levels: {},
      authors: {},
      repositories: {},
    };

    if (!table) {
      console.log(chalk.yellow('PR comments table not found, returning empty stats'));
      return defaultStats;
    }

    const resolvedProjectPath = path.resolve(projectPath);

    const filters = [`project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`];
    if (repository) {
      filters.push(`repository = '${repository.replace(/'/g, "''")}'`);
    }

    const whereClause = filters.join(' AND ');
    console.log(chalk.blue(`Getting stats with filter: ${whereClause}`));

    let totalCount = 0;
    try {
      totalCount = await table.countRows(whereClause);
      console.log(chalk.blue(`Found ${totalCount} total comments matching filter`));
    } catch (countError) {
      console.warn(chalk.yellow(`Error counting rows: ${countError.message}, trying without filter`));
      totalCount = await table.countRows();
      console.log(chalk.blue(`Found ${totalCount} total comments in table`));
    }

    let results = [];
    if (totalCount > 0) {
      try {
        // Use query() instead of search() for non-vector queries
        results = await table.query().where(whereClause).limit(10000).toArray();
        console.log(chalk.blue(`Retrieved ${results.length} comments for analysis`));
      } catch (queryError) {
        console.warn(chalk.yellow(`Error with filtered query: ${queryError.message}, trying without filter`));
        try {
          // Try getting all records and filter manually
          results = await table.query().limit(10000).toArray();
          // Filter results manually if database query failed
          if (repository) {
            results = results.filter((r) => r.repository === repository && r.project_path === resolvedProjectPath);
          } else {
            results = results.filter((r) => r.project_path === resolvedProjectPath);
          }
          console.log(chalk.blue(`Retrieved and filtered ${results.length} comments for analysis`));
        } catch (fallbackError) {
          console.error(chalk.red(`Fallback query also failed: ${fallbackError.message}`));
          results = [];
        }
      }
    }

    const stats = {
      total_comments: results.length,
      totalComments: results.length, // Add field expected by index.js
      comment_types: {},
      issue_categories: {},
      severity_levels: {},
      authors: {},
      repositories: {},
    };

    // Calculate additional fields expected by index.js
    const uniquePRs = new Set();
    let earliestDate = null;
    let latestDate = null;

    if (Array.isArray(results) && results.length > 0) {
      for (const comment of results) {
        // Safely handle potentially undefined fields
        const commentType = comment.comment_type || 'unknown';
        const issueCategory = comment.issue_category || 'general';
        const severity = comment.severity || 'minor';
        const author = comment.author || 'unknown';
        const repo = comment.repository || 'unknown';

        stats.comment_types[commentType] = (stats.comment_types[commentType] || 0) + 1;
        stats.issue_categories[issueCategory] = (stats.issue_categories[issueCategory] || 0) + 1;
        stats.severity_levels[severity] = (stats.severity_levels[severity] || 0) + 1;
        stats.authors[author] = (stats.authors[author] || 0) + 1;
        stats.repositories[repo] = (stats.repositories[repo] || 0) + 1;

        // Track unique PRs
        if (comment.pr_number) {
          uniquePRs.add(comment.pr_number);
        }

        // Track date range
        if (comment.created_at) {
          const commentDate = new Date(comment.created_at);
          if (!earliestDate || commentDate < earliestDate) {
            earliestDate = commentDate;
          }
          if (!latestDate || commentDate > latestDate) {
            latestDate = commentDate;
          }
        }
      }
    }

    // Add fields expected by index.js clear command
    stats.totalPRs = uniquePRs.size;
    stats.uniqueAuthors = Object.keys(stats.authors).length;
    stats.dateRange = {
      earliest: earliestDate ? earliestDate.toISOString().split('T')[0] : 'N/A',
      latest: latestDate ? latestDate.toISOString().split('T')[0] : 'N/A',
    };

    console.log(chalk.green(`Stats generated: ${stats.totalComments} comments, ${stats.totalPRs} PRs, ${stats.uniqueAuthors} authors`));
    return stats;
  } catch (error) {
    console.error(chalk.red(`Error getting PR comments stats: ${error.message}`));
    console.error(chalk.red(`Stack trace: ${error.stack}`));
    return {
      total_comments: 0,
      comment_types: {},
      issue_categories: {},
      severity_levels: {},
      authors: {},
      repositories: {},
    };
  }
}

/**
 * Get the date range of processed PRs for a repository
 * @param {string} repository - Repository in format "owner/repo"
 * @param {string} projectPath - Project path for filtering (optional, defaults to cwd)
 * @returns {Promise<{oldestPR: string|null, newestPR: string|null}>} Date range of processed PRs
 */
export async function getProcessedPRDateRange(repository, projectPath = process.cwd()) {
  try {
    const table = await getPRCommentsTable();

    if (!table) {
      return { oldestPR: null, newestPR: null };
    }

    const resolvedProjectPath = path.resolve(projectPath);
    const whereClause = `repository = '${repository.replace(/'/g, "''")}' AND project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`;

    // Get all unique PR numbers and their creation dates
    const results = await table.query().where(whereClause).limit(10000).toArray();

    if (results.length === 0) {
      return { oldestPR: null, newestPR: null };
    }

    // Extract unique PRs with their dates
    const prDates = new Map();
    results.forEach((comment) => {
      if (comment.pr_number && comment.created_at) {
        const prNumber = comment.pr_number;
        const commentDate = new Date(comment.created_at);

        if (!prDates.has(prNumber) || commentDate < prDates.get(prNumber)) {
          prDates.set(prNumber, commentDate);
        }
      }
    });

    if (prDates.size === 0) {
      return { oldestPR: null, newestPR: null };
    }

    const dates = Array.from(prDates.values()).sort((a, b) => a - b);
    const oldestPR = dates[0].toISOString();
    const newestPR = dates[dates.length - 1].toISOString();

    console.log(chalk.blue(`Processed PR date range: ${oldestPR} to ${newestPR} (${prDates.size} PRs)`));
    return { oldestPR, newestPR };
  } catch (error) {
    console.error(chalk.red(`Error getting processed PR date range: ${error.message}`));
    return { oldestPR: null, newestPR: null };
  }
}

/**
 * Check if a PR should be skipped based on processed date range
 * @param {Object} pr - PR object with merged_at or created_at date
 * @param {string} oldestPR - Oldest processed PR date (ISO string)
 * @param {string} newestPR - Newest processed PR date (ISO string)
 * @returns {boolean} True if PR should be skipped
 */
export function shouldSkipPR(pr, oldestPR, newestPR) {
  if (!oldestPR || !newestPR || !pr) {
    return false;
  }

  const prDate = new Date(pr.merged_at || pr.created_at || pr.updated_at);
  const oldestDate = new Date(oldestPR);
  const newestDate = new Date(newestPR);

  // Skip if PR date falls within the already processed range
  return prDate >= oldestDate && prDate <= newestDate;
}

/**
 * Clear all PR comments for a repository
 * @param {string} repository - Repository in format "owner/repo"
 * @param {string} projectPath - Project path for filtering (optional, defaults to cwd)
 * @returns {Promise<number>} Number of deleted comments
 */
export async function clearPRComments(repository, projectPath = process.cwd()) {
  try {
    const table = await getPRCommentsTable();

    if (!table) {
      return 0;
    }

    const resolvedProjectPath = path.resolve(projectPath);
    const deleteQuery = `repository = '${repository.replace(/'/g, "''")}' AND project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`;
    const countBefore = await table.countRows(deleteQuery);

    await table.delete(deleteQuery);

    console.log(chalk.yellow(`Cleared ${countBefore} PR comments for repository ${repository}`));
    return countBefore;
  } catch (error) {
    console.error(chalk.red(`Error clearing PR comments: ${error.message}`));
    return 0;
  }
}

/**
 * Check if PR comments exist for a repository
 * @param {string} repository - Repository in format "owner/repo"
 * @param {string} projectPath - Project path for filtering (optional, if null checks all projects)
 * @returns {Promise<boolean>} True if comments exist
 */
export async function hasPRComments(repository, projectPath = process.cwd()) {
  try {
    const table = await getPRCommentsTable();

    if (!table) {
      return false;
    }

    let whereClause = `repository = '${repository.replace(/'/g, "''")}'`;

    if (projectPath !== null) {
      const resolvedProjectPath = path.resolve(projectPath);
      whereClause += ` AND project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`;
    }

    const count = await table.countRows(whereClause);
    return count > 0;
  } catch (error) {
    console.error(chalk.red(`Error checking PR comments existence: ${error.message}`));
    return false;
  }
}

/**
 * Get the timestamp of the last analysis for incremental updates
 * @param {string} repository - Repository in format "owner/repo"
 * @param {string} projectPath - Project path for filtering
 * @returns {Promise<string|null>} ISO timestamp or null if no previous analysis
 */
export async function getLastAnalysisTimestamp(repository, projectPath) {
  try {
    const table = await getPRCommentsTable();

    if (!table) {
      return null;
    }

    const resolvedProjectPath = path.resolve(projectPath);

    const filters = [`repository = '${repository.replace(/'/g, "''")}'`, `project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`];

    const results = await table
      .search()
      .where(filters.join(' AND '))
      .limit(1)
      .select(['created_at'])
      .orderBy([{ column: 'created_at', order: 'desc' }])
      .toArray();

    if (results.length > 0) {
      return results[0].created_at;
    }

    return null;
  } catch (error) {
    console.error(chalk.red(`Error getting last analysis timestamp: ${error.message}`));
    return null;
  }
}

// ============================================================================
// MAIN OPTIMIZATION FUNCTIONS
// ============================================================================

// ============================================================================
// HYBRID SEARCH IMPLEMENTATION BASED ON RESEARCH SAMPLE
// ============================================================================

// Configuration based on research sample
const HYBRID_SEARCH_CONFIG = {
  CHUNK_SIZE: 20,
  CHUNK_OVERLAP: 5,
  SEARCH_LIMIT: 1, // We only need the single best chunk match for each historical comment
  SIMILARITY_THRESHOLD: 0.4, // this is actually distance, where 0 is an exact match
  LLM_BATCH_SIZE: 10,
};

/**
 * Creates overlapping chunks of code from a source file (based on research sample)
 * @param {string} codeContent - The full string content of the code file
 * @param {number} chunkSize - The number of lines per chunk
 * @param {number} overlap - The number of lines to overlap between consecutive chunks
 * @returns {Array<{code: string, startLine: number, endLine: number}>} An array of code chunks
 */
function createCodeChunks(codeContent, chunkSize = HYBRID_SEARCH_CONFIG.CHUNK_SIZE, overlap = HYBRID_SEARCH_CONFIG.CHUNK_OVERLAP) {
  const lines = codeContent.split(/\r?\n/);
  const chunks = [];
  const step = chunkSize - overlap;

  for (let i = 0; i < lines.length; i += step) {
    const end = Math.min(i + chunkSize, lines.length);
    const chunkLines = lines.slice(i, end);

    if (chunkLines.join('').trim() !== '') {
      chunks.push({
        code: chunkLines.join('\n'),
        startLine: i + 1,
        endLine: end,
      });
    }
    if (end === lines.length) break;
  }
  return chunks;
}

// Initialize the classifier with better error handling and configuration
// Detect M1 chips specifically and disable classifiers completely due to mutex threading issues
const isM1Chip = (() => {
  try {
    const cpuInfo = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
    return cpuInfo.includes('M1');
  } catch {
    return false;
  }
})();

let classifier = null;

if (isM1Chip) {
  console.log(chalk.yellow('⚠ Detected M1 chip - disabling HuggingFace classifiers due to mutex threading issues'));
  console.log(chalk.yellow('⚠ PR comment verification will fall back to assuming all candidates are relevant'));
} else {
  try {
    classifier = await pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli', {
      quantized: true,
      // Reduce precision to avoid dimension issues
      dtype: 'q4',
      device: 'cpu',
    });
    console.log(chalk.green('✓ Local MobileBERT classifier initialized successfully'));
  } catch {
    console.warn(chalk.yellow('⚠ Failed to initialize MobileBERT, trying fallback model...'));
    try {
      // Fallback to a smaller, more stable model
      classifier = await pipeline('zero-shot-classification', 'Xenova/distilbert-base-uncased-mnli', {
        quantized: true,
        dtype: 'q4',
        device: 'cpu',
      });
      console.log(chalk.green('✓ Local DistilBERT classifier initialized successfully (fallback)'));
    } catch (fallbackError) {
      console.warn(chalk.yellow('⚠ Failed to initialize any local classifier:'), fallbackError.message);
      classifier = null;
    }
  }
}

/**
 * Clean up the classifier resources to prevent hanging
 */
export async function cleanupClassifier() {
  if (classifier) {
    try {
      await classifier.dispose();

      classifier = null;
      console.log(chalk.green('✓ Local classifier resources cleaned up'));

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
    } catch (error) {
      console.warn(chalk.yellow('⚠ Error cleaning up classifier:'), error.message);
      classifier = null;
    }
  }
}

/**
 * A faster, local alternative to the full LLM verification that processes candidates in batches.
 * @param {Array<object>} candidates - An array of candidate objects to verify. Each object should have
 * `comment_text`, and a `matchedChunk` with `code`.
 * @returns {Promise<Array<object>>} - An array of the candidates that were verified as relevant.
 */
async function verifyLocally(candidates) {
  if (!candidates || candidates.length === 0) {
    return [];
  }

  // Check if classifier is available
  if (!classifier) {
    console.warn(chalk.yellow('Local classifier not available, assuming all candidates relevant'));
    return candidates;
  }

  // MobileBERT has a max sequence length of 512 tokens.
  // We need to be very conservative to avoid ONNX dimension mismatches.
  // Use a much smaller limit and clean the text more aggressively
  const maxChars = 400; // Very conservative limit

  // 1. Create an array of text contexts for the entire batch.
  const contexts = candidates.map((candidate) => {
    // Clean and normalize the text inputs to prevent tokenization issues
    const commentText = (candidate.comment_text || '')
      .trim()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/[^\w\s.,;:!?()-]/g, '') // Remove special characters that might cause issues
      .substring(0, maxChars / 2);

    const codeText = (candidate.matchedChunk.code || '')
      .trim()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/[^\w\s.,;:!?(){}[\]<>=+\-*/]/g, '') // Keep basic code characters
      .substring(0, maxChars / 2);

    // Create a simple, clean input format
    const problemContext = `Comment: ${commentText} Code: ${codeText}`;

    // Final safety truncation with word boundary respect
    let truncatedContext = problemContext.substring(0, maxChars);

    // Ensure we don't cut off in the middle of a word
    const lastSpaceIndex = truncatedContext.lastIndexOf(' ');
    if (lastSpaceIndex > maxChars * 0.8) {
      // Only trim if we're not losing too much
      truncatedContext = truncatedContext.substring(0, lastSpaceIndex);
    }

    return truncatedContext;
  });

  const candidateLabels = ['relevant issue', 'irrelevant'];
  const relevanceThreshold = 0.75; // Tune this value (75% confidence)
  const verifiedCandidates = [];

  try {
    // 2. Make a SINGLE call to the classifier with the entire batch of contexts.
    // The pipeline will return an array of results, one for each context.
    const outputs = await classifier(contexts, candidateLabels);

    // 3. Process the batch of results.
    outputs.forEach((output, index) => {
      const relevanceScore = output.scores[output.labels.indexOf('relevant issue')];

      if (relevanceScore > relevanceThreshold) {
        verifiedCandidates.push(candidates[index]);
      }
    });

    return verifiedCandidates;
  } catch (error) {
    // Check if it's the specific ONNX broadcasting error
    if (error.message && error.message.includes('BroadcastIterator')) {
      console.warn(chalk.yellow(`Local batch verification skipped due to tensor dimension mismatch. Batch size: ${candidates.length}`));
    } else {
      console.error(chalk.red('Local batch verification failed:'), error.message || error);
    }

    // Fail open: if the local model fails, assume the whole batch is relevant to avoid discarding good matches.
    return candidates;
  }
}

// NEW: A fast pre-filtering step to reduce candidates before hitting the LLM.
// Use English stopwords from stopwords-iso
const stopWords = new Set(stopwords.en || []);
function preFilterWithKeywords(candidate) {
  const commentText = (candidate.comment_text || '').toLowerCase();
  const codeText = (candidate.matchedChunk.code || '').toLowerCase();

  // Extract potential keywords from the comment, ignoring common words.
  const keywords = commentText.split(/[^a-zA-Z0-9_]+/).filter((word) => word.length > 2 && !stopWords.has(word));

  // If there are no good keywords, we can't pre-filter, so let it pass.
  if (keywords.length === 0) {
    return true;
  }

  // Check if at least one of the keywords from the comment appears in the code chunk.
  return keywords.some((keyword) => codeText.includes(keyword));
}

/**
 * Find relevant PR comments using hybrid search with chunking strategy
 * @param {string} reviewFileContent - Content of the review file
 * @param {Object} options - Search options
 * @returns {Promise<Array<Object>>} Relevant PR comments with verification
 */
export async function findRelevantPRComments(reviewFileContent, options = {}) {
  const { limit = 10, projectPath = process.cwd(), isTestFile = false } = options;

  try {
    console.log(chalk.cyan('🔍 Starting FORWARD Hybrid Search with LLM Verification'));

    if (!reviewFileContent) {
      console.warn(chalk.yellow('No review file content provided'));
      return [];
    }

    // --- Step 1: Create chunks from the file under review ---
    const codeChunks = createCodeChunks(reviewFileContent);
    if (codeChunks.length === 0) {
      console.warn(chalk.yellow('No valid chunks created from review file'));
      return [];
    }
    console.log(chalk.blue(`📝 Created ${codeChunks.length} chunks from the review file.`));

    const chunkEmbeddings = await Promise.all(
      codeChunks.map(async (chunk) => ({
        vector: await calculateQueryEmbedding(chunk.code),
        ...chunk,
      }))
    );

    // --- Step 2: Search for relevant historical comments for each chunk ---
    const mainTable = await getPRCommentsTable();
    if (!mainTable) throw new Error('Main PR comments table not found.');

    const candidateMatches = new Map();

    // Create project-specific WHERE clause for filtering
    const resolvedProjectPath = path.resolve(projectPath);
    const projectWhereClause = `project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`;

    console.log(chalk.blue(`🔒 Project isolation: filtering by project_path = '${resolvedProjectPath}'`));

    const searchPromises = chunkEmbeddings.map((chunk) => {
      if (!chunk.vector) return Promise.resolve([]);
      return (
        mainTable
          .search(chunk.vector)
          .column('combined_embedding')
          .where(projectWhereClause) // Add project-specific filtering
          .limit(15) // Get 15 potential candidates for each chunk
          .toArray()
          // Attach the chunk that was used for the search to each result
          .then((results) => results.map((res) => ({ ...res, matchedChunk: chunk })))
      );
    });

    const allResults = await Promise.all(searchPromises);
    const flattenedResults = allResults.flat();

    // Deduplicate results, keeping the best match (lowest distance) for each comment
    for (const historicalComment of flattenedResults) {
      const commentId = historicalComment.id;
      const distance = historicalComment._distance;

      if (distance <= HYBRID_SEARCH_CONFIG.SIMILARITY_THRESHOLD) {
        if (!candidateMatches.has(commentId) || distance < candidateMatches.get(commentId)._distance) {
          candidateMatches.set(commentId, historicalComment);
        }
      }
    }

    console.log(chalk.blue(`🎯 Found ${candidateMatches.size} unique candidate comments for verification.`));

    // --- STEP 3: THE NEW PRE-FILTERING STEP ---
    const preFilteredCandidates = Array.from(candidateMatches.values()).filter(preFilterWithKeywords);
    console.log(chalk.yellow(`⚡ After keyword pre-filtering, ${preFilteredCandidates.length} candidates remain for LLM verification.`));

    // --- Step 4: LLM Verification ---
    const candidatesArray = preFilteredCandidates;
    const batchSize = HYBRID_SEARCH_CONFIG.LLM_BATCH_SIZE;
    const verifiedComments = [];
    console.log(chalk.cyan(`🤖 Starting LLM verification of ${candidatesArray.length} candidates...`));

    for (let i = 0; i < candidatesArray.length; i += batchSize) {
      const batch = candidatesArray.slice(i, i + batchSize);
      const verifiedBatch = await verifyLocally(batch); // SINGLE batch call
      verifiedComments.push(...verifiedBatch);
    }
    console.log(chalk.green(`✅ LLM verification complete: ${verifiedComments.length}/${candidatesArray.length} comments verified.`));

    // --- Step 4: Filtering and Formatting (same as before) ---
    let filteredComments = verifiedComments;
    if (isTestFile) {
      console.log(chalk.blue('🧪 Applying test file filtering - prioritizing test-related comments'));
      filteredComments = filteredComments.filter((comment) => {
        const filePath = comment.file_path || '';
        const commentText = comment.comment_text || '';
        return (
          filePath.includes('.test.') ||
          filePath.includes('.spec.') ||
          commentText.toLowerCase().includes('test') ||
          commentText.toLowerCase().includes('spec')
        );
      });
    } else {
      console.log(chalk.blue('📝 Applying non-test file filtering - excluding test-specific comments'));
      filteredComments = filteredComments.filter((comment) => {
        const filePath = comment.file_path || '';
        const commentText = comment.comment_text || '';
        // Only exclude if it's clearly a test file AND has test-specific content
        return !(filePath.includes('.test.') && (commentText.includes('describe(') || commentText.includes('it(')));
      });
    }

    const sortedResults = filteredComments.sort((a, b) => a._distance - b._distance).slice(0, limit);

    const formattedResults = sortedResults.map((res) => ({
      id: res.id,
      comment_text: res.comment_text,
      body: res.comment_text,
      original_code: res.original_code,
      suggested_code: res.suggested_code,
      file_path: res.file_path,
      line_number: res.line_number,
      pr_number: res.pr_number,
      author: res.author,
      created_at: res.created_at,
      issue_category: res.issue_category,
      severity: res.severity,
      pattern_tags: res.pattern_tags ? JSON.parse(res.pattern_tags) : [],
      similarity_score: 1 - res._distance,
      matchedChunk: res.matchedChunk,
      contentVerified: true,
    }));

    console.log(chalk.green.bold(`\n🎉 Final results: ${formattedResults.length} relevant comments found.`));
    return formattedResults;
  } catch (error) {
    console.error(chalk.red(`Error in reverse hybrid search: ${error.message}`));
    return [];
  }
}
