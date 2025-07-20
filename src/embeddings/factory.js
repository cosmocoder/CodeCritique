/**
 * Embeddings System Factory
 *
 * This module provides a factory pattern for creating and wiring together
 * all components of the embeddings system. It implements dependency injection
 * and provides both singleton and instance-based usage patterns.
 *
 * Features:
 * - Dependency injection for all modules
 * - System-wide initialization and cleanup
 * - Configuration management
 * - Environment setup
 * - Module lifecycle management
 */

/**
 * @typedef {import('./types.js').EmbeddingConfig} EmbeddingConfig
 * @typedef {import('./types.js').SearchOptions} SearchOptions
 * @typedef {import('./types.js').SearchResult} SearchResult
 * @typedef {import('./types.js').ProcessingProgress} ProcessingProgress
 */

import chalk from 'chalk';
import { ContentRetriever } from '../content-retrieval.js';
import { CustomDocumentProcessor } from '../custom-documents.js';
import { CacheManager } from './cache-manager.js';
import { EMBEDDING_DIMENSIONS, MODEL_NAME_STRING, MAX_RETRIES, LANCEDB_PATH, FASTEMBED_CACHE_DIR } from './constants.js';
import { DatabaseManager } from './database.js';
import { EmbeddingError } from './errors.js';
import { FileProcessor } from './file-processor.js';
import { ModelManager } from './model-manager.js';

// ============================================================================
// EMBEDDINGS SYSTEM CLASS
// ============================================================================

/**
 * EmbeddingsSystem class that encapsulates all embedding functionality
 * with proper dependency injection and lifecycle management
 */
class EmbeddingsSystem {
  constructor(options = {}) {
    this.options = options;
    this.initialized = false;
    this.initializing = false;
    this.initializationPromise = null;
    this.cleaningUp = false;

    // Initialize core components with dependency injection
    this.cacheManager =
      options.cacheManager ||
      new CacheManager({
        maxCacheSize: options.maxCacheSize || 1000,
        maxEmbeddingCacheSize: options.maxEmbeddingCacheSize || 1000,
      });

    this.databaseManager =
      options.databaseManager ||
      new DatabaseManager({
        dbPath: options.dbPath || LANCEDB_PATH,
        embeddingDimensions: options.embeddingDimensions || EMBEDDING_DIMENSIONS,
      });

    this.modelManager =
      options.modelManager ||
      new ModelManager({
        embeddingDimensions: options.embeddingDimensions || EMBEDDING_DIMENSIONS,
        modelNameString: options.modelNameString || MODEL_NAME_STRING,
        maxRetries: options.maxRetries || MAX_RETRIES,
        cacheDir: options.cacheDir || FASTEMBED_CACHE_DIR,
        cacheManager: this.cacheManager,
      });

    this.fileProcessor =
      options.fileProcessor ||
      new FileProcessor({
        modelManager: this.modelManager,
        databaseManager: this.databaseManager,
        cacheManager: this.cacheManager,
      });

    this.contentRetriever =
      options.contentRetriever ||
      new ContentRetriever({
        modelManager: this.modelManager,
        database: this.databaseManager,
        cacheManager: this.cacheManager,
      });

    this.customDocumentProcessor =
      options.customDocumentProcessor ||
      new CustomDocumentProcessor({
        modelManager: this.modelManager,
        cacheManager: this.cacheManager,
      });

    // Track initialization status
    this.components = {
      cacheManager: this.cacheManager,
      databaseManager: this.databaseManager,
      modelManager: this.modelManager,
      fileProcessor: this.fileProcessor,
      contentRetriever: this.contentRetriever,
      customDocumentProcessor: this.customDocumentProcessor,
    };

    console.log(chalk.green('[EmbeddingsSystem] System created with dependency injection'));
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Initialize the embeddings system
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    if (this.initializing) {
      return this.initializationPromise;
    }

    this.initializing = true;
    this.initializationPromise = this._performInitialization();

    try {
      await this.initializationPromise;
      this.initialized = true;
      this.initializing = false;
      console.log(chalk.green('[EmbeddingsSystem] System initialized successfully'));
    } catch (error) {
      this.initializing = false;
      this.initializationPromise = null;
      throw error;
    }
  }

  /**
   * Perform the actual initialization
   * @private
   */
  async _performInitialization() {
    console.log(chalk.blue('[EmbeddingsSystem] Initializing embeddings system...'));

    try {
      // Initialize database and tables
      await this.databaseManager.initializeTables();

      // Initialize the model
      await this.modelManager.initialize();

      console.log(chalk.green('[EmbeddingsSystem] All components initialized successfully'));
    } catch (error) {
      console.error(chalk.red(`[EmbeddingsSystem] Initialization failed: ${error.message}`));
      throw new EmbeddingError(`System initialization failed: ${error.message}`, 'SYSTEM_INITIALIZATION_FAILED', error);
    }
  }

  /**
   * Check if the system is initialized
   * @returns {boolean}
   */
  isInitialized() {
    return this.initialized;
  }

  // ============================================================================
  // PUBLIC API METHODS
  // ============================================================================

  /**
   * Calculate embedding for text
   * @param {string} text - Text to embed
   * @returns {Promise<import('./types.js').EmbeddingVector|null>}
   */
  async calculateEmbedding(text) {
    await this.initialize();
    return this.modelManager.calculateEmbedding(text);
  }

  /**
   * Calculate query embedding for text
   * @param {string} text - Query text to embed
   * @returns {Promise<import('./types.js').EmbeddingVector|null>}
   */
  async calculateQueryEmbedding(text) {
    await this.initialize();
    return this.modelManager.calculateQueryEmbedding(text);
  }

  /**
   * Find relevant documentation
   * @param {string} queryText - Query text
   * @param {SearchOptions} options - Search options
   * @returns {Promise<SearchResult[]>}
   */
  async findRelevantDocs(queryText, options = {}) {
    await this.initialize();
    return this.contentRetriever.findRelevantDocs(queryText, options);
  }

  /**
   * Find similar code
   * @param {string} queryText - Query text
   * @param {SearchOptions} options - Search options
   * @returns {Promise<SearchResult[]>}
   */
  async findSimilarCode(queryText, options = {}) {
    await this.initialize();
    return this.contentRetriever.findSimilarCode(queryText, options);
  }

  /**
   * Process custom documents in memory
   * @param {import('./types.js').CustomDocument[]} customDocs - Array of custom documents
   * @param {string} projectPath - Project path
   * @returns {Promise<import('./types.js').DocumentChunk[]>}
   */
  async processCustomDocumentsInMemory(customDocs, projectPath) {
    await this.initialize();
    return this.customDocumentProcessor.processDocumentsInMemory(customDocs, projectPath);
  }

  /**
   * Find relevant custom document chunks
   * @param {string} queryText - Query text
   * @param {import('./types.js').DocumentChunk[]} chunks - Document chunks
   * @param {SearchOptions} options - Search options
   * @returns {Promise<SearchResult[]>}
   */
  async findRelevantCustomDocChunks(queryText, chunks = [], options = {}) {
    await this.initialize();
    return this.customDocumentProcessor.findRelevantChunks(queryText, chunks, options);
  }

  /**
   * Get existing custom document chunks
   * @param {string} projectPath - Project path
   * @returns {Promise<import('./types.js').DocumentChunk[]>}
   */
  async getExistingCustomDocumentChunks(projectPath) {
    await this.initialize();
    return this.customDocumentProcessor.getExistingChunks(projectPath);
  }

  /**
   * Process batch embeddings
   * @param {string[]} filePaths - Array of file paths
   * @param {import('./types.js').BatchProcessingOptions} options - Processing options
   * @returns {Promise<ProcessingProgress>}
   */
  async processBatchEmbeddings(filePaths, options = {}) {
    await this.initialize();
    return this.fileProcessor.processBatchEmbeddings(filePaths, options);
  }

  /**
   * Get project embeddings (compatibility method)
   * @param {string} projectPath - Project path
   * @returns {Object}
   */
  getProjectEmbeddings(projectPath = process.cwd()) {
    // This is a sync method that returns cached data
    return {
      system: this,
      projectPath,
      components: this.components,
      initialized: this.initialized,
      config: this.config,
    };
  }

  /**
   * Clear embeddings for a project
   * For deletion operations, we only need database connection - no need for
   * full system initialization (models, indexes, etc.)
   * @param {string} projectPath - Project path
   * @returns {Promise<boolean>}
   */
  async clearEmbeddings(projectPath = process.cwd()) {
    await this.databaseManager.getDBConnection();
    return this.databaseManager.clearProjectEmbeddings(projectPath);
  }

  /**
   * Clear all embeddings
   * @returns {Promise<boolean>}
   */
  async clearAllEmbeddings() {
    // Only ensure database connection exists, skip full initialization
    await this.databaseManager.getDBConnection();
    return this.databaseManager.clearAllEmbeddings();
  }

  // ============================================================================
  // PR COMMENTS TABLE METHODS
  // ============================================================================

  /**
   * Get PR comments table
   * @returns {Promise<import('@lancedb/lancedb').Table|null>} PR comments table or null on error
   */
  async getPRCommentsTable() {
    await this.initialize();
    return this.databaseManager.getTable(this.databaseManager.prCommentsTable);
  }

  /**
   * Update the vector index for the PR comments table
   * @returns {Promise<void>}
   */
  async updatePRCommentsIndex() {
    await this.initialize();
    return this.databaseManager.updatePRCommentsIndex();
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Get system metrics
   * @returns {Object}
   */
  getSystemMetrics() {
    return {
      initialized: this.initialized,
      initializing: this.initializing,
      config: this.config,
      cacheMetrics: this.cacheManager.getCacheMetrics(),
      contentRetrieverMetrics: this.contentRetriever.getPerformanceMetrics(),
      customDocumentMetrics: this.customDocumentProcessor.getPerformanceMetrics(),
    };
  }

  /**
   * Get system status
   * @returns {Object}
   */
  getSystemStatus() {
    return {
      initialized: this.initialized,
      initializing: this.initializing,
      modelReady: this.modelManager.isInitialized(),
      databaseReady: this.databaseManager.tablesInitialized,
      cacheStatus: this.cacheManager.getCacheStatus(),
    };
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Cleanup system resources
   * @returns {Promise<void>}
   */
  async cleanup() {
    if (this.cleaningUp) {
      return; // Already cleaning up, prevent duplicate calls
    }

    this.cleaningUp = true;

    try {
      console.log(chalk.yellow('[EmbeddingsSystem] Cleaning up system resources...'));

      // Cleanup all components
      await Promise.all([
        this.modelManager.cleanup(),
        this.databaseManager.cleanup(),
        this.fileProcessor.cleanup(),
        this.contentRetriever.cleanup(),
        this.customDocumentProcessor.cleanup(),
        this.cacheManager.cleanup(),
      ]);

      // Reset state
      this.initialized = false;
      this.initializing = false;
      this.initializationPromise = null;

      console.log(chalk.green('[EmbeddingsSystem] System cleanup completed'));
    } catch (error) {
      console.error(chalk.red(`[EmbeddingsSystem] Error during cleanup: ${error.message}`));
      throw error;
    } finally {
      this.cleaningUp = false;
    }
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a new EmbeddingsSystem instance
 * @param {EmbeddingConfig} options - Configuration options
 * @returns {EmbeddingsSystem}
 */
function createEmbeddingsSystem(options = {}) {
  return new EmbeddingsSystem(options);
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

// Create a default singleton instance for backward compatibility
let defaultSystem = null;

/**
 * Get the default singleton EmbeddingsSystem instance
 * @returns {EmbeddingsSystem}
 */
export function getDefaultEmbeddingsSystem() {
  if (!defaultSystem) {
    defaultSystem = createEmbeddingsSystem();
  }
  return defaultSystem;
}
