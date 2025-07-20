/**
 * Content Retrieval Service
 *
 * This module provides sophisticated content retrieval capabilities with:
 * - Hybrid search combining vector similarity and full-text search
 * - Context-aware reranking algorithms
 * - Project-specific filtering and isolation
 * - H1 embedding cache integration
 * - Parallel processing for optimal performance
 *
 * @module ContentRetrieval
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { CacheManager } from './embeddings/cache-manager.js';
import { TABLE_NAMES } from './embeddings/constants.js';
import { DatabaseManager } from './embeddings/database.js';
import { EmbeddingError } from './embeddings/errors.js';
import { ModelManager } from './embeddings/model-manager.js';
import { calculateCosineSimilarity, calculatePathSimilarity } from './embeddings/similarity-calculator.js';
import { debug } from './utils.js';
import { isDocumentationFile, isGenericDocument, getGenericDocumentContext, inferContextFromDocumentContent } from './utils.js';

const FILE_EMBEDDINGS_TABLE = TABLE_NAMES.FILE_EMBEDDINGS;
const DOCUMENT_CHUNK_TABLE = TABLE_NAMES.DOCUMENT_CHUNK;

/**
 * ContentRetriever class for advanced search and discovery
 */
export class ContentRetriever {
  constructor(options = {}) {
    this.modelManager = options.modelManager || new ModelManager();
    this.database = options.database || new DatabaseManager();
    this.cacheManager = options.cacheManager || new CacheManager();

    // Initialize caches for performance optimization
    this.h1EmbeddingCache = new Map();
    this.documentContextCache = new Map();
    this.documentContextPromiseCache = new Map();

    // Performance tracking
    this.performanceMetrics = {
      searchCount: 0,
      totalSearchTime: 0,
      cacheHitRate: 0,
      parallelRerankingTime: 0,
    };

    // Cleanup guard
    this.cleaningUp = false;
  }

  /**
   * Find relevant documentation with sophisticated reranking
   * @param {string} queryText - The search query
   * @param {Object} options - Search configuration
   * @returns {Promise<Array>} Array of relevant documents
   */
  async findRelevantDocs(queryText, options = {}) {
    const {
      limit = 10,
      similarityThreshold = 0.1,
      useReranking = true,
      queryFilePath = null,
      queryContextForReranking = null,
      projectPath = process.cwd(),
      precomputedQueryEmbedding = null,
    } = options;

    this.performanceMetrics.searchCount++;

    try {
      if (!queryText?.trim()) {
        console.warn(chalk.yellow('Empty query text provided for documentation search'));
        return [];
      }

      console.log(
        chalk.cyan(`Native hybrid documentation search - limit: ${limit}, threshold: ${similarityThreshold}, reranking: ${useReranking}`)
      );

      await this.database.connect();
      const table = await this.database.getTable(DOCUMENT_CHUNK_TABLE);

      if (!table) {
        console.warn(chalk.yellow(`Documentation table ${DOCUMENT_CHUNK_TABLE} not found`));
        return [];
      }

      console.log(chalk.cyan('Performing native hybrid search for documentation...'));
      let query = table.search(queryText).nearestToText(queryText);

      const resolvedProjectPath = path.resolve(projectPath);
      try {
        const tableSchema = await table.schema;
        if (tableSchema?.fields?.some((field) => field.name === 'project_path')) {
          query = query.where(`project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`);
          debug(`Filtering documentation by project_path: ${resolvedProjectPath}`);
        }
      } catch (schemaError) {
        debug(`Could not check schema for project_path field: ${schemaError.message}`);
      }

      const results = await query.limit(Math.max(limit * 3, 20)).toArray();
      console.log(chalk.green(`Native hybrid search returned ${results.length} documentation results`));

      // OPTIMIZATION: Enhanced batch file existence checks with parallel processing
      const docsToCheck = [];
      const docProjectMatchMap = new Map();

      // First pass: collect files that need existence checking
      for (let i = 0; i < results.length; i++) {
        const result = results[i];

        if (result.project_path) {
          docProjectMatchMap.set(i, result.project_path === resolvedProjectPath);
          continue;
        }

        if (!result.original_document_path) {
          docProjectMatchMap.set(i, false);
          continue;
        }

        const filePath = result.original_document_path;
        try {
          if (path.isAbsolute(filePath)) {
            docProjectMatchMap.set(i, filePath.startsWith(resolvedProjectPath));
            continue;
          }

          const absolutePath = path.resolve(resolvedProjectPath, filePath);
          if (absolutePath.startsWith(resolvedProjectPath)) {
            // Mark for batch existence check
            docsToCheck.push({ result, index: i, absolutePath, filePath });
          } else {
            docProjectMatchMap.set(i, false);
          }
        } catch (error) {
          debug(`Error filtering result for project: ${error.message}`);
          docProjectMatchMap.set(i, false);
        }
      }

      // Enhanced batch check file existence with improved error handling
      if (docsToCheck.length > 0) {
        debug(`[OPTIMIZATION] Batch checking existence of ${docsToCheck.length} documentation files`);
        const existencePromises = docsToCheck.map(async ({ index, absolutePath, filePath }) => {
          try {
            await fs.promises.access(absolutePath, fs.constants.F_OK);
            return { index, exists: true };
          } catch {
            debug(`Filtering out non-existent documentation file: ${filePath}`);
            return { index, exists: false };
          }
        });

        const existenceResults = await Promise.all(existencePromises);
        for (const { index, exists } of existenceResults) {
          docProjectMatchMap.set(index, exists);
        }
      }

      // Filter results based on project match using the map
      const projectFilteredResults = results.filter((result, index) => docProjectMatchMap.get(index) === true);

      console.log(chalk.blue(`Filtered to ${projectFilteredResults.length} documentation results from current project`));
      let finalResults = projectFilteredResults.map((result) => {
        let similarity;
        if (result._distance !== undefined) {
          similarity = Math.max(0, Math.min(1, 1 - result._distance));
        } else if (result._score !== undefined) {
          similarity = Math.max(0, Math.min(1, result._score));
        } else {
          similarity = 0.5;
        }

        return {
          similarity,
          type: 'documentation-chunk',
          content: result.content,
          path: result.original_document_path,
          file_path: result.original_document_path,
          language: result.language,
          headingText: result.heading_text,
          document_title: result.document_title,
          startLine: result.start_line,
          reranked: false,
        };
      });

      finalResults = finalResults.filter((result) => result.similarity >= similarityThreshold);

      let queryEmbedding = null;
      if (useReranking && queryContextForReranking && finalResults.length >= 3) {
        console.log(chalk.cyan('Applying sophisticated contextual reranking to documentation...'));
        const WEIGHT_INITIAL_SIM = 0.3;
        const WEIGHT_H1_CHUNK_RERANK = 0.15;
        const HEAVY_BOOST_SAME_AREA = 0.4;
        const MODERATE_BOOST_TECH_MATCH = 0.2;
        const HEAVY_PENALTY_AREA_MISMATCH = -0.1;
        const PENALTY_GENERIC_DOC_LOW_CONTEXT_MATCH = -0.1;

        queryEmbedding = precomputedQueryEmbedding || (await this.modelManager.calculateQueryEmbedding(queryText));

        // OPTIMIZATION 1: Enhanced batch calculate missing H1 embeddings with cache tracking
        const uniqueH1Titles = new Set();
        const h1TitlesToCalculate = [];

        for (const result of finalResults) {
          const docH1 = result.document_title;
          if (docH1 && !uniqueH1Titles.has(docH1)) {
            uniqueH1Titles.add(docH1);
            if (!this.h1EmbeddingCache.has(docH1)) {
              h1TitlesToCalculate.push(docH1);
            }
          }
        }

        // Batch calculate H1 embeddings for cache misses
        if (h1TitlesToCalculate.length > 0) {
          debug(`[OPTIMIZATION] Batch calculating ${h1TitlesToCalculate.length} H1 embeddings`);
          const h1Embeddings = await this.modelManager.calculateEmbeddingBatch(h1TitlesToCalculate);
          for (let i = 0; i < h1TitlesToCalculate.length; i++) {
            if (h1Embeddings[i]) {
              this.h1EmbeddingCache.set(h1TitlesToCalculate[i], h1Embeddings[i]);
            }
          }
        }

        // OPTIMIZATION 2: Cross-file document context caching for multi-file PRs
        const docContextsToCalculate = [];

        // Check cache for ALL documents (no uniqueDocPaths filter to allow cross-file caching)
        const documentPathsInThisQuery = new Set();
        for (const result of finalResults) {
          const docPath = result.path;
          // Use normalized path for better cache hits (resolve relative to target project)
          const normalizedPath = path.resolve(resolvedProjectPath, docPath);

          if (docPath && !documentPathsInThisQuery.has(normalizedPath)) {
            documentPathsInThisQuery.add(normalizedPath);

            // Need to calculate document context
            if (!this.documentContextCache.has(normalizedPath) && !this.documentContextPromiseCache.has(normalizedPath)) {
              docContextsToCalculate.push({
                docPath: normalizedPath,
                originalPath: docPath,
                docH1: result.document_title,
                result,
              });
            }
          }
        }

        // Optimize context calculation with concurrency limits and fast-path detection
        if (docContextsToCalculate.length > 0) {
          debug(`[OPTIMIZATION] Batch calculating ${docContextsToCalculate.length} document contexts with concurrency limit`);

          // Process in smaller batches to avoid memory issues and improve responsiveness
          const CONTEXT_BATCH_SIZE = 3; // Limit concurrent context calculations
          const contextResults = [];

          for (let i = 0; i < docContextsToCalculate.length; i += CONTEXT_BATCH_SIZE) {
            const batch = docContextsToCalculate.slice(i, i + CONTEXT_BATCH_SIZE);

            const batchPromises = batch.map(async ({ docPath, originalPath, docH1, result }) => {
              // Check if there's already a promise for this document
              if (this.documentContextPromiseCache.has(docPath)) {
                const context = await this.documentContextPromiseCache.get(docPath);
                return { docPath, context };
              }

              // Create a new promise for this document calculation
              const contextPromise = (async () => {
                try {
                  let context;

                  // FAST-PATH OPTIMIZATION: Check for generic documents first
                  if (isGenericDocument(originalPath, docH1)) {
                    // Use pre-computed context for generic documents (README, RUNBOOK, etc.)
                    context = getGenericDocumentContext(originalPath, docH1);
                    debug(`[FAST-PATH] Using pre-computed context for generic document: ${originalPath}`);
                  } else {
                    // Use the expensive inference for non-generic documents
                    context = await inferContextFromDocumentContent(
                      originalPath,
                      docH1,
                      [result],
                      queryContextForReranking.language || 'typescript'
                    );
                  }

                  return context;
                } catch (error) {
                  debug(`[ERROR] Failed to get context for ${originalPath}: ${error.message}`);
                  // Return a fallback context to avoid breaking the pipeline
                  return {
                    area: 'Unknown',
                    dominantTech: [],
                    isGeneralPurposeReadmeStyle: true,
                  };
                }
              })();

              // Store the promise in the cache
              this.documentContextPromiseCache.set(docPath, contextPromise);

              // Wait for the result
              const context = await contextPromise;

              // Store the result in the regular cache and remove the promise
              this.documentContextCache.set(docPath, context);
              this.documentContextPromiseCache.delete(docPath);

              return { docPath, context };
            });

            const batchResults = await Promise.all(batchPromises);
            contextResults.push(...batchResults);

            // Add a small delay between batches to prevent overwhelming the system
            if (i + CONTEXT_BATCH_SIZE < docContextsToCalculate.length) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          // Cache all results with normalized paths (consistent with lookup keys)
          for (const { docPath, context } of contextResults) {
            this.documentContextCache.set(docPath, context);
          }
        }

        // OPTIMIZATION 3: Enhanced parallelize main reranking calculations with memory monitoring
        const rerankingPromises = finalResults.map(async (result) => {
          let chunkInitialScore = result.similarity * WEIGHT_INITIAL_SIM;
          let contextMatchBonus = 0;
          let h1RelevanceBonus = 0;
          let genericDocPenalty = 0;
          let pathSimilarityScore = 0;

          const docPath = result.path;
          const docH1 = result.document_title;

          // Context should now be cached from batch operation above
          const normalizedDocPath = path.resolve(resolvedProjectPath, docPath);
          const chunkParentDocContext = this.documentContextCache.get(normalizedDocPath);

          if (
            chunkParentDocContext &&
            queryContextForReranking.area !== 'Unknown' &&
            chunkParentDocContext.area !== 'Unknown' &&
            chunkParentDocContext.area !== 'General'
          ) {
            if (queryContextForReranking.area === chunkParentDocContext.area) {
              contextMatchBonus += HEAVY_BOOST_SAME_AREA;
              if (queryContextForReranking.dominantTech && chunkParentDocContext.dominantTech) {
                const techIntersection = queryContextForReranking.dominantTech.some((tech) =>
                  chunkParentDocContext.dominantTech.map((t) => t.toLowerCase()).includes(tech.toLowerCase())
                );
                if (techIntersection) {
                  contextMatchBonus += MODERATE_BOOST_TECH_MATCH;
                }
              }
            } else if (queryContextForReranking.area !== 'GeneralJS_TS') {
              contextMatchBonus += HEAVY_PENALTY_AREA_MISMATCH;
            }
          }

          // H1 embedding should now be cached from batch operation above
          if (docH1) {
            const h1Emb = this.h1EmbeddingCache.get(docH1);
            if (h1Emb && queryEmbedding) {
              h1RelevanceBonus = calculateCosineSimilarity(queryEmbedding, h1Emb) * WEIGHT_H1_CHUNK_RERANK;
            }
          }

          if (chunkParentDocContext && chunkParentDocContext.isGeneralPurposeReadmeStyle) {
            const contextMatchScore = queryContextForReranking.area === chunkParentDocContext.area ? 1.0 : 0.0;
            if (contextMatchScore < 0.4) {
              genericDocPenalty = PENALTY_GENERIC_DOC_LOW_CONTEXT_MATCH;
              debug(`[findRelevantDocs] Doc ${result.path} is generic with low context match, applying penalty: ${genericDocPenalty}`);
            }
          }

          if (queryFilePath && result.path) {
            pathSimilarityScore = calculatePathSimilarity(queryFilePath, result.path) * 0.1;
          }

          const finalScore = chunkInitialScore + contextMatchBonus + h1RelevanceBonus + pathSimilarityScore + genericDocPenalty;
          result.similarity = Math.max(0, Math.min(1, finalScore));
          result.reranked = true;

          return result;
        });

        // Wait for all reranking calculations to complete
        await Promise.all(rerankingPromises);

        // Log debug info for first few results
        for (let i = 0; i < Math.min(5, finalResults.length); i++) {
          const result = finalResults[i];
          debug(`[SophisticatedRerank] ${result.path?.substring(0, 30)}... Final=${result.similarity.toFixed(4)}`);
        }

        finalResults.sort((a, b) => b.similarity - a.similarity);
        debug('Sophisticated contextual reranking of documentation complete.');
      }

      finalResults.sort((a, b) => b.similarity - a.similarity);
      if (finalResults.length > limit) {
        finalResults = finalResults.slice(0, limit);
      }

      console.log(chalk.green(`Returning ${finalResults.length} documentation results`));

      return finalResults;
    } catch (error) {
      console.error(chalk.red(`Error in findRelevantDocs: ${error.message}`), error);
      throw new EmbeddingError(`Documentation search failed: ${error.message}`);
    }
  }

  /**
   * Find similar code using native LanceDB hybrid search
   * Optimized implementation using LanceDB's built-in vector + FTS + RRF
   * @param {string} queryText - The text query
   * @param {Object} options - Search options
   * @returns {Promise<Array<object>>} Search results
   */
  async findSimilarCode(queryText, options = {}) {
    const {
      limit = 5,
      similarityThreshold = 0.7,
      includeProjectStructure = false,
      queryFilePath = null,
      projectPath = process.cwd(),
      isTestFile = null,
      precomputedQueryEmbedding = null,
    } = options;

    console.log(chalk.cyan(`Native hybrid code search - limit: ${limit}, threshold: ${similarityThreshold}, isTestFile: ${isTestFile}`));

    try {
      if (!queryText?.trim()) {
        console.warn(chalk.yellow('Empty query text provided'));
        return [];
      }

      await this.database.connect();
      const table = await this.database.getTable(FILE_EMBEDDINGS_TABLE);

      if (!table) {
        console.warn(chalk.yellow(`Table ${FILE_EMBEDDINGS_TABLE} not found`));
        return [];
      }

      // Native hybrid search with automatic vector + FTS + RRF
      console.log(chalk.cyan('Performing native hybrid search for code...'));
      let query = table.search(queryText).nearestToText(queryText);

      // Add filtering conditions
      const conditions = [];
      conditions.push("type != 'directory-structure'");

      // Add filtering for test files.
      if (isTestFile !== null) {
        if (isTestFile) {
          // Only include test files
          conditions.push(`(path LIKE '%.test.%' OR path LIKE '%.spec.%' OR path LIKE '%_test.py' OR path LIKE 'test_%.py')`);
          console.log(chalk.blue(`Filtering to include only test files.`));
        } else {
          // Exclude test files
          conditions.push(
            `(path NOT LIKE '%.test.%' AND path NOT LIKE '%.spec.%' AND path NOT LIKE '%_test.py' AND path NOT LIKE 'test_%.py')`
          );
          console.log(chalk.blue(`Filtering to exclude test files.`));
        }
      }

      // Resolve project path once for use in multiple places
      const resolvedProjectPath = path.resolve(projectPath);

      // Exclude the file being reviewed if queryFilePath is provided
      if (queryFilePath) {
        const normalizedQueryPath = path.resolve(resolvedProjectPath, queryFilePath);
        // Add condition to exclude the file being reviewed
        const escapedPath = normalizedQueryPath.replace(/'/g, "''");
        conditions.push(`path != '${escapedPath}'`);

        // Also check for relative path variants to be thorough
        const relativePath = path.relative(resolvedProjectPath, normalizedQueryPath);
        if (relativePath && !relativePath.startsWith('..')) {
          const escapedRelativePath = relativePath.replace(/'/g, "''");
          conditions.push(`path != '${escapedRelativePath}'`);
        }

        debug(`Excluding file being reviewed from similar code search: ${normalizedQueryPath}`);
      }

      // Add project path filtering if the field exists in the schema
      // Check if the table has project_path field
      try {
        const tableSchema = await table.schema;
        if (tableSchema && tableSchema.fields) {
          const hasProjectPathField = tableSchema.fields.some((field) => field.name === 'project_path');

          if (hasProjectPathField) {
            // Use exact match for project path
            conditions.push(`project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`);
            debug(`Filtering by project_path: ${resolvedProjectPath}`);
          }
        }
      } catch (schemaError) {
        debug(`Could not check schema for project_path field: ${schemaError.message}`);
        // Continue without project_path filtering in query
      }

      if (conditions.length > 0) {
        query = query.where(conditions.join(' AND '));
      }

      const results = await query.limit(Math.max(limit * 3, 20)).toArray();

      console.log(chalk.green(`Native hybrid search returned ${results.length} results`));

      // OPTIMIZATION: Batch file existence checks for better performance
      const resultsToCheck = [];
      const projectMatchMap = new Map();

      // First pass: collect files that need existence checking
      for (let i = 0; i < results.length; i++) {
        const result = results[i];

        // Use project_path field if available (new schema)
        if (result.project_path) {
          projectMatchMap.set(i, result.project_path === resolvedProjectPath);
          continue;
        }

        // Fallback for old embeddings without project_path field
        if (!result.path && !result.original_document_path) {
          projectMatchMap.set(i, false);
          continue;
        }

        const filePath = result.original_document_path || result.path;
        try {
          // Check if this result belongs to the current project
          // First try as absolute path
          if (path.isAbsolute(filePath)) {
            projectMatchMap.set(i, filePath.startsWith(resolvedProjectPath));
            continue;
          }

          // For relative paths, check if the file actually exists in the project
          const absolutePath = path.resolve(resolvedProjectPath, filePath);

          // Verify the path is within project bounds
          if (absolutePath.startsWith(resolvedProjectPath)) {
            // Mark for batch existence check
            resultsToCheck.push({ result, index: i, absolutePath });
          } else {
            projectMatchMap.set(i, false);
          }
        } catch (error) {
          debug(`Error filtering result for project: ${error.message}`);
          projectMatchMap.set(i, false);
        }
      }

      // Batch check file existence for better performance
      if (resultsToCheck.length > 0) {
        debug(`[OPTIMIZATION] Batch checking existence of ${resultsToCheck.length} files`);
        const existencePromises = resultsToCheck.map(async ({ result, index, absolutePath }) => {
          try {
            await fs.promises.access(absolutePath, fs.constants.F_OK);
            return { index, exists: true };
          } catch {
            debug(`Filtering out non-existent file: ${result.original_document_path || result.path}`);
            return { index, exists: false };
          }
        });

        const existenceResults = await Promise.all(existencePromises);
        for (const { index, exists } of existenceResults) {
          projectMatchMap.set(index, exists);
        }
      }

      // Filter results based on project match using the map
      const projectFilteredResults = results.filter((result, index) => projectMatchMap.get(index) === true);

      console.log(chalk.blue(`Filtered to ${projectFilteredResults.length} results from current project`));

      // Map results to expected format
      let finalResults = projectFilteredResults.map((result) => {
        // Handle different score types from native hybrid search
        let similarity;
        if (result._distance !== undefined) {
          // Vector search distance (0 = perfect match, higher = less similar)
          // Apply more precise normalization to avoid all scores being 1.000
          similarity = Math.max(0, Math.min(1, Math.exp(-result._distance * 2)));
        } else if (result._score !== undefined) {
          // FTS or hybrid score - normalize to 0-1 range with better scaling
          similarity = Math.max(0, Math.min(1, result._score / Math.max(result._score, 1)));
        } else {
          // Fallback
          similarity = 0.5;
        }

        // Determine if this is a documentation file using the utility function
        const isDocumentation = isDocumentationFile(result.path, result.language);

        return {
          similarity,
          type: 'file',
          content: result.content,
          path: result.path,
          file_path: result.path,
          language: result.language,
          reranked: false,
          isDocumentation, // Add the missing flag that cag-analyzer expects
        };
      });

      // Apply similarity threshold
      finalResults = finalResults.filter((result) => result.similarity >= similarityThreshold);

      // PERFORMANCE FIX: Calculate query embedding once and reuse for both reranking and project structure
      let queryEmbedding = null;

      // Include project structure if requested (project-specific)
      if (includeProjectStructure) {
        try {
          const fileTable = await this.database.getTable(FILE_EMBEDDINGS_TABLE);
          if (fileTable) {
            // Look for project-specific structure ID
            const projectStructureId = `__project_structure__${path.basename(resolvedProjectPath)}`;
            let structureResults = await fileTable.query().where(`id = '${projectStructureId}'`).limit(1).toArray();

            // Fall back to generic project structure if project-specific one doesn't exist
            if (structureResults.length === 0) {
              structureResults = await fileTable.query().where("id = '__project_structure__'").limit(1).toArray();
            }

            if (structureResults.length > 0) {
              const structureRecord = structureResults[0];
              if (structureRecord.vector) {
                // PERFORMANCE FIX: Use pre-computed query embedding if available, otherwise calculate once
                if (!queryEmbedding) {
                  queryEmbedding = precomputedQueryEmbedding || (await this.modelManager.calculateQueryEmbedding(queryText));
                }
                if (queryEmbedding) {
                  const similarity = calculateCosineSimilarity(queryEmbedding, Array.from(structureRecord.vector));
                  if (similarity > 0.5) {
                    finalResults.push({
                      similarity,
                      type: 'project-structure',
                      content: structureRecord.content,
                      path: structureRecord.path,
                      file_path: structureRecord.path,
                      language: 'text',
                      reranked: false,
                    });
                  }
                }
              }
            }
          }
        } catch (error) {
          console.warn(chalk.yellow(`Project structure inclusion failed: ${error.message}`));
        }
      }

      // Final sorting and limiting
      finalResults.sort((a, b) => b.similarity - a.similarity);
      if (finalResults.length > limit) {
        finalResults = finalResults.slice(0, limit);
      }

      console.log(chalk.green(`Returning ${finalResults.length} optimized hybrid search results`));
      return finalResults;
    } catch (error) {
      console.error(chalk.red(`Error in optimized findSimilarCode: ${error.message}`), error);
      return [];
    }
  }

  /**
   * Get performance metrics
   * @returns {Object} Performance metrics
   */
  getPerformanceMetrics() {
    return {
      ...this.performanceMetrics,
      averageSearchTime:
        this.performanceMetrics.searchCount > 0 ? this.performanceMetrics.totalSearchTime / this.performanceMetrics.searchCount : 0,
      cacheSize: this.h1EmbeddingCache.size,
      documentContextCacheSize: this.documentContextCache.size,
    };
  }

  /**
   * Clear all caches
   */
  clearCaches() {
    this.h1EmbeddingCache.clear();
    this.documentContextCache.clear();
    this.documentContextPromiseCache.clear();
    console.log(chalk.green('ContentRetriever caches cleared'));
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.cleaningUp) {
      return; // Already cleaning up, prevent duplicate calls
    }

    this.cleaningUp = true;

    try {
      // Clear LOCAL caches only (not system-wide caches)
      this.h1EmbeddingCache.clear();
      this.documentContextCache.clear();
      this.documentContextPromiseCache.clear();

      // Reset LOCAL performance metrics
      this.performanceMetrics = {
        searchCount: 0,
        totalSearchTime: 0,
        cacheHitRate: 0,
        parallelRerankingTime: 0,
      };

      console.log(chalk.green('ContentRetriever cleanup complete'));
    } finally {
      this.cleaningUp = false;
    }
  }
}
