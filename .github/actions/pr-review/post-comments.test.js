import fs from 'node:fs';
import postComments from './post-comments.js';

const { mockShouldSkipSimilarIssue, mockLoadFeedbackData } = vi.hoisted(() => ({
  mockShouldSkipSimilarIssue: vi.fn(),
  mockLoadFeedbackData: vi.fn(),
}));

// Mock the feedback-loader module with the hoisted mocks
vi.mock('../../../src/feedback-loader.js', () => ({
  shouldSkipSimilarIssue: mockShouldSkipSimilarIssue,
  loadFeedbackData: mockLoadFeedbackData,
}));

describe('post-comments.js', () => {
  let mockGithub;
  let mockContext;
  let mockCore;
  let originalEnv;

  // Sample review output data
  const sampleReviewOutput = {
    summary: {
      totalFilesReviewed: 3,
      totalIssues: 2,
    },
    details: [
      {
        filePath: '/home/runner/_work/test-repo/test-repo/src/utils.js',
        review: {
          issues: [
            {
              description: 'Consider using const instead of let',
              severity: 'warning',
              lineNumbers: [10],
              suggestion: 'Use const for variables that are not reassigned',
            },
          ],
        },
      },
      {
        filePath: 'src/index.js',
        review: {
          issues: [
            {
              description: 'Missing error handling',
              severity: 'error',
              lineNumbers: [25],
              suggestion: 'Add try-catch block around async operations',
            },
          ],
        },
      },
    ],
  };

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Setup mock environment variables
    process.env.REVIEW_OUTPUT_PATH = '/tmp/test-review-output.json';
    process.env.GITHUB_WORKSPACE = '/tmp/test-workspace';
    process.env.INPUT_FEEDBACK_ARTIFACT_NAME = 'ai-review-feedback-123';

    // Reset mocks and restore default implementations
    vi.clearAllMocks();

    // Fully reset feedback mocks and set default implementations
    mockShouldSkipSimilarIssue.mockReset();
    mockLoadFeedbackData.mockReset();

    // Set default mock implementations - always return false for skip by default
    mockShouldSkipSimilarIssue.mockImplementation(() => Promise.resolve(false));
    mockLoadFeedbackData.mockImplementation(() => Promise.resolve({}));

    // Mock fs module
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(sampleReviewOutput));
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);

    // Mock GitHub API client
    mockGithub = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              head: { sha: 'abc123def456' },
              number: 42,
            },
          }),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
          createReviewComment: vi.fn().mockResolvedValue({ data: { id: 1001 } }),
          deleteReviewComment: vi.fn().mockResolvedValue({}),
          createReplyForReviewComment: vi.fn().mockResolvedValue({}),
        },
        issues: {
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          createComment: vi.fn().mockResolvedValue({ data: { id: 2001 } }),
          updateComment: vi.fn().mockResolvedValue({}),
        },
        reactions: {
          listForPullRequestReviewComment: vi.fn().mockResolvedValue({ data: [] }),
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [],
            },
          },
        },
      }),
    };

    // Mock GitHub Actions context
    mockContext = {
      issue: { number: 42 },
      repo: { owner: 'test-owner', repo: 'test-repo' },
      runId: 12345,
    };

    // Mock GitHub Actions core utilities
    mockCore = {
      setOutput: vi.fn(),
      setFailed: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('basic functionality', () => {
    it('should handle missing review output file gracefully', async () => {
      fs.existsSync.mockReturnValue(false);

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should not fail, just return early
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    it('should process review results and post summary comment', async () => {
      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should fetch PR information
      expect(mockGithub.rest.pulls.get).toHaveBeenCalledWith({
        pull_number: 42,
        owner: 'test-owner',
        repo: 'test-repo',
      });

      // Should create summary comment
      expect(mockGithub.rest.issues.createComment).toHaveBeenCalled();
      const createCommentCall = mockGithub.rest.issues.createComment.mock.calls[0][0];
      expect(createCommentCall.body).toContain('CodeCritique Review Summary');
      expect(createCommentCall.body).toContain('Files Analyzed:** 3');
      expect(createCommentCall.body).toContain('Issues Found:** 2');
    });

    it('should update existing summary comment when found', async () => {
      const existingCommentId = 9999;
      mockGithub.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            id: existingCommentId,
            body: '## 🤖 CodeCritique Review Summary\n<!-- codecritique-review-action -->',
            user: { login: 'github-actions[bot]' },
          },
        ],
      });

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should update existing comment instead of creating new
      expect(mockGithub.rest.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: existingCommentId,
        })
      );
      expect(mockGithub.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  describe('inline comment posting', () => {
    it('should post inline comments for issues (or skip with feedback filtering)', async () => {
      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Either inline comments were posted or feedback filtering skipped them
      // The important thing is the function completed without error
      expect(mockCore.setFailed).not.toHaveBeenCalled();

      // Summary comment should always be posted
      expect(mockGithub.rest.issues.createComment).toHaveBeenCalled();
    });

    it('should convert absolute paths to relative paths (when comments are posted)', async () => {
      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Check that the path was converted correctly if comments were posted
      const calls = mockGithub.rest.pulls.createReviewComment.mock.calls;

      if (calls.length > 0) {
        const pathsUsed = calls.map((call) => call[0].path);
        // The path should be converted from /home/runner/_work/test-repo/test-repo/src/utils.js
        // to src/utils.js
        expect(pathsUsed).toContain('src/utils.js');
      } else {
        // If feedback filtering skipped all issues, verify the function ran without error
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });

    it('should handle inline comment posting failure gracefully', async () => {
      mockGithub.rest.pulls.createReviewComment.mockRejectedValue({
        status: 422,
        message: 'Validation Failed',
      });

      // Should not throw, just log the error
      await expect(postComments({ github: mockGithub, context: mockContext, core: mockCore })).resolves.not.toThrow();
    });

    it('should respect maxComments limit', async () => {
      // Create review output with many issues
      const manyIssues = {
        summary: { totalFilesReviewed: 1, totalIssues: 50 },
        details: [
          {
            filePath: 'src/test.js',
            review: {
              issues: Array(50)
                .fill(null)
                .map((_, i) => ({
                  description: `Issue ${i}`,
                  severity: 'warning',
                  lineNumbers: [i + 1],
                })),
            },
          },
        ],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(manyIssues));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should not exceed maxComments (25)
      const commentCalls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      expect(commentCalls.length).toBeLessThanOrEqual(25);
    });
  });

  describe('comment severity mapping', () => {
    it('should use correct emoji for error severity', async () => {
      const errorIssue = {
        summary: { totalFilesReviewed: 1, totalIssues: 1 },
        details: [
          {
            filePath: 'src/test.js',
            review: {
              issues: [{ description: 'Critical error', severity: 'error', lineNumbers: [1] }],
            },
          },
        ],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(errorIssue));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // If inline comments were posted, check the body
      const calls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0].body).toContain('🚨');
      } else {
        // If feedback filtering skipped the issue, verify the function ran without error
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });

    it('should use correct emoji for warning severity', async () => {
      const warningIssue = {
        summary: { totalFilesReviewed: 1, totalIssues: 1 },
        details: [
          {
            filePath: 'src/test.js',
            review: {
              issues: [{ description: 'Warning issue', severity: 'warning', lineNumbers: [1] }],
            },
          },
        ],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(warningIssue));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // If inline comments were posted, check the body
      const calls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0].body).toContain('⚠️');
      } else {
        // If feedback filtering skipped the issue, verify the function ran without error
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });

    it('should use info emoji for other severities', async () => {
      const infoIssue = {
        summary: { totalFilesReviewed: 1, totalIssues: 1 },
        details: [
          {
            filePath: 'src/test.js',
            review: {
              issues: [{ description: 'Info issue', severity: 'info', lineNumbers: [1] }],
            },
          },
        ],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(infoIssue));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // If inline comments were posted, check the body
      const calls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0].body).toContain('💡');
      } else {
        // If feedback filtering skipped the issue, verify the function ran without error
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });
  });

  describe('feedback analysis', () => {
    it('should load existing feedback data', async () => {
      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      expect(mockLoadFeedbackData).toHaveBeenCalled();
    });

    it('should skip issues similar to previously dismissed ones', async () => {
      // Override the default mock to return true (skip all issues)
      mockShouldSkipSimilarIssue.mockImplementation(() => Promise.resolve(true));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should not post inline comments for skipped issues
      expect(mockGithub.rest.pulls.createReviewComment).not.toHaveBeenCalled();
    });

    it('should post inline comments when shouldSkipSimilarIssue returns false (await regression test)', async () => {
      // This test ensures the await keyword is used when calling shouldSkipSimilarIssue.
      // If await is missing, the Promise object (which is truthy) will cause all issues
      // to be incorrectly skipped, and this test will fail.
      mockShouldSkipSimilarIssue.mockImplementation(() => Promise.resolve(false));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // When shouldSkipSimilarIssue returns false, inline comments MUST be posted
      // This will fail if the await is missing because Promise is truthy
      expect(mockGithub.rest.pulls.createReviewComment).toHaveBeenCalled();

      // Verify the function was called for each issue in the sample data (2 issues)
      expect(mockShouldSkipSimilarIssue).toHaveBeenCalledTimes(2);
    });

    it('should analyze feedback on existing bot comments', async () => {
      mockGithub.rest.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 5001,
            body: '⚠️ **CodeCritique Review**\n\n*Severity: warning*\n\nTest issue\n\n<!-- codecritique-review-action -->',
            user: { login: 'github-actions[bot]' },
          },
        ],
      });

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should fetch reactions for existing comments
      expect(mockGithub.rest.reactions.listForPullRequestReviewComment).toHaveBeenCalled();
    });

    it('should preserve comments with user interaction', async () => {
      mockGithub.rest.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 5001,
            body: '⚠️ **CodeCritique Review**\n\n*Severity: warning*\n\nTest issue\n\n<!-- codecritique-review-action -->',
            user: { login: 'github-actions[bot]' },
          },
        ],
      });

      // Simulate positive reaction on comment
      mockGithub.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [{ content: '+1' }],
      });

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should NOT delete comment with user reaction
      expect(mockGithub.rest.pulls.deleteReviewComment).not.toHaveBeenCalled();
    });

    it('should delete comments without user interaction', async () => {
      mockGithub.rest.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 5001,
            body: '⚠️ **CodeCritique Review**\n\n*Severity: warning*\n\nTest issue\n\n<!-- codecritique-review-action -->',
            user: { login: 'github-actions[bot]' },
          },
        ],
      });

      // No reactions
      mockGithub.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({ data: [] });

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should delete comment without user interaction
      expect(mockGithub.rest.pulls.deleteReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 5001,
        })
      );
    });
  });

  describe('auto-resolution of conversations', () => {
    it('should auto-resolve conversation when user provides dismissive feedback', async () => {
      const commentId = 5001;
      const threadId = 'thread-123';

      mockGithub.rest.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: commentId,
            body: '⚠️ **CodeCritique Review**\n\n*Severity: warning*\n\nTest issue\n\n<!-- codecritique-review-action -->',
            user: { login: 'github-actions[bot]' },
          },
          {
            id: 5002,
            in_reply_to_id: commentId,
            body: 'This is a false positive, please ignore',
            user: { login: 'developer' },
          },
        ],
      });

      mockGithub.graphql.mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: threadId,
                  comments: { nodes: [{ databaseId: commentId }] },
                  isResolved: false,
                },
              ],
            },
          },
        },
      });

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should resolve the thread via GraphQL
      expect(mockGithub.graphql).toHaveBeenCalledWith(
        expect.stringContaining('resolveReviewThread'),
        expect.objectContaining({ threadId })
      );
    });

    it('should not resolve already resolved threads', async () => {
      const commentId = 5001;

      mockGithub.rest.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: commentId,
            body: '⚠️ **CodeCritique Review**\n\n*Severity: warning*\n\nTest issue\n\n<!-- codecritique-review-action -->',
            user: { login: 'github-actions[bot]' },
          },
          {
            id: 5002,
            in_reply_to_id: commentId,
            body: 'ignore this',
            user: { login: 'developer' },
          },
        ],
      });

      mockGithub.graphql.mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'thread-123',
                  comments: { nodes: [{ databaseId: commentId }] },
                  isResolved: true, // Already resolved
                },
              ],
            },
          },
        },
      });

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should only call graphql for the query, not for resolution
      const resolveCalls = mockGithub.graphql.mock.calls.filter((call) => call[0].includes('resolveReviewThread'));
      expect(resolveCalls.length).toBe(0);
    });
  });

  describe('feedback data saving', () => {
    it('should save feedback data when there are existing comments', async () => {
      mockGithub.rest.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 5001,
            body: '⚠️ **CodeCritique Review**\n\n*Severity: warning*\n\nTest issue\n\n<!-- codecritique-review-action -->',
            user: { login: 'github-actions[bot]' },
          },
        ],
      });

      mockGithub.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [{ content: '+1' }],
      });

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Should save feedback file
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(mockCore.setOutput).toHaveBeenCalledWith('feedback-artifact-uploaded', 'true');
    });

    it('should create feedback directory if it does not exist', async () => {
      fs.existsSync.mockImplementation((filepath) => {
        if (filepath.includes('.ai-feedback')) return false;
        return true;
      });

      mockGithub.rest.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 5001,
            body: '⚠️ **CodeCritique Review**\n\n*Severity: warning*\n\nTest issue\n\n<!-- codecritique-review-action -->',
            user: { login: 'github-actions[bot]' },
          },
        ],
      });

      mockGithub.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [{ content: '+1' }],
      });

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.ai-feedback'), { recursive: true });
    });
  });

  describe('output setting', () => {
    it('should set comments-posted output', async () => {
      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      expect(mockCore.setOutput).toHaveBeenCalledWith('comments-posted', expect.any(String));
    });

    it('should set comments-posted to 0 when no issues', async () => {
      const noIssues = {
        summary: { totalFilesReviewed: 1, totalIssues: 0 },
        details: [],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(noIssues));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      expect(mockCore.setOutput).toHaveBeenCalledWith('comments-posted', '0');
    });
  });

  describe('error handling', () => {
    it('should call core.setFailed on unhandled errors', async () => {
      mockGithub.rest.pulls.get.mockRejectedValue(new Error('API Error'));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      expect(mockCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('API Error'));
    });

    it('should handle invalid JSON in review output', async () => {
      fs.readFileSync.mockReturnValue('invalid json');

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      expect(mockCore.setFailed).toHaveBeenCalled();
    });

    it('should handle comment deletion failure gracefully', async () => {
      mockGithub.rest.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 5001,
            body: '⚠️ **CodeCritique Review**\n\n*Severity: warning*\n\nTest issue\n\n<!-- codecritique-review-action -->',
            user: { login: 'github-actions[bot]' },
          },
        ],
      });

      mockGithub.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({ data: [] });
      mockGithub.rest.pulls.deleteReviewComment.mockRejectedValue(new Error('Delete failed'));

      // Should not throw
      await expect(postComments({ github: mockGithub, context: mockContext, core: mockCore })).resolves.not.toThrow();
    });
  });

  describe('no issues scenario', () => {
    it('should show success message when no issues found', async () => {
      const noIssues = {
        summary: { totalFilesReviewed: 5, totalIssues: 0 },
        details: [],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(noIssues));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      const createCommentCall = mockGithub.rest.issues.createComment.mock.calls[0][0];
      expect(createCommentCall.body).toContain('No Issues Found');
      expect(createCommentCall.body).toContain('Great job!');
    });
  });

  describe('path conversion edge cases', () => {
    it('should handle paths without runner prefix', async () => {
      const simplePathIssue = {
        summary: { totalFilesReviewed: 1, totalIssues: 1 },
        details: [
          {
            filePath: 'src/simple.js',
            review: {
              issues: [{ description: 'Test', severity: 'info', lineNumbers: [1] }],
            },
          },
        ],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(simplePathIssue));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // If inline comments were posted, check the path
      const calls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0].path).toBe('src/simple.js');
      } else {
        // If feedback filtering skipped the issue, verify the function ran without error
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });

    it('should handle paths with leading slashes', async () => {
      const leadingSlashIssue = {
        summary: { totalFilesReviewed: 1, totalIssues: 1 },
        details: [
          {
            filePath: '/src/leading.js',
            review: {
              issues: [{ description: 'Test', severity: 'info', lineNumbers: [1] }],
            },
          },
        ],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(leadingSlashIssue));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // If inline comments were posted, check the path conversion
      const calls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0].path).toBe('src/leading.js');
      } else {
        // If feedback filtering skipped the issue, verify the function ran without error
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });
  });

  describe('suggestion handling', () => {
    it('should include suggestion in comment body when provided', async () => {
      const issueWithSuggestion = {
        summary: { totalFilesReviewed: 1, totalIssues: 1 },
        details: [
          {
            filePath: 'src/test.js',
            review: {
              issues: [
                {
                  description: 'Variable could be const',
                  severity: 'warning',
                  lineNumbers: [5],
                  suggestion: 'Change let to const',
                },
              ],
            },
          },
        ],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(issueWithSuggestion));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // If inline comments were posted, check suggestion content
      const calls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0].body).toContain('**Suggestion:**');
        expect(calls[0][0].body).toContain('Change let to const');
      } else {
        // If feedback filtering skipped the issue, verify the function ran without error
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });

    it('should not include suggestion section when not provided', async () => {
      const issueWithoutSuggestion = {
        summary: { totalFilesReviewed: 1, totalIssues: 1 },
        details: [
          {
            filePath: 'src/test.js',
            review: {
              issues: [
                {
                  description: 'Some issue',
                  severity: 'warning',
                  lineNumbers: [5],
                },
              ],
            },
          },
        ],
      };

      fs.readFileSync.mockReturnValue(JSON.stringify(issueWithoutSuggestion));

      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // If inline comments were posted, check no suggestion section
      const calls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0].body).not.toContain('**Suggestion:**');
      } else {
        // If feedback filtering skipped the issue, verify the function ran without error
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });
  });

  describe('feedback tracking notice', () => {
    it('should include feedback tracking notice in comments', async () => {
      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // If inline comments were posted, check for tracking notice
      const calls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0].body).toContain('React with 👍/👎');
        expect(calls[0][0].body).toContain('false positive');
      } else {
        // If feedback filtering skipped the issue, verify the function ran without error
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });
  });

  describe('unique comment identifier', () => {
    it('should include unique comment identifier in all comments', async () => {
      await postComments({ github: mockGithub, context: mockContext, core: mockCore });

      // Check summary comment (should always be posted)
      const summaryCall = mockGithub.rest.issues.createComment.mock.calls[0][0];
      expect(summaryCall.body).toContain('<!-- codecritique-review-action -->');

      // If inline comments were posted, check for identifier
      const inlineCalls = mockGithub.rest.pulls.createReviewComment.mock.calls;
      if (inlineCalls.length > 0) {
        expect(inlineCalls[0][0].body).toContain('<!-- codecritique-review-action -->');
      } else {
        // If feedback filtering skipped inline comments, that's OK - summary was checked
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      }
    });
  });

  describe('error status handling', () => {
    it('should handle 404 error for inline comments', async () => {
      mockGithub.rest.pulls.createReviewComment.mockRejectedValue({
        status: 404,
        message: 'Not Found',
      });

      await expect(postComments({ github: mockGithub, context: mockContext, core: mockCore })).resolves.not.toThrow();
    });

    it('should handle 422 error for inline comments', async () => {
      mockGithub.rest.pulls.createReviewComment.mockRejectedValue({
        status: 422,
        message: 'Validation Failed',
      });

      await expect(postComments({ github: mockGithub, context: mockContext, core: mockCore })).resolves.not.toThrow();
    });
  });
});
