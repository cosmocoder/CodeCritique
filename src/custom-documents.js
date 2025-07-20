/**
 * Custom Document Processor
 *
 * This module provides advanced custom document processing capabilities:
 * - Intelligent document chunking with metadata preservation
 * - Batch embedding generation for optimal performance
 * - Memory-based document storage with project isolation
 * - Context-aware search and retrieval
 * - Parallel processing with sophisticated reranking
 *
 * @module CustomDocuments
 */

import { createHash } from 'crypto';
import path from 'path';
import chalk from 'chalk';
import { CacheManager } from './embeddings/cache-manager.js';
import { EmbeddingError, ValidationError } from './embeddings/errors.js';
import { ModelManager } from './embeddings/model-manager.js';
import { calculateCosineSimilarity, calculatePathSimilarity } from './embeddings/similarity-calculator.js';
import { debug } from './utils/logging.js';
import { slugify } from './utils/string-utils.js';

/**
 * CustomDocumentProcessor class for advanced document processing
 */
export class CustomDocumentProcessor {
  constructor(options = {}) {
    this.modelManager = options.modelManager || new ModelManager();
    this.cacheManager = options.cacheManager || new CacheManager();

    // In-memory storage for custom document chunks (project-isolated)
    this.customDocumentChunks = new Map();

    // Embedding cache for performance optimization
    this.h1EmbeddingCache = new Map();

    // Performance metrics
    this.performanceMetrics = {
      documentsProcessed: 0,
      chunksGenerated: 0,
      embeddingsCalculated: 0,
      batchSuccessRate: 0,
      averageChunkSize: 0,
      processingTime: 0,
    };

    // Cleanup guard
    this.cleaningUp = false;
  }

  /**
   * Chunk a custom document into manageable pieces
   * @param {Object} doc - Document object with title and content
   * @returns {Array} Array of document chunks
   */
  chunkDocument(doc) {
    const { title, content } = doc;
    const startTime = Date.now();

    try {
      if (!doc || !content) {
        throw new ValidationError('Document must have content');
      }

      // Extract the actual document title from content
      let documentTitle = title;

      // Try to find a markdown header in the content
      const headerMatch = content.match(/^#\s+(.+)$/m);
      if (headerMatch) {
        documentTitle = headerMatch[1].trim();
      } else {
        // If no header found, try to extract filename from title like "instruction:./FILENAME.md"
        const filePathMatch = title.match(/:\.\/([^/]+)\.([a-zA-Z]+)$/);
        if (filePathMatch) {
          // Use filename without extension, but capitalize it nicely
          documentTitle = filePathMatch[1].replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
        }
      }

      const chunks = [];
      const sections = content.split(/\n\s*\n/);
      let currentChunk = '';
      let chunkIndex = 0;
      const maxChunkSize = 1000; // Max characters per chunk
      const minChunkSize = 100; // Min characters to avoid tiny chunks

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i].trim();
        if (!section) continue;

        // Check if adding this section would exceed max chunk size
        if (currentChunk.length + section.length > maxChunkSize && currentChunk.length > minChunkSize) {
          // Save current chunk
          chunks.push({
            id: `${slugify(documentTitle)}_chunk_${chunkIndex}`,
            content: currentChunk.trim(),
            document_title: documentTitle,
            chunk_index: chunkIndex,
            metadata: {
              section_start: chunkIndex === 0,
              total_chunks: 0, // Will be updated after all chunks are created
              original_title: title,
              chunk_hash: createHash('md5').update(currentChunk.trim()).digest('hex').substring(0, 8),
            },
          });

          chunkIndex++;
          currentChunk = section;
        } else {
          // Add section to current chunk
          currentChunk += (currentChunk ? '\n\n' : '') + section;
        }
      }

      // Add the last chunk if it has content
      if (currentChunk.trim()) {
        chunks.push({
          id: `${slugify(documentTitle)}_chunk_${chunkIndex}`,
          content: currentChunk.trim(),
          document_title: documentTitle,
          chunk_index: chunkIndex,
          metadata: {
            section_start: chunkIndex === 0,
            total_chunks: 0,
            original_title: title,
            chunk_hash: createHash('md5').update(currentChunk.trim()).digest('hex').substring(0, 8),
          },
        });
      }

      // Update total_chunks metadata for all chunks
      chunks.forEach((chunk) => {
        chunk.metadata.total_chunks = chunks.length;
      });

      // Update performance metrics
      this.performanceMetrics.chunksGenerated += chunks.length;
      this.performanceMetrics.averageChunkSize = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0) / chunks.length;
      this.performanceMetrics.processingTime += Date.now() - startTime;

      console.log(chalk.gray(`  Chunked document "${documentTitle}" into ${chunks.length} chunks`));
      return chunks;
    } catch (error) {
      console.error(chalk.red(`Error chunking document: ${error.message}`));
      throw new EmbeddingError(`Document chunking failed: ${error.message}`);
    }
  }

  /**
   * Process custom documents in memory with advanced batch processing
   * @param {Array} customDocs - Array of custom documents
   * @param {string} projectPath - Project path for isolation
   * @returns {Promise<Array>} Array of processed chunks with embeddings
   */
  async processDocumentsInMemory(customDocs, projectPath) {
    const startTime = Date.now();

    try {
      if (!customDocs || customDocs.length === 0) {
        console.log(chalk.gray('No custom documents to process'));
        return [];
      }

      console.log(chalk.cyan(`Processing ${customDocs.length} custom documents into chunks...`));

      const allChunks = [];
      let totalBatchAttempts = 0;
      let successfulBatches = 0;

      for (const doc of customDocs) {
        console.log(chalk.gray(`  Processing document: ${doc.title}`));

        // Chunk the document
        const chunks = this.chunkDocument(doc);

        // OPTIMIZATION: Batch process embeddings instead of individual calls
        const chunkContents = chunks.map((chunk) => chunk.content);
        totalBatchAttempts++;

        try {
          // Generate embeddings for all chunks in a single batch
          const embeddings = await this.modelManager.calculateEmbeddingBatch(chunkContents);
          successfulBatches++;

          // Process results with mixed success/failure handling
          const chunksWithEmbeddings = chunks.map((chunk, index) => {
            if (embeddings[index] !== null) {
              return {
                ...chunk,
                embedding: embeddings[index],
                similarity: 0, // Will be calculated during search
                type: 'custom-document-chunk',
                project_path: path.resolve(projectPath),
                created_at: new Date().toISOString(),
              };
            } else {
              console.error(chalk.red(`Error generating embedding for chunk ${chunk.id}: batch processing failed`));
              return null;
            }
          });

          // Filter out failed chunks
          const validChunks = chunksWithEmbeddings.filter((chunk) => chunk !== null);
          allChunks.push(...validChunks);

          console.log(chalk.gray(`    Generated embeddings for ${validChunks.length}/${chunks.length} chunks`));
          this.performanceMetrics.embeddingsCalculated += validChunks.length;
        } catch (error) {
          console.error(chalk.red(`Error in batch embedding generation for document ${doc.title}: ${error.message}`));
          // Fallback to individual processing for this document
          console.log(chalk.yellow(`    Falling back to individual processing for ${doc.title}`));

          const chunksWithEmbeddings = await Promise.all(
            chunks.map(async (chunk) => {
              try {
                const embedding = await this.modelManager.calculateEmbedding(chunk.content);
                this.performanceMetrics.embeddingsCalculated++;
                return {
                  ...chunk,
                  embedding,
                  similarity: 0,
                  type: 'custom-document-chunk',
                  project_path: path.resolve(projectPath),
                  created_at: new Date().toISOString(),
                };
              } catch (error) {
                console.error(chalk.red(`Error generating embedding for chunk ${chunk.id}: ${error.message}`));
                return null;
              }
            })
          );

          const validChunks = chunksWithEmbeddings.filter((chunk) => chunk !== null);
          allChunks.push(...validChunks);

          console.log(chalk.gray(`    Generated embeddings for ${validChunks.length}/${chunks.length} chunks (fallback)`));
        }
      }

      // Calculate batch success rate
      this.performanceMetrics.batchSuccessRate = totalBatchAttempts > 0 ? (successfulBatches / totalBatchAttempts) * 100 : 0;

      // Store chunks in memory organized by project path
      const resolvedProjectPath = path.resolve(projectPath);
      this.customDocumentChunks.set(resolvedProjectPath, allChunks);

      // Cache in CacheManager for persistence
      await this.cacheManager.storeCustomDocuments(resolvedProjectPath, allChunks);

      this.performanceMetrics.documentsProcessed += customDocs.length;
      this.performanceMetrics.processingTime += Date.now() - startTime;

      console.log(chalk.green(`Successfully processed ${allChunks.length} custom document chunks (${Date.now() - startTime}ms)`));
      return allChunks;
    } catch (error) {
      console.error(chalk.red(`Error processing custom documents: ${error.message}`));
      throw new EmbeddingError(`Custom document processing failed: ${error.message}`);
    }
  }

  /**
   * Find relevant custom document chunks with advanced reranking
   * @param {string} queryText - The search query
   * @param {Array} chunks - Array of document chunks to search
   * @param {Object} options - Search configuration
   * @returns {Promise<Array>} Array of relevant chunks
   */
  async findRelevantChunks(queryText, chunks = [], options = {}) {
    const {
      limit = 5,
      similarityThreshold = 0.3,
      queryContextForReranking = null,
      useReranking = true,
      precomputedQueryEmbedding = null,
      queryFilePath = null,
    } = options;

    const startTime = Date.now();

    try {
      if (!queryText?.trim()) {
        throw new ValidationError('Empty query text provided for custom document search');
      }

      if (!chunks || chunks.length === 0) {
        console.log(chalk.gray('No custom document chunks available for search'));
        return [];
      }

      console.log(chalk.cyan(`Searching ${chunks.length} custom document chunks...`));

      // OPTIMIZATION: Use pre-computed query embedding if available
      let queryEmbedding = precomputedQueryEmbedding;
      if (!queryEmbedding) {
        queryEmbedding = await this.modelManager.calculateQueryEmbedding(queryText);
      }

      // OPTIMIZATION: Vectorized similarity calculation for better performance
      const results = chunks.map((chunk) => ({
        ...chunk,
        similarity: calculateCosineSimilarity(queryEmbedding, chunk.embedding),
        reranked: false,
      }));

      // Filter by similarity threshold
      let filteredResults = results.filter((result) => result.similarity >= similarityThreshold);

      // Apply sophisticated context-aware reranking if enabled and context is available
      if (useReranking && queryContextForReranking && filteredResults.length >= 2) {
        await this._applyParallelReranking(filteredResults, queryText, queryContextForReranking, queryFilePath, queryEmbedding);
      }

      // Sort by similarity and limit results
      filteredResults.sort((a, b) => b.similarity - a.similarity);

      if (filteredResults.length > limit) {
        filteredResults = filteredResults.slice(0, limit);
      }

      console.log(chalk.green(`Found ${filteredResults.length} relevant custom document chunks (${Date.now() - startTime}ms)`));

      // Log top results for debugging
      if (filteredResults.length > 0) {
        debug(`[Custom Doc Search] Top result: ${filteredResults[0].document_title} (${filteredResults[0].similarity.toFixed(3)})`);
      }

      return filteredResults;
    } catch (error) {
      console.error(chalk.red(`Error searching custom document chunks: ${error.message}`));
      throw new EmbeddingError(`Custom document search failed: ${error.message}`);
    }
  }

  /**
   * Get existing custom document chunks for a project
   * @param {string} projectPath - Project path
   * @returns {Promise<Array>} Array of existing chunks
   */
  async getExistingChunks(projectPath) {
    try {
      const resolvedProjectPath = path.resolve(projectPath);

      // Try memory first
      const existingChunks = this.customDocumentChunks.get(resolvedProjectPath);
      if (existingChunks && existingChunks.length > 0) {
        debug(`[getExistingChunks] Found ${existingChunks.length} existing chunks in memory for project: ${resolvedProjectPath}`);
        return existingChunks;
      }

      // Try cache manager
      const cachedChunks = await this.cacheManager.getCustomDocuments(resolvedProjectPath);
      if (cachedChunks && cachedChunks.length > 0) {
        // Restore to memory
        this.customDocumentChunks.set(resolvedProjectPath, cachedChunks);
        debug(`[getExistingChunks] Restored ${cachedChunks.length} chunks from cache for project: ${resolvedProjectPath}`);
        return cachedChunks;
      }

      debug(`[getExistingChunks] No existing chunks found for project: ${resolvedProjectPath}`);
      return [];
    } catch (error) {
      debug(`[getExistingChunks] Error checking existing chunks: ${error.message}`);
      return [];
    }
  }

  /**
   * Apply sophisticated parallel reranking to custom document chunks
   * @private
   */
  async _applyParallelReranking(filteredResults, queryText, queryContextForReranking, queryFilePath, queryEmbedding) {
    console.log(chalk.cyan('Applying optimized parallel contextual reranking to custom document chunks...'));

    const WEIGHT_INITIAL_SIM = 0.4;
    const WEIGHT_DOCUMENT_TITLE_MATCH = 0.2;
    const HEAVY_BOOST_SAME_AREA = 0.3;
    const MODERATE_BOOST_TECH_MATCH = 0.15;
    const HEAVY_PENALTY_AREA_MISMATCH = -0.1;
    const PENALTY_GENERIC_DOC_LOW_CONTEXT_MATCH = -0.1;

    // Pre-calculate common values to avoid redundant computations
    const queryArea = queryContextForReranking.area;
    const queryAreaLower = queryArea?.toLowerCase();
    const queryKeywords = queryContextForReranking.keywords || [];
    const queryKeywordsLower = queryKeywords.map((kw) => kw.toLowerCase());
    const queryTech = queryContextForReranking.dominantTech || [];
    const queryTechLower = queryTech.map((tech) => tech.toLowerCase());

    // Pre-calculate area matching patterns
    const areaMatchPatterns = queryAreaLower ? [queryAreaLower, queryAreaLower.replace(/[_-]/g, ' ')] : [];

    // Batch calculate document title embeddings for cache misses
    await this._batchCalculateDocumentTitleEmbeddings(filteredResults);

    // True parallel processing with pre-computed values
    const rerankingPromises = filteredResults.map(async (result) => {
      let chunkInitialScore = result.similarity * WEIGHT_INITIAL_SIM;
      let contextMatchBonus = 0;
      let titleRelevanceBonus = 0;
      let genericDocPenalty = 0;
      let pathSimilarityScore = 0;

      const docTitle = result.document_title;
      const contentLower = result.content.toLowerCase();

      // Vectorized context matching with pre-computed patterns
      if (queryArea !== 'Unknown' && queryArea !== 'General') {
        const areaMatch = areaMatchPatterns.some((pattern) => contentLower.includes(pattern));

        if (areaMatch) {
          contextMatchBonus += HEAVY_BOOST_SAME_AREA;

          // Vectorized technology matching
          if (queryTechLower.length > 0) {
            const techMatch = queryTechLower.some((tech) => contentLower.includes(tech));
            if (techMatch) {
              contextMatchBonus += MODERATE_BOOST_TECH_MATCH;
            }
          }
        } else if (queryArea !== 'GeneralJS_TS') {
          contextMatchBonus += HEAVY_PENALTY_AREA_MISMATCH;
        }
      }

      // Vectorized keyword matching
      if (queryKeywordsLower.length > 0) {
        const matchingKeywords = queryKeywordsLower.filter((keyword) => contentLower.includes(keyword));
        const keywordMatchRatio = matchingKeywords.length / queryKeywordsLower.length;
        contextMatchBonus += keywordMatchRatio * 0.1;
      }

      // Cached title relevance calculation
      if (docTitle && queryEmbedding) {
        const titleEmb = this.h1EmbeddingCache.get(docTitle);
        if (titleEmb) {
          titleRelevanceBonus = calculateCosineSimilarity(queryEmbedding, titleEmb) * WEIGHT_DOCUMENT_TITLE_MATCH;
        }
      }

      // Optimized generic document penalty calculation
      const contentLength = result.content.length;
      if (contentLength > 2000 && queryKeywordsLower.length > 0) {
        const matchingKeywords = queryKeywordsLower.filter((kw) => contentLower.includes(kw));
        const specificityScore = matchingKeywords.length / queryKeywordsLower.length;

        if (specificityScore < 0.3) {
          genericDocPenalty = PENALTY_GENERIC_DOC_LOW_CONTEXT_MATCH;
        }
      }

      // Cached path similarity calculation
      if (queryFilePath && result.document_title) {
        const pathSim = calculatePathSimilarity(queryFilePath, result.document_title);
        pathSimilarityScore = pathSim * 0.1;
      }

      const finalScore = chunkInitialScore + contextMatchBonus + titleRelevanceBonus + pathSimilarityScore + genericDocPenalty;
      result.similarity = Math.max(0, Math.min(1, finalScore));
      result.reranked = true;

      return result;
    });

    // Wait for all reranking calculations to complete in parallel
    await Promise.all(rerankingPromises);

    console.log(chalk.cyan(`Parallel reranking completed for ${filteredResults.length} chunks`));

    // Log debug info for first few results
    for (let i = 0; i < Math.min(3, filteredResults.length); i++) {
      const result = filteredResults[i];
      debug(`[CustomDocRerank] ${result.document_title?.substring(0, 30)}... Final=${result.similarity.toFixed(4)}`);
    }

    debug('Optimized parallel contextual reranking of custom document chunks complete.');
  }

  /**
   * Batch calculate document title embeddings for performance
   * @private
   */
  async _batchCalculateDocumentTitleEmbeddings(results) {
    const uniqueDocTitles = new Set();
    const docTitlesToCalculate = [];

    for (const result of results) {
      const docTitle = result.document_title;
      if (docTitle && !uniqueDocTitles.has(docTitle)) {
        uniqueDocTitles.add(docTitle);
        if (!this.h1EmbeddingCache.has(docTitle)) {
          docTitlesToCalculate.push(docTitle);
        }
      }
    }

    // Batch calculate document title embeddings for cache misses
    if (docTitlesToCalculate.length > 0) {
      debug(`[OPTIMIZATION] Batch calculating ${docTitlesToCalculate.length} custom document title embeddings`);
      try {
        const titleEmbeddings = await this.modelManager.calculateEmbeddingBatch(docTitlesToCalculate);
        for (let i = 0; i < docTitlesToCalculate.length; i++) {
          if (titleEmbeddings[i]) {
            this.h1EmbeddingCache.set(docTitlesToCalculate[i], titleEmbeddings[i]);
          }
        }
      } catch (error) {
        debug(`[OPTIMIZATION] Error in batch title embedding calculation: ${error.message}`);
        // Continue without title embeddings
      }
    }
  }

  /**
   * Clear custom document chunks for a project
   * @param {string} projectPath - Project path
   */
  async clearProjectChunks(projectPath) {
    try {
      const resolvedProjectPath = path.resolve(projectPath);
      this.customDocumentChunks.delete(resolvedProjectPath);
      await this.cacheManager.clearCustomDocuments(resolvedProjectPath);
      console.log(chalk.green(`Cleared custom document chunks for project: ${resolvedProjectPath}`));
    } catch (error) {
      console.error(chalk.red(`Error clearing project chunks: ${error.message}`));
    }
  }

  /**
   * Get all projects with custom documents
   * @returns {Array} Array of project paths
   */
  getProjectsWithCustomDocuments() {
    return Array.from(this.customDocumentChunks.keys());
  }

  /**
   * Get performance metrics
   * @returns {Object} Performance metrics
   */
  getPerformanceMetrics() {
    return {
      ...this.performanceMetrics,
      averageProcessingTime:
        this.performanceMetrics.documentsProcessed > 0
          ? this.performanceMetrics.processingTime / this.performanceMetrics.documentsProcessed
          : 0,
      embeddingEfficiency:
        this.performanceMetrics.chunksGenerated > 0
          ? (this.performanceMetrics.embeddingsCalculated / this.performanceMetrics.chunksGenerated) * 100
          : 0,
      cacheSize: this.h1EmbeddingCache.size,
      activeProjects: this.customDocumentChunks.size,
    };
  }

  /**
   * Clear all caches
   */
  clearCaches() {
    this.h1EmbeddingCache.clear();
    this.customDocumentChunks.clear();
    console.log(chalk.green('CustomDocumentProcessor caches cleared'));
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
      this.customDocumentChunks.clear();

      // Reset LOCAL performance metrics
      this.performanceMetrics = {
        documentsProcessed: 0,
        chunksGenerated: 0,
        embeddingsCalculated: 0,
        batchSuccessRate: 0,
        averageChunkSize: 0,
        processingTime: 0,
      };

      console.log(chalk.green('CustomDocumentProcessor cleanup complete'));
    } finally {
      this.cleaningUp = false;
    }
  }
}
