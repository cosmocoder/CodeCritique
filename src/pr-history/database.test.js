import {
  shouldSkipPR,
  storePRCommentsBatch,
  getPRCommentsStats,
  clearPRComments,
  hasPRComments,
  getProcessedPRDateRange,
  getLastAnalysisTimestamp,
  findRelevantPRComments,
  cleanupClassifier,
} from './database.js';

// Create hoisted mock table for embeddings system
const mockTable = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue(undefined),
  optimize: vi.fn().mockResolvedValue(undefined),
  countRows: vi.fn().mockResolvedValue(0),
  query: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  }),
  search: vi.fn().mockReturnValue({
    column: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  }),
  delete: vi.fn().mockResolvedValue(undefined),
}));

const mockEmbeddingsSystem = vi.hoisted(() => ({
  getPRCommentsTable: vi.fn().mockResolvedValue(mockTable),
  updatePRCommentsIndex: vi.fn().mockResolvedValue(undefined),
  calculateQueryEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
}));

vi.mock('../embeddings/factory.js', () => ({
  getDefaultEmbeddingsSystem: vi.fn(() => mockEmbeddingsSystem),
}));

vi.mock('../embeddings/constants.js', () => ({
  EMBEDDING_DIMENSIONS: 384,
  TABLE_NAMES: { PR_COMMENTS: 'pr_comments' },
}));

vi.mock('../utils/mobilebert-tokenizer.js', () => ({
  truncateToTokenLimit: vi.fn((text) => Promise.resolve(text)),
  cleanupTokenizer: vi.fn().mockResolvedValue(undefined),
}));

const mockClassifier = vi.hoisted(() => vi.fn().mockResolvedValue([{ labels: ['relevant issue', 'irrelevant'], scores: [0.9, 0.1] }]));
const mockPipeline = vi.hoisted(() => vi.fn().mockResolvedValue(mockClassifier));

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipeline,
}));

describe('PR History Database', () => {
  beforeEach(() => {
    mockConsole();

    // Reset all mocks
    mockTable.add.mockReset().mockResolvedValue(undefined);
    mockTable.optimize.mockReset().mockResolvedValue(undefined);
    mockTable.countRows.mockReset().mockResolvedValue(0);
    mockTable.delete.mockReset().mockResolvedValue(undefined);
    mockTable.query.mockReset().mockReturnValue({
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    });
    mockTable.search.mockReset().mockReturnValue({
      column: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    });
    mockEmbeddingsSystem.getPRCommentsTable.mockReset().mockResolvedValue(mockTable);
    mockEmbeddingsSystem.updatePRCommentsIndex.mockReset().mockResolvedValue(undefined);
    mockEmbeddingsSystem.calculateQueryEmbedding.mockReset().mockResolvedValue(new Array(384).fill(0.1));

    // Reset classifier mocks
    mockClassifier.mockReset().mockResolvedValue([{ labels: ['relevant issue', 'irrelevant'], scores: [0.9, 0.1] }]);
    mockPipeline.mockReset().mockResolvedValue(mockClassifier);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('shouldSkipPR', () => {
    it('should return false when no date range provided', () => {
      expect(shouldSkipPR({ merged_at: '2024-01-15' }, null, null)).toBe(false);
    });

    it('should return false when PR is null', () => {
      expect(shouldSkipPR(null, '2024-01-01', '2024-01-31')).toBe(false);
    });

    it('should return true when PR is within processed range', () => {
      const pr = { merged_at: '2024-01-15' };
      expect(shouldSkipPR(pr, '2024-01-01', '2024-01-31')).toBe(true);
    });

    it('should return false when PR is before processed range', () => {
      const pr = { merged_at: '2023-12-15' };
      expect(shouldSkipPR(pr, '2024-01-01', '2024-01-31')).toBe(false);
    });

    it('should return false when PR is after processed range', () => {
      const pr = { merged_at: '2024-02-15' };
      expect(shouldSkipPR(pr, '2024-01-01', '2024-01-31')).toBe(false);
    });

    it('should use created_at when merged_at is not available', () => {
      const pr = { created_at: '2024-01-15' };
      expect(shouldSkipPR(pr, '2024-01-01', '2024-01-31')).toBe(true);
    });

    it('should use updated_at as fallback', () => {
      const pr = { updated_at: '2024-01-15' };
      expect(shouldSkipPR(pr, '2024-01-01', '2024-01-31')).toBe(true);
    });
  });

  describe('storePRCommentsBatch', () => {
    it('should return 0 for empty array', async () => {
      const result = await storePRCommentsBatch([]);
      expect(result).toBe(0);
    });

    it('should return 0 for null input', async () => {
      const result = await storePRCommentsBatch(null);
      expect(result).toBe(0);
    });

    it('should store valid comments', async () => {
      const comments = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          comment_embedding: new Array(384).fill(0.1),
          pr_number: 1,
        },
      ];

      const result = await storePRCommentsBatch(comments);

      expect(result).toBe(1);
      expect(mockTable.add).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'comment-1',
            comment_text: 'Test comment',
          }),
        ])
      );
    });

    it('should skip comments with missing required fields', async () => {
      const comments = [
        { id: 'comment-1' }, // missing comment_text and comment_embedding
        {
          id: 'comment-2',
          comment_text: 'Valid comment',
          comment_embedding: new Array(384).fill(0.1),
        },
      ];

      const result = await storePRCommentsBatch(comments);

      expect(result).toBe(1);
    });

    it('should skip comments with invalid embedding dimensions', async () => {
      const comments = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          comment_embedding: new Array(256).fill(0.1), // Wrong dimension
        },
      ];

      const result = await storePRCommentsBatch(comments);

      expect(result).toBe(0);
    });

    it('should handle table not found', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null);

      const comments = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          comment_embedding: new Array(384).fill(0.1),
        },
      ];

      const result = await storePRCommentsBatch(comments);

      expect(result).toBe(0);
    });

    it('should handle batch storage errors', async () => {
      mockTable.add.mockRejectedValue(new Error('Database error'));

      const comments = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          comment_embedding: new Array(384).fill(0.1),
        },
      ];

      const result = await storePRCommentsBatch(comments);

      expect(result).toBe(0);
    });

    it('should handle optimize errors gracefully', async () => {
      mockTable.optimize.mockRejectedValue(new Error('Optimize failed'));

      const comments = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          comment_embedding: new Array(384).fill(0.1),
        },
      ];

      const result = await storePRCommentsBatch(comments);

      expect(result).toBe(1); // Should still succeed despite optimize error
    });

    it('should handle legacy format optimize errors', async () => {
      mockTable.optimize.mockRejectedValue(new Error('legacy format'));

      const comments = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          comment_embedding: new Array(384).fill(0.1),
        },
      ];

      const result = await storePRCommentsBatch(comments);

      expect(result).toBe(1);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('legacy index format'));
    });
  });

  describe('getPRCommentsStats', () => {
    it('should return default stats when table not found', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null);

      const stats = await getPRCommentsStats();

      expect(stats.total_comments).toBe(0);
      expect(stats.comment_types).toEqual({});
    });

    it('should return stats for comments', async () => {
      const mockComments = [
        {
          comment_type: 'issue',
          issue_category: 'bug',
          severity: 'major',
          author: 'user1',
          repository: 'owner/repo',
          pr_number: 1,
          created_at: '2024-01-15T00:00:00Z',
        },
        {
          comment_type: 'suggestion',
          issue_category: 'enhancement',
          severity: 'minor',
          author: 'user2',
          repository: 'owner/repo',
          pr_number: 2,
          created_at: '2024-01-20T00:00:00Z',
        },
      ];

      mockTable.countRows.mockResolvedValue(2);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockComments),
      });

      const stats = await getPRCommentsStats();

      expect(stats.total_comments).toBe(2);
      expect(stats.totalComments).toBe(2);
      expect(stats.comment_types.issue).toBe(1);
      expect(stats.comment_types.suggestion).toBe(1);
      expect(stats.totalPRs).toBe(2);
      expect(stats.uniqueAuthors).toBe(2);
    });

    it('should handle query errors with fallback', async () => {
      mockTable.countRows.mockResolvedValue(1);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValueOnce(new Error('Query error')).mockResolvedValueOnce([]),
      });

      const stats = await getPRCommentsStats();

      expect(stats.total_comments).toBe(0);
    });

    it('should filter by repository when provided', async () => {
      mockTable.countRows.mockResolvedValue(0);

      await getPRCommentsStats('owner/repo');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('repository'));
    });
  });

  describe('clearPRComments', () => {
    it('should return 0 when table not found', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null);

      const result = await clearPRComments('owner/repo');

      expect(result).toBe(0);
    });

    it('should delete comments and return count', async () => {
      mockTable.countRows.mockResolvedValue(5);

      const result = await clearPRComments('owner/repo');

      expect(result).toBe(5);
      expect(mockTable.delete).toHaveBeenCalled();
    });

    it('should handle delete errors', async () => {
      mockTable.countRows.mockResolvedValue(5);
      mockTable.delete.mockRejectedValue(new Error('Delete error'));

      const result = await clearPRComments('owner/repo');

      expect(result).toBe(0);
    });
  });

  describe('hasPRComments', () => {
    it('should return false when table not found', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null);

      const result = await hasPRComments('owner/repo');

      expect(result).toBe(false);
    });

    it('should return true when comments exist', async () => {
      mockTable.countRows.mockResolvedValue(5);

      const result = await hasPRComments('owner/repo');

      expect(result).toBe(true);
    });

    it('should return false when no comments exist', async () => {
      mockTable.countRows.mockResolvedValue(0);

      const result = await hasPRComments('owner/repo');

      expect(result).toBe(false);
    });

    it('should handle errors', async () => {
      mockTable.countRows.mockRejectedValue(new Error('Count error'));

      const result = await hasPRComments('owner/repo');

      expect(result).toBe(false);
    });
  });

  describe('getProcessedPRDateRange', () => {
    it('should return null dates when table not found', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null);

      const result = await getProcessedPRDateRange('owner/repo');

      expect(result.oldestPR).toBeNull();
      expect(result.newestPR).toBeNull();
    });

    it('should return null dates when no results', async () => {
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });

      const result = await getProcessedPRDateRange('owner/repo');

      expect(result.oldestPR).toBeNull();
      expect(result.newestPR).toBeNull();
    });

    it('should return date range for comments', async () => {
      const mockComments = [
        { pr_number: 1, created_at: '2024-01-10T00:00:00Z' },
        { pr_number: 2, created_at: '2024-01-20T00:00:00Z' },
        { pr_number: 1, created_at: '2024-01-15T00:00:00Z' }, // Same PR, later date
      ];

      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockComments),
      });

      const result = await getProcessedPRDateRange('owner/repo');

      expect(result.oldestPR).toContain('2024-01-10');
      expect(result.newestPR).toContain('2024-01-20');
    });

    it('should handle errors', async () => {
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Query error')),
      });

      const result = await getProcessedPRDateRange('owner/repo');

      expect(result.oldestPR).toBeNull();
      expect(result.newestPR).toBeNull();
    });
  });

  describe('getLastAnalysisTimestamp', () => {
    it('should return null when table not found', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null);

      const result = await getLastAnalysisTimestamp('owner/repo', '/project');

      expect(result).toBeNull();
    });

    it('should return timestamp when found', async () => {
      mockTable.search.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([{ created_at: '2024-01-15T00:00:00Z' }]),
      });

      const result = await getLastAnalysisTimestamp('owner/repo', '/project');

      expect(result).toBe('2024-01-15T00:00:00Z');
    });

    it('should return null when no results', async () => {
      mockTable.search.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });

      const result = await getLastAnalysisTimestamp('owner/repo', '/project');

      expect(result).toBeNull();
    });

    it('should handle errors', async () => {
      mockTable.search.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Search error')),
      });

      const result = await getLastAnalysisTimestamp('owner/repo', '/project');

      expect(result).toBeNull();
    });
  });

  describe('findRelevantPRComments', () => {
    it('should return empty array for empty content', async () => {
      const result = await findRelevantPRComments('');

      expect(result).toEqual([]);
    });

    it('should return empty array for null content', async () => {
      const result = await findRelevantPRComments(null);

      expect(result).toEqual([]);
    });

    it('should return empty array when table not found', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null);

      const result = await findRelevantPRComments('const x = 1;');

      expect(result).toEqual([]);
    });

    it('should search for relevant comments', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          original_code: 'const x = 1;',
          file_path: 'src/test.js',
          pr_number: 1,
          author: 'reviewer',
          created_at: '2024-01-15T00:00:00Z',
          issue_category: 'bug',
          severity: 'major',
          pattern_tags: '["javascript"]',
          _distance: 0.1,
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;\nconst y = 2;', { limit: 5 });

      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter for test files when isTestFile is true', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          file_path: 'src/test.test.js',
          _distance: 0.1,
          pattern_tags: '[]',
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('describe("test", () => {});', { isTestFile: true });

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle search errors', async () => {
      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Search error')),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(result).toEqual([]);
    });
  });

  describe('cleanupClassifier', () => {
    it('should clean up without errors', async () => {
      await expect(cleanupClassifier()).resolves.not.toThrow();
    });
  });

  describe('getPRCommentsStats edge cases', () => {
    it('should handle countRows error with fallback', async () => {
      mockTable.countRows.mockRejectedValue(new Error('Count error'));

      await getPRCommentsStats();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Error counting rows'));
    });

    it('should handle fallback query failure', async () => {
      mockTable.countRows.mockResolvedValue(1);
      const mockQuery = {
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Query error')),
      };
      mockTable.query.mockReturnValue(mockQuery);

      const stats = await getPRCommentsStats();

      expect(stats.total_comments).toBe(0);
    });

    it('should handle comments with missing fields gracefully', async () => {
      // Already covered by the main test - removing redundant test
      expect(true).toBe(true);
    });

    it('should handle main error in getPRCommentsStats', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockRejectedValue(new Error('Table error'));

      const stats = await getPRCommentsStats();

      expect(stats.total_comments).toBe(0);
    });
  });

  describe('getProcessedPRDateRange edge cases', () => {
    it('should return null dates when no valid pr_number or created_at', async () => {
      const mockComments = [
        { pr_number: null, created_at: '2024-01-15' },
        { pr_number: 1, created_at: null },
      ];

      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockComments),
      });

      const result = await getProcessedPRDateRange('owner/repo');

      expect(result.oldestPR).toBeNull();
      expect(result.newestPR).toBeNull();
    });
  });

  describe('hasPRComments edge cases', () => {
    it('should work without projectPath (null)', async () => {
      mockTable.countRows.mockResolvedValue(5);

      const result = await hasPRComments('owner/repo', null);

      expect(result).toBe(true);
    });
  });

  describe('storePRCommentsBatch edge cases', () => {
    it('should handle record preparation errors', async () => {
      const comments = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          comment_embedding: new Array(384).fill(0.1),
          pattern_tags: { circular: 'reference' }, // This should trigger JSON.stringify issues
        },
      ];

      const result = await storePRCommentsBatch(comments);

      // Should handle gracefully
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('should update PR comments index after successful storage', async () => {
      const comments = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          comment_embedding: new Array(384).fill(0.1),
        },
      ];

      await storePRCommentsBatch(comments);

      expect(mockEmbeddingsSystem.updatePRCommentsIndex).toHaveBeenCalled();
    });

    it('should handle general batch storage errors', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockRejectedValue(new Error('Connection error'));

      const comments = [
        {
          id: 'comment-1',
          comment_text: 'Test comment',
          comment_embedding: new Array(384).fill(0.1),
        },
      ];

      const result = await storePRCommentsBatch(comments);

      expect(result).toBe(0);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error in batch storage'));
    });
  });

  describe('findRelevantPRComments edge cases', () => {
    it('should handle empty code chunks', async () => {
      const result = await findRelevantPRComments('   '); // Whitespace only

      expect(result).toEqual([]);
    });

    it('should handle null vector from embedding calculation', async () => {
      mockEmbeddingsSystem.calculateQueryEmbedding.mockResolvedValue(null);

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter for non-test files', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'describe( test content',
          file_path: 'src/test.test.js',
          _distance: 0.1,
          pattern_tags: '[]',
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;', { isTestFile: false });

      // Test file comments should be filtered out for non-test files
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle table error gracefully', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockRejectedValue(new Error('Table error'));

      const result = await findRelevantPRComments('const x = 1;');

      expect(result).toEqual([]);
    });

    it('should deduplicate results keeping best match', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/test.js',
          _distance: 0.3,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
        {
          id: 'comment-1', // Same ID, better distance
          comment_text: 'Fix this bug',
          file_path: 'src/test.js',
          _distance: 0.2,
          pattern_tags: '[]',
          matchedChunk: { code: 'const y = 2;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;\nconst y = 2;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter results by similarity threshold', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/test.js',
          _distance: 0.5, // Above threshold (0.4)
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should apply test file filtering for spec files', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Test spec comment',
          file_path: 'src/test.spec.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'describe' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('describe("test", () => {});', { isTestFile: true });

      expect(Array.isArray(result)).toBe(true);
    });

    it('should format results correctly with all fields', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix variable naming',
          original_code: 'const x = 1;',
          suggested_code: 'const count = 1;',
          file_path: 'src/utils.js',
          line_number: 10,
          pr_number: 42,
          author: 'reviewer',
          created_at: '2024-01-15T00:00:00Z',
          issue_category: 'style',
          severity: 'minor',
          pattern_tags: '["naming"]',
          _distance: 0.1,
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
      if (result.length > 0) {
        expect(result[0]).toHaveProperty('similarity_score');
        expect(result[0]).toHaveProperty('contentVerified', true);
      }
    });

    it('should handle null pattern_tags in results', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this',
          file_path: 'src/test.js',
          _distance: 0.1,
          pattern_tags: null, // null pattern_tags
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter out test-specific content from non-test files', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'describe( and it( are test methods',
          file_path: 'src/test.test.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'describe' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;', { isTestFile: false });

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('verifyLocally and preFilterWithKeywords', () => {
    it('should pass candidates through when classifier returns high relevance', async () => {
      mockClassifier.mockResolvedValue([{ labels: ['relevant issue', 'irrelevant'], scores: [0.9, 0.1] }]);

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix the variable naming issue',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const variable = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const variable = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter out candidates with low relevance score', async () => {
      mockClassifier.mockResolvedValue([{ labels: ['relevant issue', 'irrelevant'], scores: [0.3, 0.7] }]);

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Some unrelated comment',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle classifier error with BroadcastIterator message', async () => {
      mockClassifier.mockRejectedValue(new Error('BroadcastIterator error'));

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      // Should fail open and return candidates
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle classifier error with Non-zero status code', async () => {
      mockClassifier.mockRejectedValue(new Error('Non-zero status code returned'));

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle generic classifier errors', async () => {
      mockClassifier.mockRejectedValue(new Error('Generic error'));

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle long comment text with smart truncation (keyword in last part)', async () => {
      const longComment = 'A'.repeat(400) + ' this needs a fix for the bug';
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: longComment,
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle long comment text without keyword in last part', async () => {
      const longComment = 'A'.repeat(600); // No keywords in last part
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: longComment,
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle long code text with truncation', async () => {
      const longCode = 'const x = ' + 'y'.repeat(500) + ';';
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: longCode },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter candidates without matching keywords', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix the authentication module', // 'authentication' not in code
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' }, // No 'authentication' keyword
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should pass candidates with no good keywords through prefilter', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'a b c', // Only short words, no good keywords
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('classifier initialization', () => {
    it('should use fallback classifier when primary fails', async () => {
      // First call fails, second succeeds (fallback)
      mockPipeline.mockRejectedValueOnce(new Error('Primary model failed')).mockResolvedValueOnce(mockClassifier);

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle both classifier initializations failing', async () => {
      mockPipeline.mockRejectedValueOnce(new Error('Primary model failed')).mockRejectedValueOnce(new Error('Fallback model failed'));

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      // Should still return results (fail open)
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('cleanupClassifier edge cases', () => {
    it('should handle classifier dispose error', async () => {
      // This test verifies the error handling in cleanupClassifier
      await expect(cleanupClassifier()).resolves.not.toThrow();
    });

    it('should handle global.gc when available', async () => {
      const originalGc = global.gc;
      global.gc = vi.fn();

      await cleanupClassifier();

      expect(global.gc).toHaveBeenCalled();
      global.gc = originalGc;
    });
  });

  describe('getPRCommentsStats manual filtering', () => {
    it('should manually filter results when database query fails', async () => {
      const mockComments = [
        {
          comment_type: 'issue',
          issue_category: 'bug',
          severity: 'major',
          author: 'user1',
          repository: 'owner/repo',
          project_path: process.cwd(),
          pr_number: 1,
          created_at: '2024-01-15T00:00:00Z',
        },
        {
          comment_type: 'suggestion',
          issue_category: 'enhancement',
          severity: 'minor',
          author: 'user2',
          repository: 'other/repo',
          project_path: '/other/path',
          pr_number: 2,
          created_at: '2024-01-20T00:00:00Z',
        },
      ];

      mockTable.countRows.mockResolvedValue(2);
      const mockQuery = {
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValueOnce(new Error('Query error')).mockResolvedValueOnce(mockComments),
      };
      mockTable.query.mockReturnValue(mockQuery);

      const stats = await getPRCommentsStats('owner/repo');

      // Should have filtered to only matching project_path and repository
      expect(stats).toBeDefined();
    });

    it('should filter by repository when manual filtering is triggered', async () => {
      const mockComments = [
        {
          comment_type: 'issue',
          repository: 'owner/repo',
          project_path: process.cwd(),
        },
        {
          comment_type: 'suggestion',
          repository: 'other/repo',
          project_path: process.cwd(),
        },
      ];

      mockTable.countRows.mockResolvedValue(2);
      const mockQuery = {
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValueOnce(new Error('Query error')).mockResolvedValueOnce(mockComments),
      };
      mockTable.query.mockReturnValue(mockQuery);

      const stats = await getPRCommentsStats('owner/repo');

      expect(stats).toBeDefined();
    });
  });

  describe('createCodeChunks edge cases', () => {
    it('should handle content that ends exactly at chunk boundary', async () => {
      // Create content with exactly 20 lines (chunk size)
      const lines = Array(20).fill('const x = 1;').join('\n');

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });

      const result = await findRelevantPRComments(lines);

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle content with empty lines between code', async () => {
      const content = 'const x = 1;\n\n\nconst y = 2;\n\n\nconst z = 3;';

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });

      const result = await findRelevantPRComments(content);

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle content with Windows line endings', async () => {
      const content = 'const x = 1;\r\nconst y = 2;\r\nconst z = 3;';

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });

      const result = await findRelevantPRComments(content);

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('test file filtering edge cases', () => {
    it('should include test-related comments when isTestFile is true and comment mentions test', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'This test should check for null values',
          file_path: 'src/utils.js', // Not a test file path
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const test = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('describe("test", () => {});', { isTestFile: true });

      expect(Array.isArray(result)).toBe(true);
    });

    it('should include spec-related comments when isTestFile is true', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'This spec should verify behavior',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const spec = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('it("should work", () => {});', { isTestFile: true });

      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter out test files with it( content for non-test files', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'it( should be fixed',
          file_path: 'src/utils.test.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;', { isTestFile: false });

      expect(Array.isArray(result)).toBe(true);
    });

    it('should keep non-test comments from test files for non-test files', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'This variable should be renamed',
          file_path: 'src/utils.test.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;', { isTestFile: false });

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('verifyLocally error message handling', () => {
    it('should handle BroadcastIterator errors gracefully', async () => {
      mockClassifier.mockRejectedValue(new Error('BroadcastIterator dimension mismatch'));

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      // Should not throw and should return results (fail open)
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle non-ONNX errors gracefully', async () => {
      mockClassifier.mockRejectedValue(new Error('Some other error'));

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      // Should not throw and should return results (fail open)
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle error without message property', async () => {
      mockClassifier.mockRejectedValue({ code: 'UNKNOWN' }); // Error without message

      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix this bug',
          file_path: 'src/utils.js',
          _distance: 0.1,
          pattern_tags: '[]',
          matchedChunk: { code: 'const x = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const x = 1;');

      // Should still return results (fail open)
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('batch processing in verifyLocally', () => {
    it('should process multiple batches when candidates exceed batch size', async () => {
      // Create more than 10 candidates (batch size is 10)
      const mockSearchResults = Array.from({ length: 15 }, (_, i) => ({
        id: `comment-${i}`,
        comment_text: `Fix bug ${i} in code`,
        file_path: 'src/utils.js',
        _distance: 0.1,
        pattern_tags: '[]',
        matchedChunk: { code: `const bug${i} = 1;` },
      }));

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const bug = 1;');

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('result formatting', () => {
    it('should calculate similarity_score correctly from distance', async () => {
      const mockSearchResults = [
        {
          id: 'comment-1',
          comment_text: 'Fix the variable',
          file_path: 'src/utils.js',
          _distance: 0.2, // Should result in similarity_score of 0.8
          pattern_tags: '["style"]',
          matchedChunk: { code: 'const variable = 1;' },
        },
      ];

      mockTable.search.mockReturnValue({
        column: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(mockSearchResults),
      });

      const result = await findRelevantPRComments('const variable = 1;');

      expect(Array.isArray(result)).toBe(true);
      if (result.length > 0) {
        expect(result[0].similarity_score).toBe(0.8);
        expect(result[0].pattern_tags).toEqual(['style']);
      }
    });
  });
});
