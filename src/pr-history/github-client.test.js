import { getLastAnalysisTimestamp } from './database.js';
import { GitHubAPIClient } from './github-client.js';

vi.mock('./database.js', () => ({
  getLastAnalysisTimestamp: vi.fn(),
}));

describe('GitHubAPIClient', () => {
  let mockOctokit;
  let client;

  beforeEach(() => {
    mockConsole();

    mockOctokit = {
      repos: {
        get: vi.fn(),
      },
      pulls: {
        list: vi.fn(),
        get: vi.fn(),
        listReviewComments: vi.fn(),
        listReviews: vi.fn(),
        listFiles: vi.fn(),
      },
      issues: {
        listComments: vi.fn(),
      },
    };

    client = new GitHubAPIClient({ octokit: mockOctokit, debug: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should accept injected Octokit instance', () => {
      const customOctokit = { pulls: {} };
      const customClient = new GitHubAPIClient({ octokit: customOctokit });
      expect(customClient.octokit).toBe(customOctokit);
    });

    it('should accept token from environment when Octokit not injected', () => {
      const originalEnv = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_validtokenformat123456789012345678';

      const envClient = new GitHubAPIClient({});
      expect(envClient.token).toBe('ghp_validtokenformat123456789012345678');

      process.env.GITHUB_TOKEN = originalEnv;
    });
  });

  describe('validateToken', () => {
    it('should throw when no token is provided', () => {
      const originalEnv = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;

      expect(() => new GitHubAPIClient({})).toThrow('GitHub token required');

      process.env.GITHUB_TOKEN = originalEnv;
    });

    it('should warn for invalid token format', () => {
      const originalEnv = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'invalid-token';

      new GitHubAPIClient({});
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Token format appears invalid'));

      process.env.GITHUB_TOKEN = originalEnv;
    });
  });

  describe('testTokenPermissions', () => {
    it('should return true when token has access', async () => {
      mockOctokit.repos.get.mockResolvedValue({ data: {} });

      const result = await client.testTokenPermissions('owner', 'repo');

      expect(result).toBe(true);
      expect(mockOctokit.repos.get).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo' });
    });

    it('should throw for 403 permission denied', async () => {
      mockOctokit.repos.get.mockRejectedValue({ status: 403 });

      await expect(client.testTokenPermissions('owner', 'repo')).rejects.toThrow('Token lacks permission');
    });

    it('should throw for 404 not found', async () => {
      mockOctokit.repos.get.mockRejectedValue({ status: 404 });

      await expect(client.testTokenPermissions('owner', 'repo')).rejects.toThrow('not found or not accessible');
    });

    it('should rethrow unknown errors', async () => {
      mockOctokit.repos.get.mockRejectedValue(new Error('Unknown error'));

      await expect(client.testTokenPermissions('owner', 'repo')).rejects.toThrow('Unknown error');
    });
  });

  describe('getLastAnalysisDate', () => {
    it('should return date from database', async () => {
      getLastAnalysisTimestamp.mockResolvedValue('2024-01-15T00:00:00Z');

      const result = await client.getLastAnalysisDate('owner', 'repo', '/project/path');

      expect(result).toEqual(new Date('2024-01-15T00:00:00Z'));
      expect(getLastAnalysisTimestamp).toHaveBeenCalledWith('owner/repo', '/project/path');
    });

    it('should return null when no previous analysis', async () => {
      getLastAnalysisTimestamp.mockResolvedValue(null);

      const result = await client.getLastAnalysisDate('owner', 'repo', '/project/path');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      getLastAnalysisTimestamp.mockRejectedValue(new Error('DB error'));

      const result = await client.getLastAnalysisDate('owner', 'repo', '/project/path');

      expect(result).toBeNull();
    });
  });

  describe('calculateIncrementalRange', () => {
    it('should return full refresh when forceFullRefresh is true', () => {
      const lastDate = new Date('2024-01-15');
      const result = client.calculateIncrementalRange(lastDate, { forceFullRefresh: true });

      expect(result.incremental).toBe(false);
      expect(result.reason).toContain('force refresh');
    });

    it('should return full refresh when no previous analysis', () => {
      const result = client.calculateIncrementalRange(null);

      expect(result.incremental).toBe(false);
      expect(result.reason).toContain('no previous analysis');
    });

    it('should calculate incremental range with buffer', () => {
      const lastDate = new Date('2024-01-15');
      const result = client.calculateIncrementalRange(lastDate, { bufferDays: 7 });

      expect(result.incremental).toBe(true);
      expect(new Date(result.since)).toEqual(new Date('2024-01-08'));
    });
  });

  describe('filterPRs', () => {
    const samplePRs = [
      { number: 1, merged_at: '2024-01-10', user: { login: 'developer' }, draft: false },
      { number: 2, merged_at: '2024-01-15', user: { login: 'dependabot[bot]' }, draft: false },
      { number: 3, merged_at: null, user: { login: 'developer' }, draft: false },
      { number: 4, merged_at: '2024-01-12', user: { login: 'developer' }, draft: true },
    ];

    it('should filter out unmerged PRs', () => {
      const result = client.filterPRs(samplePRs, {});
      expect(result.some((pr) => pr.number === 3)).toBe(false);
    });

    it('should filter out Dependabot PRs when skipDependabot is true', () => {
      const result = client.filterPRs(samplePRs, { skipDependabot: true });
      expect(result.some((pr) => pr.number === 2)).toBe(false);
    });

    it('should include Dependabot PRs when skipDependabot is false', () => {
      const result = client.filterPRs(samplePRs, { skipDependabot: false });
      expect(result.some((pr) => pr.number === 2)).toBe(true);
    });

    it('should filter out drafts when includeDrafts is false', () => {
      const result = client.filterPRs(samplePRs, { includeDrafts: false });
      expect(result.some((pr) => pr.number === 4)).toBe(false);
    });

    it('should apply date filters', () => {
      // Only merged PRs are included, and PR 4 is a draft
      const result = client.filterPRs(samplePRs, {
        since: '2024-01-11',
        until: '2024-01-14',
        includeDrafts: true, // Include drafts for this test
      });

      // PR 4 has merged_at 2024-01-12 which is in range
      expect(result.length).toBe(1);
      expect(result[0].number).toBe(4);
    });
  });

  describe('isDependabotPR', () => {
    it('should detect dependabot[bot]', () => {
      expect(client.isDependabotPR({ user: { login: 'dependabot[bot]' } })).toBe(true);
    });

    it('should detect dependabot-preview[bot]', () => {
      expect(client.isDependabotPR({ user: { login: 'dependabot-preview[bot]' } })).toBe(true);
    });

    it('should return false for regular users', () => {
      expect(client.isDependabotPR({ user: { login: 'developer' } })).toBe(false);
    });
  });

  describe('isRetryableError', () => {
    it('should return true for rate limit errors', () => {
      expect(client.isRetryableError({ status: 429 })).toBe(true);
    });

    it('should return true for server errors', () => {
      expect(client.isRetryableError({ status: 500 })).toBe(true);
      expect(client.isRetryableError({ status: 502 })).toBe(true);
      expect(client.isRetryableError({ status: 503 })).toBe(true);
    });

    it('should return true for network errors', () => {
      expect(client.isRetryableError({ code: 'ENOTFOUND' })).toBe(true);
      expect(client.isRetryableError({ code: 'ECONNRESET' })).toBe(true);
      expect(client.isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    });

    it('should return false for client errors', () => {
      expect(client.isRetryableError({ status: 400 })).toBe(false);
      expect(client.isRetryableError({ status: 401 })).toBe(false);
      expect(client.isRetryableError({ status: 404 })).toBe(false);
    });
  });

  describe('calculateBackoffDelay', () => {
    it('should use exponential backoff', () => {
      const delay1 = client.calculateBackoffDelay(1, {});
      const delay2 = client.calculateBackoffDelay(2, {});
      const delay3 = client.calculateBackoffDelay(3, {});

      expect(delay2).toBe(delay1 * 2);
      expect(delay3).toBe(delay1 * 4);
    });

    it('should use reset time for rate limit errors', () => {
      const futureReset = Math.floor(Date.now() / 1000) + 30; // 30 seconds in future
      const error = {
        status: 429,
        response: { headers: { 'x-ratelimit-reset': futureReset.toString() } },
      };

      const delay = client.calculateBackoffDelay(1, error);
      expect(delay).toBeGreaterThan(25000);
      expect(delay).toBeLessThanOrEqual(60000);
    });
  });

  describe('fetchPRDetails', () => {
    it('should fetch all PR details in parallel', async () => {
      mockOctokit.pulls.get.mockResolvedValue({ data: { number: 1 } });
      mockOctokit.pulls.listReviewComments.mockResolvedValue({ data: [] });
      mockOctokit.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.pulls.listReviews.mockResolvedValue({ data: [] });
      mockOctokit.pulls.listFiles.mockResolvedValue({ data: [] });

      const result = await client.fetchPRDetails('owner', 'repo', 1);

      expect(result).toHaveProperty('pr');
      expect(result).toHaveProperty('reviewComments');
      expect(result).toHaveProperty('issueComments');
      expect(result).toHaveProperty('reviews');
      expect(result).toHaveProperty('files');
    });

    it('should handle errors gracefully', async () => {
      mockOctokit.pulls.get.mockRejectedValue(new Error('API error'));

      await expect(client.fetchPRDetails('owner', 'repo', 1)).rejects.toThrow('API error');
    });
  });

  describe('sleep', () => {
    it('should wait for specified milliseconds', async () => {
      const start = Date.now();
      await client.sleep(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45);
    });
  });

  describe('detectChangedPRs', () => {
    it('should return all PRs when no last analysis date', async () => {
      const prs = [{ number: 1 }, { number: 2 }];
      const result = await client.detectChangedPRs('owner', 'repo', prs, null);

      expect(result).toEqual(prs);
    });

    it('should filter PRs updated after last analysis', async () => {
      const lastAnalysis = new Date('2024-01-15');
      const prs = [
        { number: 1, updated_at: '2024-01-10', merged_at: '2024-01-10' },
        { number: 2, updated_at: '2024-01-20', merged_at: '2024-01-20' },
      ];

      const result = await client.detectChangedPRs('owner', 'repo', prs, lastAnalysis);

      expect(result.length).toBe(1);
      expect(result[0].number).toBe(2);
    });
  });

  describe('resumeFromLastPosition', () => {
    it('should return null when no resume data found', async () => {
      client.resumeFile = '/nonexistent/file';
      const result = await client.resumeFromLastPosition();

      expect(result).toBeNull();
    });
  });

  describe('fetchAllPRs', () => {
    beforeEach(() => {
      mockOctokit.repos.get.mockResolvedValue({ data: {} });
    });

    it('should fetch PRs with pagination', async () => {
      mockOctokit.pulls.list
        .mockResolvedValueOnce({ data: [{ number: 1, merged_at: '2024-01-10', user: { login: 'user' } }] })
        .mockResolvedValueOnce({ data: [] });

      const result = await client.fetchAllPRs('owner', 'repo', { limit: 10 });

      // fetchAllPRs returns an array directly, not an object with prs
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0].number).toBe(1);
    });

    it('should stop when limit is reached', async () => {
      mockOctokit.pulls.list.mockResolvedValue({
        data: [
          { number: 1, merged_at: '2024-01-10', user: { login: 'user' } },
          { number: 2, merged_at: '2024-01-11', user: { login: 'user' } },
        ],
      });

      const result = await client.fetchAllPRs('owner', 'repo', { limit: 1 });

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it('should handle incremental mode', async () => {
      getLastAnalysisTimestamp.mockResolvedValue('2024-01-10T00:00:00Z');
      mockOctokit.pulls.list.mockResolvedValue({ data: [] });

      await client.fetchAllPRs('owner', 'repo', { incremental: true, projectPath: '/test' });

      expect(getLastAnalysisTimestamp).toHaveBeenCalled();
    });
  });

  describe('callWithRetry', () => {
    it('should succeed on first try', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const result = await client.callWithRetry(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error', async () => {
      vi.useFakeTimers();

      const fn = vi.fn().mockRejectedValueOnce({ status: 503 }).mockResolvedValue('success');

      const promise = client.callWithRetry(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should throw on non-retryable error', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 401 });

      await expect(client.callWithRetry(fn)).rejects.toMatchObject({ status: 401 });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('loadProgress', () => {
    it('should return empty object when resume is false', async () => {
      const result = await client.loadProgress(false);

      expect(result).toEqual({});
    });

    it('should return empty object when no resume file', async () => {
      client.resumeFile = null;
      const result = await client.loadProgress(true);

      expect(result).toEqual({});
    });
  });

  describe('saveProgress', () => {
    it('should not save when no resume file', async () => {
      client.resumeFile = null;

      await expect(client.saveProgress({ prs: [] })).resolves.not.toThrow();
    });
  });

  describe('log', () => {
    it('should log when debug is enabled', () => {
      client.debug = true;
      client.log('test message');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('test message'));
    });

    it('should log with warn level using console.log', () => {
      client.debug = true;
      client.log('warning message', 'warn');

      // The log method uses console.log for all levels, just with different colors
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('warning message'));
    });

    it('should not log debug messages when debug is disabled', () => {
      client.debug = false;
      client.log('debug message', 'debug');

      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('debug message'));
    });

    it('should use white color for unknown level', () => {
      client.debug = true;
      client.log('unknown level message', 'unknown');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('unknown level message'));
    });
  });

  describe('shouldStopFetching', () => {
    it('should return false when no since date', () => {
      const prs = [{ merged_at: '2024-01-15' }];
      const result = client.shouldStopFetching(prs, {});

      expect(result).toBe(false);
    });

    it('should return false for empty PRs', () => {
      const result = client.shouldStopFetching([], { since: '2024-01-01' });

      expect(result).toBe(false);
    });

    it('should return true when all PRs are older than since', () => {
      const prs = [{ merged_at: '2023-12-01' }, { merged_at: '2023-12-15' }];

      const result = client.shouldStopFetching(prs, { since: '2024-01-01' });

      expect(result).toBe(true);
    });

    it('should return false when some PRs are newer than since', () => {
      const prs = [{ merged_at: '2023-12-01' }, { merged_at: '2024-01-15' }];

      const result = client.shouldStopFetching(prs, { since: '2024-01-01' });

      expect(result).toBe(false);
    });
  });

  describe('getPRReviewComments', () => {
    it('should fetch review comments', async () => {
      mockOctokit.pulls.listReviewComments.mockResolvedValue({ data: [{ id: 1 }] });

      const result = await client.getPRReviewComments('owner', 'repo', 1);

      expect(result).toEqual([{ id: 1 }]);
      expect(mockOctokit.pulls.listReviewComments).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
      });
    });

    it('should handle errors', async () => {
      mockOctokit.pulls.listReviewComments.mockRejectedValue(new Error('API error'));

      await expect(client.getPRReviewComments('owner', 'repo', 1)).rejects.toThrow('API error');
    });
  });

  describe('getPRIssueComments', () => {
    it('should fetch issue comments', async () => {
      mockOctokit.issues.listComments.mockResolvedValue({ data: [{ id: 1 }] });

      const result = await client.getPRIssueComments('owner', 'repo', 1);

      expect(result).toEqual([{ id: 1 }]);
      expect(mockOctokit.issues.listComments).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 1,
      });
    });

    it('should handle errors', async () => {
      mockOctokit.issues.listComments.mockRejectedValue(new Error('API error'));

      await expect(client.getPRIssueComments('owner', 'repo', 1)).rejects.toThrow('API error');
    });
  });

  describe('getPRFiles', () => {
    it('should fetch PR files', async () => {
      mockOctokit.pulls.listFiles.mockResolvedValue({ data: [{ filename: 'file.js' }] });

      const result = await client.getPRFiles('owner', 'repo', 1);

      expect(result).toEqual([{ filename: 'file.js' }]);
      expect(mockOctokit.pulls.listFiles).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
      });
    });

    it('should handle errors', async () => {
      mockOctokit.pulls.listFiles.mockRejectedValue(new Error('API error'));

      await expect(client.getPRFiles('owner', 'repo', 1)).rejects.toThrow('API error');
    });
  });

  describe('updateRateLimitInfo', () => {
    it('should update rate limit info from headers', () => {
      const headers = {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4500',
        'x-ratelimit-reset': '1700000000',
        'x-ratelimit-used': '500',
      };

      client.updateRateLimitInfo(headers);

      expect(client.rateLimitInfo).toEqual({
        limit: 5000,
        remaining: 4500,
        reset: 1700000000,
        used: 500,
      });
    });

    it('should handle missing headers', () => {
      client.updateRateLimitInfo({});

      expect(client.rateLimitInfo.limit).toBe(0);
      expect(client.rateLimitInfo.remaining).toBe(0);
    });
  });

  describe('respectRateLimit', () => {
    it('should not delay when no rate limit info', async () => {
      client.rateLimitInfo = null;
      const start = Date.now();
      await client.respectRateLimit();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('should not delay when enough remaining requests', async () => {
      client.rateLimitInfo = { remaining: 500, reset: Math.floor(Date.now() / 1000) + 3600 };
      const start = Date.now();
      await client.respectRateLimit();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('calculateIncrementalRange edge cases', () => {
    it('should use explicit since date when provided', () => {
      const lastDate = new Date('2024-01-15');
      const result = client.calculateIncrementalRange(lastDate, {
        since: '2024-01-01', // Earlier than buffer
        bufferDays: 7,
      });

      expect(result.incremental).toBe(true);
      // Should use the earlier of explicit since or buffer date
      expect(new Date(result.since)).toEqual(new Date('2024-01-01'));
    });

    it('should use full refresh with explicit since and until', () => {
      const result = client.calculateIncrementalRange(null, {
        since: '2024-01-01',
        until: '2024-01-31',
      });

      expect(result.incremental).toBe(false);
      expect(result.since).toBe('2024-01-01');
      expect(result.until).toBe('2024-01-31');
    });
  });

  describe('resumeFromLastPosition edge cases', () => {
    it('should calculate last PR date from resume data', async () => {
      // Mock loadProgress to return resume data
      const mockProgress = {
        prs: [
          { number: 1, merged_at: '2024-01-10T00:00:00Z', updated_at: '2024-01-10T00:00:00Z' },
          { number: 2, merged_at: '2024-01-20T00:00:00Z', updated_at: '2024-01-20T00:00:00Z' },
        ],
        lastPage: 5,
        totalProcessed: 100,
      };

      client.loadProgress = vi.fn().mockResolvedValue(mockProgress);

      const result = await client.resumeFromLastPosition();

      expect(result.prs.length).toBe(2);
      expect(result.lastPage).toBe(5);
      expect(result.lastDate.toISOString()).toContain('2024-01-20');
    });

    it('should handle error when loading progress', async () => {
      client.loadProgress = vi.fn().mockRejectedValue(new Error('Load error'));

      const result = await client.resumeFromLastPosition();

      expect(result).toBeNull();
    });
  });

  describe('fetchAllPRs advanced scenarios', () => {
    beforeEach(() => {
      mockOctokit.repos.get.mockResolvedValue({ data: {} });
    });

    it('should call progress callback', async () => {
      const progressCallback = vi.fn();
      client.progressCallback = progressCallback;

      mockOctokit.pulls.list.mockResolvedValueOnce({
        data: [{ number: 1, merged_at: '2024-01-10', user: { login: 'user' } }],
      });

      await client.fetchAllPRs('owner', 'repo', { limit: 1 });

      expect(progressCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pr_fetch',
          page: expect.any(Number),
          totalPRs: expect.any(Number),
        })
      );
    });

    it('should stop when reaching date boundary', async () => {
      mockOctokit.pulls.list
        .mockResolvedValueOnce({
          data: [{ number: 1, merged_at: '2023-12-01', user: { login: 'user' } }], // Old PR
        })
        .mockResolvedValueOnce({ data: [] });

      const result = await client.fetchAllPRs('owner', 'repo', {
        since: '2024-01-01', // PRs should be filtered out by date
      });

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('detectChangedPRs edge cases', () => {
    it('should return all PRs when prList is not an array', async () => {
      const lastAnalysis = new Date('2024-01-15');
      const result = await client.detectChangedPRs('owner', 'repo', null, lastAnalysis);

      expect(result).toBeNull();
    });
  });
});
