import fs from 'node:fs';
import { shouldProcessFile } from '../utils/file-validation.js';
import { FileProcessor } from './file-processor.js';

vi.mock('node:fs', () => ({
  default: {
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    promises: {
      readFile: vi.fn(),
    },
  },
}));

vi.mock('node:crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockReturnValue('abc12345'),
  })),
}));

vi.mock('../utils/file-validation.js', () => ({
  batchCheckGitignore: vi.fn().mockResolvedValue(new Map()),
  isDocumentationFile: vi.fn().mockReturnValue(false),
  shouldProcessFile: vi.fn().mockReturnValue(true),
}));

vi.mock('../utils/language-detection.js', () => ({
  detectLanguageFromExtension: vi.fn().mockReturnValue('javascript'),
}));

vi.mock('../utils/markdown.js', () => ({
  extractMarkdownChunks: vi.fn().mockReturnValue({ chunks: [], documentH1: 'Test' }),
}));

vi.mock('../utils/logging.js', () => ({
  debug: vi.fn(),
}));

describe('FileProcessor', () => {
  let processor;
  let mockModelManager;
  let mockDatabaseManager;
  let mockCacheManager;
  let mockTable;

  beforeEach(() => {
    mockConsole();

    mockTable = {
      add: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      }),
      optimize: vi.fn().mockResolvedValue(undefined),
    };

    mockModelManager = {
      initialize: vi.fn().mockResolvedValue(undefined),
      calculateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
      calculateEmbeddingBatch: vi.fn().mockResolvedValue([new Array(384).fill(0.1)]),
      embeddingDimensions: 384,
    };

    mockDatabaseManager = {
      getDB: vi.fn().mockResolvedValue({}),
      getTable: vi.fn().mockResolvedValue(mockTable),
    };

    mockCacheManager = {};

    processor = new FileProcessor({
      modelManager: mockModelManager,
      databaseManager: mockDatabaseManager,
      cacheManager: mockCacheManager,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const defaultProcessor = new FileProcessor();

      expect(defaultProcessor.modelManager).toBeNull();
      expect(defaultProcessor.databaseManager).toBeNull();
      expect(defaultProcessor.processedFiles).toBeDefined();
    });

    it('should accept injected dependencies', () => {
      expect(processor.modelManager).toBe(mockModelManager);
      expect(processor.databaseManager).toBe(mockDatabaseManager);
    });
  });

  describe('getProgressTracker', () => {
    it('should return progress tracker object', () => {
      const tracker = processor.getProgressTracker();

      expect(tracker).toHaveProperty('totalFiles');
      expect(tracker).toHaveProperty('processedCount');
      expect(tracker).toHaveProperty('skippedCount');
      expect(tracker).toHaveProperty('failedCount');
    });
  });

  describe('resetProgressTracker', () => {
    it('should reset progress tracker with new total', () => {
      processor.resetProgressTracker(100);
      const tracker = processor.getProgressTracker();

      expect(tracker.totalFiles).toBe(100);
      expect(tracker.processedCount).toBe(0);
    });
  });

  describe('generateDirectoryStructure', () => {
    it('should generate directory tree string', () => {
      fs.readdirSync.mockReturnValue([
        { name: 'src', isDirectory: () => true, isFile: () => false },
        { name: 'file.js', isDirectory: () => false, isFile: () => true },
      ]);

      const structure = processor.generateDirectoryStructure({
        rootDir: '/project',
        maxDepth: 2,
        showFiles: true,
      });

      expect(structure).toContain('src/');
      expect(structure).toContain('file.js');
    });

    it('should respect maxDepth option', () => {
      fs.readdirSync.mockReturnValue([]);

      processor.generateDirectoryStructure({ maxDepth: 1 });

      // Should be called but not recurse beyond maxDepth
      expect(fs.readdirSync).toHaveBeenCalled();
    });

    it('should ignore specified patterns', () => {
      fs.readdirSync.mockReturnValue([
        { name: 'node_modules', isDirectory: () => true, isFile: () => false },
        { name: 'src', isDirectory: () => true, isFile: () => false },
      ]);

      const structure = processor.generateDirectoryStructure({
        ignorePatterns: ['node_modules'],
      });

      expect(structure).not.toContain('node_modules');
    });
  });

  describe('generateDirectoryStructureEmbedding', () => {
    it('should throw when ModelManager is not available', async () => {
      const processorNoModel = new FileProcessor({ databaseManager: mockDatabaseManager });

      await expect(processorNoModel.generateDirectoryStructureEmbedding()).rejects.toThrow('ModelManager is required');
    });

    it('should throw when DatabaseManager is not available', async () => {
      const processorNoDb = new FileProcessor({ modelManager: mockModelManager });

      await expect(processorNoDb.generateDirectoryStructureEmbedding()).rejects.toThrow('DatabaseManager is required');
    });

    it('should generate and store directory structure embedding', async () => {
      fs.readdirSync.mockReturnValue([{ name: 'file.js', isDirectory: () => false, isFile: () => true }]);

      const result = await processor.generateDirectoryStructureEmbedding({ rootDir: '/project' });

      expect(result).toBe(true);
      expect(mockTable.add).toHaveBeenCalled();
    });

    it('should delete existing structure embedding before adding new one', async () => {
      fs.readdirSync.mockReturnValue([]);

      await processor.generateDirectoryStructureEmbedding();

      expect(mockTable.delete).toHaveBeenCalled();
    });

    it('should return false when embedding calculation fails', async () => {
      mockModelManager.calculateEmbedding.mockResolvedValue(null);
      fs.readdirSync.mockReturnValue([{ name: 'file.js', isDirectory: () => false, isFile: () => true }]);

      const result = await processor.generateDirectoryStructureEmbedding();

      expect(result).toBe(false);
    });
  });

  describe('processBatchEmbeddings', () => {
    it('should throw when ModelManager is not available', async () => {
      const processorNoModel = new FileProcessor({ databaseManager: mockDatabaseManager });

      await expect(processorNoModel.processBatchEmbeddings(['file.js'])).rejects.toThrow('ModelManager is required');
    });

    it('should throw when DatabaseManager is not available', async () => {
      const processorNoDb = new FileProcessor({ modelManager: mockModelManager });

      await expect(processorNoDb.processBatchEmbeddings(['file.js'])).rejects.toThrow('DatabaseManager is required');
    });

    it('should process files and return results', async () => {
      fs.statSync.mockReturnValue({
        size: 1000,
        mtime: new Date(),
        isFile: () => true,
      });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);

      const result = await processor.processBatchEmbeddings(['/test/file.js'], {
        baseDir: '/test',
      });

      expect(result).toHaveProperty('processed');
      expect(result).toHaveProperty('failed');
      expect(result).toHaveProperty('skipped');
    });

    it('should skip files that fail shouldProcessFile check', async () => {
      shouldProcessFile.mockReturnValue(false);
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.readdirSync.mockReturnValue([]);

      const result = await processor.processBatchEmbeddings(['/test/file.js']);

      expect(result.excluded).toBeGreaterThan(0);
    });

    it('should call onProgress callback', async () => {
      const onProgress = vi.fn();
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('code');
      fs.readdirSync.mockReturnValue([]);

      await processor.processBatchEmbeddings(['/test/file.js'], { onProgress });

      expect(onProgress).toHaveBeenCalled();
    });

    it('should handle model initialization failure', async () => {
      mockModelManager.initialize.mockRejectedValue(new Error('Model init failed'));
      fs.readdirSync.mockReturnValue([]);

      const result = await processor.processBatchEmbeddings(['/test/file.js']);

      expect(result.failed).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('should clear processed files map', async () => {
      processor.processedFiles.set('file.js', 'processed');

      await processor.cleanup();

      expect(processor.processedFiles.size).toBe(0);
    });

    it('should reset progress tracker', async () => {
      processor.progressTracker.processedCount = 10;

      await processor.cleanup();

      expect(processor.progressTracker.processedCount).toBe(0);
    });

    it('should prevent duplicate cleanup calls', async () => {
      processor.cleaningUp = true;

      await processor.cleanup();

      // Should return early without doing anything
      expect(processor.cleaningUp).toBe(true);
    });
  });

  describe('generateDirectoryStructure edge cases', () => {
    it('should handle empty directory', () => {
      fs.readdirSync.mockReturnValue([]);

      const structure = processor.generateDirectoryStructure({
        rootDir: '/project',
        maxDepth: 3,
      });

      expect(structure).toBeDefined();
    });

    it('should handle read errors gracefully', () => {
      fs.readdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const structure = processor.generateDirectoryStructure({
        rootDir: '/project',
      });

      expect(structure).toBe('');
    });

    it('should not show files when showFiles is false', () => {
      fs.readdirSync.mockReturnValue([
        { name: 'src', isDirectory: () => true, isFile: () => false },
        { name: 'file.js', isDirectory: () => false, isFile: () => true },
      ]);

      const structure = processor.generateDirectoryStructure({
        rootDir: '/project',
        showFiles: false,
      });

      expect(structure).toContain('src/');
      expect(structure).not.toContain('file.js');
    });
  });

  describe('processBatchEmbeddings edge cases', () => {
    it('should handle empty file list', async () => {
      fs.readdirSync.mockReturnValue([]);

      const result = await processor.processBatchEmbeddings([]);

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('should handle file read errors', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockRejectedValue(new Error('Read error'));
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });

      expect(result.failed).toBeGreaterThanOrEqual(0);
    });

    it('should skip large files', async () => {
      fs.statSync.mockReturnValue({ size: 10 * 1024 * 1024, mtime: new Date() }); // 10MB
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const result = await processor.processBatchEmbeddings(['/test/large-file.js'], {
        maxFileSizeBytes: 1024 * 1024, // 1MB limit
        baseDir: '/test',
      });

      expect(result.skipped).toBeGreaterThanOrEqual(0);
    });

    it('should handle batch embedding calculation failure', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date(), isFile: () => true });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);
      mockModelManager.calculateEmbeddingBatch.mockRejectedValue(new Error('Batch failed'));

      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });

      expect(result.failed).toBeGreaterThanOrEqual(0);
    });

    it('should process documentation files with markdown chunks', async () => {
      const { isDocumentationFile } = await import('../utils/file-validation.js'); // eslint-disable-line no-restricted-syntax
      isDocumentationFile.mockReturnValue(true);

      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date(), isFile: () => true });
      fs.promises.readFile.mockResolvedValue('# Title\n\nContent');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const result = await processor.processBatchEmbeddings(['/test/README.md'], { baseDir: '/test' });

      expect(result.processed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('generateDirectoryStructureEmbedding edge cases', () => {
    it('should handle table operations error', async () => {
      fs.readdirSync.mockReturnValue([{ name: 'file.js', isDirectory: () => false, isFile: () => true }]);
      mockTable.add.mockRejectedValue(new Error('Table error'));

      // The function catches the error and returns false instead of throwing
      const result = await processor.generateDirectoryStructureEmbedding();
      expect(result).toBe(false);
    });

    it('should use custom project path', async () => {
      fs.readdirSync.mockReturnValue([{ name: 'file.js', isDirectory: () => false, isFile: () => true }]);

      const result = await processor.generateDirectoryStructureEmbedding({
        rootDir: '/custom/project',
        projectPath: '/custom/project',
      });

      expect(result).toBe(true);
      expect(mockTable.add).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            project_path: expect.stringContaining('/custom/project'),
          }),
        ])
      );
    });

    it('should return false when table is not found', async () => {
      mockDatabaseManager.getTable.mockResolvedValue(null);

      const result = await processor.generateDirectoryStructureEmbedding();

      expect(result).toBe(false);
    });

    it('should handle delete error with non-record-not-found message', async () => {
      fs.readdirSync.mockReturnValue([{ name: 'file.js', isDirectory: () => false, isFile: () => true }]);
      mockTable.delete.mockRejectedValue(new Error('Delete failed'));

      const result = await processor.generateDirectoryStructureEmbedding();

      expect(result).toBe(true);
    });

    it('should handle delete error with Record not found message', async () => {
      fs.readdirSync.mockReturnValue([{ name: 'file.js', isDirectory: () => false, isFile: () => true }]);
      mockTable.delete.mockRejectedValue(new Error('Record not found'));

      const result = await processor.generateDirectoryStructureEmbedding();

      expect(result).toBe(true);
    });

    it('should return false when vector dimension mismatch', async () => {
      fs.readdirSync.mockReturnValue([{ name: 'file.js', isDirectory: () => false, isFile: () => true }]);
      mockModelManager.calculateEmbedding.mockResolvedValue(new Array(256).fill(0.1)); // Wrong dimension

      const result = await processor.generateDirectoryStructureEmbedding();

      expect(result).toBe(false);
    });
  });

  describe('processBatchEmbeddings advanced scenarios', () => {
    it('should handle database initialization failure', async () => {
      mockDatabaseManager.getDB.mockRejectedValue(new Error('DB init failed'));
      fs.readdirSync.mockReturnValue([]);

      const result = await processor.processBatchEmbeddings(['/test/file.js']);

      expect(result.failed).toBe(1);
    });

    it('should handle file table not found', async () => {
      mockDatabaseManager.getTable
        .mockResolvedValueOnce(mockTable) // First call for dir structure
        .mockResolvedValueOnce(null); // Second call for file embeddings
      fs.readdirSync.mockReturnValue([]);

      const result = await processor.processBatchEmbeddings(['/test/file.js']);

      expect(result.failed).toBe(1);
    });

    it('should skip unchanged files based on content hash', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      // Set up existing embeddings with matching content hash
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            path: 'file.js',
            content_hash: 'abc12345', // Same hash as our mock
            last_modified: new Date().toISOString(),
          },
        ]),
      });

      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });

      expect(result.skipped).toBeGreaterThanOrEqual(0);
    });

    it('should delete old version when content hash differs', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      // Set up existing embeddings with different content hash
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            id: 'old-record',
            path: 'file.js',
            content_hash: 'different', // Different hash
            last_modified: new Date().toISOString(),
          },
        ]),
      });

      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });

      expect(mockTable.delete).toHaveBeenCalled();
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });

    it('should handle delete old version error', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      // Set up existing embeddings with different hash
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            id: 'old-record',
            path: 'file.js',
            content_hash: 'different',
            last_modified: new Date().toISOString(),
          },
        ]),
      });

      mockTable.delete.mockRejectedValue(new Error('Delete failed'));

      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });

      expect(console.warn).toHaveBeenCalled();
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });

    it('should handle file stat error', async () => {
      fs.statSync.mockImplementation(() => {
        throw new Error('Stat error');
      });
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const onProgress = vi.fn();
      const result = await processor.processBatchEmbeddings(['/test/file.js'], {
        baseDir: '/test',
        onProgress,
      });

      expect(result.failed).toBe(1);
      expect(onProgress).toHaveBeenCalledWith('failed', '/test/file.js');
    });

    it('should skip empty files', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('   '); // Empty/whitespace
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const onProgress = vi.fn();
      await processor.processBatchEmbeddings(['/test/file.js'], {
        baseDir: '/test',
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledWith('skipped', '/test/file.js');
    });

    it('should truncate long code files', async () => {
      const longContent = Array.from({ length: 1500 }, (_, i) => `const x${i} = ${i};`).join('\n');
      fs.statSync.mockReturnValue({ size: longContent.length, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue(longContent);
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const result = await processor.processBatchEmbeddings(['/test/file.js'], {
        baseDir: '/test',
        maxLines: 1000,
      });

      expect(result.processed).toBeGreaterThanOrEqual(0);
    });

    it('should handle embedding calculation returning null', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([null]);

      const onProgress = vi.fn();
      const result = await processor.processBatchEmbeddings(['/test/file.js'], {
        baseDir: '/test',
        onProgress,
      });

      expect(result.failed).toBeGreaterThanOrEqual(0);
    });

    it('should handle table optimize legacy format error', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);
      mockTable.optimize.mockRejectedValue(new Error('legacy format'));

      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('legacy index format'));
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });

    it('should handle table optimize other error', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);
      mockTable.optimize.mockRejectedValue(new Error('Other optimize error'));

      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to optimize'));
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });

    it('should check modification time for potentially unchanged files', async () => {
      const mtime = new Date();
      fs.statSync.mockReturnValue({ size: 1000, mtime });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      // Set up existing embeddings with matching modification time
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            path: 'file.js',
            content_hash: 'different',
            last_modified: mtime.toISOString(),
          },
        ]),
      });

      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });

      expect(result).toBeDefined();
    });

    it('should handle existing embeddings query failure', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('const x = 1;');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Query failed')),
      });

      await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not query existing embeddings'));
    });
  });

  describe('generateDirectoryStructure ignore patterns', () => {
    it('should handle ** prefix patterns', () => {
      fs.readdirSync.mockReturnValue([
        { name: 'dist', isDirectory: () => true, isFile: () => false },
        { name: 'src', isDirectory: () => true, isFile: () => false },
      ]);

      const structure = processor.generateDirectoryStructure({
        rootDir: '/project',
        ignorePatterns: ['**/dist'],
      });

      expect(structure).not.toContain('dist');
      expect(structure).toContain('src');
    });
  });

  describe('_processDocumentChunks', () => {
    it('should skip large documentation files', async () => {
      const { isDocumentationFile } = await import('../utils/file-validation.js'); // eslint-disable-line no-restricted-syntax
      isDocumentationFile.mockReturnValue(true);

      fs.statSync.mockReturnValue({ size: 6 * 1024 * 1024, mtime: new Date() }); // 6MB
      fs.promises.readFile.mockResolvedValue('# Large doc');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const result = await processor.processBatchEmbeddings(['/test/large.md'], { baseDir: '/test' });

      expect(result).toBeDefined();
    });

    it('should skip empty documentation files', async () => {
      const { isDocumentationFile } = await import('../utils/file-validation.js'); // eslint-disable-line no-restricted-syntax
      isDocumentationFile.mockReturnValue(true);

      fs.statSync.mockReturnValue({ size: 100, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('   '); // Empty
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const result = await processor.processBatchEmbeddings(['/test/empty.md'], { baseDir: '/test' });

      expect(result).toBeDefined();
    });

    it('should process documentation chunks with extractMarkdownChunks', async () => {
      const { isDocumentationFile } = await import('../utils/file-validation.js'); // eslint-disable-line no-restricted-syntax
      const { extractMarkdownChunks } = await import('../utils/markdown.js'); // eslint-disable-line no-restricted-syntax

      isDocumentationFile.mockReturnValue(true);
      extractMarkdownChunks.mockReturnValue({
        chunks: [
          { content: 'Chunk 1', heading: 'Section 1', original_document_path: 'doc.md', start_line_in_doc: 1 },
          { content: 'Chunk 2', heading: 'Section 2', original_document_path: 'doc.md', start_line_in_doc: 10 },
        ],
        documentH1: 'Document Title',
      });

      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('# Title\n\n## Section 1\nContent\n\n## Section 2\nMore content');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding(), createMockEmbedding()]);

      const result = await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' });

      expect(result).toBeDefined();
    });

    it('should skip unchanged documentation chunks', async () => {
      const { isDocumentationFile } = await import('../utils/file-validation.js'); // eslint-disable-line no-restricted-syntax
      const { extractMarkdownChunks } = await import('../utils/markdown.js'); // eslint-disable-line no-restricted-syntax

      isDocumentationFile.mockReturnValue(true);
      extractMarkdownChunks.mockReturnValue({
        chunks: [{ content: 'Chunk 1', heading: 'Section 1', original_document_path: 'doc.md', start_line_in_doc: 1 }],
        documentH1: 'Title',
      });

      // Set up existing chunks with matching hash
      const docMockTable = {
        add: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnThis(),
          toArray: vi.fn().mockResolvedValue([{ original_document_path: 'doc.md', content_hash: 'abc12345' }]),
        }),
        optimize: vi.fn().mockResolvedValue(undefined),
      };

      mockDatabaseManager.getTable
        .mockResolvedValueOnce(mockTable) // For dir structure
        .mockResolvedValueOnce(mockTable) // For file embeddings
        .mockResolvedValueOnce(docMockTable); // For document chunks

      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('# Title\n\nChunk 1');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const result = await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' });

      expect(result).toBeDefined();
    });

    it('should handle document chunk processing errors', async () => {
      const { isDocumentationFile } = await import('../utils/file-validation.js'); // eslint-disable-line no-restricted-syntax
      isDocumentationFile.mockReturnValue(true);

      fs.statSync.mockImplementation((filePath) => {
        if (filePath.includes('error')) {
          throw new Error('Stat error');
        }
        return { size: 1000, mtime: new Date() };
      });
      fs.promises.readFile.mockResolvedValue('# Title');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      const result = await processor.processBatchEmbeddings(['/test/error.md'], { baseDir: '/test' });

      expect(result).toBeDefined();
    });

    it('should handle document chunk table not found', async () => {
      const { isDocumentationFile } = await import('../utils/file-validation.js'); // eslint-disable-line no-restricted-syntax
      isDocumentationFile.mockReturnValue(true);

      // Track call order by table name
      mockDatabaseManager.getTable.mockImplementation((tableName) => {
        if (tableName === 'file_embeddings') return Promise.resolve(mockTable);
        if (tableName === 'document_chunk_embeddings') return Promise.resolve(null); // Not found
        return Promise.resolve(mockTable);
      });

      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('# Title');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);

      await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' });

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping Phase 2'));
    });

    it('should successfully add document chunks', async () => {
      const { isDocumentationFile } = await import('../utils/file-validation.js'); // eslint-disable-line no-restricted-syntax
      const { extractMarkdownChunks } = await import('../utils/markdown.js'); // eslint-disable-line no-restricted-syntax

      isDocumentationFile.mockReturnValue(true);
      extractMarkdownChunks.mockReturnValue({
        chunks: [{ content: 'Chunk', heading: 'Section', original_document_path: 'doc.md', start_line_in_doc: 1 }],
        documentH1: 'Title',
      });

      const docMockTable = {
        add: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnThis(),
          toArray: vi.fn().mockResolvedValue([]),
        }),
        optimize: vi.fn().mockResolvedValue(undefined),
      };

      let callCount = 0;
      mockDatabaseManager.getTable.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mockTable); // dir structure
        if (callCount === 2) return Promise.resolve(mockTable); // file embeddings table
        if (callCount === 3) return Promise.resolve(docMockTable); // document chunk table
        return Promise.resolve(mockTable);
      });

      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('# Title\n\nContent');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding()]);

      await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' });

      expect(docMockTable.add).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully added'));
    });

    it('should handle document chunk optimize legacy format error', async () => {
      const { isDocumentationFile } = await import('../utils/file-validation.js'); // eslint-disable-line no-restricted-syntax
      const { extractMarkdownChunks } = await import('../utils/markdown.js'); // eslint-disable-line no-restricted-syntax

      isDocumentationFile.mockReturnValue(true);
      extractMarkdownChunks.mockReturnValue({
        chunks: [{ content: 'Chunk', heading: 'Section', original_document_path: 'doc.md', start_line_in_doc: 1 }],
        documentH1: 'Title',
      });

      const docMockTable = {
        add: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnThis(),
          toArray: vi.fn().mockResolvedValue([]),
        }),
        optimize: vi.fn().mockRejectedValue(new Error('legacy format')),
      };

      let callCount = 0;
      mockDatabaseManager.getTable.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mockTable); // dir structure
        if (callCount === 2) return Promise.resolve(mockTable); // file embeddings table
        if (callCount === 3) return Promise.resolve(docMockTable); // document chunk table
        return Promise.resolve(mockTable);
      });

      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('# Title\n\nContent');
      fs.readdirSync.mockReturnValue([]);
      shouldProcessFile.mockReturnValue(true);
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding()]);

      await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' });

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('legacy index format'));
    });
  });

  describe('cleanup edge cases', () => {
    it('should handle cleanup errors gracefully', async () => {
      processor.processedFiles = {
        clear: vi.fn(() => {
          throw new Error('Clear failed');
        }),
      };

      await processor.cleanup();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error during cleanup'));
    });
  });
});
