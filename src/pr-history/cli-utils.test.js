import { execSync } from 'node:child_process';
import fs from 'node:fs';
import {
  getRepositoryAndProjectPath,
  validateGitHubToken,
  displayProgress,
  displayAnalysisResults,
  displayStatus,
  displayDatabaseStats,
} from './cli-utils.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
  },
}));

describe('CLI Utils', () => {
  beforeEach(() => {
    mockConsoleSelective('log', 'warn');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getRepositoryAndProjectPath', () => {
    it('should use provided repository option', () => {
      const result = getRepositoryAndProjectPath({
        repository: 'owner/repo',
        directory: '/test/path',
      });

      expect(result.repository).toBe('owner/repo');
      expect(result.projectPath).toBe('/test/path');
    });

    it('should auto-detect repository from git remote', () => {
      fs.existsSync.mockReturnValue(true);
      execSync.mockReturnValue('https://github.com/myowner/myrepo.git\n');

      const result = getRepositoryAndProjectPath({ directory: '/project' });

      expect(result.repository).toBe('myowner/myrepo');
    });

    it('should throw when repository cannot be detected', () => {
      fs.existsSync.mockReturnValue(false);

      expect(() => getRepositoryAndProjectPath({})).toThrow('Could not detect GitHub repository');
    });

    it('should throw for invalid repository format', () => {
      expect(() => getRepositoryAndProjectPath({ repository: 'invalid' })).toThrow('Invalid repository format');
    });

    it('should parse SSH git URLs', () => {
      fs.existsSync.mockReturnValue(true);
      execSync.mockReturnValue('git@github.com:owner/repo.git\n');

      const result = getRepositoryAndProjectPath({ directory: '/project' });

      expect(result.repository).toBe('owner/repo');
    });

    it('should handle HTTPS URLs without .git suffix', () => {
      fs.existsSync.mockReturnValue(true);
      execSync.mockReturnValue('https://github.com/owner/repo\n');

      const result = getRepositoryAndProjectPath({ directory: '/project' });

      expect(result.repository).toBe('owner/repo');
    });
  });

  describe('validateGitHubToken', () => {
    it('should return token from options', () => {
      const result = validateGitHubToken({ token: 'my-token' });
      expect(result).toBe('my-token');
    });

    it('should return token from GITHUB_TOKEN env var', () => {
      const originalEnv = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'env-token';

      const result = validateGitHubToken({});

      expect(result).toBe('env-token');
      process.env.GITHUB_TOKEN = originalEnv;
    });

    it('should return token from GH_TOKEN env var', () => {
      const originalGithub = process.env.GITHUB_TOKEN;
      const originalGh = process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = 'gh-token';

      const result = validateGitHubToken({});

      expect(result).toBe('gh-token');
      process.env.GITHUB_TOKEN = originalGithub;
      process.env.GH_TOKEN = originalGh;
    });

    it('should throw when no token is found', () => {
      const originalGithub = process.env.GITHUB_TOKEN;
      const originalGh = process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;

      expect(() => validateGitHubToken({})).toThrow('GitHub token is required');

      process.env.GITHUB_TOKEN = originalGithub;
      process.env.GH_TOKEN = originalGh;
    });
  });

  describe('displayProgress', () => {
    it('should display progress when verbose is true', () => {
      const progress = { stage: 'test', message: 'Testing', current: 5, total: 10 };

      displayProgress(progress, true);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[test]'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('5/10'));
    });

    it('should not display progress when verbose is false', () => {
      const progress = { stage: 'test', message: 'Testing', current: 5, total: 10 };

      displayProgress(progress, false);

      expect(console.log).not.toHaveBeenCalled();
    });
  });

  describe('displayAnalysisResults', () => {
    it('should display analysis results', () => {
      const results = {
        repository: 'owner/repo',
        total_prs: 100,
        total_comments: 500,
        patterns: [{ type: 'category', name: 'security', count: 50, percentage: '10.0' }],
        top_authors: [{ author: 'user1', count: 100 }],
      };

      displayAnalysisResults(results, 120);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Analysis completed'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('owner/repo'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('100'));
    });

    it('should handle empty patterns and authors', () => {
      const results = {
        repository: 'owner/repo',
        total_prs: 10,
        total_comments: 20,
        patterns: [],
        top_authors: [],
      };

      displayAnalysisResults(results, 10);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('20'));
    });
  });

  describe('displayStatus', () => {
    it('should display status for not started', () => {
      const status = {
        repository: 'owner/repo',
        status: 'not_started',
      };

      displayStatus(status);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('not_started'));
    });

    it('should display detailed status for in progress', () => {
      const status = {
        repository: 'owner/repo',
        status: 'in_progress',
        prs: '50/100',
        comments: '200/400',
        failed_comments: 5,
        errors: 2,
        elapsed: '10m 30s',
      };

      displayStatus(status);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('50/100'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('200/400'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('5'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2'));
    });
  });

  describe('displayDatabaseStats', () => {
    it('should display stats when comments exist', () => {
      const stats = {
        total_comments: 100,
        comment_types: { review: 50, inline: 50 },
      };

      displayDatabaseStats(stats, true);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('100'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('review'));
    });

    it('should display message when no comments exist', () => {
      displayDatabaseStats({}, false);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No PR comments found'));
    });
  });
});
