import { CacheManager } from './cache-manager.js';

describe('CacheManager', () => {
  let cacheManager;

  beforeEach(() => {
    mockConsoleSelective('log', 'warn');
    cacheManager = new CacheManager();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const manager = new CacheManager();
      expect(manager.maxCacheSize).toBe(1000);
      expect(manager.documentContextCache.size).toBe(0);
      expect(manager.stats.hits).toBe(0);
      expect(manager.stats.misses).toBe(0);
    });

    it('should accept custom options', () => {
      const manager = new CacheManager({
        maxCacheSize: 500,
        maxEmbeddingCacheSize: 2000,
      });
      expect(manager.maxCacheSize).toBe(500);
      expect(manager.maxEmbeddingCacheSize).toBe(2000);
    });
  });

  describe('document context cache', () => {
    it('should get and set document context', () => {
      const context = { content: 'test content', metadata: {} };
      cacheManager.setDocumentContext('key1', context);

      const retrieved = cacheManager.getDocumentContext('key1');
      expect(retrieved).toEqual(context);
    });

    it('should return undefined for missing keys', () => {
      const result = cacheManager.getDocumentContext('nonexistent');
      expect(result).toBeUndefined();
    });

    it('should track hits and misses', () => {
      cacheManager.setDocumentContext('key', 'value');

      cacheManager.getDocumentContext('key'); // Hit
      cacheManager.getDocumentContext('key'); // Hit
      cacheManager.getDocumentContext('missing'); // Miss

      expect(cacheManager.stats.hits).toBe(2);
      expect(cacheManager.stats.misses).toBe(1);
    });
  });

  describe('document context promise cache', () => {
    it('should get and set promises', () => {
      const promise = Promise.resolve('result');
      cacheManager.setDocumentContextPromise('key', promise);

      expect(cacheManager.getDocumentContextPromise('key')).toBe(promise);
    });

    it('should remove promises', () => {
      cacheManager.setDocumentContextPromise('key', Promise.resolve());
      cacheManager.removeDocumentContextPromise('key');

      expect(cacheManager.getDocumentContextPromise('key')).toBeUndefined();
    });
  });

  describe('H1 embedding cache', () => {
    it('should get and set H1 embeddings', () => {
      const embedding = createMockEmbedding();
      cacheManager.setH1Embedding('doc:heading', embedding);

      expect(cacheManager.getH1Embedding('doc:heading')).toEqual(embedding);
    });

    it('should return undefined for missing H1 embeddings', () => {
      expect(cacheManager.getH1Embedding('missing')).toBeUndefined();
    });
  });

  describe('general embedding cache', () => {
    it('should get and set embeddings', () => {
      const embedding = createMockEmbedding();
      cacheManager.setEmbedding('text:hash', embedding);

      expect(cacheManager.getEmbedding('text:hash')).toEqual(embedding);
    });

    it('should return undefined for missing embeddings', () => {
      expect(cacheManager.getEmbedding('missing')).toBeUndefined();
    });
  });

  describe('custom document chunks cache', () => {
    it('should get and set custom document chunks', () => {
      const chunks = [
        { id: '1', content: 'chunk 1' },
        { id: '2', content: 'chunk 2' },
      ];
      cacheManager.setCustomDocumentChunks('/project/path', chunks);

      expect(cacheManager.getCustomDocumentChunks('/project/path')).toEqual(chunks);
    });

    it('should store custom documents via async method', async () => {
      const chunks = [{ id: '1', content: 'async chunk' }];
      await cacheManager.storeCustomDocuments('/project', chunks);

      expect(cacheManager.getCustomDocumentChunks('/project')).toEqual(chunks);
    });
  });

  describe('cache eviction', () => {
    it('should evict oldest entries when max size is reached', () => {
      const smallManager = new CacheManager({ maxCacheSize: 3 });

      smallManager.setDocumentContext('key1', 'value1');
      smallManager.setDocumentContext('key2', 'value2');
      smallManager.setDocumentContext('key3', 'value3');
      smallManager.setDocumentContext('key4', 'value4'); // Should evict key1

      expect(smallManager.getDocumentContext('key1')).toBeUndefined();
      expect(smallManager.getDocumentContext('key4')).toBe('value4');
    });

    it('should track evictions in stats', () => {
      const smallManager = new CacheManager({ maxCacheSize: 2 });

      smallManager.setDocumentContext('key1', 'value1');
      smallManager.setDocumentContext('key2', 'value2');
      smallManager.setDocumentContext('key3', 'value3'); // Evicts key1

      expect(smallManager.stats.evictions).toBe(1);
    });

    it('should use separate limits for embedding cache', () => {
      const manager = new CacheManager({
        maxCacheSize: 2,
        maxEmbeddingCacheSize: 3,
      });

      // Add 3 embeddings (within embedding limit)
      manager.setEmbedding('e1', [1]);
      manager.setEmbedding('e2', [2]);
      manager.setEmbedding('e3', [3]);

      // All should still exist
      expect(manager.getEmbedding('e1')).toEqual([1]);

      // Add 3 document contexts (should evict)
      manager.setDocumentContext('d1', 'v1');
      manager.setDocumentContext('d2', 'v2');
      manager.setDocumentContext('d3', 'v3'); // Evicts d1

      expect(manager.getDocumentContext('d1')).toBeUndefined();
    });
  });

  describe('clearAllCaches', () => {
    it('should clear all caches', () => {
      cacheManager.setDocumentContext('key', 'value');
      cacheManager.setDocumentContextPromise('key', Promise.resolve());
      cacheManager.setH1Embedding('key', [1, 2, 3]);
      cacheManager.setEmbedding('key', [1, 2, 3]);
      cacheManager.setCustomDocumentChunks('key', []);

      cacheManager.clearAllCaches();

      expect(cacheManager.documentContextCache.size).toBe(0);
      expect(cacheManager.documentContextPromiseCache.size).toBe(0);
      expect(cacheManager.h1EmbeddingCache.size).toBe(0);
      expect(cacheManager.embeddingCache.size).toBe(0);
      expect(cacheManager.customDocumentChunks.size).toBe(0);
    });

    it('should reset stats', () => {
      cacheManager.setDocumentContext('key', 'value');
      cacheManager.getDocumentContext('key'); // Hit
      cacheManager.getDocumentContext('missing'); // Miss

      cacheManager.clearAllCaches();

      expect(cacheManager.stats.hits).toBe(0);
      expect(cacheManager.stats.misses).toBe(0);
      expect(cacheManager.stats.evictions).toBe(0);
    });
  });

  describe('clearCache', () => {
    it('should clear specific cache type', () => {
      cacheManager.setDocumentContext('key', 'value');
      cacheManager.setEmbedding('key', [1, 2, 3]);

      cacheManager.clearCache('documentContext');

      expect(cacheManager.documentContextCache.size).toBe(0);
      expect(cacheManager.embeddingCache.size).toBe(1); // Not cleared
    });

    it('should warn for unknown cache type', () => {
      cacheManager.clearCache('unknownCache');
      expect(console.warn).toHaveBeenCalled();
    });

    it('should handle all cache types', () => {
      const cacheTypes = ['documentContext', 'documentContextPromise', 'h1Embedding', 'embedding', 'customDocumentChunks'];

      // Clearing each cache type should not throw
      cacheTypes.forEach((type) => {
        expect(() => cacheManager.clearCache(type)).not.toThrow();
      });
    });
  });

  describe('getCacheMetrics', () => {
    it('should return cache sizes', () => {
      cacheManager.setDocumentContext('d1', 'v1');
      cacheManager.setDocumentContext('d2', 'v2');
      cacheManager.setEmbedding('e1', [1]);

      const metrics = cacheManager.getCacheMetrics();

      expect(metrics.sizes.documentContext).toBe(2);
      expect(metrics.sizes.embedding).toBe(1);
    });

    it('should return limits', () => {
      const metrics = cacheManager.getCacheMetrics();

      expect(metrics.limits.maxCacheSize).toBe(1000);
      expect(metrics.limits.maxEmbeddingCacheSize).toBeGreaterThan(0);
    });

    it('should calculate hit rate', () => {
      cacheManager.setDocumentContext('key', 'value');
      cacheManager.getDocumentContext('key'); // Hit
      cacheManager.getDocumentContext('key'); // Hit
      cacheManager.getDocumentContext('missing'); // Miss
      cacheManager.getDocumentContext('missing2'); // Miss

      const metrics = cacheManager.getCacheMetrics();

      expect(metrics.statistics.hits).toBe(2);
      expect(metrics.statistics.misses).toBe(2);
      expect(metrics.statistics.hitRate).toBe('50.00%');
    });

    it('should handle zero hits and misses', () => {
      const metrics = cacheManager.getCacheMetrics();
      // Hit rate is returned as a percentage string
      expect(metrics.statistics.hitRate).toBe('0%');
    });

    it('should include uptime', () => {
      const metrics = cacheManager.getCacheMetrics();
      expect(metrics.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getCacheStatus', () => {
    it('should return summary status', () => {
      cacheManager.setDocumentContext('key', 'value');

      const status = cacheManager.getCacheStatus();

      expect(status.totalCachedItems).toBe(1);
      expect(status.memoryEfficiency).toBe('active');
      expect(status.uptime).toContain('s');
    });

    it('should show idle when no items cached', () => {
      const status = cacheManager.getCacheStatus();
      expect(status.memoryEfficiency).toBe('idle');
    });
  });

  describe('cleanup', () => {
    it('should clear all caches on cleanup', async () => {
      cacheManager.setDocumentContext('key', 'value');
      cacheManager.setEmbedding('key', [1, 2, 3]);

      await cacheManager.cleanup();

      expect(cacheManager.documentContextCache.size).toBe(0);
      expect(cacheManager.embeddingCache.size).toBe(0);
    });

    it('should prevent duplicate cleanup calls', async () => {
      cacheManager.setDocumentContext('key', 'value');

      // Simulate overlapping cleanup calls
      cacheManager.cleaningUp = true;
      await cacheManager.cleanup();

      // Cache should not be cleared because cleaningUp was true
      // (the real cleanup logic is skipped)
      expect(cacheManager.documentContextCache.size).toBe(1);
    });

    it('should reset cleaningUp flag after completion', async () => {
      await cacheManager.cleanup();
      expect(cacheManager.cleaningUp).toBe(false);
    });
  });
});
