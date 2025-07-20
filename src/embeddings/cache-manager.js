/**
 * Cache Manager Module
 *
 * This module provides centralized cache management for embeddings,
 * document contexts, and other cached data structures.
 *
 * Features:
 * - Document context caching
 * - H1 embedding caching
 * - General embedding caching with size limits
 * - Custom document chunks caching
 * - Cache metrics and monitoring
 * - Cache eviction policies
 */
/**
 * @typedef {import('./types.js').CacheMetrics} CacheMetrics
 * @typedef {import('./types.js').EmbeddingVector} EmbeddingVector
 * @typedef {import('./types.js').DocumentChunk} DocumentChunk
 */

import chalk from 'chalk';
import { MAX_EMBEDDING_CACHE_SIZE } from './constants.js';

// ============================================================================
// CACHE CONFIGURATION
// ============================================================================

const DEFAULT_MAX_CACHE_SIZE = 1000;
const DEFAULT_MAX_EMBEDDING_CACHE_SIZE = MAX_EMBEDDING_CACHE_SIZE;

// ============================================================================
// CACHE MANAGER CLASS
// ============================================================================

export class CacheManager {
  constructor(options = {}) {
    this.maxCacheSize = options.maxCacheSize || DEFAULT_MAX_CACHE_SIZE;
    this.maxEmbeddingCacheSize = options.maxEmbeddingCacheSize || DEFAULT_MAX_EMBEDDING_CACHE_SIZE;

    // Initialize cache Maps
    this.documentContextCache = new Map();
    this.documentContextPromiseCache = new Map();
    this.h1EmbeddingCache = new Map();
    this.embeddingCache = new Map();
    this.customDocumentChunks = new Map();

    // Cache statistics
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      created: Date.now(),
    };

    // Cleanup guard
    this.cleaningUp = false;
  }

  // ============================================================================
  // DOCUMENT CONTEXT CACHE
  // ============================================================================

  /**
   * Get document context from cache
   * @param {string} key - Cache key
   * @returns {*} Cached document context or undefined
   */
  getDocumentContext(key) {
    if (this.documentContextCache.has(key)) {
      this.stats.hits++;
      return this.documentContextCache.get(key);
    }
    this.stats.misses++;
    return undefined;
  }

  /**
   * Set document context in cache
   * @param {string} key - Cache key
   * @param {*} context - Document context to cache
   */
  setDocumentContext(key, context) {
    this._enforceMaxSize(this.documentContextCache, this.maxCacheSize);
    this.documentContextCache.set(key, context);
  }

  /**
   * Get document context promise from cache
   * @param {string} key - Cache key
   * @returns {Promise|undefined} Cached promise or undefined
   */
  getDocumentContextPromise(key) {
    if (this.documentContextPromiseCache.has(key)) {
      this.stats.hits++;
      return this.documentContextPromiseCache.get(key);
    }
    this.stats.misses++;
    return undefined;
  }

  /**
   * Set document context promise in cache
   * @param {string} key - Cache key
   * @param {Promise} promise - Promise to cache
   */
  setDocumentContextPromise(key, promise) {
    this._enforceMaxSize(this.documentContextPromiseCache, this.maxCacheSize);
    this.documentContextPromiseCache.set(key, promise);
  }

  /**
   * Remove document context promise from cache
   * @param {string} key - Cache key
   */
  removeDocumentContextPromise(key) {
    this.documentContextPromiseCache.delete(key);
  }

  // ============================================================================
  // H1 EMBEDDING CACHE
  // ============================================================================

  /**
   * Get H1 embedding from cache
   * @param {string} key - Cache key
   * @returns {EmbeddingVector|undefined} Cached H1 embedding or undefined
   */
  getH1Embedding(key) {
    if (this.h1EmbeddingCache.has(key)) {
      this.stats.hits++;
      return this.h1EmbeddingCache.get(key);
    }
    this.stats.misses++;
    return undefined;
  }

  /**
   * Set H1 embedding in cache
   * @param {string} key - Cache key
   * @param {EmbeddingVector} embedding - H1 embedding to cache
   */
  setH1Embedding(key, embedding) {
    this._enforceMaxSize(this.h1EmbeddingCache, this.maxCacheSize);
    this.h1EmbeddingCache.set(key, embedding);
  }

  // ============================================================================
  // GENERAL EMBEDDING CACHE
  // ============================================================================

  /**
   * Get embedding from cache
   * @param {string} key - Cache key
   * @returns {EmbeddingVector|undefined} Cached embedding or undefined
   */
  getEmbedding(key) {
    if (this.embeddingCache.has(key)) {
      this.stats.hits++;
      return this.embeddingCache.get(key);
    }
    this.stats.misses++;
    return undefined;
  }

  /**
   * Set embedding in cache
   * @param {string} key - Cache key
   * @param {EmbeddingVector} embedding - Embedding to cache
   */
  setEmbedding(key, embedding) {
    this._enforceMaxSize(this.embeddingCache, this.maxEmbeddingCacheSize);
    this.embeddingCache.set(key, embedding);
  }

  // ============================================================================
  // CUSTOM DOCUMENT CHUNKS CACHE
  // ============================================================================

  /**
   * Get custom document chunks from cache
   * @param {string} projectPath - Project path key
   * @returns {DocumentChunk[]|undefined} Cached chunks or undefined
   */
  getCustomDocumentChunks(projectPath) {
    if (this.customDocumentChunks.has(projectPath)) {
      this.stats.hits++;
      return this.customDocumentChunks.get(projectPath);
    }
    this.stats.misses++;
    return undefined;
  }

  /**
   * Set custom document chunks in cache
   * @param {string} projectPath - Project path key
   * @param {DocumentChunk[]} chunks - Chunks to cache
   */
  setCustomDocumentChunks(projectPath, chunks) {
    this._enforceMaxSize(this.customDocumentChunks, this.maxCacheSize);
    this.customDocumentChunks.set(projectPath, chunks);
  }

  /**
   * Store custom documents (alias for setCustomDocumentChunks)
   * @param {string} projectPath - Project path
   * @param {Array} chunks - Document chunks to store
   */
  async storeCustomDocuments(projectPath, chunks) {
    this.setCustomDocumentChunks(projectPath, chunks);
  }

  // ============================================================================
  // CACHE MANAGEMENT
  // ============================================================================

  /**
   * Clear all caches
   */
  clearAllCaches() {
    const docCacheSize = this.documentContextCache.size;
    const h1CacheSize = this.h1EmbeddingCache.size;
    const embeddingCacheSize = this.embeddingCache.size;
    const promiseCacheSize = this.documentContextPromiseCache.size;
    const customDocCacheSize = this.customDocumentChunks.size;

    this.documentContextCache.clear();
    this.documentContextPromiseCache.clear();
    this.h1EmbeddingCache.clear();
    this.embeddingCache.clear();
    this.customDocumentChunks.clear();

    // Reset stats
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;

    console.log(
      chalk.yellow(
        `[CACHE] Cleared all caches - Document contexts: ${docCacheSize}, Promise: ${promiseCacheSize}, H1 embeddings: ${h1CacheSize}, Embeddings: ${embeddingCacheSize}, Custom docs: ${customDocCacheSize}`
      )
    );
  }

  /**
   * Clear specific cache type
   * @param {string} cacheType - Type of cache to clear
   */
  clearCache(cacheType) {
    const cacheMap = this._getCacheMap(cacheType);
    if (cacheMap) {
      const size = cacheMap.size;
      cacheMap.clear();
      console.log(chalk.yellow(`[CACHE] Cleared ${cacheType} cache - ${size} items`));
    } else {
      console.warn(chalk.yellow(`[CACHE] Unknown cache type: ${cacheType}`));
    }
  }

  /**
   * Get cache metrics
   * @returns {CacheMetrics} Cache metrics object
   */
  getCacheMetrics() {
    const hitRate =
      this.stats.hits + this.stats.misses > 0 ? ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(2) : 0;

    return {
      sizes: {
        documentContext: this.documentContextCache.size,
        documentContextPromise: this.documentContextPromiseCache.size,
        h1Embedding: this.h1EmbeddingCache.size,
        embedding: this.embeddingCache.size,
        customDocumentChunks: this.customDocumentChunks.size,
      },
      limits: {
        maxCacheSize: this.maxCacheSize,
        maxEmbeddingCacheSize: this.maxEmbeddingCacheSize,
      },
      statistics: {
        hits: this.stats.hits,
        misses: this.stats.misses,
        evictions: this.stats.evictions,
        hitRate: `${hitRate}%`,
      },
      uptime: Date.now() - this.stats.created,
    };
  }

  /**
   * Get cache status summary
   * @returns {Object} Cache status summary
   */
  getCacheStatus() {
    const metrics = this.getCacheMetrics();
    const totalSize = Object.values(metrics.sizes).reduce((sum, size) => sum + size, 0);

    return {
      totalCachedItems: totalSize,
      hitRate: metrics.statistics.hitRate,
      memoryEfficiency: totalSize > 0 ? 'active' : 'idle',
      uptime: `${Math.floor(metrics.uptime / 1000)}s`,
    };
  }

  /**
   * Cleanup method for compatibility with factory cleanup pattern
   * @returns {Promise<void>}
   */
  async cleanup() {
    if (this.cleaningUp) {
      return; // Already cleaning up, prevent duplicate calls
    }

    this.cleaningUp = true;

    try {
      this.clearAllCaches();
      console.log(chalk.green('[CACHE] Cache cleanup completed'));
    } finally {
      this.cleaningUp = false;
    }
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Enforce maximum cache size by evicting oldest entries
   * @param {Map} cacheMap - Cache map to enforce size limit on
   * @param {number} maxSize - Maximum allowed size
   * @private
   */
  _enforceMaxSize(cacheMap, maxSize) {
    while (cacheMap.size >= maxSize) {
      const firstKey = cacheMap.keys().next().value;
      cacheMap.delete(firstKey);
      this.stats.evictions++;
    }
  }

  /**
   * Get cache map by type
   * @param {string} cacheType - Cache type
   * @returns {Map|null} Cache map or null if not found
   * @private
   */
  _getCacheMap(cacheType) {
    switch (cacheType) {
      case 'documentContext':
        return this.documentContextCache;
      case 'documentContextPromise':
        return this.documentContextPromiseCache;
      case 'h1Embedding':
        return this.h1EmbeddingCache;
      case 'embedding':
        return this.embeddingCache;
      case 'customDocumentChunks':
        return this.customDocumentChunks;
      default:
        return null;
    }
  }
}
