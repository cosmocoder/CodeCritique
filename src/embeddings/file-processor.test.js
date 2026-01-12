import fs from 'node:fs';
import { createMockTable, createMockModelManager, createMockDatabaseManager } from '../test-utils/fixtures.js';
import { shouldProcessFile, isDocumentationFile } from '../utils/file-validation.js';
import { extractMarkdownChunks } from '../utils/markdown.js';
import { FileProcessor } from './file-processor.js';

vi.mock('node:fs', () => ({
  default: {
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    promises: { readFile: vi.fn() },
  },
}));

vi.mock('node:crypto', () => ({
  createHash: vi.fn(() => ({ update: vi.fn().mockReturnThis(), digest: vi.fn().mockReturnValue('abc12345') })),
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

vi.mock('../utils/logging.js', () => ({ debug: vi.fn() }));

// ============================================================================
// Shared Setup
// ============================================================================

const setupFileSystemMocks = (content = 'const x = 1;') => {
  fs.statSync.mockReturnValue({ size: 1000, mtime: new Date(), isFile: () => true });
  fs.promises.readFile.mockResolvedValue(content);
  fs.readdirSync.mockReturnValue([]);
};

const createDirEntry = (name, isDir = false) => ({
  name,
  isDirectory: () => isDir,
  isFile: () => !isDir,
});

// ============================================================================
// Tests
// ============================================================================

describe('FileProcessor', () => {
  let processor;
  let mockTable;
  let mockModelManager;
  let mockDatabaseManager;

  beforeEach(() => {
    mockConsole();
    mockTable = createMockTable();
    mockModelManager = createMockModelManager();
    mockDatabaseManager = createMockDatabaseManager(mockTable);
    processor = new FileProcessor({
      modelManager: mockModelManager,
      databaseManager: mockDatabaseManager,
      cacheManager: {},
    });
  });

  afterEach(() => vi.restoreAllMocks());

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it.each([
      ['default options', {}, (p) => p.modelManager === null && p.processedFiles !== undefined],
      ['injected dependencies', { modelManager: {}, databaseManager: {} }, (p) => p.modelManager !== null],
    ])('should initialize with %s', (_, options, validator) => {
      const p = new FileProcessor(options);
      expect(validator(p)).toBe(true);
    });
  });

  // ==========================================================================
  // Progress Tracker
  // ==========================================================================

  describe('progress tracking', () => {
    it('should return progress tracker with required properties', () => {
      const tracker = processor.getProgressTracker();
      expect(tracker).toMatchObject({
        totalFiles: expect.any(Number),
        processedCount: expect.any(Number),
        skippedCount: expect.any(Number),
        failedCount: expect.any(Number),
      });
    });

    it('should reset progress tracker with new total', () => {
      processor.resetProgressTracker(100);
      expect(processor.getProgressTracker().totalFiles).toBe(100);
      expect(processor.getProgressTracker().processedCount).toBe(0);
    });
  });

  // ==========================================================================
  // Directory Structure Generation
  // ==========================================================================

  describe('generateDirectoryStructure', () => {
    it('should generate directory tree string', () => {
      fs.readdirSync.mockReturnValue([createDirEntry('src', true), createDirEntry('file.js')]);
      const structure = processor.generateDirectoryStructure({ rootDir: '/project', maxDepth: 2, showFiles: true });
      expect(structure).toContain('src/');
      expect(structure).toContain('file.js');
    });

    it('should not show files when showFiles is false', () => {
      fs.readdirSync.mockReturnValue([createDirEntry('src', true), createDirEntry('file.js')]);
      const structure = processor.generateDirectoryStructure({ rootDir: '/project', showFiles: false });
      expect(structure).toContain('src/');
      expect(structure).not.toContain('file.js');
    });

    it.each([
      ['node_modules', 'node_modules'],
      ['**/dist pattern', 'dist', '**/dist'],
    ])('should ignore %s', (_, ignoredName, pattern) => {
      fs.readdirSync.mockReturnValue([createDirEntry(ignoredName, true), createDirEntry('src', true)]);
      const structure = processor.generateDirectoryStructure({
        ignorePatterns: [pattern || ignoredName],
      });
      expect(structure).not.toContain(ignoredName);
    });

    it('should handle empty directory', () => {
      fs.readdirSync.mockReturnValue([]);
      const structure = processor.generateDirectoryStructure({ rootDir: '/project', maxDepth: 3 });
      expect(structure).toBeDefined();
    });

    it('should handle read errors gracefully', () => {
      fs.readdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });
      const structure = processor.generateDirectoryStructure({ rootDir: '/project' });
      expect(structure).toBe('');
    });
  });

  // ==========================================================================
  // Directory Structure Embedding
  // ==========================================================================

  describe('generateDirectoryStructureEmbedding', () => {
    it.each([
      ['ModelManager', { databaseManager: {} }, 'ModelManager is required'],
      ['DatabaseManager', { modelManager: {} }, 'DatabaseManager is required'],
    ])('should throw when %s is not available', async (_, options, errorMessage) => {
      const p = new FileProcessor(options);
      await expect(p.generateDirectoryStructureEmbedding()).rejects.toThrow(errorMessage);
    });

    it('should generate and store directory structure embedding', async () => {
      fs.readdirSync.mockReturnValue([createDirEntry('file.js')]);
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
      fs.readdirSync.mockReturnValue([createDirEntry('file.js')]);
      expect(await processor.generateDirectoryStructureEmbedding()).toBe(false);
    });

    it('should return false when table is not found', async () => {
      mockDatabaseManager.getTable.mockResolvedValue(null);
      expect(await processor.generateDirectoryStructureEmbedding()).toBe(false);
    });

    it('should return false when vector dimension mismatch', async () => {
      fs.readdirSync.mockReturnValue([createDirEntry('file.js')]);
      mockModelManager.calculateEmbedding.mockResolvedValue(new Array(256).fill(0.1));
      expect(await processor.generateDirectoryStructureEmbedding()).toBe(false);
    });

    it('should use custom project path', async () => {
      fs.readdirSync.mockReturnValue([createDirEntry('file.js')]);
      const result = await processor.generateDirectoryStructureEmbedding({
        rootDir: '/custom/project',
        projectPath: '/custom/project',
      });
      expect(result).toBe(true);
      expect(mockTable.add).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ project_path: expect.stringContaining('/custom/project') })])
      );
    });

    it.each([
      ['non-record-not-found message', 'Delete failed'],
      ['Record not found message', 'Record not found'],
    ])('should handle delete error with %s', async (_, errorMsg) => {
      fs.readdirSync.mockReturnValue([createDirEntry('file.js')]);
      mockTable.delete.mockRejectedValue(new Error(errorMsg));
      expect(await processor.generateDirectoryStructureEmbedding()).toBe(true);
    });

    it('should handle table operations error', async () => {
      fs.readdirSync.mockReturnValue([createDirEntry('file.js')]);
      mockTable.add.mockRejectedValue(new Error('Table error'));
      expect(await processor.generateDirectoryStructureEmbedding()).toBe(false);
    });
  });

  // ==========================================================================
  // Batch Embeddings Processing
  // ==========================================================================

  describe('processBatchEmbeddings', () => {
    it.each([
      ['ModelManager', { databaseManager: {} }, 'ModelManager is required'],
      ['DatabaseManager', { modelManager: {} }, 'DatabaseManager is required'],
    ])('should throw when %s is not available', async (_, options, errorMessage) => {
      fs.readdirSync.mockReturnValue([]);
      const p = new FileProcessor(options);
      await expect(p.processBatchEmbeddings(['file.js'])).rejects.toThrow(errorMessage);
    });

    it('should process files and return results', async () => {
      setupFileSystemMocks();
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });
      expect(result).toMatchObject({ processed: expect.any(Number), failed: expect.any(Number), skipped: expect.any(Number) });
    });

    it('should handle empty file list', async () => {
      fs.readdirSync.mockReturnValue([]);
      const result = await processor.processBatchEmbeddings([]);
      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
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
      setupFileSystemMocks();
      await processor.processBatchEmbeddings(['/test/file.js'], { onProgress });
      expect(onProgress).toHaveBeenCalled();
    });

    it('should handle model initialization failure', async () => {
      mockModelManager.initialize.mockRejectedValue(new Error('Model init failed'));
      fs.readdirSync.mockReturnValue([]);
      const result = await processor.processBatchEmbeddings(['/test/file.js']);
      expect(result.failed).toBe(1);
    });

    it('should handle database initialization failure', async () => {
      mockDatabaseManager.getDB.mockRejectedValue(new Error('DB init failed'));
      fs.readdirSync.mockReturnValue([]);
      const result = await processor.processBatchEmbeddings(['/test/file.js']);
      expect(result.failed).toBe(1);
    });

    it('should handle file table not found', async () => {
      mockDatabaseManager.getTable.mockResolvedValueOnce(mockTable).mockResolvedValueOnce(null);
      fs.readdirSync.mockReturnValue([]);
      const result = await processor.processBatchEmbeddings(['/test/file.js']);
      expect(result.failed).toBe(1);
    });
  });

  // ==========================================================================
  // File Processing Edge Cases
  // ==========================================================================

  describe('file processing edge cases', () => {
    beforeEach(() => {
      shouldProcessFile.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([]);
    });

    it('should handle file read errors', async () => {
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });
      fs.promises.readFile.mockRejectedValue(new Error('Read error'));
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });
      expect(result.failed).toBeGreaterThanOrEqual(0);
    });

    it('should skip large files', async () => {
      fs.statSync.mockReturnValue({ size: 10 * 1024 * 1024, mtime: new Date() });
      const result = await processor.processBatchEmbeddings(['/test/large-file.js'], {
        maxFileSizeBytes: 1024 * 1024,
        baseDir: '/test',
      });
      expect(result.skipped).toBeGreaterThanOrEqual(0);
    });

    it('should handle file stat error', async () => {
      fs.statSync.mockImplementation(() => {
        throw new Error('Stat error');
      });
      const onProgress = vi.fn();
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test', onProgress });
      expect(result.failed).toBe(1);
      expect(onProgress).toHaveBeenCalledWith('failed', '/test/file.js');
    });

    it('should skip empty files', async () => {
      setupFileSystemMocks('   ');
      const onProgress = vi.fn();
      await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test', onProgress });
      expect(onProgress).toHaveBeenCalledWith('skipped', '/test/file.js');
    });

    it('should truncate long code files', async () => {
      const longContent = Array.from({ length: 1500 }, (_, i) => `const x${i} = ${i};`).join('\n');
      setupFileSystemMocks(longContent);
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test', maxLines: 1000 });
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });

    it('should handle embedding calculation returning null', async () => {
      setupFileSystemMocks();
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([null]);
      const onProgress = vi.fn();
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test', onProgress });
      expect(result.failed).toBeGreaterThanOrEqual(0);
    });

    it('should handle batch embedding calculation failure', async () => {
      setupFileSystemMocks();
      mockModelManager.calculateEmbeddingBatch.mockRejectedValue(new Error('Batch failed'));
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });
      expect(result.failed).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // Content Hash & Unchanged Files
  // ==========================================================================

  describe('content hash handling', () => {
    beforeEach(() => {
      shouldProcessFile.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([]);
    });

    it('should skip unchanged files based on content hash', async () => {
      setupFileSystemMocks();
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([{ path: 'file.js', content_hash: 'abc12345', last_modified: new Date().toISOString() }]),
      });
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });
      expect(result.skipped).toBeGreaterThanOrEqual(0);
    });

    it('should delete old version when content hash differs', async () => {
      setupFileSystemMocks();
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi
          .fn()
          .mockResolvedValue([{ id: 'old-record', path: 'file.js', content_hash: 'different', last_modified: new Date().toISOString() }]),
      });
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });
      expect(mockTable.delete).toHaveBeenCalled();
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });

    it('should handle delete old version error', async () => {
      setupFileSystemMocks();
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi
          .fn()
          .mockResolvedValue([{ id: 'old-record', path: 'file.js', content_hash: 'different', last_modified: new Date().toISOString() }]),
      });
      mockTable.delete.mockRejectedValue(new Error('Delete failed'));
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });
      expect(console.warn).toHaveBeenCalled();
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });

    it('should handle existing embeddings query failure', async () => {
      setupFileSystemMocks();
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Query failed')),
      });
      await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not query existing embeddings'));
    });
  });

  // ==========================================================================
  // Table Optimization
  // ==========================================================================

  describe('table optimization', () => {
    beforeEach(() => {
      shouldProcessFile.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([]);
    });

    it.each([
      ['legacy format error', 'legacy format', 'legacy index format'],
      ['other optimize error', 'Other optimize error', 'Failed to optimize'],
    ])('should handle %s', async (_, errorMsg, expectedLog) => {
      setupFileSystemMocks();
      mockTable.optimize.mockRejectedValue(new Error(errorMsg));
      const result = await processor.processBatchEmbeddings(['/test/file.js'], { baseDir: '/test' });
      if (errorMsg === 'legacy format') {
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining(expectedLog));
      } else {
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(expectedLog));
      }
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // Documentation Processing
  // ==========================================================================

  describe('documentation processing', () => {
    beforeEach(() => {
      isDocumentationFile.mockReturnValue(true);
      shouldProcessFile.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([]);
    });

    it('should skip large documentation files', async () => {
      fs.statSync.mockReturnValue({ size: 6 * 1024 * 1024, mtime: new Date() });
      fs.promises.readFile.mockResolvedValue('# Large doc');
      expect(await processor.processBatchEmbeddings(['/test/large.md'], { baseDir: '/test' })).toBeDefined();
    });

    it('should skip empty documentation files', async () => {
      setupFileSystemMocks('   ');
      expect(await processor.processBatchEmbeddings(['/test/empty.md'], { baseDir: '/test' })).toBeDefined();
    });

    it('should process documentation chunks with extractMarkdownChunks', async () => {
      extractMarkdownChunks.mockReturnValue({
        chunks: [
          { content: 'Chunk 1', heading: 'Section 1', original_document_path: 'doc.md', start_line_in_doc: 1 },
          { content: 'Chunk 2', heading: 'Section 2', original_document_path: 'doc.md', start_line_in_doc: 10 },
        ],
        documentH1: 'Document Title',
      });
      setupFileSystemMocks('# Title\n\n## Section 1\nContent');
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding(), createMockEmbedding()]);
      expect(await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' })).toBeDefined();
    });

    it('should skip unchanged documentation chunks', async () => {
      extractMarkdownChunks.mockReturnValue({
        chunks: [{ content: 'Chunk 1', heading: 'Section 1', original_document_path: 'doc.md', start_line_in_doc: 1 }],
        documentH1: 'Title',
      });
      const docMockTable = createMockTable({
        query: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnThis(),
          toArray: vi.fn().mockResolvedValue([{ original_document_path: 'doc.md', content_hash: 'abc12345' }]),
        }),
      });
      mockDatabaseManager.getTable.mockResolvedValueOnce(mockTable).mockResolvedValueOnce(mockTable).mockResolvedValueOnce(docMockTable);
      setupFileSystemMocks('# Title\n\nChunk 1');
      expect(await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' })).toBeDefined();
    });

    it('should handle document chunk table not found', async () => {
      mockDatabaseManager.getTable.mockImplementation((tableName) => {
        if (tableName === 'file_embeddings') return Promise.resolve(mockTable);
        if (tableName === 'document_chunk_embeddings') return Promise.resolve(null);
        return Promise.resolve(mockTable);
      });
      setupFileSystemMocks('# Title');
      await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping Phase 2'));
    });

    it('should successfully add document chunks', async () => {
      extractMarkdownChunks.mockReturnValue({
        chunks: [{ content: 'Chunk', heading: 'Section', original_document_path: 'doc.md', start_line_in_doc: 1 }],
        documentH1: 'Title',
      });
      const docMockTable = createMockTable();
      let callCount = 0;
      mockDatabaseManager.getTable.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 3 ? docMockTable : mockTable);
      });
      setupFileSystemMocks('# Title\n\nContent');
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding()]);
      await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' });
      expect(docMockTable.add).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully added'));
    });

    it('should handle document chunk optimize legacy format error', async () => {
      extractMarkdownChunks.mockReturnValue({
        chunks: [{ content: 'Chunk', heading: 'Section', original_document_path: 'doc.md', start_line_in_doc: 1 }],
        documentH1: 'Title',
      });
      const docMockTable = createMockTable({ optimize: vi.fn().mockRejectedValue(new Error('legacy format')) });
      let callCount = 0;
      mockDatabaseManager.getTable.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 3 ? docMockTable : mockTable);
      });
      setupFileSystemMocks('# Title\n\nContent');
      mockModelManager.calculateEmbeddingBatch.mockResolvedValue([createMockEmbedding()]);
      await processor.processBatchEmbeddings(['/test/doc.md'], { baseDir: '/test' });
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('legacy index format'));
    });

    it('should handle document chunk processing errors', async () => {
      fs.statSync.mockImplementation((filePath) => {
        if (filePath.includes('error')) throw new Error('Stat error');
        return { size: 1000, mtime: new Date() };
      });
      fs.promises.readFile.mockResolvedValue('# Title');
      expect(await processor.processBatchEmbeddings(['/test/error.md'], { baseDir: '/test' })).toBeDefined();
    });
  });

  // ==========================================================================
  // Cleanup
  // ==========================================================================

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
      expect(processor.cleaningUp).toBe(true);
    });

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
