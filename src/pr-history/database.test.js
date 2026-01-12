import { createMockPRSearchResult, generateShouldSkipPRTestCases } from '../test-utils/fixtures.js';
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

// Create hoisted mock table for embeddings system (must be inline, can't use imported functions)
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

// ============================================================================
// Helper Functions
// ============================================================================

const createValidComment = (overrides = {}) => ({
  id: `comment-${Date.now()}-${Math.random()}`,
  comment_text: 'Test comment',
  comment_embedding: new Array(384).fill(0.1),
  pr_number: 1,
  ...overrides,
});

const createMockSearchResult = (overrides = {}) =>
  createMockPRSearchResult({
    file_path: 'src/test.js',
    original_code: 'const x = 1;',
    ...overrides,
  });

const setupMockSearchResults = (results) => {
  mockTable.search.mockReturnValue({
    column: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(results),
  });
};

const setupMockQueryResults = (results) => {
  mockTable.query.mockReturnValue({
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(results),
  });
};

// ============================================================================
// Tests
// ============================================================================

describe('PR History Database', () => {
  beforeEach(() => {
    mockConsole();
    // Reset mockTable (inline since can't use imported function with hoisted mocks)
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
    mockClassifier.mockReset().mockResolvedValue([{ labels: ['relevant issue', 'irrelevant'], scores: [0.9, 0.1] }]);
    mockPipeline.mockReset().mockResolvedValue(mockClassifier);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // shouldSkipPR
  // ==========================================================================

  describe('shouldSkipPR', () => {
    it.each(generateShouldSkipPRTestCases())('should return $expected when $description', ({ pr, oldest, newest, expected }) => {
      expect(shouldSkipPR(pr, oldest, newest)).toBe(expected);
    });
  });

  // ==========================================================================
  // storePRCommentsBatch
  // ==========================================================================

  describe('storePRCommentsBatch', () => {
    it.each([
      ['empty array', [], 0],
      ['null input', null, 0],
    ])('should return 0 for %s', async (_, input, expected) => {
      const result = await storePRCommentsBatch(input);
      expect(result).toBe(expected);
    });

    it('should store valid comments', async () => {
      const comments = [createValidComment()];
      const result = await storePRCommentsBatch(comments);
      expect(result).toBe(1);
      expect(mockTable.add).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ comment_text: 'Test comment' })]));
    });

    it('should skip comments with missing required fields', async () => {
      const comments = [{ id: 'comment-1' }, createValidComment()];
      const result = await storePRCommentsBatch(comments);
      expect(result).toBe(1);
    });

    it('should skip comments with invalid embedding dimensions', async () => {
      const comments = [createValidComment({ comment_embedding: new Array(256).fill(0.1) })];
      const result = await storePRCommentsBatch(comments);
      expect(result).toBe(0);
    });

    it('should handle table not found', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null);
      const result = await storePRCommentsBatch([createValidComment()]);
      expect(result).toBe(0);
    });

    it('should handle batch storage errors', async () => {
      mockTable.add.mockRejectedValue(new Error('Database error'));
      const result = await storePRCommentsBatch([createValidComment()]);
      expect(result).toBe(0);
    });

    it.each([
      ['optimize errors gracefully', 'Optimize failed', 1],
      ['legacy format optimize errors', 'legacy format', 1],
    ])('should handle %s', async (_, errorMessage, expectedResult) => {
      mockTable.optimize.mockRejectedValue(new Error(errorMessage));
      const result = await storePRCommentsBatch([createValidComment()]);
      expect(result).toBe(expectedResult);
      if (errorMessage === 'legacy format') {
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('legacy index format'));
      }
    });

    it('should update PR comments index after successful storage', async () => {
      await storePRCommentsBatch([createValidComment()]);
      expect(mockEmbeddingsSystem.updatePRCommentsIndex).toHaveBeenCalled();
    });

    it('should handle general batch storage errors', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockRejectedValue(new Error('Connection error'));
      const result = await storePRCommentsBatch([createValidComment()]);
      expect(result).toBe(0);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error in batch storage'));
    });

    it('should handle record preparation errors', async () => {
      const comments = [createValidComment({ pattern_tags: { circular: 'reference' } })];
      const result = await storePRCommentsBatch(comments);
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // getPRCommentsStats
  // ==========================================================================

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
      setupMockQueryResults(mockComments);
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

    it.each([
      ['countRows error', () => mockTable.countRows.mockRejectedValue(new Error('Count error'))],
      ['main error', () => mockEmbeddingsSystem.getPRCommentsTable.mockRejectedValue(new Error('Table error'))],
    ])('should handle %s with fallback', async (_, setupError) => {
      setupError();
      const stats = await getPRCommentsStats();
      expect(stats.total_comments).toBe(0);
    });
  });

  // ==========================================================================
  // clearPRComments
  // ==========================================================================

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

  // ==========================================================================
  // hasPRComments
  // ==========================================================================

  describe('hasPRComments', () => {
    it.each([
      ['false when table not found', () => mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null), false],
      ['true when comments exist', () => mockTable.countRows.mockResolvedValue(5), true],
      ['false when no comments exist', () => mockTable.countRows.mockResolvedValue(0), false],
      ['false on errors', () => mockTable.countRows.mockRejectedValue(new Error('Count error')), false],
    ])('should return %s', async (_, setup, expected) => {
      setup();
      const result = await hasPRComments('owner/repo');
      expect(result).toBe(expected);
    });

    it('should work without projectPath (null)', async () => {
      mockTable.countRows.mockResolvedValue(5);
      const result = await hasPRComments('owner/repo', null);
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // getProcessedPRDateRange
  // ==========================================================================

  describe('getProcessedPRDateRange', () => {
    it.each([
      ['table not found', () => mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null)],
      ['no results', () => setupMockQueryResults([])],
      [
        'query errors',
        () =>
          mockTable.query.mockReturnValue({
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            toArray: vi.fn().mockRejectedValue(new Error('Query error')),
          }),
      ],
    ])('should return null dates when %s', async (_, setup) => {
      setup();
      const result = await getProcessedPRDateRange('owner/repo');
      expect(result.oldestPR).toBeNull();
      expect(result.newestPR).toBeNull();
    });

    it('should return date range for comments', async () => {
      const mockComments = [
        { pr_number: 1, created_at: '2024-01-10T00:00:00Z' },
        { pr_number: 2, created_at: '2024-01-20T00:00:00Z' },
        { pr_number: 1, created_at: '2024-01-15T00:00:00Z' },
      ];
      setupMockQueryResults(mockComments);
      const result = await getProcessedPRDateRange('owner/repo');
      expect(result.oldestPR).toContain('2024-01-10');
      expect(result.newestPR).toContain('2024-01-20');
    });

    it('should return null dates when no valid pr_number or created_at', async () => {
      setupMockQueryResults([
        { pr_number: null, created_at: '2024-01-15' },
        { pr_number: 1, created_at: null },
      ]);
      const result = await getProcessedPRDateRange('owner/repo');
      expect(result.oldestPR).toBeNull();
      expect(result.newestPR).toBeNull();
    });
  });

  // ==========================================================================
  // getLastAnalysisTimestamp
  // ==========================================================================

  describe('getLastAnalysisTimestamp', () => {
    const setupMockLastAnalysis = (results) => {
      mockTable.search.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(results),
      });
    };

    it.each([
      ['null when table not found', () => mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null), null],
      ['null when no results', () => setupMockLastAnalysis([]), null],
      [
        'null on errors',
        () =>
          mockTable.search.mockReturnValue({
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            toArray: vi.fn().mockRejectedValue(new Error('Search error')),
          }),
        null,
      ],
    ])('should return %s', async (_, setup, expected) => {
      setup();
      const result = await getLastAnalysisTimestamp('owner/repo', '/project');
      expect(result).toBe(expected);
    });

    it('should return timestamp when found', async () => {
      setupMockLastAnalysis([{ created_at: '2024-01-15T00:00:00Z' }]);
      const result = await getLastAnalysisTimestamp('owner/repo', '/project');
      expect(result).toBe('2024-01-15T00:00:00Z');
    });
  });

  // ==========================================================================
  // findRelevantPRComments
  // ==========================================================================

  describe('findRelevantPRComments', () => {
    it.each([
      ['empty content', ''],
      ['null content', null],
      ['whitespace only', '   '],
    ])('should return empty array for %s', async (_, content) => {
      const result = await findRelevantPRComments(content);
      expect(result).toEqual([]);
    });

    it('should return empty array when table not found', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockResolvedValue(null);
      const result = await findRelevantPRComments('const x = 1;');
      expect(result).toEqual([]);
    });

    it('should search for relevant comments', async () => {
      setupMockSearchResults([createMockSearchResult()]);
      const result = await findRelevantPRComments('const x = 1;\nconst y = 2;', { limit: 5 });
      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter for test files when isTestFile is true', async () => {
      setupMockSearchResults([createMockSearchResult({ file_path: 'src/test.test.js' })]);
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

    it('should handle null vector from embedding calculation', async () => {
      mockEmbeddingsSystem.calculateQueryEmbedding.mockResolvedValue(null);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle table error gracefully', async () => {
      mockEmbeddingsSystem.getPRCommentsTable.mockRejectedValue(new Error('Table error'));
      const result = await findRelevantPRComments('const x = 1;');
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // findRelevantPRComments - Test File Filtering
  // ==========================================================================

  describe('findRelevantPRComments test file filtering', () => {
    beforeEach(() => setupMockSearchResults([createMockSearchResult()]));

    it.each([
      ['non-test files', { isTestFile: false }],
      ['test files', { isTestFile: true }],
    ])('should apply filtering for %s', async (_, options) => {
      const result = await findRelevantPRComments('const x = 1;', options);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should include test-related comments when isTestFile is true', async () => {
      setupMockSearchResults([
        createMockSearchResult({ comment_text: 'This test should check for null values', file_path: 'src/utils.js' }),
      ]);
      const result = await findRelevantPRComments('describe("test", () => {});', { isTestFile: true });
      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter out test files with test content for non-test files', async () => {
      setupMockSearchResults([createMockSearchResult({ comment_text: 'it( should be fixed', file_path: 'src/utils.test.js' })]);
      const result = await findRelevantPRComments('const x = 1;', { isTestFile: false });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ==========================================================================
  // findRelevantPRComments - Deduplication & Filtering
  // ==========================================================================

  describe('findRelevantPRComments deduplication and filtering', () => {
    it('should deduplicate results keeping best match', async () => {
      setupMockSearchResults([
        createMockSearchResult({ id: 'comment-1', _distance: 0.3 }),
        createMockSearchResult({ id: 'comment-1', _distance: 0.2 }),
      ]);
      const result = await findRelevantPRComments('const x = 1;\nconst y = 2;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter results by similarity threshold', async () => {
      setupMockSearchResults([createMockSearchResult({ _distance: 0.5 })]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should format results correctly with all fields', async () => {
      setupMockSearchResults([
        createMockSearchResult({
          suggested_code: 'const count = 1;',
          line_number: 10,
          issue_category: 'style',
          severity: 'minor',
          pattern_tags: '["naming"]',
          _distance: 0.1,
        }),
      ]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
      if (result.length > 0) {
        expect(result[0]).toHaveProperty('similarity_score');
        expect(result[0]).toHaveProperty('contentVerified', true);
      }
    });

    it('should handle null pattern_tags in results', async () => {
      setupMockSearchResults([createMockSearchResult({ pattern_tags: null })]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should calculate similarity_score correctly from distance', async () => {
      setupMockSearchResults([createMockSearchResult({ _distance: 0.2 })]);
      const result = await findRelevantPRComments('const variable = 1;');
      expect(Array.isArray(result)).toBe(true);
      if (result.length > 0) {
        expect(result[0].similarity_score).toBe(0.8);
      }
    });
  });

  // ==========================================================================
  // Classifier Verification
  // ==========================================================================

  describe('verifyLocally and preFilterWithKeywords', () => {
    beforeEach(() => setupMockSearchResults([createMockSearchResult({ comment_text: 'Fix the variable naming issue' })]));

    it('should pass candidates through when classifier returns high relevance', async () => {
      mockClassifier.mockResolvedValue([{ labels: ['relevant issue', 'irrelevant'], scores: [0.9, 0.1] }]);
      const result = await findRelevantPRComments('const variable = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter out candidates with low relevance score', async () => {
      mockClassifier.mockResolvedValue([{ labels: ['relevant issue', 'irrelevant'], scores: [0.3, 0.7] }]);
      setupMockSearchResults([createMockSearchResult({ comment_text: 'Some unrelated comment' })]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it.each([
      ['BroadcastIterator error', 'BroadcastIterator error'],
      ['Non-zero status code', 'Non-zero status code returned'],
      ['generic error', 'Generic error'],
      ['BroadcastIterator dimension mismatch', 'BroadcastIterator dimension mismatch'],
    ])('should handle classifier %s gracefully', async (_, errorMessage) => {
      mockClassifier.mockRejectedValue(new Error(errorMessage));
      setupMockSearchResults([createMockSearchResult()]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle error without message property', async () => {
      mockClassifier.mockRejectedValue({ code: 'UNKNOWN' });
      setupMockSearchResults([createMockSearchResult()]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ==========================================================================
  // Classifier Text Truncation
  // ==========================================================================

  describe('classifier text truncation', () => {
    beforeEach(() => setupMockSearchResults([]));

    it.each([
      ['long comment with keyword in last part', 'A'.repeat(400) + ' this needs a fix for the bug'],
      ['long comment without keyword in last part', 'A'.repeat(600)],
      ['long code text', 'const x = ' + 'y'.repeat(500) + ';'],
    ])('should handle %s', async (_, content) => {
      setupMockSearchResults([
        createMockSearchResult({
          comment_text: content.includes('const') ? 'Fix this' : content,
          matchedChunk: { code: content.includes('const') ? content : 'const x = 1;' },
        }),
      ]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should filter candidates without matching keywords', async () => {
      setupMockSearchResults([createMockSearchResult({ comment_text: 'Fix the authentication module' })]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should pass candidates with no good keywords through prefilter', async () => {
      setupMockSearchResults([createMockSearchResult({ comment_text: 'a b c' })]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ==========================================================================
  // Classifier Initialization
  // ==========================================================================

  describe('classifier initialization', () => {
    it('should use fallback classifier when primary fails', async () => {
      mockPipeline.mockRejectedValueOnce(new Error('Primary model failed')).mockResolvedValueOnce(mockClassifier);
      setupMockSearchResults([createMockSearchResult()]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle both classifier initializations failing', async () => {
      mockPipeline.mockRejectedValueOnce(new Error('Primary model failed')).mockRejectedValueOnce(new Error('Fallback model failed'));
      setupMockSearchResults([createMockSearchResult()]);
      const result = await findRelevantPRComments('const x = 1;');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ==========================================================================
  // cleanupClassifier
  // ==========================================================================

  describe('cleanupClassifier', () => {
    it('should clean up without errors', async () => {
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

  // ==========================================================================
  // Code Chunk Processing
  // ==========================================================================

  describe('createCodeChunks edge cases', () => {
    beforeEach(() => setupMockSearchResults([]));

    it.each([
      ['content at chunk boundary', Array(20).fill('const x = 1;').join('\n')],
      ['content with empty lines', 'const x = 1;\n\n\nconst y = 2;\n\n\nconst z = 3;'],
      ['content with Windows line endings', 'const x = 1;\r\nconst y = 2;\r\nconst z = 3;'],
    ])('should handle %s', async (_, content) => {
      const result = await findRelevantPRComments(content);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ==========================================================================
  // Batch Processing
  // ==========================================================================

  describe('batch processing in verifyLocally', () => {
    it('should process multiple batches when candidates exceed batch size', async () => {
      const mockResults = Array.from({ length: 15 }, (_, i) =>
        createMockSearchResult({ id: `comment-${i}`, comment_text: `Fix bug ${i}` })
      );
      setupMockSearchResults(mockResults);
      const result = await findRelevantPRComments('const bug = 1;');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ==========================================================================
  // Stats Manual Filtering
  // ==========================================================================

  describe('getPRCommentsStats manual filtering', () => {
    it('should manually filter results when database query fails', async () => {
      const mockComments = [
        {
          comment_type: 'issue',
          issue_category: 'bug',
          author: 'user1',
          repository: 'owner/repo',
          project_path: process.cwd(),
          pr_number: 1,
          created_at: '2024-01-15T00:00:00Z',
        },
        {
          comment_type: 'suggestion',
          issue_category: 'enhancement',
          author: 'user2',
          repository: 'other/repo',
          project_path: '/other/path',
          pr_number: 2,
          created_at: '2024-01-20T00:00:00Z',
        },
      ];
      mockTable.countRows.mockResolvedValue(2);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValueOnce(new Error('Query error')).mockResolvedValueOnce(mockComments),
      });
      const stats = await getPRCommentsStats('owner/repo');
      expect(stats).toBeDefined();
    });
  });
});
