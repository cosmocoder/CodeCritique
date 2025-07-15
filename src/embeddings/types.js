/**
 * Type Definitions for Embeddings System
 *
 * This module provides TypeScript-style interfaces and type definitions
 * for the embeddings system. These help with documentation and development
 * even in a JavaScript environment.
 */

/**
 * @typedef {Object} EmbeddingVector
 * @property {number[]} vector - The embedding vector array
 * @property {number} dimensions - Number of dimensions in the vector
 * @property {string} model - Model used to generate the embedding
 * @property {string} [id] - Optional identifier for the embedding
 */

/**
 * @typedef {Object} SearchResult
 * @property {string} content - The content that was found
 * @property {string} path - File path of the content
 * @property {number} similarity - Similarity score (0-1)
 * @property {string} [language] - Programming language of the content
 * @property {string} [context] - Additional context information
 * @property {number} [line_start] - Starting line number
 * @property {number} [line_end] - Ending line number
 * @property {boolean} [reranked] - Whether the result has been reranked
 * @property {Object} [metadata] - Additional metadata
 */

/**
 * @typedef {Object} SearchOptions
 * @property {number} [limit] - Maximum number of results to return
 * @property {number} [threshold] - Minimum similarity threshold
 * @property {string} [language] - Filter by programming language
 * @property {string} [path] - Filter by file path pattern
 * @property {boolean} [includeMetadata] - Include metadata in results
 * @property {boolean} [rerank] - Whether to rerank results
 * @property {string} [context] - Additional context for search
 */

/**
 * @typedef {Object} DocumentChunk
 * @property {string} content - The text content of the chunk
 * @property {string} document_title - Title of the document
 * @property {string} document_path - Path to the document
 * @property {number} chunk_index - Index of the chunk within the document
 * @property {number[]} embedding - Embedding vector for the chunk
 * @property {string} [h1_title] - H1 title if applicable
 * @property {number[]} [h1_embedding] - H1 embedding if applicable
 * @property {string} [language] - Programming language
 * @property {Object} [metadata] - Additional metadata
 */

/**
 * @typedef {Object} EmbeddingConfig
 * @property {string} modelName - Name of the embedding model
 * @property {number} dimensions - Number of dimensions
 * @property {string} lancedbPath - Path to LanceDB database
 * @property {string} fastembedCacheDir - FastEmbed cache directory
 * @property {number} maxRetries - Maximum number of retries
 * @property {boolean} debug - Enable debug mode
 * @property {number} maxConcurrency - Maximum concurrent operations
 * @property {number} batchSize - Batch size for processing
 */

/**
 * @typedef {Object} CacheMetrics
 * @property {number} hits - Number of cache hits
 * @property {number} misses - Number of cache misses
 * @property {number} size - Current cache size
 * @property {number} maxSize - Maximum cache size
 * @property {number} evictions - Number of evictions
 * @property {number} hitRate - Hit rate percentage
 */

/**
 * @typedef {Object} ProcessingProgress
 * @property {number} totalFiles - Total number of files to process
 * @property {number} processedCount - Number of files processed
 * @property {number} skippedCount - Number of files skipped
 * @property {number} failedCount - Number of files failed
 * @property {number} startTime - Processing start time
 * @property {number} currentTime - Current time
 * @property {number} estimatedTimeRemaining - Estimated time remaining
 * @property {number} percentComplete - Percentage complete
 */

/**
 * @typedef {Object} DatabaseSchema
 * @property {string} tableName - Name of the table
 * @property {Object} fields - Field definitions
 * @property {string[]} indexes - Index definitions
 * @property {string} primaryKey - Primary key field
 */

/**
 * @typedef {Object} BatchProcessingOptions
 * @property {number} batchSize - Size of each batch
 * @property {number} maxConcurrency - Maximum concurrent batches
 * @property {boolean} skipExisting - Skip files that already exist
 * @property {Function} [progressCallback] - Progress callback function
 * @property {Function} [errorCallback] - Error callback function
 */

/**
 * @typedef {Object} QueryEmbeddingOptions
 * @property {string} [context] - Additional context for the query
 * @property {string} [language] - Programming language hint
 * @property {boolean} [normalize] - Whether to normalize the embedding
 * @property {Object} [metadata] - Additional metadata
 */

export {};
