import { filterBotComments } from './bot-detector.js';
import { PRCommentProcessor } from './comment-processor.js';

const mockEmbeddingsSystem = vi.hoisted(() => ({
  calculateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
}));

vi.mock('../embeddings/factory.js', () => ({
  getDefaultEmbeddingsSystem: vi.fn(() => mockEmbeddingsSystem),
}));

vi.mock('./bot-detector.js', () => ({
  filterBotComments: vi.fn((comments) => comments),
}));

describe('PRCommentProcessor', () => {
  let processor;

  beforeEach(() => {
    mockConsoleSelective('error');

    // Reset the mock before each test
    mockEmbeddingsSystem.calculateEmbedding.mockResolvedValue(new Array(384).fill(0.1));

    processor = new PRCommentProcessor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractMetadata', () => {
    it('should extract metadata from comment', () => {
      const comment = {
        id: 12345,
        body: 'This is a review comment',
        user: { login: 'testuser' },
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        path: 'src/app.js',
        position: 10,
        pull_request_review_id: 67890,
      };
      const prContext = {
        pr: { number: 42, repository: 'owner/repo' },
      };

      const metadata = processor.extractMetadata(comment, prContext);

      expect(metadata.id).toBe('12345');
      expect(metadata.pr_number).toBe(42);
      expect(metadata.repository).toBe('owner/repo');
      expect(metadata.author).toBe('testuser');
      expect(metadata.comment_type).toBe('review');
    });

    it('should handle missing user gracefully', () => {
      const comment = {
        id: 123,
        body: 'Comment',
        user: null,
        created_at: '2024-01-01T00:00:00Z',
      };
      const prContext = { pr: {} };

      const metadata = processor.extractMetadata(comment, prContext);

      expect(metadata.author).toBe('unknown');
    });
  });

  describe('determineCommentType', () => {
    it('should return "review" for comments with path and position', () => {
      const comment = { path: 'file.js', position: 10 };
      expect(processor.determineCommentType(comment)).toBe('review');
    });

    it('should return "inline" for comments with path and line', () => {
      const comment = { path: 'file.js', line: 5 };
      expect(processor.determineCommentType(comment)).toBe('inline');
    });

    it('should return "issue" for general comments', () => {
      const comment = { body: 'General comment' };
      expect(processor.determineCommentType(comment)).toBe('issue');
    });
  });

  describe('extractLineRange', () => {
    it('should extract line range from diff hunk', () => {
      const diffHunk = '@@ -10,5 +15,7 @@ function example() {';
      const range = processor.extractLineRange(diffHunk);

      expect(range.start).toBe(15);
      expect(range.end).toBe(21); // 15 + 7 - 1
      expect(range.contextLines).toBe(7);
    });

    it('should handle hunks without context line count', () => {
      const diffHunk = '@@ -10 +15 @@ function example() {';
      const range = processor.extractLineRange(diffHunk);

      expect(range.start).toBe(15);
      expect(range.contextLines).toBe(1);
    });

    it('should return nulls for invalid diff hunk', () => {
      const diffHunk = 'invalid hunk';
      const range = processor.extractLineRange(diffHunk);

      expect(range.start).toBeNull();
      expect(range.end).toBeNull();
    });
  });

  describe('extractCodeFromDiff', () => {
    it('should extract original and suggested code', () => {
      const diffHunk = `@@ -1,3 +1,3 @@
 context line
-old code
+new code
 more context`;

      const result = processor.extractCodeFromDiff(diffHunk);

      expect(result.original_code).toBe('old code');
      expect(result.suggested_code).toBe('new code');
      expect(result.context_lines).toContain('context line');
    });

    it('should handle multi-line changes', () => {
      const diffHunk = `@@ -1,4 +1,4 @@
-line1
-line2
+newline1
+newline2`;

      const result = processor.extractCodeFromDiff(diffHunk);

      expect(result.original_code).toBe('line1\nline2');
      expect(result.suggested_code).toBe('newline1\nnewline2');
    });

    it('should return null for no changes', () => {
      const diffHunk = `@@ -1,2 +1,2 @@
 unchanged line
 another unchanged`;

      const result = processor.extractCodeFromDiff(diffHunk);

      expect(result.original_code).toBeNull();
      expect(result.suggested_code).toBeNull();
    });
  });

  describe('classifyComment', () => {
    it('should classify security-related comments', async () => {
      const result = await processor.classifyComment('This has a SQL injection vulnerability');

      expect(result.issue_category).toBe('security');
      expect(result.severity).toBe('major'); // Security defaults to major
    });

    it('should classify performance-related comments', async () => {
      const result = await processor.classifyComment('This loop is inefficient and causes a bottleneck');

      expect(result.issue_category).toBe('performance');
    });

    it('should classify style-related comments', async () => {
      const result = await processor.classifyComment('Please follow the naming convention');

      expect(result.issue_category).toBe('style');
    });

    it('should classify logic-related comments', async () => {
      const result = await processor.classifyComment('This condition is always false');

      expect(result.issue_category).toBe('logic');
    });

    it('should detect critical severity', async () => {
      const result = await processor.classifyComment('This will crash the application');

      expect(result.severity).toBe('critical');
    });

    it('should detect major severity', async () => {
      const result = await processor.classifyComment('This is a serious issue that will cause failure');

      expect(result.severity).toBe('major');
    });

    it('should generate pattern tags', async () => {
      const result = await processor.classifyComment('Add error handling for this async operation');

      expect(result.pattern_tags).toContain('error_handling');
      expect(result.pattern_tags).toContain('async_await');
    });
  });

  describe('generatePatternTags', () => {
    it('should generate error handling tags', () => {
      const tags = processor.generatePatternTags('Need better error handling here');
      expect(tags).toContain('error_handling');
    });

    it('should generate validation tags', () => {
      const tags = processor.generatePatternTags('Add input validation');
      expect(tags).toContain('input_validation');
    });

    it('should generate null check tags', () => {
      const tags = processor.generatePatternTags('Check for null before accessing');
      expect(tags).toContain('null_check');
    });

    it('should deduplicate tags', () => {
      const tags = processor.generatePatternTags('error error handling error');
      const errorCount = tags.filter((t) => t === 'error_handling').length;
      expect(errorCount).toBe(1);
    });
  });

  describe('identifyPatterns', () => {
    it('should identify recurring patterns across comments', () => {
      const comments = ['Add error handling here', 'Need error handling for this case', 'Consider input validation', 'Validate the input'];

      const patterns = processor.identifyPatterns(comments);

      expect(patterns).toContain('error_handling');
      expect(patterns).toContain('input_validation');
    });

    it('should only return patterns that appear multiple times', () => {
      const comments = ['Add error handling', 'Fix the typo', 'Update documentation'];

      const patterns = processor.identifyPatterns(comments);

      // Each pattern only appears once, so none should be returned
      expect(patterns.length).toBe(0);
    });
  });

  describe('calculatePatternWeights', () => {
    it('should calculate normalized pattern weights', () => {
      const comments = ['Add error handling', 'More error handling needed', 'Fix security issue', 'Another comment'];

      const weights = processor.calculatePatternWeights(comments);

      expect(weights.error_handling).toBe(0.5); // 2/4
      expect(weights.security).toBe(0.25); // 1/4
    });
  });

  describe('processComment', () => {
    it('should process a valid comment', async () => {
      const comment = {
        id: 123,
        body: 'Please add error handling',
        user: { login: 'reviewer' },
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        path: 'src/app.js',
        position: 10,
      };
      const prContext = {
        pr: { number: 1, repository: 'owner/repo' },
        files: [],
      };

      const result = await processor.processComment(comment, prContext);

      expect(result.id).toBe('123');
      expect(result.comment_embedding).toHaveLength(384);
      expect(result.issue_category).toBeDefined();
      expect(result.pattern_tags).toBeDefined();
    });

    it('should throw error for invalid comment data', async () => {
      await expect(processor.processComment(null, {})).rejects.toThrow('Invalid comment data');
      await expect(processor.processComment({ body: null }, {})).rejects.toThrow('Invalid comment data');
    });

    it('should include code embedding when code context exists', async () => {
      const comment = {
        id: 123,
        body: 'Fix this',
        user: { login: 'reviewer' },
        created_at: '2024-01-01T00:00:00Z',
        diff_hunk: '@@ -1,1 +1,1 @@\n-old\n+new',
      };
      const prContext = { pr: { number: 1 }, files: [] };

      const result = await processor.processComment(comment, prContext);

      expect(result.code_embedding).toHaveLength(384);
      expect(result.combined_embedding).toHaveLength(384);
    });
  });

  describe('processBatch', () => {
    it('should process multiple comments', async () => {
      const comments = [
        { id: 1, body: 'Comment 1', user: { login: 'user1' }, created_at: '2024-01-01' },
        { id: 2, body: 'Comment 2', user: { login: 'user2' }, created_at: '2024-01-01' },
      ];
      const prContext = { pr: { number: 1 }, files: [] };

      const results = await processor.processBatch(comments, prContext);

      expect(results.length).toBe(2);
    });

    it('should filter out bot comments', async () => {
      filterBotComments.mockReturnValue([{ id: 1, body: 'Human comment', user: { login: 'human' }, created_at: '2024-01-01' }]);

      const comments = [
        { id: 1, body: 'Human comment', user: { login: 'human' }, created_at: '2024-01-01' },
        { id: 2, body: 'Bot comment', user: { login: 'dependabot[bot]' }, created_at: '2024-01-01' },
      ];
      const prContext = { pr: { number: 1 }, files: [] };

      const results = await processor.processBatch(comments, prContext);

      expect(filterBotComments).toHaveBeenCalledWith(comments);
      expect(results.length).toBe(1);
    });

    it('should return empty array for empty input', async () => {
      const results = await processor.processBatch([], {});
      expect(results).toEqual([]);
    });

    it('should return empty array when all comments are filtered as bots', async () => {
      filterBotComments.mockReturnValue([]);

      const comments = [{ id: 1, body: 'Bot comment', user: { login: 'dependabot[bot]' }, created_at: '2024-01-01' }];
      const prContext = { pr: { number: 1 }, files: [] };

      const results = await processor.processBatch(comments, prContext);

      expect(results).toEqual([]);
    });

    it('should handle individual comment processing errors gracefully', async () => {
      // Use implementation that fails for specific input
      mockEmbeddingsSystem.calculateEmbedding.mockImplementation((text) => {
        if (text === 'Bad comment') {
          return Promise.reject(new Error('Embedding failed'));
        }
        return Promise.resolve(new Array(384).fill(0.1));
      });

      const comments = [
        { id: 1, body: 'Good comment', user: { login: 'user1' }, created_at: '2024-01-01' },
        { id: 2, body: 'Bad comment', user: { login: 'user2' }, created_at: '2024-01-01' },
      ];
      const prContext = { pr: { number: 1 }, files: [] };

      // Ensure filterBotComments returns all comments
      filterBotComments.mockReturnValue(comments);

      const results = await processor.processBatch(comments, prContext);

      // Verify filterBotComments was called with all comments
      expect(filterBotComments).toHaveBeenCalledWith(comments);

      // Only the successful comment should be in results
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('1');
    });
  });

  describe('processComment edge cases', () => {
    it('should throw error when embedding has undefined length', async () => {
      mockEmbeddingsSystem.calculateEmbedding.mockResolvedValue(null);

      const comment = {
        id: 123,
        body: 'Test comment',
        user: { login: 'reviewer' },
        created_at: '2024-01-01T00:00:00Z',
      };
      const prContext = { pr: { number: 1 }, files: [] };

      await expect(processor.processComment(comment, prContext)).rejects.toThrow('Invalid embedding dimensions');
    });

    it('should throw error when embedding has wrong dimensions', async () => {
      mockEmbeddingsSystem.calculateEmbedding.mockResolvedValue(new Array(256).fill(0.1));

      const comment = {
        id: 123,
        body: 'Test comment',
        user: { login: 'reviewer' },
        created_at: '2024-01-01T00:00:00Z',
      };
      const prContext = { pr: { number: 1 }, files: [] };

      await expect(processor.processComment(comment, prContext)).rejects.toThrow('Invalid embedding dimensions');
    });

    it('should gracefully handle classification failure', async () => {
      // Temporarily break classification
      const originalClassifyComment = processor.classifyComment;
      processor.classifyComment = vi.fn().mockRejectedValue(new Error('Classification failed'));

      const comment = {
        id: 123,
        body: 'Test comment',
        user: { login: 'reviewer' },
        created_at: '2024-01-01T00:00:00Z',
      };
      const prContext = { pr: { number: 1 }, files: [] };

      const result = await processor.processComment(comment, prContext);

      expect(result.issue_category).toBe('unknown');
      expect(result.severity).toBe('minor');
      expect(result.pattern_tags).toEqual([]);

      processor.classifyComment = originalClassifyComment;
    });
  });

  describe('extractCodeContext', () => {
    it('should extract context from file patch when no diff hunk', () => {
      const comment = {
        path: 'src/app.js',
        line: 10,
      };
      const prContext = {
        files: [
          {
            filename: 'src/app.js',
            patch: '@@ -1,3 +1,3 @@\n context\n-old\n+new',
          },
        ],
      };

      const result = processor.extractCodeContext(comment, prContext);

      expect(result.file_path).toBe('src/app.js');
      expect(result.diff_hunk).toBe('@@ -1,3 +1,3 @@\n context\n-old\n+new');
    });

    it('should handle missing file in context', () => {
      const comment = {
        path: 'src/other.js',
        line: 10,
      };
      const prContext = {
        files: [
          {
            filename: 'src/app.js',
            patch: '@@ -1,3 +1,3 @@\n context',
          },
        ],
      };

      const result = processor.extractCodeContext(comment, prContext);

      expect(result.original_code).toBeNull();
      expect(result.diff_hunk).toBeNull();
    });
  });

  describe('extractCodeFromPatch', () => {
    it('should extract code at specific line', () => {
      const patch = '@@ -1,5 +1,5 @@\n context\n-old code\n+new code\n more context';
      const result = processor.extractCodeFromPatch(patch, 2);

      expect(result).toBeDefined();
    });

    it('should handle non-matching line', () => {
      const patch = '@@ -1,3 +1,3 @@\n context\n-old\n+new';
      const result = processor.extractCodeFromPatch(patch, 100);

      expect(result.original_code).toBeNull();
      expect(result.suggested_code).toBeNull();
    });
  });

  describe('combineEmbeddings', () => {
    it('should return null for empty inputs', async () => {
      const result = await processor.combineEmbeddings('', '');
      expect(result).toBeNull();
    });

    it('should throw for invalid combined embedding dimensions', async () => {
      mockEmbeddingsSystem.calculateEmbedding.mockResolvedValue(new Array(256).fill(0.1));

      await expect(processor.combineEmbeddings('comment', 'code')).rejects.toThrow('Invalid combined embedding dimensions');
    });
  });

  describe('classifyComment edge cases', () => {
    it('should detect security from code context', async () => {
      const result = await processor.classifyComment('Review this code', { code: 'const password = user.password' });

      expect(result.issue_category).toBe('security');
    });

    it('should detect security from file path', async () => {
      // The file path detection for security requires the code to include security-related terms
      // or the file path to contain 'auth', and category to be 'general' initially
      const result = await processor.classifyComment('Review this implementation', { file_path: 'src/auth/login.js', code: 'token' });

      expect(result.issue_category).toBe('security');
    });

    it('should detect style severity', async () => {
      const result = await processor.classifyComment('There is a typo here');

      expect(result.severity).toBe('style');
    });
  });
});
