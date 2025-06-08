/**
 * PR History Database Integration
 *
 * This module provides PR comment storage and retrieval functionality
 * by reusing the database infrastructure from embeddings.js.
 * All database connection, table management, and indexing is handled by embeddings.js.
 */

import { calculateEmbedding, calculateQueryEmbedding, CONSTANTS, getPRCommentsTable } from '../../embeddings.js';
import { detectLanguageFromExtension, inferContextFromCodeContent } from '../../utils.js';
import chalk from 'chalk';
import path from 'node:path';

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
    const table = await getPRCommentsTable(projectPath);

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
  } catch (error) {
    console.error(chalk.red(`Error in batch storage: ${error.message}`));
  }

  return successCount;
}

/**
 * Find similar PR comments using vector similarity search
 * @param {string|Array<number>} query - Query text or embedding vector
 * @param {Object} options - Search options
 * @returns {Promise<Array<Object>>} Similar comments with scores
 */
export async function findSimilarPRComments(query, options = {}) {
  try {
    const {
      limit = 10,
      file_path = null,
      author = null,
      comment_type = null,
      issue_category = null,
      severity = null,
      threshold = 0.15,
      projectPath = process.cwd(),
      targetCodeContent = null,
      targetFilePath = null,
    } = options;

    const table = await getPRCommentsTable(projectPath);
    if (!table) {
      throw new Error(`Table ${PR_COMMENTS_TABLE} not found`);
    }

    console.log(chalk.blue(`🔍 Embedding-Based PR Comment Search`));

    // Stage 1: Chunk the target code file into searchable segments first
    const codeChunks = targetCodeContent ? chunkCodeContent(targetCodeContent) : [];
    console.log(chalk.blue(`📝 Created ${codeChunks.length} code chunks from target file`));

    // Generate query embedding - use chunk-based approach if available
    let queryEmbedding;
    if (typeof query === 'string') {
      // If we have code chunks, use the most representative chunks for the query
      let targetQuery = query;
      if (codeChunks.length > 0) {
        // Use the content from priority chunks to create a more focused query
        const representativeChunks = codeChunks.filter((chunk) => chunk.type === 'function_context').slice(0, 3);

        if (representativeChunks.length > 0) {
          const chunkContent = representativeChunks.map((chunk) => chunk.content).join('\n\n');
          targetQuery = chunkContent + '\n\n' + query.substring(0, 500);
          console.log(chalk.blue(`🎯 Using representative chunks for query (${representativeChunks.length} chunks)`));
        }
      }

      queryEmbedding = await calculateQueryEmbedding(targetQuery);
      if (!queryEmbedding) {
        throw new Error('Failed to generate query embedding');
      }
    } else if (Array.isArray(query)) {
      queryEmbedding = query;
    } else {
      throw new Error('Query must be string or embedding array');
    }

    // Stage 2: Multi-strategy search combining text and code chunk matching
    const candidateComments = await performCodeChunkBasedSearch(queryEmbedding, table, codeChunks, { ...options, projectPath, threshold });
    console.log(chalk.blue(`📊 Retrieved ${candidateComments.length} candidate comments`));

    if (candidateComments.length === 0) {
      return [];
    }

    // Stage 3: Apply similarity threshold filtering
    const thresholdFiltered = candidateComments.filter((comment) => comment.similarity_score >= threshold);

    // Stage 4: Contextual reranking with code chunk matching
    const rerankedComments = await applyCodeChunkReranking(thresholdFiltered, queryEmbedding, codeChunks, targetFilePath);
    console.log(chalk.blue(`🔄 Applied code chunk reranking to ${rerankedComments.length} comments`));

    // Stage 5: Final sorting and limiting
    const finalResults = rerankedComments.sort((a, b) => b.finalScore - a.finalScore).slice(0, limit);

    console.log(chalk.green(`🎯 Final results: ${finalResults.length} comments selected`));

    return finalResults;
  } catch (error) {
    console.error(chalk.red(`Error finding similar PR comments: ${error.message}`));
    return [];
  }
}

/**
 * Perform single-stage search (original implementation)
 * @param {string|Array<number>} query - Query text or embedding vector
 * @param {Object} table - Database table
 * @param {Object} options - Search options
 * @returns {Promise<Array<Object>>} Search results
 */
async function performSingleStageSearch(query, table, options) {
  const {
    limit = 10,
    repository = null,
    file_path = null,
    author = null,
    comment_type = null,
    issue_category = null,
    severity = null,
    threshold = 0.15,
    projectPath = process.cwd(),
  } = options;

  // Generate query embedding if query is text
  let queryEmbedding;
  if (typeof query === 'string') {
    queryEmbedding = await calculateQueryEmbedding(query);
    if (!queryEmbedding) {
      throw new Error('Failed to generate query embedding');
    }
  } else if (Array.isArray(query)) {
    queryEmbedding = query;
  } else {
    throw new Error('Query must be string or embedding array');
  }

  // Validate embedding dimensions
  if (queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Invalid query embedding dimensions: expected ${EMBEDDING_DIMENSIONS}, got ${queryEmbedding.length}`);
  }

  // Build search query - use combined_embedding for better semantic matching
  // Combined embedding includes both comment text and code context
  let searchQuery = table
    .search(queryEmbedding)
    .column('combined_embedding')
    .limit(limit * 2);

  // Apply filters
  const filters = [];

  if (projectPath) {
    const resolvedProjectPath = path.resolve(projectPath);
    filters.push(`project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`);
  }

  if (repository) filters.push(`repository = '${repository.replace(/'/g, "''")}'`);
  if (file_path) filters.push(`file_path LIKE '%${file_path.replace(/'/g, "''")}%'`);
  if (author) filters.push(`author = '${author.replace(/'/g, "''")}'`);
  if (comment_type) filters.push(`comment_type = '${comment_type.replace(/'/g, "''")}'`);
  if (issue_category) filters.push(`issue_category = '${issue_category.replace(/'/g, "''")}'`);
  if (severity) filters.push(`severity = '${severity.replace(/'/g, "''")}'`);

  if (filters.length > 0) {
    searchQuery = searchQuery.where(filters.join(' AND '));
  }

  // Execute search
  console.log(chalk.gray(`  Executing search with combined_embedding, threshold: ${threshold}`));
  const results = await searchQuery.toArray();

  // Debug: Check what data we actually have
  if (results.length > 0) {
    const sampleRecord = results[0];
    console.log(chalk.gray(`  Sample record fields: ${Object.keys(sampleRecord).join(', ')}`));
    console.log(chalk.gray(`  Has combined_embedding: ${!!sampleRecord.combined_embedding}`));
    console.log(chalk.gray(`  Has comment_embedding: ${!!sampleRecord.comment_embedding}`));
    console.log(chalk.gray(`  Has code_embedding: ${!!sampleRecord.code_embedding}`));
  }

  // Process and filter results
  const processedResults = results
    .filter((result) => result._distance >= threshold)
    .slice(0, limit)
    .map((result) => ({
      id: result.id,
      pr_number: result.pr_number,
      repository: result.repository,
      comment_type: result.comment_type,
      comment_text: result.comment_text,
      body: result.comment_text, // Add body field for CAG analyzer compatibility
      file_path: result.file_path,
      line_number: result.line_number,
      original_code: result.original_code,
      author: result.author,
      created_at: result.created_at,
      issue_category: result.issue_category,
      severity: result.severity,
      pattern_tags: result.pattern_tags ? JSON.parse(result.pattern_tags) : [],
      similarity_score: result._distance,
    }));

  return processedResults;
}

/**
 * Perform hierarchical search using embeddings only
 * @param {Array<number>} queryEmbedding - Query embedding
 * @param {Object} table - Database table
 * @param {Object} options - Search options
 * @returns {Promise<Array<Object>>} Candidate comments
 */
async function performEmbeddingHierarchicalSearch(queryEmbedding, table, options) {
  const { threshold = 0.15, limit = 10, projectPath } = options;

  // Stage 1: Broad semantic search
  const broadThreshold = Math.max(threshold - 0.1, 0.05);
  let searchQuery = table
    .search(queryEmbedding)
    .column('combined_embedding')
    .limit(limit * 5);

  // Apply filters
  const filters = [];
  const resolvedProjectPath = path.resolve(projectPath);
  filters.push(`project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`);

  if (options.file_path) filters.push(`file_path LIKE '%${options.file_path.replace(/'/g, "''")}%'`);
  if (options.author) filters.push(`author = '${options.author.replace(/'/g, "''")}'`);
  if (options.comment_type) filters.push(`comment_type = '${options.comment_type.replace(/'/g, "''")}'`);
  if (options.issue_category) filters.push(`issue_category = '${options.issue_category.replace(/'/g, "''")}'`);
  if (options.severity) filters.push(`severity = '${options.severity.replace(/'/g, "''")}'`);

  if (filters.length > 0) {
    searchQuery = searchQuery.where(filters.join(' AND '));
  }

  const results = await searchQuery.toArray();

  // Filter by threshold and map to include necessary fields
  return results
    .filter((result) => result._distance >= broadThreshold)
    .map((result) => ({
      id: result.id,
      pr_number: result.pr_number,
      comment_type: result.comment_type,
      comment_text: result.comment_text,
      body: result.comment_text,
      file_path: result.file_path,
      line_number: result.line_number,
      original_code: result.original_code,
      suggested_code: result.suggested_code,
      author: result.author,
      created_at: result.created_at,
      issue_category: result.issue_category,
      severity: result.severity,
      pattern_tags: result.pattern_tags ? JSON.parse(result.pattern_tags) : [],
      similarity_score: result._distance,
      comment_embedding: result.comment_embedding,
      code_embedding: result.code_embedding,
      combined_embedding: result.combined_embedding,
    }));
}

/**
 * Apply context-aware scoring using embeddings
 * @param {Array<Object>} comments - Comments to score
 * @param {Array<number>} queryEmbedding - Query embedding
 * @param {string} targetCodeContent - Target code content
 * @returns {Promise<Array<Object>>} Scored comments
 */
async function applyEmbeddingContextScoring(comments, queryEmbedding, targetCodeContent) {
  const scoredComments = [];

  // Generate context embedding if code content provided
  let contextEmbedding = null;
  if (targetCodeContent && typeof targetCodeContent === 'string') {
    contextEmbedding = await calculateQueryEmbedding(targetCodeContent);
  }

  for (const comment of comments) {
    try {
      // Base semantic score from initial search
      const semanticScore = comment.similarity_score || 0;

      // Context score based on code similarity
      let contextScore = 0;
      if (contextEmbedding && comment.code_embedding) {
        contextScore = calculateCosineSimilarity(contextEmbedding, comment.code_embedding);
      } else if (contextEmbedding && comment.combined_embedding) {
        contextScore = calculateCosineSimilarity(contextEmbedding, comment.combined_embedding) * 0.7;
      }

      // Recency score
      const createdAt = new Date(comment.created_at);
      const ageHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
      const recencyScore = Math.exp(-ageHours / (24 * 30)); // 30-day half-life

      // Combined multi-dimensional score
      const finalScore = semanticScore * 0.5 + contextScore * 0.3 + recencyScore * 0.2;

      scoredComments.push({
        ...comment,
        semanticScore,
        contextScore,
        recencyScore,
        finalScore,
      });
    } catch (error) {
      console.warn(chalk.yellow(`Scoring failed for comment ${comment.id}: ${error.message}`));
      scoredComments.push({
        ...comment,
        finalScore: comment.similarity_score || 0,
      });
    }
  }

  return scoredComments.sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Apply quality assessment using embeddings
 * @param {Array<Object>} comments - Comments to assess
 * @returns {Promise<Array<Object>>} Quality-filtered comments
 */
async function applyEmbeddingQualityAssessment(comments) {
  const qualityComments = [];

  // Generate embeddings for quality indicators
  const technicalEmbedding = await calculateQueryEmbedding('code implementation function class method algorithm performance security');
  const genericEmbedding = await calculateQueryEmbedding('good nice looks okay thanks lgtm');

  for (const comment of comments) {
    const commentText = comment.comment_text || comment.body || '';

    // Skip very short comments
    if (commentText.length < 20) continue;

    try {
      // Generate comment embedding if not available
      const commentEmbedding = comment.comment_embedding || (await calculateQueryEmbedding(commentText));

      if (commentEmbedding) {
        // Calculate technical vs generic scores
        const technicalScore = calculateCosineSimilarity(commentEmbedding, technicalEmbedding);
        const genericScore = calculateCosineSimilarity(commentEmbedding, genericEmbedding);

        // Filter out overly generic comments
        if (genericScore > technicalScore * 1.5) {
          console.log(chalk.yellow(`  Filtered generic comment: "${commentText.substring(0, 50)}..."`));
          continue;
        }

        // Boost technical comments
        if (technicalScore > 0.4) {
          comment.finalScore *= 1.2;
          comment.qualityScore = technicalScore;
        }
      }

      qualityComments.push(comment);
    } catch (error) {
      console.warn(chalk.yellow(`Quality assessment failed for comment ${comment.id}: ${error.message}`));
      qualityComments.push(comment);
    }
  }

  return qualityComments;
}

/**
 * Enhance comments with pattern detection via embeddings
 * @param {Array<Object>} comments - Comments to enhance
 * @param {string} targetCodeContent - Target code content
 * @returns {Promise<Array<Object>>} Pattern-enhanced comments
 */
async function enhanceWithEmbeddingPatterns(comments, targetCodeContent) {
  if (!targetCodeContent) {
    return comments;
  }

  const enhancedComments = [];

  try {
    // Generate embedding for target code patterns
    const targetEmbedding = await calculateQueryEmbedding(targetCodeContent);

    for (const comment of comments) {
      // Check if comment has code suggestions
      if (comment.suggested_code || comment.original_code) {
        const codeContent = comment.suggested_code || comment.original_code;
        const codeEmbedding = await calculateQueryEmbedding(codeContent);

        if (codeEmbedding && targetEmbedding) {
          const patternSimilarity = calculateCosineSimilarity(codeEmbedding, targetEmbedding);

          if (patternSimilarity > 0.3) {
            comment.finalScore *= 1 + patternSimilarity * 0.5;
            comment.patternSimilarity = patternSimilarity;
          }
        }
      }

      enhancedComments.push(comment);
    }
  } catch (error) {
    console.warn(chalk.yellow(`Pattern enhancement failed: ${error.message}`));
    return comments;
  }

  return enhancedComments.sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Perform diversity selection using embedding clusters
 * @param {Array<Object>} comments - Comments to select from
 * @param {number} limit - Maximum number of comments
 * @returns {Promise<Array<Object>>} Diverse selection of comments
 */
async function performEmbeddingDiversitySelection(comments, limit) {
  if (comments.length <= limit) {
    return comments;
  }

  const selected = [];
  const selectedEmbeddings = [];

  for (const comment of comments) {
    if (selected.length >= limit) break;

    // Get comment embedding
    const embedding = comment.comment_embedding || comment.combined_embedding;
    if (!embedding) {
      selected.push(comment);
      continue;
    }

    // Check similarity with already selected comments
    let tooSimilar = false;
    for (const selectedEmb of selectedEmbeddings) {
      const similarity = calculateCosineSimilarity(embedding, selectedEmb);
      if (similarity > 0.85) {
        // High similarity threshold
        tooSimilar = true;
        break;
      }
    }

    if (!tooSimilar) {
      selected.push(comment);
      selectedEmbeddings.push(embedding);
    }
  }

  // Fill remaining slots if needed
  if (selected.length < limit) {
    const remaining = comments.filter((c) => !selected.includes(c));
    selected.push(...remaining.slice(0, limit - selected.length));
  }

  return selected;
}

/**
 * Check if comment has directive language patterns using embeddings
 * @param {string} commentText - Comment text to analyze
 * @returns {Promise<boolean>} True if comment has directive patterns
 */
async function hasDirectivePatterns(commentText) {
  if (!commentText || commentText.length < 10) {
    return false;
  }

  try {
    // Use embeddings to detect directive language patterns
    const directiveKeywords = 'always should must never ensure require avoid';
    const directiveEmbedding = await calculateQueryEmbedding(directiveKeywords);
    const commentEmbedding = await calculateQueryEmbedding(commentText);

    if (!directiveEmbedding || !commentEmbedding) {
      return false;
    }

    const similarity = calculateCosineSimilarity(commentEmbedding, directiveEmbedding);
    return similarity > 0.25; // Threshold for directive language detection
  } catch (error) {
    return false;
  }
}

// Cache for embeddings to improve performance
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 1000;

/**
 * Get or calculate embedding with caching
 * @param {string} text - Text to get embedding for
 * @returns {Promise<Array<number>>} Embedding vector
 */
async function getCachedEmbedding(text) {
  if (!text) return null;

  const cacheKey = text.substring(0, 200); // Use first 200 chars as key
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  const embedding = await calculateQueryEmbedding(text);

  // Maintain cache size
  if (embeddingCache.size >= MAX_CACHE_SIZE) {
    const firstKey = embeddingCache.keys().next().value;
    embeddingCache.delete(firstKey);
  }

  embeddingCache.set(cacheKey, embedding);
  return embedding;
}

/**
 * Check if comment mentions function patterns related to the query
 * @param {string} commentText - Comment text to analyze
 * @param {string|Array<number>} query - Original query for context
 * @returns {Promise<boolean>} True if comment mentions function patterns
 */
async function hasFunctionPatterns(commentText, query) {
  if (!commentText || commentText.length < 10 || typeof query !== 'string') {
    return false;
  }

  try {
    // Extract potential function/method names from the query using embeddings
    const functionKeywords = 'function method class component implementation';
    const functionEmbedding = await getCachedEmbedding(functionKeywords);
    const commentEmbedding = await getCachedEmbedding(commentText);

    if (!functionEmbedding || !commentEmbedding) {
      return false;
    }

    const similarity = calculateCosineSimilarity(commentEmbedding, functionEmbedding);
    return similarity > 0.2; // Threshold for function pattern detection
  } catch (error) {
    return false;
  }
}

/**
 * Helper function to calculate cosine similarity between two vectors
 * @param {Array<number>} vecA - First vector
 * @param {Array<number>} vecB - Second vector
 * @returns {number} Cosine similarity score
 */
function calculateCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Classify comment relevance using embeddings-based analysis
 * @param {Object} comment - Comment object to classify
 * @param {string} query - Original query for context
 * @returns {Promise<Object>} Classification result
 */
async function classifyCommentRelevance(comment, query) {
  const commentText = comment.comment_text || comment.body || '';

  if (!commentText || commentText.length < 10) {
    return { isDirective: false, isPatternSpecific: false, isGeneral: false };
  }

  try {
    // Define classification categories using embeddings
    const directiveKeywords = 'should must always never require avoid add remove use prefix suffix';
    const patternKeywords = 'function method class component implementation pattern practice';
    const generalKeywords = 'consider might could suggestion recommendation advice';

    // Calculate embeddings for classification
    const commentEmbedding = await calculateQueryEmbedding(commentText);
    const directiveEmbedding = await calculateQueryEmbedding(directiveKeywords);
    const patternEmbedding = await calculateQueryEmbedding(patternKeywords);
    const generalEmbedding = await calculateQueryEmbedding(generalKeywords);

    if (!commentEmbedding || !directiveEmbedding || !patternEmbedding || !generalEmbedding) {
      return { isDirective: false, isPatternSpecific: false, isGeneral: false };
    }

    // Calculate similarity scores for each category
    const directiveScore = calculateCosineSimilarity(commentEmbedding, directiveEmbedding);
    const patternScore = calculateCosineSimilarity(commentEmbedding, patternEmbedding);
    const generalScore = calculateCosineSimilarity(commentEmbedding, generalEmbedding);

    // Classify based on highest score above threshold
    const threshold = 0.3;
    const maxScore = Math.max(directiveScore, patternScore, generalScore);

    if (maxScore < threshold) {
      return { isDirective: false, isPatternSpecific: false, isGeneral: false };
    }

    return {
      isDirective: directiveScore === maxScore && directiveScore > threshold,
      isPatternSpecific: patternScore === maxScore && patternScore > threshold,
      isGeneral: generalScore === maxScore && generalScore > threshold,
      scores: { directive: directiveScore, pattern: patternScore, general: generalScore },
    };
  } catch (error) {
    return { isDirective: false, isPatternSpecific: false, isGeneral: false };
  }
}

/**
 * Get PR comments by repository
 * @param {string} repository - Repository in format "owner/repo"
 * @param {Object} options - Query options
 * @returns {Promise<Array<Object>>} PR comments
 */
export async function getPRCommentsByRepository(repository, options = {}) {
  try {
    const { limit = 100, offset = 0, author = null, comment_type = null, projectPath = process.cwd() } = options;

    const table = await getPRCommentsTable(projectPath);

    if (!table) {
      throw new Error(`Table ${PR_COMMENTS_TABLE} not found`);
    }

    const resolvedProjectPath = path.resolve(projectPath);

    const filters = [`repository = '${repository.replace(/'/g, "''")}'`, `project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`];
    if (author) filters.push(`author = '${author.replace(/'/g, "''")}'`);
    if (comment_type) filters.push(`comment_type = '${comment_type.replace(/'/g, "''")}'`);

    const query = table.search().where(filters.join(' AND ')).limit(limit).offset(offset);
    const results = await query.toArray();

    return results.map((result) => ({
      id: result.id,
      pr_number: result.pr_number,
      repository: result.repository,
      comment_type: result.comment_type,
      comment_text: result.comment_text,
      file_path: result.file_path,
      line_number: result.line_number,
      original_code: result.original_code,
      author: result.author,
      created_at: result.created_at,
      issue_category: result.issue_category,
      severity: result.severity,
      pattern_tags: result.pattern_tags ? JSON.parse(result.pattern_tags) : [],
    }));
  } catch (error) {
    console.error(chalk.red(`Error getting PR comments by repository: ${error.message}`));
    return [];
  }
}

/**
 * Get statistics about stored PR comments
 * @param {string} repository - Repository to get stats for (optional)
 * @param {string} projectPath - Project path for filtering (optional, defaults to cwd)
 * @returns {Promise<Object>} Statistics object
 */
export async function getPRCommentsStats(repository = null, projectPath = process.cwd()) {
  try {
    const table = await getPRCommentsTable(projectPath);

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
    const table = await getPRCommentsTable(projectPath);

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
    const table = await getPRCommentsTable(projectPath);

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
    const table = await getPRCommentsTable(projectPath);

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
 * Get PR comments for a specific file with relevance scoring
 * @param {string} repository - Repository in format "owner/repo"
 * @param {string} projectPath - Project path for filtering
 * @param {Object} searchCriteria - Search criteria object
 * @returns {Promise<Array<Object>>} Relevant PR comments
 */
export async function getPRCommentsForFile(repository, projectPath, searchCriteria) {
  try {
    const { filePath, fileName, directoryPath, fileExtension, dateRange = null, maxResults = 50 } = searchCriteria;

    const table = await getPRCommentsTable(projectPath);

    if (!table) {
      return [];
    }

    const resolvedProjectPath = path.resolve(projectPath);

    const filters = [`repository = '${repository.replace(/'/g, "''")}'`, `project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`];

    // Add file-related filters
    const fileFilters = [];

    if (filePath) {
      fileFilters.push(`file_path = '${filePath.replace(/'/g, "''")}'`);
    }

    if (fileName) {
      fileFilters.push(`file_path LIKE '%${fileName.replace(/'/g, "''")}'`);
    }

    if (directoryPath) {
      fileFilters.push(`file_path LIKE '${directoryPath.replace(/'/g, "''")}%'`);
    }

    if (fileExtension) {
      fileFilters.push(`file_path LIKE '%${fileExtension.replace(/'/g, "''")}'`);
    }

    if (fileFilters.length > 0) {
      filters.push(`(${fileFilters.join(' OR ')})`);
    }

    if (dateRange) {
      if (dateRange.since) {
        filters.push(`created_at >= '${dateRange.since}'`);
      }
      if (dateRange.until) {
        filters.push(`created_at <= '${dateRange.until}'`);
      }
    }

    const whereClause = filters.join(' AND ');
    const results = await table.search().where(whereClause).limit(maxResults).toArray();

    return results.map((result) => ({
      id: result.id,
      pr_number: result.pr_number,
      pr_title: result.pr_title || `PR #${result.pr_number}`,
      repository: result.repository,
      comment_type: result.comment_type,
      body: result.comment_text,
      file_path: result.file_path,
      line_number: result.line_number,
      author_login: result.author,
      created_at: result.created_at,
      issue_category: result.issue_category,
      severity: result.severity,
      pattern_tags: result.pattern_tags ? JSON.parse(result.pattern_tags) : [],
    }));
  } catch (error) {
    console.error(chalk.red(`Error getting PR comments for file: ${error.message}`));
    return [];
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
    const table = await getPRCommentsTable(projectPath);

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
// UTILITY FUNCTIONS FOR OPTIMIZED PR COMMENT RETRIEVAL
// ============================================================================

/**
 * Infer context from a PR comment using embeddings
 * @param {Object} comment - Comment object
 * @returns {Promise<Object>} Inferred context
 */
async function inferCommentContext(comment) {
  const commentText = comment.comment_text || comment.body || '';
  const filePath = comment.file_path || '';

  // Try to infer language from file path
  const language = filePath ? detectLanguageFromExtension(filePath) : 'unknown';

  // Use the existing context inference function with combined text
  const combinedText = [commentText, comment.original_code || '', comment.suggested_code || ''].join(' ');
  const context = inferContextFromCodeContent(combinedText, language);

  return context;
}

/**
 * Calculate semantic similarity between two area descriptions using embeddings
 * @param {string} area1 - First area
 * @param {string} area2 - Second area
 * @returns {Promise<number>} Similarity score (0-1)
 */
async function calculateAreaSimilarity(area1, area2) {
  if (!area1 || !area2) return 0;
  if (area1 === area2) return 1;

  const area1Embedding = await getCachedEmbedding(area1);
  const area2Embedding = await getCachedEmbedding(area2);

  if (!area1Embedding || !area2Embedding) return 0;

  return calculateCosineSimilarity(area1Embedding, area2Embedding);
}

/**
 * Calculate technology overlap using embeddings
 * @param {Array<string>} tech1 - First tech array
 * @param {Array<string>} tech2 - Second tech array
 * @returns {Promise<number>} Overlap score (0-1)
 */
async function calculateTechnologyOverlap(tech1, tech2) {
  if (!tech1 || !tech2 || tech1.length === 0 || tech2.length === 0) {
    return 0;
  }

  // Create combined tech strings
  const tech1String = tech1.join(' ');
  const tech2String = tech2.join(' ');

  const tech1Embedding = await getCachedEmbedding(tech1String);
  const tech2Embedding = await getCachedEmbedding(tech2String);

  if (!tech1Embedding || !tech2Embedding) return 0;

  return calculateCosineSimilarity(tech1Embedding, tech2Embedding);
}

/**
 * Check if comment is generic using embeddings
 * @param {string} commentText - Comment text
 * @returns {Promise<number>} Genericness score (0-1, higher means more generic)
 */
async function calculateGenericScore(commentText) {
  if (!commentText || commentText.length < 5) return 1;

  const genericExamples = 'lgtm looks good nice job thanks approved acknowledgment simple agreement';
  const technicalExamples = 'implementation algorithm function method performance security architecture design pattern optimization';

  const commentEmbedding = await getCachedEmbedding(commentText);
  const genericEmbedding = await getCachedEmbedding(genericExamples);
  const technicalEmbedding = await getCachedEmbedding(technicalExamples);

  if (!commentEmbedding || !genericEmbedding || !technicalEmbedding) {
    return commentText.length < 20 ? 0.8 : 0.5;
  }

  const genericSimilarity = calculateCosineSimilarity(commentEmbedding, genericEmbedding);
  const technicalSimilarity = calculateCosineSimilarity(commentEmbedding, technicalEmbedding);

  // Higher generic similarity and lower technical similarity means more generic
  return Math.max(0, genericSimilarity - technicalSimilarity + 0.5);
}

/**
 * Calculate bot likelihood using embeddings
 * @param {Object} comment - Comment object
 * @returns {Promise<number>} Bot likelihood score (0-1)
 */
async function calculateBotLikelihood(comment) {
  const author = comment.author || '';
  const commentText = comment.comment_text || comment.body || '';

  const botIndicators = 'automated bot ci continuous integration github actions jenkins travis circle ci automation system generated';
  const humanIndicators = 'I think we should consider my opinion in my experience personally I believe';

  const authorEmbedding = await getCachedEmbedding(author);
  const textEmbedding = await getCachedEmbedding(commentText);
  const botEmbedding = await getCachedEmbedding(botIndicators);
  const humanEmbedding = await getCachedEmbedding(humanIndicators);

  if (!authorEmbedding || !botEmbedding) return 0;

  const authorBotSimilarity = calculateCosineSimilarity(authorEmbedding, botEmbedding);

  let textScore = 0;
  if (textEmbedding && humanEmbedding) {
    const textBotSimilarity = calculateCosineSimilarity(textEmbedding, botEmbedding);
    const textHumanSimilarity = calculateCosineSimilarity(textEmbedding, humanEmbedding);
    textScore = Math.max(0, textBotSimilarity - textHumanSimilarity);
  }

  return Math.max(authorBotSimilarity, textScore);
}

/**
 * Calculate test-relatedness using embeddings
 * @param {Object} comment - Comment object
 * @returns {Promise<number>} Test-relatedness score (0-1)
 */
async function calculateTestRelatedness(comment) {
  const filePath = comment.file_path || '';
  const commentText = comment.comment_text || comment.body || '';

  const testIndicators =
    'test testing unit test integration test e2e test jest mocha cypress vitest test suite test case assertion expect describe it should mock stub spy fixture';

  const combinedText = `${filePath} ${commentText}`;
  const textEmbedding = await getCachedEmbedding(combinedText);
  const testEmbedding = await getCachedEmbedding(testIndicators);

  if (!textEmbedding || !testEmbedding) return 0;

  return calculateCosineSimilarity(textEmbedding, testEmbedding);
}

/**
 * Calculate technical content score using embeddings
 * @param {string} commentText - Comment text
 * @returns {Promise<number>} Technical content score (0-1)
 */
async function calculateTechnicalContentScore(commentText) {
  if (!commentText || commentText.length < 20) {
    return 0;
  }

  try {
    // Use embeddings to detect technical content
    const technicalKeywords =
      'implementation performance algorithm optimization security architecture refactor function method class interface type design pattern code review technical debt';
    const technicalEmbedding = await getCachedEmbedding(technicalKeywords);
    const commentEmbedding = await getCachedEmbedding(commentText);

    if (!technicalEmbedding || !commentEmbedding) {
      return 0;
    }

    return calculateCosineSimilarity(commentEmbedding, technicalEmbedding);
  } catch (error) {
    return 0;
  }
}

/**
 * Calculate code suggestion score using embeddings
 * @param {string} commentText - Comment text
 * @returns {Promise<number>} Code suggestion score (0-1)
 */
async function calculateCodeSuggestionScore(commentText) {
  if (!commentText) return 0;

  // Check for code-like content using embeddings
  const codeSuggestionIndicators =
    'code example implementation suggestion refactor change modify update fix improve here is how you could instead try consider using';

  const commentEmbedding = await getCachedEmbedding(commentText);
  const codeEmbedding = await getCachedEmbedding(codeSuggestionIndicators);

  if (!commentEmbedding || !codeEmbedding) return 0;

  // Also give bonus if comment contains backticks (markdown code)
  const hasCodeMarkers = commentText.includes('```') || commentText.includes('`');
  const embeddingScore = calculateCosineSimilarity(commentEmbedding, codeEmbedding);

  return Math.min(1, embeddingScore + (hasCodeMarkers ? 0.2 : 0));
}

/**
 * Check if comment has technical content using embeddings
 * @param {string} commentText - Comment text
 * @returns {Promise<boolean>} True if has technical content
 */
async function hasTechnicalContent(commentText) {
  const score = await calculateTechnicalContentScore(commentText);
  return score > 0.35;
}

/**
 * Check if comment has code suggestions
 * @param {string} commentText - Comment text
 * @returns {Promise<boolean>} True if has code suggestions
 */
async function hasCodeSuggestions(commentText) {
  const score = await calculateCodeSuggestionScore(commentText);
  return score > 0.4;
}

/**
 * Extract semantic patterns using embeddings
 * @param {string} text - Text to analyze
 * @returns {Promise<Object>} Semantic pattern analysis
 */
async function extractSemanticPatterns(text) {
  if (!text) return { categories: [], score: 0 };

  const categories = [];
  const scores = {};

  // Define pattern categories with representative text
  const patternCategories = {
    architecture: 'architecture design pattern structure organization module component system',
    performance: 'performance optimization speed efficiency algorithm complexity cache',
    security: 'security vulnerability authentication authorization validation sanitization',
    testing: 'test testing unit integration e2e coverage assertion mock stub',
    refactoring: 'refactor clean code readability maintainability technical debt',
    bugfix: 'bug fix error issue problem resolve patch correction',
    feature: 'feature functionality implementation capability addition new',
  };

  const textEmbedding = await getCachedEmbedding(text);
  if (!textEmbedding) return { categories: [], score: 0 };

  // Calculate similarity with each category
  for (const [category, keywords] of Object.entries(patternCategories)) {
    const categoryEmbedding = await getCachedEmbedding(keywords);
    if (categoryEmbedding) {
      const similarity = calculateCosineSimilarity(textEmbedding, categoryEmbedding);
      scores[category] = similarity;
      if (similarity > 0.3) {
        categories.push(category);
      }
    }
  }

  // Get dominant category
  const dominantCategory = Object.entries(scores).reduce((a, b) => (a[1] > b[1] ? a : b))[0];

  return {
    categories,
    dominantCategory,
    scores,
    overallScore: Math.max(...Object.values(scores)),
  };
}

/**
 * Calculate semantic similarity between two texts using embeddings
 * @param {string} text1 - First text
 * @param {string} text2 - Second text
 * @returns {Promise<number>} Similarity score (0-1)
 */
async function calculateSemanticSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;

  const embedding1 = await getCachedEmbedding(text1);
  const embedding2 = await getCachedEmbedding(text2);

  if (!embedding1 || !embedding2) return 0;

  return calculateCosineSimilarity(embedding1, embedding2);
}

/**
 * Get comment semantic category using embeddings
 * @param {string} commentText - Comment text
 * @returns {Promise<string>} Semantic category
 */
async function getCommentSemanticCategory(commentText) {
  if (!commentText) return 'empty';

  const patterns = await extractSemanticPatterns(commentText);

  if (patterns.dominantCategory) {
    return patterns.dominantCategory;
  }

  // Fallback to length-based categorization
  if (commentText.length < 50) return 'brief';
  if (commentText.length < 200) return 'moderate';
  return 'detailed';
}

/**
 * Chunk code content into searchable segments
 * @param {string} codeContent - Code content to chunk
 * @returns {Array<Object>} Array of code chunks with metadata
 */
function chunkCodeContent(codeContent) {
  if (!codeContent) {
    console.log(chalk.yellow('⚠️ No code content provided to chunking function'));
    return [];
  }

  const chunks = [];
  const lines = codeContent.split('\n');

  console.log(chalk.blue(`🔍 Processing ${lines.length} lines for chunking (content length: ${codeContent.length} chars)`));

  // Strategy 1: Simple fixed-size chunks (guaranteed to work)
  const chunkSize = 10;
  let fixedChunksCreated = 0;
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunkLines = lines.slice(i, i + chunkSize);
    const chunkContent = chunkLines.join('\n').trim();

    if (chunkContent.length > 20) {
      chunks.push({
        content: chunkContent,
        startLine: i + 1,
        endLine: Math.min(i + chunkSize, lines.length),
        type: 'fixed_chunk',
      });
      fixedChunksCreated++;
    }
  }
  console.log(chalk.blue(`📦 Strategy 1: Created ${fixedChunksCreated} fixed chunks`));

  // Strategy 2: Overlapping windows for better coverage
  const windowSize = 8;
  const overlap = 4;
  let windowChunksCreated = 0;
  for (let i = 0; i < lines.length - windowSize + 1; i += overlap) {
    const windowLines = lines.slice(i, i + windowSize);
    const windowContent = windowLines.join('\n').trim();

    if (windowContent.length > 30) {
      chunks.push({
        content: windowContent,
        startLine: i + 1,
        endLine: i + windowSize,
        type: 'window',
      });
      windowChunksCreated++;
    }
  }
  console.log(chalk.blue(`🪟 Strategy 2: Created ${windowChunksCreated} window chunks`));

  // Strategy 3: Context around function calls (project-agnostic)
  let functionChunksCreated = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for any function call pattern (parentheses)
    if (line.includes('(') && line.includes(')') && line.trim().length > 10) {
      const contextStart = Math.max(0, i - 3);
      const contextEnd = Math.min(lines.length - 1, i + 3);
      const contextLines = lines.slice(contextStart, contextEnd + 1);

      chunks.push({
        content: contextLines.join('\n').trim(),
        startLine: contextStart + 1,
        endLine: contextEnd + 1,
        type: 'function_context',
        focusLine: i + 1,
      });
      functionChunksCreated++;
    }
  }
  console.log(chalk.blue(`🔧 Strategy 3: Created ${functionChunksCreated} function context chunks`));

  console.log(chalk.blue(`🔧 Before filtering: ${chunks.length} chunks created`));

  // Remove duplicates and filter by minimum content length
  const uniqueChunks = chunks.filter((chunk, index, self) => {
    const lengthOk = chunk.content.length > 25;
    const isUnique = self.findIndex((c) => c.content === chunk.content) === index;
    if (!lengthOk) {
      console.log(chalk.yellow(`⚠️ Chunk filtered out (too short): ${chunk.content.length} chars`));
    }
    return lengthOk && isUnique;
  });

  console.log(chalk.blue(`📝 Created ${uniqueChunks.length} code chunks from target file (after filtering from ${chunks.length})`));

  if (uniqueChunks.length > 0) {
    console.log(chalk.green(`✅ Sample chunk: ${uniqueChunks[0].content.substring(0, 100)}...`));
  }

  return uniqueChunks;
}

/**
 * Perform code chunk-based search for PR comments
 * @param {Array<number>} queryEmbedding - Query embedding
 * @param {Object} table - Database table
 * @param {Array<Object>} codeChunks - Code chunks to search for
 * @param {Object} options - Search options
 * @returns {Promise<Array<Object>>} Candidate comments
 */
async function performCodeChunkBasedSearch(queryEmbedding, table, codeChunks, options) {
  const { projectPath, threshold, limit = 10 } = options;
  const resolvedProjectPath = path.resolve(projectPath);

  const filters = [`project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`];
  if (options.file_path) filters.push(`file_path LIKE '%${options.file_path.replace(/'/g, "''")}%'`);
  if (options.author) filters.push(`author = '${options.author.replace(/'/g, "''")}'`);
  if (options.comment_type) filters.push(`comment_type = '${options.comment_type.replace(/'/g, "''")}'`);

  const allResults = [];

  // Strategy 1: Search using comment embeddings (most reliable)
  try {
    let commentQuery = table
      .search(queryEmbedding)
      .column('comment_embedding')
      .limit(limit * 2);

    if (filters.length > 0) {
      commentQuery = commentQuery.where(filters.join(' AND '));
    }

    const commentResults = await commentQuery.toArray();
    allResults.push(...commentResults.map((r) => ({ ...r, searchType: 'comment' })));
  } catch (error) {
    console.warn(chalk.yellow(`Comment embedding search failed: ${error.message}`));
  }

  // Strategy 2: Search using combined embeddings
  try {
    let combinedQuery = table
      .search(queryEmbedding)
      .column('combined_embedding')
      .limit(limit * 2);

    if (filters.length > 0) {
      combinedQuery = combinedQuery.where(filters.join(' AND '));
    }

    const combinedResults = await combinedQuery.toArray();
    allResults.push(...combinedResults.map((r) => ({ ...r, searchType: 'combined' })));
  } catch (error) {
    console.warn(chalk.yellow(`Combined embedding search failed: ${error.message}`));
  }

  // Strategy 3: Enhanced code chunk matching with direct code similarity
  if (codeChunks.length > 0) {
    console.log(chalk.blue(`🔍 Searching with ${codeChunks.length} code chunks`));

    // Prioritize function context chunks and chunks with function calls
    const priorityChunks = codeChunks.filter((chunk) => chunk.type === 'function_context').slice(0, 6); // Reduced for performance

    const regularChunks = codeChunks.filter((chunk) => !priorityChunks.includes(chunk)).slice(0, 3); // Reduced for performance

    const searchChunks = [...priorityChunks, ...regularChunks];
    console.log(chalk.blue(`🎯 Using ${searchChunks.length} chunks (${priorityChunks.length} priority, ${regularChunks.length} regular)`));

    // Instead of using the full file query, search with each chunk as the query
    for (const chunk of searchChunks) {
      try {
        const chunkEmbedding = await getCachedEmbedding(chunk.content);
        if (chunkEmbedding) {
          const isPriority = priorityChunks.includes(chunk);
          const searchLimit = isPriority ? limit * 2 : limit;

          // Search for comments that have similar code patterns
          try {
            let chunkCommentQuery = table.search(chunkEmbedding).column('comment_embedding').limit(searchLimit);

            if (filters.length > 0) {
              chunkCommentQuery = chunkCommentQuery.where(filters.join(' AND '));
            }

            const chunkCommentResults = await chunkCommentQuery.toArray();
            allResults.push(
              ...chunkCommentResults.map((result) => ({
                ...result,
                searchType: 'chunk_comment',
                matchedChunk: chunk,
                chunkPriority: isPriority ? 1.0 : 0.5,
                chunkType: chunk.type,
              }))
            );
          } catch (commentError) {
            console.warn(chalk.yellow(`Chunk comment search failed: ${commentError.message}`));
          }

          // Search against code embeddings for direct code pattern matching
          try {
            let chunkCodeQuery = table.search(chunkEmbedding).column('code_embedding').limit(searchLimit);

            if (filters.length > 0) {
              chunkCodeQuery = chunkCodeQuery.where(filters.join(' AND '));
            }

            const chunkCodeResults = await chunkCodeQuery.toArray();
            allResults.push(
              ...chunkCodeResults.map((result) => ({
                ...result,
                searchType: 'chunk_code',
                matchedChunk: chunk,
                chunkPriority: isPriority ? 1.0 : 0.5,
                chunkType: chunk.type,
              }))
            );
          } catch (codeError) {
            // Code embedding search might fail if column doesn't exist or is sparse
          }
        }
      } catch (error) {
        console.warn(chalk.yellow(`Failed to search for chunk: ${error.message}`));
      }
    }
  }

  // Deduplicate results
  const uniqueResults = [];
  const seenIds = new Set();

  for (const result of allResults) {
    if (!seenIds.has(result.id)) {
      seenIds.add(result.id);
      uniqueResults.push({
        id: result.id,
        pr_number: result.pr_number,
        comment_type: result.comment_type,
        comment_text: result.comment_text,
        body: result.comment_text,
        file_path: result.file_path,
        line_number: result.line_number,
        original_code: result.original_code,
        suggested_code: result.suggested_code,
        author: result.author,
        created_at: result.created_at,
        issue_category: result.issue_category,
        severity: result.severity,
        pattern_tags: result.pattern_tags ? JSON.parse(result.pattern_tags) : [],
        similarity_score: result._distance || 0,
        comment_embedding: result.comment_embedding,
        code_embedding: result.code_embedding,
        combined_embedding: result.combined_embedding,
        chunkMatch: result.chunkMatch || false,
        matchedChunk: result.matchedChunk || null,
      });
    }
  }

  return uniqueResults;
}

/**
 * Apply code chunk-based reranking
 * @param {Array<Object>} comments - Comments to rerank
 * @param {Array<number>} queryEmbedding - Query embedding
 * @param {Array<Object>} codeChunks - Code chunks for matching
 * @param {string} targetFilePath - Target file path
 * @returns {Promise<Array<Object>>} Reranked comments
 */
async function applyCodeChunkReranking(comments, queryEmbedding, codeChunks, targetFilePath) {
  const rerankedComments = [];

  for (const comment of comments) {
    let baseScore = 1 - (comment.similarity_score || 0); // Convert distance to similarity
    let codeMatchScore = 0;
    let pathSimilarityScore = 0;
    let contentRelevanceScore = 0;

    // Enhanced code chunk matching with priority consideration
    if (comment.searchType === 'chunk_comment' || comment.searchType === 'chunk_code' || comment.searchType === 'chunk_combined') {
      // Base bonus for chunk-based matches
      codeMatchScore = 0.5;

      // Additional bonus based on chunk priority
      if (comment.chunkPriority) {
        codeMatchScore += comment.chunkPriority * 0.3;
      }

      // Extra bonus for function context chunks
      if (comment.chunkType === 'function_context') {
        codeMatchScore += 0.2;
      }
    } else if (comment.original_code || comment.suggested_code) {
      // Check if comment's code samples match any of our chunks
      const commentCodes = [comment.original_code, comment.suggested_code].filter(Boolean);

      for (const commentCode of commentCodes) {
        for (const chunk of codeChunks.slice(0, 5)) {
          try {
            const similarity = await calculateSemanticSimilarity(commentCode, chunk.content);
            if (similarity > 0.3) {
              codeMatchScore = Math.max(codeMatchScore, similarity * 0.3);
            }
          } catch (error) {
            // Fallback to simple text similarity if embedding fails
            const textSimilarity = calculateSimpleTextSimilarity(commentCode, chunk.content);
            if (textSimilarity > 0.5) {
              codeMatchScore = Math.max(codeMatchScore, textSimilarity * 0.2);
            }
          }
        }
      }
    }

    // Path similarity bonus
    if (targetFilePath && comment.file_path) {
      pathSimilarityScore = calculatePathSimilarity(targetFilePath, comment.file_path) * 0.15;
    }

    // Content relevance scoring - prioritize comments with code samples
    if (comment.original_code || comment.suggested_code) {
      contentRelevanceScore += 0.2; // Bonus for having code samples
    }

    if (comment.comment_text && comment.comment_text.length > 50) {
      contentRelevanceScore += 0.1; // Bonus for substantial comments
    }

    // Enhanced search type bonuses
    let searchTypeBonus = 0;
    switch (comment.searchType) {
      case 'chunk_comment':
      case 'chunk_code':
      case 'chunk_combined':
        searchTypeBonus = 0.4; // Higher bonus for chunk-based matches
        break;
      case 'comment':
        searchTypeBonus = 0.1;
        break;
      case 'combined':
        searchTypeBonus = 0.05;
        break;
    }

    // Additional bonus for comments that mention relevant keywords
    if (comment.comment_text) {
      const commentText = comment.comment_text.toLowerCase();
      if (
        commentText.includes('ignore') ||
        commentText.includes('coverage') ||
        commentText.includes('test') ||
        commentText.includes('istanbul')
      ) {
        searchTypeBonus += 0.15;
      }
    }

    // Calculate final score with weighted components
    const finalScore = baseScore * 0.4 + codeMatchScore + pathSimilarityScore + contentRelevanceScore + searchTypeBonus;

    rerankedComments.push({
      ...comment,
      finalScore,
      baseScore,
      codeMatchScore,
      pathSimilarityScore,
      contentRelevanceScore,
      searchTypeBonus,
    });
  }

  return rerankedComments.sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Calculate simple text similarity as fallback
 * @param {string} text1 - First text
 * @param {string} text2 - Second text
 * @returns {number} Similarity score (0-1)
 */
function calculateSimpleTextSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;

  const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const norm1 = normalize(text1);
  const norm2 = normalize(text2);

  if (norm1 === norm2) return 1;

  // Calculate Jaccard similarity on words
  const words1 = new Set(norm1.split(' '));
  const words2 = new Set(norm2.split(' '));

  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Calculate path similarity between two file paths
 * @param {string} path1 - First path
 * @param {string} path2 - Second path
 * @returns {number} Similarity score (0-1)
 */
function calculatePathSimilarity(path1, path2) {
  if (!path1 || !path2) return 0;

  try {
    const parts1 = path
      .dirname(path.normalize(path1))
      .split(path.sep)
      .filter((p) => p);
    const parts2 = path
      .dirname(path.normalize(path2))
      .split(path.sep)
      .filter((p) => p);

    let commonPrefixLength = 0;
    const minLength = Math.min(parts1.length, parts2.length);

    for (let i = 0; i < minLength; i++) {
      if (parts1[i] === parts2[i]) {
        commonPrefixLength++;
      } else {
        break;
      }
    }

    const avgLength = (parts1.length + parts2.length) / 2;
    if (avgLength === 0) return 1;

    return Math.max(0, Math.min(1, commonPrefixLength / avgLength));
  } catch (error) {
    return 0;
  }
}

// ============================================================================
// MAIN OPTIMIZATION FUNCTIONS
// ============================================================================

/**
 * Perform hierarchical search with context-aware filtering
 * @param {string|Array<number>} query - Query text or embedding vector
 * @param {Object} table - Database table
 * @param {Object} options - Search options
 * @param {Object} targetContext - Target code context
 * @returns {Promise<Array<Object>>} Candidate comments
 */
async function performHierarchicalSearch(query, table, options, targetContext) {
  const { threshold = 0.15, limit = 10 } = options;

  // Stage 1: Broad semantic search with low threshold
  const broadThreshold = Math.max(threshold - 0.1, 0.05);
  const broadResults = await performSingleStageSearch(query, table, {
    ...options,
    threshold: broadThreshold,
    limit: limit * 3, // Get more candidates for filtering
  });

  console.log(chalk.gray(`  Stage 1: Broad search returned ${broadResults.length} candidates`));

  // Stage 2: Context-based filtering and scoring
  const contextFilteredResults = [];

  for (const comment of broadResults) {
    let contextScore = 1.0;
    let contextMatch = 'unknown';

    // Apply context-based filtering if we have target context
    if (targetContext && targetContext.area !== 'Unknown') {
      const commentContext = await inferCommentContext(comment);

      // Area matching using embeddings
      const areaSimilarity = await calculateAreaSimilarity(commentContext.area, targetContext.area);

      if (areaSimilarity > 0.8) {
        contextScore *= 1.8; // Strong boost for area match
        contextMatch = 'area';
      } else if (areaSimilarity > 0.5) {
        contextScore *= 1.3; // Medium boost for related areas
        contextMatch = 'related-area';
      } else if (commentContext.area !== 'Unknown' && areaSimilarity < 0.3) {
        contextScore *= 0.6; // Penalty for different areas
        contextMatch = 'different-area';
      }

      // Technology matching using embeddings
      const techOverlap = await calculateTechnologyOverlap(commentContext.dominantTech, targetContext.dominantTech);
      if (techOverlap > 0) {
        contextScore *= 1.0 + techOverlap * 0.5; // Boost based on tech overlap
        contextMatch = contextMatch === 'area' ? 'area-tech' : 'tech';
      }
    }

    comment.contextScore = contextScore;
    comment.contextMatch = contextMatch;
    comment.similarity_score *= contextScore;

    // Only include comments that pass minimum context relevance
    if (contextScore >= 0.4) {
      contextFilteredResults.push(comment);
    }
  }

  console.log(chalk.gray(`  Stage 2: Context filtering retained ${contextFilteredResults.length} comments`));
  return contextFilteredResults;
}

/**
 * Apply multi-dimensional scoring framework
 * @param {Array<Object>} comments - Comments to score
 * @param {string|Array<number>} query - Original query
 * @param {Object} targetContext - Target code context
 * @param {Object} options - Options
 * @returns {Promise<Array<Object>>} Scored comments
 */
async function applyMultiDimensionalScoring(comments, query, targetContext, options) {
  const scoredComments = [];

  for (const comment of comments) {
    try {
      // Multi-dimensional scoring: semantic (30%), context (40%), quality (20%), recency (10%)
      const semanticScore = comment.similarity_score || 0;
      const contextScore = comment.contextScore || 1.0;

      // Quality scoring
      const qualityScore = await calculateCommentQuality(comment);

      // Recency scoring (newer comments get slight boost)
      const recencyScore = calculateRecencyScore(comment.created_at);

      // Weighted combination
      const finalScore =
        semanticScore * 0.3 +
        (contextScore - 1.0 + 1.0) * 0.4 + // Normalize context score
        qualityScore * 0.2 +
        recencyScore * 0.1;

      comment.semanticScore = semanticScore;
      comment.qualityScore = qualityScore;
      comment.recencyScore = recencyScore;
      comment.finalScore = finalScore;

      scoredComments.push(comment);
    } catch (error) {
      console.warn(chalk.yellow(`Scoring failed for comment ${comment.id}: ${error.message}`));
      comment.finalScore = comment.similarity_score || 0;
      scoredComments.push(comment);
    }
  }

  return scoredComments.sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Calculate comment quality score using content analysis
 * @param {Object} comment - Comment object
 * @returns {Promise<number>} Quality score (0-1)
 */
async function calculateCommentQuality(comment) {
  const commentText = comment.comment_text || comment.body || '';
  let score = 0.5; // Base score

  // Length factor (meaningful content)
  if (commentText.length > 50) score += 0.1;
  if (commentText.length > 200) score += 0.1;
  if (commentText.length < 20) score -= 0.2;

  // Technical content indicators using embeddings
  if (await hasTechnicalContent(commentText)) score += 0.2;
  if (hasCodeSuggestions(commentText)) score += 0.2;

  // Code context
  if (comment.original_code || comment.suggested_code) score += 0.1;
  if (comment.file_path) score += 0.05;

  // Generic comment penalty
  const genericScore = await calculateGenericScore(commentText);
  score -= genericScore * 0.3;

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate recency score based on comment age
 * @param {string} createdAt - ISO timestamp
 * @returns {number} Recency score (0-1)
 */
function calculateRecencyScore(createdAt) {
  if (!createdAt) return 0.5;

  const now = new Date();
  const commentDate = new Date(createdAt);
  const daysDiff = (now - commentDate) / (1000 * 60 * 60 * 24);

  // Newer comments get higher scores, with diminishing returns
  if (daysDiff < 30) return 1.0;
  if (daysDiff < 90) return 0.8;
  if (daysDiff < 180) return 0.6;
  if (daysDiff < 365) return 0.4;
  return 0.2;
}

/**
 * Apply comment quality assessment using embeddings
 * @param {Array<Object>} comments - Comments to assess
 * @param {Object} options - Options
 * @returns {Promise<Array<Object>>} Quality-filtered comments
 */
async function applyQualityAssessment(comments, options) {
  const { isTestFile = false } = options;
  const qualityComments = [];

  for (const comment of comments) {
    const commentText = comment.comment_text || comment.body || '';

    // Calculate quality metrics using embeddings
    const genericScore = await calculateGenericScore(commentText);
    const botLikelihood = await calculateBotLikelihood(comment);
    const testRelatedness = await calculateTestRelatedness(comment);

    // Filter out highly generic comments
    if (genericScore > 0.8) {
      console.log(chalk.yellow(`  Filtered generic (score: ${genericScore.toFixed(2)}): "${commentText.substring(0, 30)}..."`));
      continue;
    }

    // Filter out likely bot comments
    if (botLikelihood > 0.7) {
      console.log(chalk.yellow(`  Filtered bot comment (likelihood: ${botLikelihood.toFixed(2)}) from ${comment.author}`));
      continue;
    }

    // Filter test-related comments if target is not a test file
    if (!isTestFile && testRelatedness > 0.7) {
      console.log(chalk.yellow(`  Filtered test comment (relatedness: ${testRelatedness.toFixed(2)}) from ${comment.file_path}`));
      continue;
    }

    // Calculate and apply quality boosts
    const technicalScore = await calculateTechnicalContentScore(commentText);
    const codeSuggestionScore = await calculateCodeSuggestionScore(commentText);

    if (technicalScore > 0.5) {
      comment.finalScore *= 1 + technicalScore * 0.2;
      comment.hasTechnicalContent = true;
      comment.technicalScore = technicalScore;
    }

    if (codeSuggestionScore > 0.5) {
      comment.finalScore *= 1 + codeSuggestionScore * 0.3;
      comment.hasCodeSuggestions = true;
      comment.codeSuggestionScore = codeSuggestionScore;
    }

    qualityComments.push(comment);
  }

  return qualityComments;
}

/**
 * Enhance comments with pattern detection using embeddings
 * @param {Array<Object>} comments - Comments to enhance
 * @param {string} targetCodeContent - Target code content
 * @param {Object} targetContext - Target context
 * @returns {Promise<Array<Object>>} Pattern-enhanced comments
 */
async function enhanceWithPatternDetection(comments, targetCodeContent, targetContext) {
  if (!targetCodeContent) {
    return comments;
  }

  const enhancedComments = [];

  // Extract semantic patterns from target code
  const targetPatterns = await extractSemanticPatterns(targetCodeContent);

  for (const comment of comments) {
    try {
      const commentText = comment.comment_text || comment.body || '';

      // Calculate semantic similarity between target code and comment
      const semanticSimilarity = await calculateSemanticSimilarity(targetCodeContent, commentText);

      if (semanticSimilarity > 0.3) {
        comment.finalScore *= 1.0 + semanticSimilarity * 0.5;
        comment.patternSimilarity = semanticSimilarity;
        comment.hasPatternMatch = true;
      }

      // Extract comment patterns and compare categories
      const commentPatterns = await extractSemanticPatterns(commentText);

      // Boost if comment addresses same category as target code
      if (targetPatterns.dominantCategory && commentPatterns.categories.includes(targetPatterns.dominantCategory)) {
        comment.finalScore *= 1.2;
        comment.categoryMatch = targetPatterns.dominantCategory;
      }

      // Boost comments that address similar code structures
      if (comment.original_code) {
        const structureSimilarity = await calculateSemanticSimilarity(targetCodeContent, comment.original_code);

        if (structureSimilarity > 0.4) {
          comment.finalScore *= 1.4;
          comment.structureSimilarity = structureSimilarity;
          comment.hasStructureMatch = true;
        }
      }

      enhancedComments.push(comment);
    } catch (error) {
      console.warn(chalk.yellow(`Pattern detection failed for comment ${comment.id}: ${error.message}`));
      enhancedComments.push(comment);
    }
  }

  return enhancedComments.sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Perform diversity selection using embedding-based clustering
 * @param {Array<Object>} comments - Comments to select from
 * @param {number} limit - Maximum number of comments to return
 * @returns {Promise<Array<Object>>} Diverse selection of comments
 */
async function performDiversitySelection(comments, limit) {
  if (comments.length <= limit) {
    return comments;
  }

  const selectedComments = [];
  const selectedEmbeddings = [];
  const usedAuthors = new Set();
  const usedFiles = new Set();

  // First pass: select highest scoring comments with diversity constraints
  for (const comment of comments) {
    if (selectedComments.length >= limit) break;

    const commentText = comment.comment_text || comment.body || '';
    const author = comment.author || 'unknown';
    const filePath = comment.file_path || 'unknown';

    // Get comment embedding
    const commentEmbedding = comment.comment_embedding || (await getCachedEmbedding(commentText));

    // Check semantic diversity
    let isDuplicate = false;
    if (commentEmbedding) {
      for (const selectedEmb of selectedEmbeddings) {
        const similarity = calculateCosineSimilarity(commentEmbedding, selectedEmb);
        if (similarity > 0.85) {
          // High similarity threshold
          isDuplicate = true;
          break;
        }
      }
    }

    // Author and file diversity checks
    const isAuthorOverrepresented = usedAuthors.has(author) && selectedComments.filter((c) => c.author === author).length >= 2;
    const isFileOverrepresented = usedFiles.has(filePath) && selectedComments.filter((c) => c.file_path === filePath).length >= 3;

    // Select if diverse enough
    if ((!isDuplicate && !isAuthorOverrepresented && !isFileOverrepresented) || selectedComments.length < limit * 0.7) {
      selectedComments.push(comment);
      if (commentEmbedding) {
        selectedEmbeddings.push(commentEmbedding);
      }
      usedAuthors.add(author);
      usedFiles.add(filePath);

      // Add semantic category for logging
      comment.semanticCategory = await getCommentSemanticCategory(commentText);
    }
  }

  // Second pass: fill remaining slots with best remaining comments
  if (selectedComments.length < limit) {
    const remaining = comments.filter((c) => !selectedComments.includes(c));
    const needed = limit - selectedComments.length;

    for (const comment of remaining.slice(0, needed)) {
      selectedComments.push(comment);
      // Add semantic category for logging
      const commentText = comment.comment_text || comment.body || '';
      comment.semanticCategory = await getCommentSemanticCategory(commentText);
    }
  }

  return selectedComments;
}
