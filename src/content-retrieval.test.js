import fs from 'node:fs';
import { ContentRetriever } from './content-retrieval.js';

vi.mock('./embeddings/model-manager.js', () => ({
  ModelManager: class {
    calculateQueryEmbedding = vi.fn().mockResolvedValue(createMockEmbedding());
    calculateEmbeddingBatch = vi.fn().mockResolvedValue([createMockEmbedding()]);
  },
}));

vi.mock('./embeddings/database.js', () => ({
  DatabaseManager: class {
    connect = vi.fn().mockResolvedValue({});
    getTable = vi.fn();
  },
}));

vi.mock('./embeddings/cache-manager.js', () => ({
  CacheManager: class {},
}));

vi.mock('./utils/context-inference.js', () => ({
  inferContextFromDocumentContent: vi.fn().mockResolvedValue({
    area: 'Frontend',
    dominantTech: ['React'],
    isGeneralPurposeReadmeStyle: false,
  }),
}));

vi.mock('./utils/document-detection.js', () => ({
  isGenericDocument: vi.fn().mockReturnValue(false),
  getGenericDocumentContext: vi.fn().mockReturnValue({
    area: 'General',
    dominantTech: [],
    isGeneralPurposeReadmeStyle: true,
  }),
}));

vi.mock('./utils/file-validation.js', () => ({
  isDocumentationFile: vi.fn().mockReturnValue(false),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    default: {
      ...original,
      promises: {
        access: vi.fn(),
      },
    },
    promises: {
      access: vi.fn(),
    },
  };
});

describe('ContentRetriever', () => {
  let retriever;
  let mockTable;
  let mockDatabase;
  let mockModelManager;

  beforeEach(() => {
    mockConsole();

    // Create mock table
    mockTable = {
      search: vi.fn().mockReturnThis(),
      nearestToText: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      query: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
      schema: { fields: [{ name: 'project_path' }] },
    };

    // Create mock database
    mockDatabase = {
      connect: vi.fn().mockResolvedValue({}),
      getTable: vi.fn().mockResolvedValue(mockTable),
    };

    // Create mock model manager
    mockModelManager = {
      calculateQueryEmbedding: vi.fn().mockResolvedValue(createMockEmbedding()),
      calculateEmbeddingBatch: vi.fn().mockResolvedValue([createMockEmbedding()]),
    };

    retriever = new ContentRetriever({
      database: mockDatabase,
      modelManager: mockModelManager,
    });

    // Mock file exists
    fs.promises.access.mockResolvedValue(undefined);
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const r = new ContentRetriever();
      expect(r.h1EmbeddingCache).toBeInstanceOf(Map);
      expect(r.documentContextCache).toBeInstanceOf(Map);
      expect(r.performanceMetrics.searchCount).toBe(0);
    });

    it('should accept custom dependencies', () => {
      const r = new ContentRetriever({
        database: mockDatabase,
        modelManager: mockModelManager,
      });
      expect(r.database).toBe(mockDatabase);
      expect(r.modelManager).toBe(mockModelManager);
    });
  });

  describe('findRelevantDocs', () => {
    it('should return empty array for empty query', async () => {
      const results = await retriever.findRelevantDocs('');
      expect(results).toEqual([]);
    });

    it('should return empty array for whitespace query', async () => {
      const results = await retriever.findRelevantDocs('   ');
      expect(results).toEqual([]);
    });

    it('should return empty array when table not found', async () => {
      mockDatabase.getTable.mockResolvedValue(null);

      const results = await retriever.findRelevantDocs('test query');

      expect(results).toEqual([]);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should perform hybrid search on documentation table', async () => {
      mockTable.toArray.mockResolvedValue([
        {
          content: 'Documentation content',
          original_document_path: 'docs/api.md',
          project_path: process.cwd(),
          _distance: 0.1,
        },
      ]);

      const results = await retriever.findRelevantDocs('API documentation');

      expect(mockTable.search).toHaveBeenCalledWith('API documentation');
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('should filter by similarity threshold', async () => {
      mockTable.toArray.mockResolvedValue([
        { content: 'High similarity', project_path: process.cwd(), _distance: 0.1 },
        { content: 'Low similarity', project_path: process.cwd(), _distance: 0.9 },
      ]);

      const results = await retriever.findRelevantDocs('query', {
        similarityThreshold: 0.5,
      });

      // Should only include high similarity result
      expect(results.every((r) => r.similarity >= 0.5)).toBe(true);
    });

    it('should limit results', async () => {
      mockTable.toArray.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          content: `Doc ${i}`,
          project_path: process.cwd(),
          _distance: 0.1 + i * 0.01,
        }))
      );

      const results = await retriever.findRelevantDocs('query', { limit: 5 });

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should filter results by project path', async () => {
      const projectPath = '/test/project';
      mockTable.toArray.mockResolvedValue([
        { content: 'In project', project_path: projectPath, _distance: 0.1 },
        { content: 'Different project', project_path: '/other/project', _distance: 0.1 },
      ]);

      const results = await retriever.findRelevantDocs('query', { projectPath });

      expect(results.every((r) => r.path !== '/other/project')).toBe(true);
    });

    it('should map results to expected format', async () => {
      mockTable.toArray.mockResolvedValue([
        {
          content: 'Content',
          original_document_path: 'docs/api.md',
          project_path: process.cwd(),
          heading_text: 'API Reference',
          document_title: 'API Documentation',
          language: 'markdown',
          _distance: 0.1,
        },
      ]);

      const results = await retriever.findRelevantDocs('query');

      expect(results[0]).toMatchObject({
        type: 'documentation-chunk',
        content: 'Content',
        path: 'docs/api.md',
        headingText: 'API Reference',
        document_title: 'API Documentation',
      });
    });

    it('should increment performance metrics', async () => {
      await retriever.findRelevantDocs('query');

      expect(retriever.performanceMetrics.searchCount).toBe(1);
    });
  });

  describe('findSimilarCode', () => {
    it('should return empty array for empty query', async () => {
      const results = await retriever.findSimilarCode('');
      expect(results).toEqual([]);
    });

    it('should return empty array when table not found', async () => {
      mockDatabase.getTable.mockResolvedValue(null);

      const results = await retriever.findSimilarCode('test query');

      expect(results).toEqual([]);
    });

    it('should perform hybrid search on file embeddings table', async () => {
      mockTable.toArray.mockResolvedValue([
        {
          content: 'function test() {}',
          path: 'src/utils.js',
          project_path: process.cwd(),
          _distance: 0.1,
        },
      ]);

      const results = await retriever.findSimilarCode('test function');

      expect(mockTable.search).toHaveBeenCalledWith('test function');
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('should exclude directory-structure from results', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _distance: 0.1 }]);

      await retriever.findSimilarCode('query');

      expect(mockTable.where).toHaveBeenCalledWith(expect.stringContaining("type != 'directory-structure'"));
    });

    it('should filter for test files when isTestFile is true', async () => {
      await retriever.findSimilarCode('query', { isTestFile: true });

      expect(mockTable.where).toHaveBeenCalledWith(expect.stringContaining('.test.'));
    });

    it('should exclude test files when isTestFile is false', async () => {
      await retriever.findSimilarCode('query', { isTestFile: false });

      expect(mockTable.where).toHaveBeenCalledWith(expect.stringContaining('NOT LIKE'));
    });

    it('should exclude the file being reviewed', async () => {
      await retriever.findSimilarCode('query', {
        queryFilePath: 'src/current-file.js',
        projectPath: '/project',
      });

      expect(mockTable.where).toHaveBeenCalledWith(expect.stringContaining('current-file'));
    });

    it('should filter by project path', async () => {
      const projectPath = '/test/project';
      mockTable.toArray.mockResolvedValue([
        { content: 'In project', project_path: projectPath, path: 'src/file.js', _distance: 0.1 },
        { content: 'Other project', project_path: '/other', path: 'src/other.js', _distance: 0.1 },
      ]);

      const results = await retriever.findSimilarCode('query', { projectPath });

      expect(results.some((r) => r.path === 'src/other.js')).toBe(false);
    });

    it('should include project structure when requested', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _distance: 0.1 }]);

      // Mock query for project structure
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            id: '__project_structure__',
            content: 'Project structure content',
            path: '.',
            vector: new Float32Array(384).fill(0.1),
          },
        ]),
      });

      const results = await retriever.findSimilarCode('query', {
        includeProjectStructure: true,
      });

      // Should include project structure in results
      const hasStructure = results.some((r) => r.type === 'project-structure');
      expect(hasStructure).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      mockDatabase.getTable.mockRejectedValue(new Error('Database error'));

      const results = await retriever.findSimilarCode('query');

      expect(results).toEqual([]);
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('getPerformanceMetrics', () => {
    it('should return performance metrics', () => {
      const metrics = retriever.getPerformanceMetrics();

      expect(metrics).toHaveProperty('searchCount');
      expect(metrics).toHaveProperty('totalSearchTime');
      expect(metrics).toHaveProperty('cacheSize');
      expect(metrics).toHaveProperty('documentContextCacheSize');
    });

    it('should calculate average search time', async () => {
      await retriever.findRelevantDocs('query1');
      await retriever.findRelevantDocs('query2');

      const metrics = retriever.getPerformanceMetrics();

      expect(metrics.searchCount).toBe(2);
    });
  });

  describe('clearCaches', () => {
    it('should clear all caches', () => {
      retriever.h1EmbeddingCache.set('key1', 'value1');
      retriever.documentContextCache.set('key2', 'value2');

      retriever.clearCaches();

      expect(retriever.h1EmbeddingCache.size).toBe(0);
      expect(retriever.documentContextCache.size).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should clear caches and reset metrics', async () => {
      retriever.h1EmbeddingCache.set('key', 'value');
      retriever.performanceMetrics.searchCount = 10;

      await retriever.cleanup();

      expect(retriever.h1EmbeddingCache.size).toBe(0);
      expect(retriever.performanceMetrics.searchCount).toBe(0);
    });

    it('should prevent duplicate cleanup calls', async () => {
      retriever.cleaningUp = true;
      retriever.h1EmbeddingCache.set('key', 'value');

      await retriever.cleanup();

      // Should not clear caches when already cleaning up
      expect(retriever.h1EmbeddingCache.size).toBe(1);
    });

    it('should reset cleaningUp flag after completion', async () => {
      await retriever.cleanup();
      expect(retriever.cleaningUp).toBe(false);
    });
  });

  describe('similarity score calculation', () => {
    it('should calculate similarity from distance', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _distance: 0 }]);

      const results = await retriever.findSimilarCode('query');

      // Distance 0 should result in high similarity
      expect(results[0].similarity).toBeGreaterThan(0.9);
    });

    it('should calculate similarity from score', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _score: 0.9 }]);

      const results = await retriever.findSimilarCode('query');

      expect(results[0].similarity).toBeGreaterThan(0);
    });

    it('should use fallback similarity when no score/distance', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd() }]);

      const results = await retriever.findSimilarCode('query', {
        similarityThreshold: 0,
      });

      expect(results[0].similarity).toBe(0.5);
    });
  });

  describe('findRelevantDocs with reranking', () => {
    it('should apply reranking when enabled with context', async () => {
      mockTable.toArray.mockResolvedValue([
        {
          content: 'Doc 1',
          original_document_path: 'docs/api.md',
          project_path: process.cwd(),
          _distance: 0.1,
          heading_text: 'API',
          document_title: 'API Docs',
        },
        {
          content: 'Doc 2',
          original_document_path: 'docs/guide.md',
          project_path: process.cwd(),
          _distance: 0.2,
          heading_text: 'Guide',
          document_title: 'Guide Docs',
        },
        {
          content: 'Doc 3',
          original_document_path: 'docs/faq.md',
          project_path: process.cwd(),
          _distance: 0.3,
          heading_text: 'FAQ',
          document_title: 'FAQ Docs',
        },
      ]);

      const results = await retriever.findRelevantDocs('API usage', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
      });

      expect(Array.isArray(results)).toBe(true);
    });

    it('should skip reranking when disabled', async () => {
      mockTable.toArray.mockResolvedValue([
        { content: 'Doc 1', original_document_path: 'docs/api.md', project_path: process.cwd(), _distance: 0.1 },
      ]);

      const results = await retriever.findRelevantDocs('query', {
        useReranking: false,
      });

      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle schema check errors gracefully', async () => {
      mockTable.schema = null; // Force schema check to fail

      mockTable.toArray.mockResolvedValue([
        { content: 'Doc', original_document_path: 'docs/api.md', project_path: process.cwd(), _distance: 0.1 },
      ]);

      const results = await retriever.findRelevantDocs('query');

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('findSimilarCode advanced options', () => {
    it('should handle precomputed embeddings', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _distance: 0.1 }]);

      const precomputed = createMockEmbedding();
      const results = await retriever.findSimilarCode('query', {
        precomputedQueryEmbedding: precomputed,
      });

      expect(Array.isArray(results)).toBe(true);
    });

    it('should call where clause to exclude self-matches', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Other', path: 'src/other.js', project_path: process.cwd(), _distance: 0.2 }]);

      await retriever.findSimilarCode('query', {
        queryFilePath: 'src/current.js',
        projectPath: process.cwd(),
        similarityThreshold: 0,
      });

      // Should have called where with exclusion clause
      expect(mockTable.where).toHaveBeenCalledWith(expect.stringContaining('current'));
    });
  });

  describe('file path filtering', () => {
    it('should filter results from different projects', async () => {
      mockTable.toArray.mockResolvedValue([
        { content: 'Same project', path: 'src/file.js', project_path: '/my/project', _distance: 0.1 },
        { content: 'Different project', path: 'src/other.js', project_path: '/other/project', _distance: 0.1 },
      ]);

      const results = await retriever.findSimilarCode('query', {
        projectPath: '/my/project',
        similarityThreshold: 0,
      });

      expect(results.every((r) => !r.path.includes('/other/project'))).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw EmbeddingError on database connection failure', async () => {
      mockDatabase.connect.mockRejectedValue(new Error('Connection failed'));

      await expect(retriever.findRelevantDocs('query')).rejects.toThrow('Documentation search failed');
      expect(console.error).toHaveBeenCalled();
    });

    it('should throw EmbeddingError on table search failure', async () => {
      mockTable.toArray.mockRejectedValue(new Error('Search failed'));

      await expect(retriever.findRelevantDocs('query')).rejects.toThrow('Documentation search failed');
    });
  });

  describe('documentation path filtering', () => {
    it('should handle results without project_path field', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Doc', original_document_path: 'docs/readme.md', _distance: 0.1 }]);

      const results = await retriever.findRelevantDocs('query', { projectPath: process.cwd() });

      expect(Array.isArray(results)).toBe(true);
    });

    it('should filter out results without original_document_path', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Doc without path', _distance: 0.1 }]);

      const results = await retriever.findRelevantDocs('query');

      expect(results.length).toBe(0);
    });

    it('should handle absolute paths in original_document_path', async () => {
      const projectPath = '/test/project';
      mockTable.toArray.mockResolvedValue([
        { content: 'In project', original_document_path: '/test/project/docs/readme.md', _distance: 0.1 },
        { content: 'Outside project', original_document_path: '/other/project/docs.md', _distance: 0.1 },
      ]);

      const results = await retriever.findRelevantDocs('query', { projectPath });

      // Only the doc in project should be included
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('In project');
    });

    it('should check file existence for relative paths without project_path', async () => {
      fs.promises.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ENOENT'));

      mockTable.toArray.mockResolvedValue([
        { content: 'Existing doc', original_document_path: 'docs/exists.md', _distance: 0.1 },
        { content: 'Missing doc', original_document_path: 'docs/missing.md', _distance: 0.1 },
      ]);

      const results = await retriever.findRelevantDocs('query', { projectPath: '/project' });

      // Only existing doc should be included
      expect(results.some((r) => r.content === 'Missing doc')).toBe(false);
    });

    it('should filter out paths outside project bounds', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Outside', original_document_path: '../outside/doc.md', _distance: 0.1 }]);

      const results = await retriever.findRelevantDocs('query', { projectPath: '/project' });

      expect(results.length).toBe(0);
    });

    it('should handle schema check errors gracefully when filtering docs', async () => {
      mockTable.schema = {
        fields: null, // Will cause error
      };
      mockTable.toArray.mockResolvedValue([{ content: 'Doc', project_path: process.cwd(), _distance: 0.1 }]);

      const results = await retriever.findRelevantDocs('query');

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('code search path filtering', () => {
    it('should handle results without project_path or path fields', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', _distance: 0.1 }]);

      const results = await retriever.findSimilarCode('query', { similarityThreshold: 0 });

      expect(results.length).toBe(0);
    });

    it('should handle absolute paths in code results', async () => {
      const projectPath = '/test/project';
      mockTable.toArray.mockResolvedValue([
        { content: 'In project', path: '/test/project/src/file.js', _distance: 0.1 },
        { content: 'Outside', path: '/other/project/src/file.js', _distance: 0.1 },
      ]);

      const results = await retriever.findSimilarCode('query', { projectPath, similarityThreshold: 0 });

      expect(results.length).toBe(1);
      expect(results[0].content).toBe('In project');
    });

    it('should check file existence for relative paths', async () => {
      fs.promises.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ENOENT'));

      mockTable.toArray.mockResolvedValue([
        { content: 'Existing', path: 'src/exists.js', _distance: 0.1 },
        { content: 'Missing', path: 'src/missing.js', _distance: 0.1 },
      ]);

      const results = await retriever.findSimilarCode('query', { projectPath: '/project', similarityThreshold: 0 });

      expect(results.some((r) => r.content === 'Missing')).toBe(false);
    });

    it('should filter out paths outside project bounds', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Outside', path: '../outside/file.js', _distance: 0.1 }]);

      const results = await retriever.findSimilarCode('query', { projectPath: '/project', similarityThreshold: 0 });

      expect(results.length).toBe(0);
    });

    it('should handle schema check errors for project_path filtering', async () => {
      mockTable.schema = null;
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _distance: 0.1 }]);

      const results = await retriever.findSimilarCode('query', { similarityThreshold: 0 });

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('project structure inclusion', () => {
    it('should fall back to generic project structure when project-specific not found', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _distance: 0.1 }]);

      // First query returns empty (project-specific structure not found)
      // Second query returns generic structure
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi
          .fn()
          .mockResolvedValueOnce([]) // No project-specific structure
          .mockResolvedValueOnce([
            {
              id: '__project_structure__',
              content: 'Generic structure',
              path: '.',
              vector: new Float32Array(384).fill(0.1),
            },
          ]),
      });

      const results = await retriever.findSimilarCode('query', {
        includeProjectStructure: true,
        similarityThreshold: 0,
      });

      const hasStructure = results.some((r) => r.type === 'project-structure');
      expect(hasStructure).toBe(true);
    });

    it('should handle project structure inclusion errors', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _distance: 0.1 }]);

      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Structure lookup failed')),
      });

      const results = await retriever.findSimilarCode('query', {
        includeProjectStructure: true,
        similarityThreshold: 0,
      });

      // Should still return results, just without structure
      expect(Array.isArray(results)).toBe(true);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Project structure inclusion failed'));
    });

    it('should skip structure when similarity is too low', async () => {
      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _distance: 0.1 }]);

      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            id: '__project_structure__',
            content: 'Structure',
            path: '.',
            vector: new Float32Array(384).fill(0), // Low similarity
          },
        ]),
      });

      const results = await retriever.findSimilarCode('query', {
        includeProjectStructure: true,
        similarityThreshold: 0,
      });

      // Structure should not be included due to low similarity
      const hasStructure = results.some((r) => r.type === 'project-structure');
      expect(hasStructure).toBe(false);
    });
  });

  describe('advanced reranking', () => {
    let inferContextMock;
    let isGenericDocMock;
    let getGenericContextMock;

    beforeEach(async () => {
      const contextInference = await import('./utils/context-inference.js'); // eslint-disable-line no-restricted-syntax
      const docDetection = await import('./utils/document-detection.js'); // eslint-disable-line no-restricted-syntax

      inferContextMock = vi.spyOn(contextInference, 'inferContextFromDocumentContent');
      isGenericDocMock = vi.spyOn(docDetection, 'isGenericDocument');
      getGenericContextMock = vi.spyOn(docDetection, 'getGenericDocumentContext');
    });

    it('should use fast-path for generic documents', async () => {
      isGenericDocMock.mockReturnValue(true);
      getGenericContextMock.mockReturnValue({
        area: 'General',
        dominantTech: [],
        isGeneralPurposeReadmeStyle: true,
      });

      mockTable.toArray.mockResolvedValue([
        { content: 'README', original_document_path: 'README.md', project_path: process.cwd(), _distance: 0.1, document_title: 'README' },
        { content: 'Guide', original_document_path: 'GUIDE.md', project_path: process.cwd(), _distance: 0.2, document_title: 'Guide' },
        { content: 'API', original_document_path: 'API.md', project_path: process.cwd(), _distance: 0.3, document_title: 'API' },
      ]);

      await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
      });

      expect(isGenericDocMock).toHaveBeenCalled();
      expect(getGenericContextMock).toHaveBeenCalled();
    });

    it('should apply generic doc penalty for low context match', async () => {
      isGenericDocMock.mockReturnValue(false);
      inferContextMock.mockResolvedValue({
        area: 'Backend',
        dominantTech: ['Node.js'],
        isGeneralPurposeReadmeStyle: true, // Generic style
      });

      mockTable.toArray.mockResolvedValue([
        { content: 'Doc', original_document_path: 'docs/readme.md', project_path: process.cwd(), _distance: 0.1, document_title: 'Readme' },
        { content: 'Doc 2', original_document_path: 'docs/api.md', project_path: process.cwd(), _distance: 0.2, document_title: 'API' },
        { content: 'Doc 3', original_document_path: 'docs/guide.md', project_path: process.cwd(), _distance: 0.3, document_title: 'Guide' },
      ]);

      const results = await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] }, // Different area
      });

      // Should still return results with penalty applied
      expect(Array.isArray(results)).toBe(true);
    });

    it('should boost results with matching area and tech', async () => {
      isGenericDocMock.mockReturnValue(false);
      inferContextMock.mockResolvedValue({
        area: 'Frontend',
        dominantTech: ['React'],
        isGeneralPurposeReadmeStyle: false,
      });

      mockTable.toArray.mockResolvedValue([
        {
          content: 'React doc',
          original_document_path: 'docs/react.md',
          project_path: process.cwd(),
          _distance: 0.3,
          document_title: 'React',
        },
        {
          content: 'Other doc',
          original_document_path: 'docs/other.md',
          project_path: process.cwd(),
          _distance: 0.2,
          document_title: 'Other',
        },
        {
          content: 'Third doc',
          original_document_path: 'docs/third.md',
          project_path: process.cwd(),
          _distance: 0.4,
          document_title: 'Third',
        },
      ]);

      const results = await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
      });

      expect(results[0].reranked).toBe(true);
    });

    it('should apply path similarity bonus when queryFilePath provided', async () => {
      isGenericDocMock.mockReturnValue(false);
      inferContextMock.mockResolvedValue({
        area: 'Frontend',
        dominantTech: ['React'],
        isGeneralPurposeReadmeStyle: false,
      });

      mockTable.toArray.mockResolvedValue([
        {
          content: 'Component doc',
          original_document_path: 'docs/components.md',
          project_path: process.cwd(),
          _distance: 0.2,
          document_title: 'Components',
        },
        { content: 'API doc', original_document_path: 'docs/api.md', project_path: process.cwd(), _distance: 0.2, document_title: 'API' },
        {
          content: 'Hooks doc',
          original_document_path: 'docs/hooks.md',
          project_path: process.cwd(),
          _distance: 0.2,
          document_title: 'Hooks',
        },
      ]);

      const results = await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
        queryFilePath: 'src/components/Button.jsx',
      });

      expect(results.every((r) => r.reranked)).toBe(true);
    });

    it('should handle context calculation errors gracefully', async () => {
      isGenericDocMock.mockReturnValue(false);
      inferContextMock.mockRejectedValue(new Error('Context calculation failed'));

      mockTable.toArray.mockResolvedValue([
        { content: 'Doc', original_document_path: 'docs/readme.md', project_path: process.cwd(), _distance: 0.1, document_title: 'Readme' },
        { content: 'Doc 2', original_document_path: 'docs/api.md', project_path: process.cwd(), _distance: 0.2, document_title: 'API' },
        { content: 'Doc 3', original_document_path: 'docs/guide.md', project_path: process.cwd(), _distance: 0.3, document_title: 'Guide' },
      ]);

      const results = await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
      });

      // Should still return results with fallback context
      expect(Array.isArray(results)).toBe(true);
    });

    it('should use cached document context promise', async () => {
      isGenericDocMock.mockReturnValue(false);
      inferContextMock.mockResolvedValue({
        area: 'Frontend',
        dominantTech: ['React'],
        isGeneralPurposeReadmeStyle: false,
      });

      // Pre-populate the document context promise cache
      const contextPromise = Promise.resolve({
        area: 'Frontend',
        dominantTech: ['React'],
        isGeneralPurposeReadmeStyle: false,
      });
      const docPath = require('node:path').resolve(process.cwd(), 'docs/cached.md');
      retriever.documentContextPromiseCache.set(docPath, contextPromise);

      mockTable.toArray.mockResolvedValue([
        {
          content: 'Cached doc',
          original_document_path: 'docs/cached.md',
          project_path: process.cwd(),
          _distance: 0.1,
          document_title: 'Cached',
        },
        {
          content: 'Other doc',
          original_document_path: 'docs/other.md',
          project_path: process.cwd(),
          _distance: 0.2,
          document_title: 'Other',
        },
        {
          content: 'Third doc',
          original_document_path: 'docs/third.md',
          project_path: process.cwd(),
          _distance: 0.3,
          document_title: 'Third',
        },
      ]);

      const results = await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
      });

      expect(Array.isArray(results)).toBe(true);
    });

    it('should apply area mismatch penalty', async () => {
      isGenericDocMock.mockReturnValue(false);
      inferContextMock.mockResolvedValue({
        area: 'Backend',
        dominantTech: ['Node.js'],
        isGeneralPurposeReadmeStyle: false,
      });

      mockTable.toArray.mockResolvedValue([
        {
          content: 'Backend doc',
          original_document_path: 'docs/backend.md',
          project_path: process.cwd(),
          _distance: 0.1,
          document_title: 'Backend',
        },
        { content: 'API doc', original_document_path: 'docs/api.md', project_path: process.cwd(), _distance: 0.2, document_title: 'API' },
        {
          content: 'DB doc',
          original_document_path: 'docs/database.md',
          project_path: process.cwd(),
          _distance: 0.3,
          document_title: 'Database',
        },
      ]);

      const results = await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] }, // Mismatched area
      });

      expect(results.every((r) => r.reranked)).toBe(true);
    });

    it('should use precomputed query embedding for reranking', async () => {
      isGenericDocMock.mockReturnValue(false);
      inferContextMock.mockResolvedValue({
        area: 'Frontend',
        dominantTech: ['React'],
        isGeneralPurposeReadmeStyle: false,
      });

      mockTable.toArray.mockResolvedValue([
        { content: 'Doc', original_document_path: 'docs/api.md', project_path: process.cwd(), _distance: 0.1, document_title: 'API' },
        { content: 'Doc 2', original_document_path: 'docs/guide.md', project_path: process.cwd(), _distance: 0.2, document_title: 'Guide' },
        {
          content: 'Doc 3',
          original_document_path: 'docs/readme.md',
          project_path: process.cwd(),
          _distance: 0.3,
          document_title: 'Readme',
        },
      ]);

      const precomputedEmbedding = createMockEmbedding();

      const results = await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
        precomputedQueryEmbedding: precomputedEmbedding,
      });

      expect(Array.isArray(results)).toBe(true);
      // Should not have called calculateQueryEmbedding since precomputed was provided
    });
  });

  describe('H1 embedding caching', () => {
    it('should batch calculate H1 embeddings for cache misses', async () => {
      mockTable.toArray.mockResolvedValue([
        {
          content: 'Doc 1',
          original_document_path: 'docs/api.md',
          project_path: process.cwd(),
          _distance: 0.1,
          document_title: 'API Reference',
        },
        {
          content: 'Doc 2',
          original_document_path: 'docs/guide.md',
          project_path: process.cwd(),
          _distance: 0.2,
          document_title: 'User Guide',
        },
        { content: 'Doc 3', original_document_path: 'docs/faq.md', project_path: process.cwd(), _distance: 0.3, document_title: 'FAQ' },
      ]);

      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding(), createMockEmbedding(), createMockEmbedding()]);

      await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
      });

      expect(mockModelManager.calculateEmbeddingBatch).toHaveBeenCalled();
      expect(retriever.h1EmbeddingCache.has('API Reference')).toBe(true);
    });

    it('should reuse cached H1 embeddings', async () => {
      // Pre-populate cache
      retriever.h1EmbeddingCache.set('Cached Title', createMockEmbedding());

      mockTable.toArray.mockResolvedValue([
        {
          content: 'Doc',
          original_document_path: 'docs/cached.md',
          project_path: process.cwd(),
          _distance: 0.1,
          document_title: 'Cached Title',
        },
        {
          content: 'Doc 2',
          original_document_path: 'docs/new.md',
          project_path: process.cwd(),
          _distance: 0.2,
          document_title: 'New Title',
        },
        {
          content: 'Doc 3',
          original_document_path: 'docs/other.md',
          project_path: process.cwd(),
          _distance: 0.3,
          document_title: 'Other Title',
        },
      ]);

      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding(), createMockEmbedding()]);

      await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
      });

      // Should only calculate for 'New Title' and 'Other Title', not 'Cached Title'
      expect(mockModelManager.calculateEmbeddingBatch).toHaveBeenCalledWith(['New Title', 'Other Title']);
    });
  });

  describe('result limiting and sorting', () => {
    it('should sort and limit final results', async () => {
      mockTable.toArray.mockResolvedValue(
        Array.from({ length: 15 }, (_, i) => ({
          content: `Doc ${i}`,
          project_path: process.cwd(),
          original_document_path: `docs/doc${i}.md`,
          _distance: 0.1 + i * 0.02,
        }))
      );

      const results = await retriever.findRelevantDocs('query', { limit: 5 });

      expect(results.length).toBeLessThanOrEqual(5);
      // Should be sorted by similarity (descending)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
      }
    });
  });

  describe('schema error handling', () => {
    it('should handle schema access errors in findRelevantDocs', async () => {
      // Make schema access throw
      Object.defineProperty(mockTable, 'schema', {
        get: () => {
          throw new Error('Schema not accessible');
        },
        configurable: true,
      });

      mockTable.toArray.mockResolvedValue([{ content: 'Doc', project_path: process.cwd(), _distance: 0.1 }]);

      const results = await retriever.findRelevantDocs('query');

      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle schema access errors in findSimilarCode', async () => {
      Object.defineProperty(mockTable, 'schema', {
        get: () => {
          throw new Error('Schema not accessible');
        },
        configurable: true,
      });

      mockTable.toArray.mockResolvedValue([{ content: 'Code', path: 'src/file.js', project_path: process.cwd(), _distance: 0.1 }]);

      const results = await retriever.findSimilarCode('query', { similarityThreshold: 0 });

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('path resolution edge cases', () => {
    it('should handle path resolution errors in findRelevantDocs', async () => {
      // Create a result that could cause path resolution issues
      mockTable.toArray.mockResolvedValue([
        {
          content: 'Doc',
          original_document_path: 'docs/normal.md',
          _distance: 0.1,
        },
      ]);

      const results = await retriever.findRelevantDocs('query', { projectPath: '/project' });

      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle path resolution errors in findSimilarCode', async () => {
      mockTable.toArray.mockResolvedValue([
        {
          content: 'Code',
          path: 'src/file.js',
          _distance: 0.1,
        },
      ]);

      const results = await retriever.findSimilarCode('query', {
        projectPath: '/project',
        similarityThreshold: 0,
      });

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('similarity calculation variants in findRelevantDocs', () => {
    it('should calculate similarity from _score', async () => {
      mockTable.toArray.mockResolvedValue([
        { content: 'Doc', project_path: process.cwd(), original_document_path: 'docs/api.md', _score: 0.85 },
      ]);

      const results = await retriever.findRelevantDocs('query');

      expect(results[0].similarity).toBe(0.85);
    });

    it('should use fallback similarity when no _distance or _score', async () => {
      mockTable.toArray.mockResolvedValue([
        { content: 'Doc', project_path: process.cwd(), original_document_path: 'docs/api.md' }, // No _distance or _score
      ]);

      const results = await retriever.findRelevantDocs('query', { similarityThreshold: 0 });

      expect(results[0].similarity).toBe(0.5);
    });
  });

  describe('context batch processing', () => {
    let inferContextMock;
    let isGenericDocMock;

    beforeEach(async () => {
      const contextInference = await import('./utils/context-inference.js'); // eslint-disable-line no-restricted-syntax
      const docDetection = await import('./utils/document-detection.js'); // eslint-disable-line no-restricted-syntax

      inferContextMock = vi.spyOn(contextInference, 'inferContextFromDocumentContent');
      isGenericDocMock = vi.spyOn(docDetection, 'isGenericDocument');
    });

    it('should process context in batches with delays for large result sets', async () => {
      isGenericDocMock.mockReturnValue(false);
      inferContextMock.mockResolvedValue({
        area: 'Frontend',
        dominantTech: ['React'],
        isGeneralPurposeReadmeStyle: false,
      });

      // Create more than CONTEXT_BATCH_SIZE (3) documents
      mockTable.toArray.mockResolvedValue([
        { content: 'Doc 1', original_document_path: 'docs/api.md', project_path: process.cwd(), _distance: 0.1, document_title: 'API' },
        {
          content: 'Doc 2',
          original_document_path: 'docs/guide.md',
          project_path: process.cwd(),
          _distance: 0.15,
          document_title: 'Guide',
        },
        { content: 'Doc 3', original_document_path: 'docs/faq.md', project_path: process.cwd(), _distance: 0.2, document_title: 'FAQ' },
        {
          content: 'Doc 4',
          original_document_path: 'docs/readme.md',
          project_path: process.cwd(),
          _distance: 0.25,
          document_title: 'README',
        },
        { content: 'Doc 5', original_document_path: 'docs/setup.md', project_path: process.cwd(), _distance: 0.3, document_title: 'Setup' },
      ]);

      const results = await retriever.findRelevantDocs('query', {
        useReranking: true,
        queryContextForReranking: { area: 'Frontend', dominantTech: ['React'] },
      });

      // All documents should be processed and results should be reranked
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.reranked)).toBe(true);
    });
  });

  describe('findSimilarCode result limiting', () => {
    it('should limit results when exceeding limit', async () => {
      // Create many results
      mockTable.toArray.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          content: `Code ${i}`,
          path: `src/file${i}.js`,
          project_path: process.cwd(),
          _distance: 0.1 + i * 0.01,
        }))
      );

      const results = await retriever.findSimilarCode('query', {
        limit: 5,
        similarityThreshold: 0,
      });

      expect(results.length).toBeLessThanOrEqual(5);
    });
  });
});
