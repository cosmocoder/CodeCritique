import { CustomDocumentProcessor } from './custom-documents.js';

vi.mock('./embeddings/model-manager.js', () => ({
  ModelManager: class {
    calculateQueryEmbedding = vi.fn().mockResolvedValue(createMockEmbedding());
    calculateEmbedding = vi.fn().mockResolvedValue(createMockEmbedding());
    calculateEmbeddingBatch = vi.fn().mockResolvedValue([createMockEmbedding(), createMockEmbedding()]);
  },
}));

vi.mock('./embeddings/cache-manager.js', () => ({
  CacheManager: class {
    storeCustomDocuments = vi.fn().mockResolvedValue(undefined);
    getCustomDocuments = vi.fn().mockResolvedValue([]);
    clearCustomDocuments = vi.fn().mockResolvedValue(undefined);
  },
}));

describe('CustomDocumentProcessor', () => {
  let processor;
  let mockModelManager;
  let mockCacheManager;

  beforeEach(() => {
    mockConsoleSelective('log', 'error');

    mockModelManager = {
      calculateQueryEmbedding: vi.fn().mockResolvedValue(createMockEmbedding()),
      calculateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding()),
      calculateEmbeddingBatch: vi.fn().mockResolvedValue([createMockEmbedding()]),
    };

    mockCacheManager = {
      storeCustomDocuments: vi.fn().mockResolvedValue(undefined),
      getCustomDocuments: vi.fn().mockResolvedValue([]),
      clearCustomDocuments: vi.fn().mockResolvedValue(undefined),
    };

    processor = new CustomDocumentProcessor({
      modelManager: mockModelManager,
      cacheManager: mockCacheManager,
    });
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const p = new CustomDocumentProcessor();
      expect(p.customDocumentChunks).toBeInstanceOf(Map);
      expect(p.h1EmbeddingCache).toBeInstanceOf(Map);
      expect(p.performanceMetrics.documentsProcessed).toBe(0);
    });

    it('should accept custom dependencies', () => {
      const p = new CustomDocumentProcessor({
        modelManager: mockModelManager,
        cacheManager: mockCacheManager,
      });
      expect(p.modelManager).toBe(mockModelManager);
      expect(p.cacheManager).toBe(mockCacheManager);
    });
  });

  describe('chunkDocument', () => {
    it('should chunk document content by paragraphs', () => {
      const doc = {
        title: 'Test Document',
        content: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
      };

      const chunks = processor.chunkDocument(doc);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].document_title).toBe('Test Document');
    });

    it('should extract document title from markdown header', () => {
      const doc = {
        title: 'instruction:./README.md',
        content: '# Real Document Title\n\nSome content here.',
      };

      const chunks = processor.chunkDocument(doc);

      expect(chunks[0].document_title).toBe('Real Document Title');
    });

    it('should extract title from filename if no header', () => {
      const doc = {
        title: 'instruction:./engineering_guidelines.md',
        content: 'Content without header.',
      };

      const chunks = processor.chunkDocument(doc);

      expect(chunks[0].document_title).toBe('Engineering Guidelines');
    });

    it('should split large content into multiple chunks', () => {
      const largeContent = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(100)}`).join('\n\n');

      const doc = {
        title: 'Large Document',
        content: largeContent,
      };

      const chunks = processor.chunkDocument(doc);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should set chunk metadata correctly', () => {
      const doc = {
        title: 'Test Doc',
        content: 'First paragraph.\n\nSecond paragraph.',
      };

      const chunks = processor.chunkDocument(doc);

      expect(chunks[0].metadata.section_start).toBe(true);
      expect(chunks[0].metadata.total_chunks).toBe(chunks.length);
      expect(chunks[0].metadata.chunk_hash).toBeDefined();
    });

    it('should generate unique chunk IDs', () => {
      const doc = {
        title: 'Test',
        content: 'Para 1.\n\nPara 2.\n\nPara 3.',
      };

      const chunks = processor.chunkDocument(doc);
      const ids = chunks.map((c) => c.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should throw error for document without content', () => {
      expect(() => processor.chunkDocument({ title: 'Empty' })).toThrow();
      expect(() => processor.chunkDocument({ title: 'Empty', content: '' })).toThrow();
    });

    it('should update performance metrics', () => {
      const doc = {
        title: 'Test',
        content: 'Some content here.',
      };

      processor.chunkDocument(doc);

      expect(processor.performanceMetrics.chunksGenerated).toBeGreaterThan(0);
    });
  });

  describe('processDocumentsInMemory', () => {
    it('should return empty array for empty input', async () => {
      const result = await processor.processDocumentsInMemory([], '/project');
      expect(result).toEqual([]);
    });

    it('should return empty array for null input', async () => {
      const result = await processor.processDocumentsInMemory(null, '/project');
      expect(result).toEqual([]);
    });

    it('should process documents and generate embeddings', async () => {
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding()]);

      const docs = [{ title: 'Doc 1', content: 'Content for doc 1.' }];

      const result = await processor.processDocumentsInMemory(docs, '/project');

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].embedding).toBeDefined();
      expect(result[0].type).toBe('custom-document-chunk');
    });

    it('should store chunks in memory by project path', async () => {
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding()]);

      const docs = [{ title: 'Doc', content: 'Content.' }];
      await processor.processDocumentsInMemory(docs, '/project');

      const storedChunks = processor.customDocumentChunks.get('/project');
      expect(storedChunks).toBeDefined();
    });

    it('should cache chunks in CacheManager', async () => {
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding()]);

      const docs = [{ title: 'Doc', content: 'Content.' }];
      await processor.processDocumentsInMemory(docs, '/project');

      expect(mockCacheManager.storeCustomDocuments).toHaveBeenCalled();
    });

    it('should fall back to individual processing on batch failure', async () => {
      mockModelManager.calculateEmbeddingBatch.mockRejectedValue(new Error('Batch failed'));
      mockModelManager.calculateEmbedding.mockResolvedValue(createMockEmbedding());

      const docs = [{ title: 'Doc', content: 'Content.' }];
      const result = await processor.processDocumentsInMemory(docs, '/project');

      expect(mockModelManager.calculateEmbedding).toHaveBeenCalled();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should update performance metrics', async () => {
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding()]);

      const docs = [{ title: 'Doc', content: 'Content.' }];
      await processor.processDocumentsInMemory(docs, '/project');

      expect(processor.performanceMetrics.documentsProcessed).toBe(1);
      expect(processor.performanceMetrics.embeddingsCalculated).toBeGreaterThan(0);
    });
  });

  describe('findRelevantChunks', () => {
    let mockChunks;

    beforeEach(() => {
      mockChunks = [
        {
          id: 'chunk1',
          content: 'Content about React components',
          document_title: 'React Guide',
          embedding: createMockEmbedding(),
        },
        {
          id: 'chunk2',
          content: 'Content about testing',
          document_title: 'Testing Guide',
          embedding: createMockEmbedding(),
        },
      ];
    });

    it('should throw error for empty query', async () => {
      await expect(processor.findRelevantChunks('', mockChunks)).rejects.toThrow();
    });

    it('should return empty array for no chunks', async () => {
      const result = await processor.findRelevantChunks('query', []);
      expect(result).toEqual([]);
    });

    it('should calculate similarity and return results', async () => {
      const result = await processor.findRelevantChunks('React', mockChunks, {
        similarityThreshold: 0,
      });

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].similarity).toBeDefined();
    });

    it('should filter by similarity threshold', async () => {
      const result = await processor.findRelevantChunks('query', mockChunks, {
        similarityThreshold: 0.99,
      });

      // High threshold should filter out most results
      expect(result.length).toBeLessThanOrEqual(mockChunks.length);
    });

    it('should limit results', async () => {
      const result = await processor.findRelevantChunks('query', mockChunks, {
        limit: 1,
        similarityThreshold: 0,
      });

      expect(result.length).toBeLessThanOrEqual(1);
    });

    it('should use precomputed query embedding', async () => {
      const precomputed = createMockEmbedding();

      await processor.findRelevantChunks('query', mockChunks, {
        precomputedQueryEmbedding: precomputed,
        similarityThreshold: 0,
      });

      expect(mockModelManager.calculateQueryEmbedding).not.toHaveBeenCalled();
    });

    it('should apply reranking when enabled', async () => {
      const result = await processor.findRelevantChunks('React components', mockChunks, {
        useReranking: true,
        queryContextForReranking: {
          area: 'Frontend',
          dominantTech: ['React'],
          keywords: ['component'],
        },
        similarityThreshold: 0,
      });

      expect(result.some((r) => r.reranked)).toBe(true);
    });

    it('should sort results by similarity', async () => {
      const result = await processor.findRelevantChunks('query', mockChunks, {
        similarityThreshold: 0,
      });

      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].similarity).toBeGreaterThanOrEqual(result[i].similarity);
      }
    });
  });

  describe('getExistingChunks', () => {
    it('should return chunks from memory', async () => {
      const chunks = [{ id: 'chunk1', content: 'test' }];
      processor.customDocumentChunks.set('/project', chunks);

      const result = await processor.getExistingChunks('/project');

      expect(result).toEqual(chunks);
    });

    it('should return chunks from cache if not in memory', async () => {
      const cachedChunks = [{ id: 'cached', content: 'from cache' }];
      mockCacheManager.getCustomDocuments.mockResolvedValue(cachedChunks);

      const result = await processor.getExistingChunks('/project');

      expect(result).toEqual(cachedChunks);
    });

    it('should restore cached chunks to memory', async () => {
      const cachedChunks = [{ id: 'cached', content: 'from cache' }];
      mockCacheManager.getCustomDocuments.mockResolvedValue(cachedChunks);

      await processor.getExistingChunks('/project');

      expect(processor.customDocumentChunks.get('/project')).toEqual(cachedChunks);
    });

    it('should return empty array when no chunks exist', async () => {
      mockCacheManager.getCustomDocuments.mockResolvedValue([]);

      const result = await processor.getExistingChunks('/project');

      expect(result).toEqual([]);
    });
  });

  describe('clearProjectChunks', () => {
    it('should clear chunks from memory', async () => {
      processor.customDocumentChunks.set('/project', [{ id: 'chunk' }]);

      await processor.clearProjectChunks('/project');

      expect(processor.customDocumentChunks.has('/project')).toBe(false);
    });

    it('should clear chunks from cache', async () => {
      await processor.clearProjectChunks('/project');

      expect(mockCacheManager.clearCustomDocuments).toHaveBeenCalled();
    });
  });

  describe('getProjectsWithCustomDocuments', () => {
    it('should return list of project paths', () => {
      processor.customDocumentChunks.set('/project1', []);
      processor.customDocumentChunks.set('/project2', []);

      const projects = processor.getProjectsWithCustomDocuments();

      expect(projects).toContain('/project1');
      expect(projects).toContain('/project2');
    });

    it('should return empty array when no projects', () => {
      const projects = processor.getProjectsWithCustomDocuments();
      expect(projects).toEqual([]);
    });
  });

  describe('getPerformanceMetrics', () => {
    it('should return performance metrics', () => {
      const metrics = processor.getPerformanceMetrics();

      expect(metrics).toHaveProperty('documentsProcessed');
      expect(metrics).toHaveProperty('chunksGenerated');
      expect(metrics).toHaveProperty('embeddingsCalculated');
      expect(metrics).toHaveProperty('batchSuccessRate');
      expect(metrics).toHaveProperty('cacheSize');
      expect(metrics).toHaveProperty('activeProjects');
    });

    it('should calculate averages correctly', () => {
      processor.performanceMetrics.documentsProcessed = 10;
      processor.performanceMetrics.processingTime = 1000;

      const metrics = processor.getPerformanceMetrics();

      expect(metrics.averageProcessingTime).toBe(100);
    });
  });

  describe('clearCaches', () => {
    it('should clear all caches', () => {
      processor.h1EmbeddingCache.set('key', 'value');
      processor.customDocumentChunks.set('/project', []);

      processor.clearCaches();

      expect(processor.h1EmbeddingCache.size).toBe(0);
      expect(processor.customDocumentChunks.size).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should clear caches and reset metrics', async () => {
      processor.h1EmbeddingCache.set('key', 'value');
      processor.performanceMetrics.documentsProcessed = 10;

      await processor.cleanup();

      expect(processor.h1EmbeddingCache.size).toBe(0);
      expect(processor.performanceMetrics.documentsProcessed).toBe(0);
    });

    it('should prevent duplicate cleanup calls', async () => {
      processor.cleaningUp = true;
      processor.h1EmbeddingCache.set('key', 'value');

      await processor.cleanup();

      // Should not clear when already cleaning up
      expect(processor.h1EmbeddingCache.size).toBe(1);
    });

    it('should reset cleaningUp flag', async () => {
      await processor.cleanup();
      expect(processor.cleaningUp).toBe(false);
    });
  });
});
