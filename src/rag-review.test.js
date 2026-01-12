import { runAnalysis, gatherUnifiedContextForPR } from './rag-analyzer.js';
import { reviewFile, reviewFiles, reviewPullRequest } from './rag-review.js';
import { shouldProcessFile } from './utils/file-validation.js';
import { getChangedLinesInfo, getFileContentFromGit } from './utils/git.js';
import { shouldChunkPR, chunkPRFiles, combineChunkResults } from './utils/pr-chunking.js';

vi.mock('./rag-analyzer.js', () => ({
  runAnalysis: vi.fn(),
  gatherUnifiedContextForPR: vi.fn().mockResolvedValue({
    codeExamples: [],
    guidelines: [],
    prComments: [],
    customDocChunks: [],
  }),
}));

vi.mock('./utils/file-validation.js', () => ({
  shouldProcessFile: vi.fn().mockReturnValue(true),
}));

vi.mock('./utils/git.js', () => ({
  findBaseBranch: vi.fn().mockReturnValue('main'),
  getChangedLinesInfo: vi.fn().mockReturnValue({
    hasChanges: true,
    addedLines: [1, 2, 3],
    removedLines: [4],
    fullDiff: '+ new code\n- old code',
  }),
  getFileContentFromGit: vi.fn().mockReturnValue('const x = 1;'),
}));

vi.mock('./utils/language-detection.js', () => ({
  detectFileType: vi.fn().mockReturnValue({ isTest: false }),
  detectLanguageFromExtension: vi.fn().mockReturnValue('javascript'),
}));

vi.mock('./utils/pr-chunking.js', () => ({
  shouldChunkPR: vi.fn().mockReturnValue({ shouldChunk: false, estimatedTokens: 1000 }),
  chunkPRFiles: vi.fn(),
  combineChunkResults: vi.fn(),
}));

describe('rag-review', () => {
  beforeEach(() => {
    mockConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('reviewFile', () => {
    it('should review a file successfully', async () => {
      runAnalysis.mockResolvedValue({
        success: true,
        filePath: '/test/file.js',
        language: 'javascript',
        results: { issues: [] },
      });

      const result = await reviewFile('/test/file.js');

      expect(result.success).toBe(true);
      expect(runAnalysis).toHaveBeenCalledWith('/test/file.js', {});
    });

    it('should convert object results to array format', async () => {
      runAnalysis.mockResolvedValue({
        success: true,
        filePath: '/test/file.js',
        language: 'javascript',
        results: { issues: [{ message: 'test' }] },
      });

      const result = await reviewFile('/test/file.js');

      expect(result.success).toBe(true);
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('should handle analysis errors', async () => {
      runAnalysis.mockRejectedValue(new Error('Analysis failed'));

      const result = await reviewFile('/test/file.js');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Analysis failed');
    });

    it('should pass options to runAnalysis', async () => {
      runAnalysis.mockResolvedValue({ success: true, results: [] });

      await reviewFile('/test/file.js', { verbose: true, maxExamples: 10 });

      expect(runAnalysis).toHaveBeenCalledWith('/test/file.js', { verbose: true, maxExamples: 10 });
    });
  });

  describe('reviewFiles', () => {
    it('should review multiple files', async () => {
      runAnalysis.mockResolvedValue({ success: true, results: [] });

      const result = await reviewFiles(['/test/file1.js', '/test/file2.js']);

      expect(result.success).toBe(true);
      expect(result.results.length).toBe(2);
    });

    it('should process files in batches based on concurrency', async () => {
      runAnalysis.mockResolvedValue({ success: true, results: [] });

      await reviewFiles(['/file1.js', '/file2.js', '/file3.js', '/file4.js', '/file5.js'], { concurrency: 2 });

      expect(runAnalysis).toHaveBeenCalledTimes(5);
    });

    it('should count successes, skips, and errors', async () => {
      runAnalysis
        .mockResolvedValueOnce({ success: true, results: [] })
        .mockResolvedValueOnce({ success: true, skipped: true, results: [] })
        .mockResolvedValueOnce({ success: false, error: 'Error' });

      const result = await reviewFiles(['/file1.js', '/file2.js', '/file3.js']);

      expect(result.message).toContain('Success: 1');
      expect(result.message).toContain('Skipped: 1');
      expect(result.message).toContain('Errors: 1');
    });

    it('should handle overall errors gracefully', async () => {
      runAnalysis.mockRejectedValue(new Error('Fatal error'));

      const result = await reviewFiles(['/file.js']);

      // Individual file errors are collected in results, not in a top-level error field
      expect(result.success).toBe(false);
      expect(result.results.length).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBe('Fatal error');
    });
  });

  describe('reviewPullRequest', () => {
    it('should review PR files', async () => {
      runAnalysis.mockResolvedValue({
        success: true,
        results: { issues: [], crossFileIssues: [], summary: 'OK' },
      });

      const result = await reviewPullRequest(['/src/file.js']);

      expect(result.success).toBe(true);
    });

    it('should return empty results when no processable files', async () => {
      const result = await reviewPullRequest([]);

      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
    });

    it('should skip files based on exclusion rules', async () => {
      shouldProcessFile.mockReturnValue(false);

      const result = await reviewPullRequest(['/file.js'], { verbose: true });

      expect(result.success).toBe(true);
    });

    it('should skip files with no changes', async () => {
      getChangedLinesInfo.mockReturnValue({ hasChanges: false });

      const result = await reviewPullRequest(['/file.js'], { verbose: true });

      expect(result.success).toBe(true);
    });

    it('should use chunked processing for large PRs', async () => {
      // Ensure file processing succeeds first (files must pass filters to reach chunking logic)
      shouldProcessFile.mockReturnValue(true);
      getChangedLinesInfo.mockReturnValue({
        hasChanges: true,
        addedLines: [1, 2, 3],
        removedLines: [],
        fullDiff: '+ new code',
      });

      // Setup: shouldChunkPR returns true to trigger chunked processing
      shouldChunkPR.mockReturnValue({ shouldChunk: true, estimatedTokens: 100000, recommendedChunks: 2 });

      // Setup chunks that will be processed
      chunkPRFiles.mockReturnValue([
        { files: [{ filePath: '/file1.js' }], totalTokens: 30000 },
        { files: [{ filePath: '/file2.js' }], totalTokens: 30000 },
      ]);

      // Setup combined results
      combineChunkResults.mockReturnValue({
        success: true,
        results: [
          { filePath: '/file1.js', success: true },
          { filePath: '/file2.js', success: true },
        ],
        prContext: { totalFiles: 2 },
      });

      // Setup analysis for the recursive chunk calls - needs to return valid holistic result
      runAnalysis.mockResolvedValue({
        success: true,
        results: { fileSpecificIssues: {}, crossFileIssues: [], summary: 'OK' },
      });

      const result = await reviewPullRequest(['/file1.js', '/file2.js'], { verbose: true });

      // Verify chunking flow was triggered
      expect(shouldChunkPR).toHaveBeenCalled();
      expect(chunkPRFiles).toHaveBeenCalled();
      expect(combineChunkResults).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should gather unified context for PR files', async () => {
      // Setup analysis to return valid holistic result
      runAnalysis.mockResolvedValue({
        success: true,
        results: { fileSpecificIssues: {}, crossFileIssues: [], summary: 'OK' },
      });

      // Ensure file processing succeeds (these are already mocked at top level)
      shouldProcessFile.mockReturnValue(true);
      getChangedLinesInfo.mockReturnValue({
        hasChanges: true,
        addedLines: [1, 2, 3],
        removedLines: [],
        fullDiff: '+ new code',
      });

      await reviewPullRequest(['/src/file.js'], { verbose: true });

      // gatherUnifiedContextForPR is called for regular (non-chunked) PRs
      expect(gatherUnifiedContextForPR).toHaveBeenCalled();
    });

    it('should handle errors in file processing gracefully', async () => {
      getFileContentFromGit.mockImplementation(() => {
        throw new Error('File not found');
      });

      const result = await reviewPullRequest(['/missing.js'], { verbose: true });

      // When file processing fails, the file is skipped, not failing the whole PR review
      expect(result.success).toBe(true);
    });

    it('should use holisticReview mode when enabled', async () => {
      runAnalysis.mockResolvedValue({
        success: true,
        results: { fileSpecificIssues: {}, crossFileIssues: [], summary: 'Holistic review' },
      });

      shouldProcessFile.mockReturnValue(true);
      getChangedLinesInfo.mockReturnValue({
        hasChanges: true,
        addedLines: [1],
        removedLines: [],
        fullDiff: '+ code',
      });

      const result = await reviewPullRequest(['/src/file.js'], { holisticReview: true });

      expect(result.success).toBe(true);
    });

    it('should include PR summary in results', async () => {
      runAnalysis.mockResolvedValue({
        success: true,
        results: { fileSpecificIssues: {}, crossFileIssues: [], summary: 'Summary text' },
      });

      shouldProcessFile.mockReturnValue(true);
      getChangedLinesInfo.mockReturnValue({
        hasChanges: true,
        addedLines: [1],
        removedLines: [],
        fullDiff: '+ code',
      });

      const result = await reviewPullRequest(['/src/file.js']);

      expect(result.success).toBe(true);
    });

    it('should handle multiple files with different statuses', async () => {
      runAnalysis
        .mockResolvedValueOnce({
          success: true,
          results: { issues: [], summary: 'OK' },
        })
        .mockResolvedValueOnce({
          success: true,
          skipped: true,
        });

      shouldProcessFile.mockReturnValue(true);
      getChangedLinesInfo.mockReturnValue({
        hasChanges: true,
        addedLines: [1],
        removedLines: [],
        fullDiff: '+ code',
      });

      const result = await reviewPullRequest(['/file1.js', '/file2.js']);

      expect(result.success).toBe(true);
    });
  });
});
