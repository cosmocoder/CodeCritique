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
      expect(result.diffTokens).toBe(86); // 300 chars / 3.5
      expect(result.fullContentTokens).toBe(172); // 600 chars / 3.5
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

    it('should not chunk only because a huge file has a tiny diff', () => {
      const prFiles = [
        {
          filePath: 'src/huge.js',
          diffContent: '@@ -10,1 +10,1 @@\n-old value\n+new value',
          content: Array.from({ length: 10000 }, (_, index) => `line ${index + 1}`).join('\n'),
        },
      ];

      const result = shouldChunkPR(prFiles, { maxTotalFullContentTokens: 1000 });

      expect(result.fullContentTokens).toBeGreaterThan(result.plannedFileContextTokens);
      expect(result.shouldChunk).toBe(false);
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

    it('should attach holistic context plans to chunked files', () => {
      const prFiles = [
        {
          filePath: 'src/huge.js',
          diffContent: '@@ -10,1 +10,1 @@\n-old value\n+new value',
          content: Array.from({ length: 10000 }, (_, index) => `line ${index + 1}`).join('\n'),
        },
      ];

      const chunks = chunkPRFiles(prFiles, 35000, { maxTotalFullContentTokens: 1000 });

      expect(chunks[0].files[0].holisticContextPlan.mode).toBe('focused');
      expect(chunks[0].files[0].estimatedTokens).toBe(chunks[0].totalTokens);
    });

    it('should shrink focused context plans instead of truncating content when chunking focused files', () => {
      const content = Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`).join('\n');
      const scatteredDiff = [
        'diff --git a/src/huge.js b/src/huge.js',
        '--- a/src/huge.js',
        '+++ b/src/huge.js',
        ...Array.from({ length: 60 }, (_, index) => {
          const line = index * 30 + 10;
          return `@@ -${line},1 +${line},1 @@\n-line ${line}\n+line ${line} changed`;
        }),
      ].join('\n');

      const chunks = chunkPRFiles([{ filePath: 'src/huge.js', diffContent: scatteredDiff, content }], 1500, {
        maxTotalFullContentTokens: 1,
      });
      const chunkedFile = chunks[0].files[0];

      expect(chunkedFile.holisticContextPlan.mode).toBe('focused');
      expect(chunkedFile.holisticContextPlan.maxFocusedContextTokens).toBeLessThan(1500);
      expect(chunkedFile.truncatedForChunk).toBeUndefined();
      expect(chunks.every((chunk) => chunk.totalTokens <= 1500)).toBe(true);
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

    it('should split a single large file without dropping changed hunks', () => {
      const hugeDiff = [
        'diff --git a/src/huge.js b/src/huge.js',
        '--- a/src/huge.js',
        '+++ b/src/huge.js',
        ...Array.from({ length: 90 }, (_, i) => `@@ -${i},1 +${i},1 @@\n-context ${i}\n+changed sentinel-${i} ${'x'.repeat(5000)}`),
      ].join('\n');
      const prFiles = [{ filePath: 'src/huge.js', diffContent: hugeDiff, content: 'y'.repeat(150000) }];
      const chunks = chunkPRFiles(prFiles, 35000);
      const splitFiles = chunks.flatMap((chunk) => chunk.files);
      const combinedDiff = splitFiles.map((file) => file.diffContent).join('\n');

      expect(splitFiles.length).toBeGreaterThan(1);
      expect(splitFiles.every((file) => file.diffSplitForChunk)).toBe(true);
      expect(splitFiles.every((file) => file.originalEstimatedTokens > 35000)).toBe(true);
      expect(chunks.every((chunk) => chunk.totalTokens <= 35000)).toBe(true);
      expect(combinedDiff).toContain('changed sentinel-0');
      expect(combinedDiff).toContain('changed sentinel-45');
      expect(combinedDiff).toContain('changed sentinel-89');
    });

    it('should clear whole-file diffInfo on focused split parts so each part anchors its own diff slice', () => {
      const hugeDiff = [
        'diff --git a/src/huge.js b/src/huge.js',
        '--- a/src/huge.js',
        '+++ b/src/huge.js',
        ...Array.from({ length: 90 }, (_, i) => `@@ -${i + 1},1 +${i + 1},1 @@\n-context ${i}\n+changed sentinel-${i} ${'x'.repeat(5000)}`),
      ].join('\n');
      const prFiles = [
        {
          filePath: 'src/huge.js',
          diffContent: hugeDiff,
          content: Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n'),
          diffInfo: {
            addedLines: Array.from({ length: 90 }, (_, index) => ({ lineNumber: index + 1, content: `changed ${index}` })),
          },
        },
      ];

      const chunks = chunkPRFiles(prFiles, 35000, { maxTotalFullContentTokens: 1 });
      const splitFiles = chunks.flatMap((chunk) => chunk.files);

      expect(splitFiles.length).toBeGreaterThan(1);
      expect(splitFiles.every((file) => file.diffSplitForChunk)).toBe(true);
      expect(splitFiles.every((file) => file.diffInfo === undefined)).toBe(true);
    });

    it('should preserve hunk headers on char-split diff continuations for focused context anchoring', () => {
      const hugeDiff = [
        'diff --git a/src/huge.js b/src/huge.js',
        '--- a/src/huge.js',
        '+++ b/src/huge.js',
        `@@ -150,1 +150,1 @@\n-old\n+${'x'.repeat(140000)}`,
      ].join('\n');

      const chunks = chunkPRFiles([{ filePath: 'src/huge.js', diffContent: hugeDiff, content: 'y'.repeat(1200) }], 35000, {
        maxTotalFullContentTokens: 1,
      });
      const splitFiles = chunks.flatMap((chunk) => chunk.files);

      expect(splitFiles.length).toBeGreaterThan(1);
      expect(splitFiles.slice(1).every((file) => file.diffContent.includes('@@ -150,1 +150,1 @@'))).toBe(true);
    });

    it('should adjust char-split continuation hunk headers toward the slice line range', () => {
      const hugeDiff = [
        'diff --git a/src/huge.js b/src/huge.js',
        '--- a/src/huge.js',
        '+++ b/src/huge.js',
        '@@ -150,0 +150,2000 @@',
        ...Array.from({ length: 2000 }, (_, index) => `+changed ${index} ${'x'.repeat(90)}`),
      ].join('\n');

      const chunks = chunkPRFiles(
        [
          {
            filePath: 'src/huge.js',
            diffContent: hugeDiff,
            content: Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join('\n'),
          },
        ],
        35000,
        { maxTotalFullContentTokens: 1 }
      );
      const splitFiles = chunks.flatMap((chunk) => chunk.files);
      const continuationStart = splitFiles
        .slice(1)
        .map((file) => file.diffContent.match(/@@ -150,0 \+(\d+),2000 @@/)?.[1])
        .find(Boolean);

      expect(splitFiles.length).toBeGreaterThan(1);
      expect(Number(continuationStart)).toBeGreaterThan(150);
    });

    it('should keep split diff parts within budget for tiny budgets with large headers', () => {
      const hugeDiff = [
        `diff --git a/${'very-long-path/'.repeat(20)}huge.js b/${'very-long-path/'.repeat(20)}huge.js`,
        '--- a/src/huge.js',
        '+++ b/src/huge.js',
        `@@ -1,1 +1,1 @@\n-old\n+${'x'.repeat(120)}`,
      ].join('\n');

      const chunks = chunkPRFiles([{ filePath: 'src/huge.js', diffContent: hugeDiff, content: 'y'.repeat(120) }], 5);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.totalTokens <= 5)).toBe(true);
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

    it('should merge duplicate file results from split diff chunks', () => {
      const duplicateIssue = { type: 'bug', description: 'Missing null check', lineNumbers: [10], suggestion: 'Add a guard' };
      const chunkResults = [
        {
          success: true,
          results: [{ filePath: 'src/huge.js', results: { issues: [duplicateIssue] } }],
        },
        {
          success: true,
          results: [
            {
              filePath: 'src/huge.js',
              results: { issues: [duplicateIssue, { type: 'bug', description: 'Handle timeout', lineNumbers: [50] }] },
            },
          ],
        },
      ];

      const combined = combineChunkResults(chunkResults, 1);

      expect(combined.results.length).toBe(1);
      expect(combined.results[0].filePath).toBe('src/huge.js');
      expect(combined.results[0].results.issues).toHaveLength(2);
      expect(combined.results[0].chunkInfo.chunkNumbers).toEqual([1, 2]);
      expect(combined.combinedSummary).toContain('Total issues found: 2');
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

    it('should not flag duplicate split-file issues as cross-chunk patterns', () => {
      const chunkResults = [
        {
          chunkId: 1,
          success: true,
          results: [{ filePath: 'src/huge.js', results: { issues: [{ type: 'bug', description: 'Missing null check in handler' }] } }],
        },
        {
          chunkId: 2,
          success: true,
          results: [{ filePath: 'src/huge.js', results: { issues: [{ type: 'bug', description: 'Missing null check in handler' }] } }],
        },
      ];

      const combined = combineChunkResults(chunkResults, 1);

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
