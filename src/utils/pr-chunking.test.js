import { shouldChunkPR, chunkPRFiles, combineChunkResults } from './pr-chunking.js';

describe('shouldChunkPR', () => {
  beforeEach(() => {
    mockConsoleSelective('log');
  });

  describe('small PRs that should not be chunked', () => {
    it('should not chunk a small PR with few files', () => {
      const prFiles = [
        { filePath: 'src/utils.js', diffContent: 'small change', content: 'file content' },
        { filePath: 'src/helpers.js', diffContent: 'another change', content: 'more content' },
      ];
      const result = shouldChunkPR(prFiles);
      expect(result.shouldChunk).toBe(false);
    });

    it('should return estimated token counts', () => {
      const prFiles = [{ filePath: 'src/utils.js', diffContent: 'a'.repeat(300), content: 'b'.repeat(600) }];
      const result = shouldChunkPR(prFiles);
      expect(result.estimatedTokens).toBeGreaterThan(0);
      expect(result.diffTokens).toBe(100); // 300 chars / 3
      expect(result.fullContentTokens).toBe(200); // 600 chars / 3
    });
  });

  describe('large PRs that should be chunked', () => {
    it('should chunk PR when total tokens exceed threshold', () => {
      // Create files that will exceed the 100k token threshold
      // Each file needs: diff content + full content + 25k context overhead
      const largeContent = 'x'.repeat(90000); // 30k tokens per file
      const prFiles = Array.from({ length: 5 }, (_, i) => ({
        filePath: `src/file${i}.js`,
        diffContent: largeContent,
        content: largeContent,
      }));
      const result = shouldChunkPR(prFiles);
      expect(result.shouldChunk).toBe(true);
      expect(result.estimatedTokens).toBeGreaterThan(100000);
    });

    it('should chunk PR when file count exceeds 30', () => {
      const prFiles = Array.from({ length: 35 }, (_, i) => ({
        filePath: `src/file${i}.js`,
        diffContent: 'small',
        content: 'content',
      }));
      const result = shouldChunkPR(prFiles);
      expect(result.shouldChunk).toBe(true);
    });

    it('should recommend appropriate number of chunks', () => {
      const largeContent = 'x'.repeat(30000); // 10k tokens
      const prFiles = Array.from({ length: 10 }, (_, i) => ({
        filePath: `src/file${i}.js`,
        diffContent: largeContent,
        content: largeContent,
      }));
      const result = shouldChunkPR(prFiles);
      expect(result.recommendedChunks).toBeGreaterThan(1);
    });
  });

  describe('edge cases', () => {
    it('should handle empty PR', () => {
      const result = shouldChunkPR([]);
      expect(result.shouldChunk).toBe(false);
      expect(result.diffTokens).toBe(0);
      expect(result.fullContentTokens).toBe(0);
    });

    it('should handle files with missing content', () => {
      const prFiles = [{ filePath: 'src/file.js', diffContent: null, content: undefined }];
      const result = shouldChunkPR(prFiles);
      expect(result.diffTokens).toBe(0);
      expect(result.fullContentTokens).toBe(0);
    });
  });
});

describe('chunkPRFiles', () => {
  describe('chunking behavior', () => {
    it('should create multiple chunks when files exceed token limit', () => {
      const prFiles = Array.from({ length: 10 }, (_, i) => ({
        filePath: `src/file${i}.js`,
        diffContent: 'x'.repeat(15000), // ~5k tokens each
        content: 'y'.repeat(15000), // ~5k tokens each
      }));

      // Each file = 10k tokens, limit = 35k, so should need multiple chunks
      const chunks = chunkPRFiles(prFiles, 35000);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should keep all files in one chunk when under limit', () => {
      const prFiles = [
        { filePath: 'src/a.js', diffContent: 'small', content: 'content' },
        { filePath: 'src/b.js', diffContent: 'small', content: 'content' },
      ];
      const chunks = chunkPRFiles(prFiles, 35000);
      expect(chunks.length).toBe(1);
      expect(chunks[0].files.length).toBe(2);
    });

    it('should assign chunk IDs correctly', () => {
      const prFiles = Array.from({ length: 10 }, (_, i) => ({
        filePath: `src/file${i}.js`,
        diffContent: 'x'.repeat(15000),
        content: 'y'.repeat(15000),
      }));
      const chunks = chunkPRFiles(prFiles, 35000);
      chunks.forEach((chunk, index) => {
        expect(chunk.chunkId).toBe(index + 1);
      });
    });

    it('should track total tokens per chunk', () => {
      const prFiles = [{ filePath: 'src/file.js', diffContent: 'abc', content: 'def' }];
      const chunks = chunkPRFiles(prFiles);
      expect(chunks[0].totalTokens).toBeGreaterThan(0);
    });
  });

  describe('file sorting and grouping', () => {
    it('should keep files from the same directory together', () => {
      const prFiles = [
        { filePath: 'src/components/Button.js', diffContent: 'x'.repeat(3000), content: 'y'.repeat(3000) },
        { filePath: 'src/utils/helpers.js', diffContent: 'x'.repeat(3000), content: 'y'.repeat(3000) },
        { filePath: 'src/components/Modal.js', diffContent: 'x'.repeat(3000), content: 'y'.repeat(3000) },
        { filePath: 'src/utils/validators.js', diffContent: 'x'.repeat(3000), content: 'y'.repeat(3000) },
      ];
      const chunks = chunkPRFiles(prFiles, 10000);

      // Files should be grouped by directory
      const firstChunkDirs = chunks[0].files.map((f) => f.filePath.split('/').slice(0, -1).join('/'));
      // Check that at least some files from the same directory are together
      expect(new Set(firstChunkDirs).size).toBeLessThanOrEqual(2);
    });

    it('should calculate change size from diff content', () => {
      const prFiles = [
        {
          filePath: 'src/file.js',
          diffContent: '+added line\n-removed line\n context\n+another add',
          content: 'content',
        },
      ];
      const chunks = chunkPRFiles(prFiles);
      expect(chunks[0].files[0].changeSize).toBe(3); // 2 additions + 1 deletion
    });
  });

  describe('edge cases', () => {
    it('should handle empty file list', () => {
      const chunks = chunkPRFiles([]);
      expect(chunks.length).toBe(0);
    });

    it('should handle files with no content', () => {
      const prFiles = [{ filePath: 'src/file.js', diffContent: '', content: '' }];
      const chunks = chunkPRFiles(prFiles);
      expect(chunks.length).toBe(1);
      expect(chunks[0].files[0].estimatedTokens).toBe(0);
    });

    it('should handle single large file that exceeds chunk limit', () => {
      const prFiles = [{ filePath: 'src/huge.js', diffContent: 'x'.repeat(150000), content: 'y'.repeat(150000) }];
      const chunks = chunkPRFiles(prFiles, 35000);
      // Single file should still be in its own chunk even if it exceeds limit
      expect(chunks.length).toBe(1);
      expect(chunks[0].files.length).toBe(1);
    });
  });
});

describe('combineChunkResults', () => {
  beforeEach(() => {
    mockConsoleSelective('log');
  });

  describe('result combination', () => {
    it('should combine results from multiple chunks', () => {
      const chunkResults = [
        {
          success: true,
          results: [{ filePath: 'src/a.js', results: { issues: [] } }],
        },
        {
          success: true,
          results: [{ filePath: 'src/b.js', results: { issues: [] } }],
        },
      ];
      const combined = combineChunkResults(chunkResults, 2);
      expect(combined.results.length).toBe(2);
      expect(combined.success).toBe(true);
    });

    it('should add chunk info to each result', () => {
      const chunkResults = [
        {
          success: true,
          results: [{ filePath: 'src/a.js', results: { issues: [] } }],
        },
        {
          success: true,
          results: [{ filePath: 'src/b.js', results: { issues: [] } }],
        },
      ];
      const combined = combineChunkResults(chunkResults, 2);
      expect(combined.results[0].chunkInfo.chunkNumber).toBe(1);
      expect(combined.results[0].chunkInfo.totalChunks).toBe(2);
      expect(combined.results[1].chunkInfo.chunkNumber).toBe(2);
    });

    it('should track PR context', () => {
      const chunkResults = [{ success: true, results: [] }];
      const combined = combineChunkResults(chunkResults, 5);
      expect(combined.prContext.totalFiles).toBe(5);
      expect(combined.prContext.chunkedReview).toBe(true);
      expect(combined.prContext.chunks).toBe(1);
    });
  });

  describe('summary generation', () => {
    it('should create combined summary', () => {
      const chunkResults = [
        {
          success: true,
          results: [{ filePath: 'src/a.js', results: { issues: [{ type: 'bug' }] } }],
        },
      ];
      const combined = combineChunkResults(chunkResults, 1);
      expect(combined.combinedSummary).toContain('1/1 chunks processed');
      expect(combined.combinedSummary).toContain('Total issues found: 1');
    });

    it('should handle failed chunks in summary', () => {
      const chunkResults = [
        { success: true, results: [] },
        { success: false, results: null },
      ];
      const combined = combineChunkResults(chunkResults, 2);
      expect(combined.combinedSummary).toContain('1/2 chunks processed');
    });
  });

  describe('cross-chunk issue detection', () => {
    it('should detect similar issues across chunks', () => {
      const chunkResults = [
        {
          chunkId: 1,
          success: true,
          results: [
            {
              filePath: 'src/a.js',
              results: {
                issues: [{ type: 'bug', description: 'Missing null check in handler' }],
              },
            },
          ],
        },
        {
          chunkId: 2,
          success: true,
          results: [
            {
              filePath: 'src/b.js',
              results: {
                issues: [{ type: 'bug', description: 'Missing null check in handler' }],
              },
            },
          ],
        },
      ];
      const combined = combineChunkResults(chunkResults, 2);
      expect(combined.crossChunkIssues.length).toBeGreaterThan(0);
      expect(combined.crossChunkIssues[0].type).toBe('pattern');
      expect(combined.crossChunkIssues[0].affectedFiles).toContain('src/a.js');
      expect(combined.crossChunkIssues[0].affectedFiles).toContain('src/b.js');
    });

    it('should not flag issues appearing in only one chunk', () => {
      const chunkResults = [
        {
          chunkId: 1,
          success: true,
          results: [
            {
              filePath: 'src/a.js',
              results: {
                issues: [{ type: 'bug', description: 'Unique issue A' }],
              },
            },
          ],
        },
        {
          chunkId: 2,
          success: true,
          results: [
            {
              filePath: 'src/b.js',
              results: {
                issues: [{ type: 'style', description: 'Different issue B' }],
              },
            },
          ],
        },
      ];
      const combined = combineChunkResults(chunkResults, 2);
      expect(combined.crossChunkIssues.length).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty chunk results', () => {
      const combined = combineChunkResults([], 0);
      expect(combined.results.length).toBe(0);
      expect(combined.success).toBe(true);
    });

    it('should handle chunks with no results', () => {
      const chunkResults = [
        { success: true, results: null },
        { success: true, results: undefined },
      ];
      const combined = combineChunkResults(chunkResults, 0);
      expect(combined.results.length).toBe(0);
    });

    it('should handle chunks with empty issues arrays', () => {
      const chunkResults = [
        {
          success: true,
          results: [{ filePath: 'src/a.js', results: { issues: [] } }],
        },
      ];
      const combined = combineChunkResults(chunkResults, 1);
      expect(combined.combinedSummary).toContain('Total issues found: 0');
    });
  });
});
