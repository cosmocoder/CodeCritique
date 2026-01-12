import { PRHistoryAnalyzer } from './analyzer.js';
import { clearPRComments, getPRCommentsStats, storePRCommentsBatch } from './database.js';

vi.mock('./comment-processor.js', () => ({
  PRCommentProcessor: class {
    processBatch = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('./database.js', () => ({
  clearPRComments: vi.fn().mockResolvedValue(0),
  getPRCommentsStats: vi.fn().mockResolvedValue({
    total_comments: 0,
    comment_types: {},
    issue_categories: {},
    severity_levels: {},
    authors: {},
    repositories: {},
  }),
  getProcessedPRDateRange: vi.fn().mockResolvedValue({ oldestPR: null, newestPR: null }),
  shouldSkipPR: vi.fn().mockReturnValue(false),
  storePRCommentsBatch: vi.fn().mockResolvedValue(0),
}));

vi.mock('./github-client.js', () => ({
  GitHubAPIClient: class {
    fetchAllPRs = vi.fn().mockResolvedValue([]);
    getPRReviewComments = vi.fn().mockResolvedValue([]);
    getPRIssueComments = vi.fn().mockResolvedValue([]);
    getPRFiles = vi.fn().mockResolvedValue([]);
  },
}));

describe('PRHistoryAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    mockConsole();

    analyzer = new PRHistoryAnalyzer();
    analyzer.initialize('test-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create analyzer with default options', () => {
      const defaultAnalyzer = new PRHistoryAnalyzer();

      expect(defaultAnalyzer.options.concurrency).toBe(2);
      expect(defaultAnalyzer.options.batchSize).toBe(50);
      expect(defaultAnalyzer.options.skipDependabot).toBe(true);
    });

    it('should accept custom options', () => {
      const customAnalyzer = new PRHistoryAnalyzer({
        concurrency: 5,
        batchSize: 100,
        skipDependabot: false,
      });

      expect(customAnalyzer.options.concurrency).toBe(5);
      expect(customAnalyzer.options.batchSize).toBe(100);
      expect(customAnalyzer.options.skipDependabot).toBe(false);
    });
  });

  describe('initialize', () => {
    it('should create GitHub client with token', () => {
      const newAnalyzer = new PRHistoryAnalyzer();
      expect(newAnalyzer.githubClient).toBeNull();

      newAnalyzer.initialize('my-token');

      // After initialization, githubClient should be created
      expect(newAnalyzer.githubClient).toBeDefined();
      expect(newAnalyzer.githubClient).not.toBeNull();
    });
  });

  describe('analyzeRepository', () => {
    it('should return results when no PRs found', async () => {
      analyzer.githubClient.fetchAllPRs.mockResolvedValue([]);

      const result = await analyzer.analyzeRepository('owner/repo');

      expect(result.repository).toBe('owner/repo');
      expect(result.total_prs).toBe(0);
      expect(result.total_comments).toBe(0);
    });

    it('should process PRs with merged_at', async () => {
      const prs = [
        { number: 1, merged_at: '2024-01-01', comments: 5, review_comments: 3 },
        { number: 2, merged_at: '2024-01-02', comments: 2, review_comments: 1 },
      ];
      analyzer.githubClient.fetchAllPRs.mockResolvedValue(prs);

      const result = await analyzer.analyzeRepository('owner/repo');

      expect(result.repository).toBe('owner/repo');
    });

    it('should clear existing data when clearExisting is true', async () => {
      await analyzer.analyzeRepository('owner/repo', { clearExisting: true });

      expect(clearPRComments).toHaveBeenCalledWith('owner/repo', expect.any(String));
    });

    it('should store processed comments', async () => {
      const prs = [{ number: 1, merged_at: '2024-01-01' }];
      analyzer.githubClient.fetchAllPRs.mockResolvedValue(prs);
      analyzer.githubClient.getPRReviewComments.mockResolvedValue([{ id: 1, body: 'Comment', user: { login: 'user' } }]);
      analyzer.commentProcessor.processBatch.mockResolvedValue([{ id: '1', comment_text: 'Comment', comment_embedding: [] }]);

      await analyzer.analyzeRepository('owner/repo');

      expect(storePRCommentsBatch).toHaveBeenCalled();
    });

    it('should call onProgress callback', async () => {
      const onProgress = vi.fn();
      const prs = [{ number: 1, merged_at: '2024-01-01' }];
      analyzer.githubClient.fetchAllPRs.mockResolvedValue(prs);

      await analyzer.analyzeRepository('owner/repo', { onProgress });

      expect(onProgress).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      analyzer.githubClient.fetchAllPRs.mockRejectedValue(new Error('API Error'));

      await expect(analyzer.analyzeRepository('owner/repo')).rejects.toThrow('API Error');
    });
  });

  describe('getProgressStatus', () => {
    it('should return not_started for new repository', async () => {
      const result = await analyzer.getProgressStatus('owner/repo');

      expect(result.status).toBe('not_started');
    });
  });

  describe('resumeAnalysis', () => {
    it('should call analyzeRepository with resume option', async () => {
      const analyzeSpy = vi.spyOn(analyzer, 'analyzeRepository');
      analyzer.githubClient.fetchAllPRs.mockResolvedValue([]);

      await analyzer.resumeAnalysis('owner/repo', { limit: 100 });

      expect(analyzeSpy).toHaveBeenCalledWith('owner/repo', expect.objectContaining({ resume: true }));
    });
  });

  describe('processSinglePR', () => {
    it('should fetch and process all comment types', async () => {
      analyzer.progress = { repository: 'owner/repo' };

      analyzer.githubClient.getPRReviewComments.mockResolvedValue([{ id: 1, body: 'Review comment', user: { login: 'user' } }]);
      analyzer.githubClient.getPRIssueComments.mockResolvedValue([{ id: 2, body: 'Issue comment', user: { login: 'user' } }]);
      analyzer.githubClient.getPRFiles.mockResolvedValue([{ filename: 'file.js', patch: '...' }]);

      await analyzer.processSinglePR({ number: 1 });

      expect(analyzer.githubClient.getPRReviewComments).toHaveBeenCalledWith('owner', 'repo', 1);
      expect(analyzer.githubClient.getPRIssueComments).toHaveBeenCalledWith('owner', 'repo', 1);
      expect(analyzer.githubClient.getPRFiles).toHaveBeenCalledWith('owner', 'repo', 1);
      expect(analyzer.commentProcessor.processBatch).toHaveBeenCalled();
    });

    it('should return empty array when no comments', async () => {
      analyzer.progress = { repository: 'owner/repo' };

      analyzer.githubClient.getPRReviewComments.mockResolvedValue([]);
      analyzer.githubClient.getPRIssueComments.mockResolvedValue([]);
      analyzer.githubClient.getPRFiles.mockResolvedValue([]);

      const result = await analyzer.processSinglePR({ number: 1 });

      expect(result).toEqual([]);
    });
  });

  describe('getAnalysisResults', () => {
    it('should format analysis results correctly', async () => {
      getPRCommentsStats.mockResolvedValue({
        total_comments: 100,
        comment_types: { review: 60, inline: 40 },
        issue_categories: { security: 30, style: 70 },
        severity_levels: { major: 20, minor: 80 },
        authors: { user1: 50, user2: 30, user3: 20 },
        repositories: { 'owner/repo': 100 },
      });

      const result = await analyzer.getAnalysisResults('owner/repo');

      expect(result.repository).toBe('owner/repo');
      expect(result.total_comments).toBe(100);
      expect(result.patterns.length).toBeGreaterThan(0);
      expect(result.top_authors.length).toBe(3);
      expect(result.top_authors[0].author).toBe('user1');
    });

    it('should handle errors in stats retrieval', async () => {
      getPRCommentsStats.mockRejectedValue(new Error('DB Error'));

      const result = await analyzer.getAnalysisResults('owner/repo');

      expect(result.error).toBe('DB Error');
      expect(result.total_comments).toBe(0);
    });
  });
});
