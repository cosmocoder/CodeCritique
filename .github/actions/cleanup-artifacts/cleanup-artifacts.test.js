import fs from 'node:fs';
import {
  ARTIFACT_PATTERNS,
  getArtifactPatterns,
  artifactMatchesPatterns,
  artifactMatchesExcludePatterns,
  isArtifactOlderThan,
  filterArtifacts,
  generateSummary,
  createCleanupReport,
  bytesToMb,
  setOutput,
  setOutputs,
  fetchArtifacts,
  deleteArtifact,
  runCleanup,
} from './cleanup-artifacts.js';

vi.mock('node:fs');

describe('cleanup-artifacts.js', () => {
  describe('ARTIFACT_PATTERNS', () => {
    it('should have patterns for all cleanup types', () => {
      expect(ARTIFACT_PATTERNS.embeddings).toContain('ai-code-review-embeddings-');
      expect(ARTIFACT_PATTERNS.models).toContain('ai-model-cache-');
      expect(ARTIFACT_PATTERNS.models).toContain('ai-fastembed-cache-');
      expect(ARTIFACT_PATTERNS.feedback).toContain('ai-review-feedback-');
      expect(ARTIFACT_PATTERNS.reports).toContain('ai-review-report-');
    });

    it('should have all patterns for "all" cleanup type', () => {
      expect(ARTIFACT_PATTERNS.all).toHaveLength(5);
      expect(ARTIFACT_PATTERNS.all).toContain('ai-code-review-embeddings-');
      expect(ARTIFACT_PATTERNS.all).toContain('ai-model-cache-');
      expect(ARTIFACT_PATTERNS.all).toContain('ai-fastembed-cache-');
      expect(ARTIFACT_PATTERNS.all).toContain('ai-review-feedback-');
      expect(ARTIFACT_PATTERNS.all).toContain('ai-review-report-');
    });
  });

  describe('getArtifactPatterns', () => {
    it('should return patterns for cleanup type', () => {
      const patterns = getArtifactPatterns('embeddings');
      expect(patterns).toContain('ai-code-review-embeddings-');
    });

    it('should add custom pattern when provided', () => {
      const patterns = getArtifactPatterns('embeddings', 'custom-pattern');
      expect(patterns).toContain('ai-code-review-embeddings-');
      expect(patterns).toContain('custom-pattern');
    });

    it('should ignore empty custom pattern', () => {
      const patterns = getArtifactPatterns('embeddings', '');
      expect(patterns).toHaveLength(1);
    });

    it('should trim custom pattern', () => {
      const patterns = getArtifactPatterns('embeddings', '  custom-pattern  ');
      expect(patterns).toContain('custom-pattern');
    });

    it('should return empty array for unknown cleanup type', () => {
      const patterns = getArtifactPatterns('unknown');
      expect(patterns).toHaveLength(0);
    });
  });

  describe('artifactMatchesPatterns', () => {
    it('should match artifact name against patterns', () => {
      expect(artifactMatchesPatterns('ai-code-review-embeddings-123', ['ai-code-review-embeddings-'])).toBe(true);
      expect(artifactMatchesPatterns('ai-review-feedback-456', ['ai-review-feedback-'])).toBe(true);
    });

    it('should not match when pattern is not found', () => {
      expect(artifactMatchesPatterns('other-artifact', ['ai-code-review-embeddings-'])).toBe(false);
    });

    it('should match against any of multiple patterns', () => {
      expect(artifactMatchesPatterns('ai-model-cache-test', ['ai-code-review-embeddings-', 'ai-model-cache-'])).toBe(true);
    });

    it('should not match when patterns array is empty', () => {
      expect(artifactMatchesPatterns('ai-code-review-embeddings-123', [])).toBe(false);
    });
  });

  describe('artifactMatchesExcludePatterns', () => {
    it('should detect excluded artifacts', () => {
      const result = artifactMatchesExcludePatterns('important-artifact', 'important');
      expect(result.excluded).toBe(true);
      expect(result.matchedPattern).toBe('important');
    });

    it('should not exclude when pattern does not match', () => {
      const result = artifactMatchesExcludePatterns('test-artifact', 'important');
      expect(result.excluded).toBe(false);
      expect(result.matchedPattern).toBeNull();
    });

    it('should handle comma-separated patterns', () => {
      const result = artifactMatchesExcludePatterns('keep-this-artifact', 'important,keep');
      expect(result.excluded).toBe(true);
      expect(result.matchedPattern).toBe('keep');
    });

    it('should handle empty exclude patterns', () => {
      expect(artifactMatchesExcludePatterns('artifact', '')).toEqual({ excluded: false, matchedPattern: null });
      expect(artifactMatchesExcludePatterns('artifact', null)).toEqual({ excluded: false, matchedPattern: null });
    });

    it('should trim patterns', () => {
      const result = artifactMatchesExcludePatterns('test-artifact', ' test , other ');
      expect(result.excluded).toBe(true);
      expect(result.matchedPattern).toBe('test');
    });
  });

  describe('isArtifactOlderThan', () => {
    const now = Date.now();

    it('should return true when artifact is older than threshold', () => {
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
      expect(isArtifactOlderThan(oldDate, 30, now)).toBe(true);
    });

    it('should return false when artifact is newer than threshold', () => {
      const recentDate = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
      expect(isArtifactOlderThan(recentDate, 30, now)).toBe(false);
    });

    it('should return true when olderThanDays is 0 (no filter)', () => {
      const recentDate = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
      expect(isArtifactOlderThan(recentDate, 0, now)).toBe(true);
    });

    it('should handle edge case at exactly the threshold', () => {
      // At exactly 30 days, artifact is NOT older than 30 days (uses strict < comparison)
      const exactDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // exactly 30 days ago
      expect(isArtifactOlderThan(exactDate, 30, now)).toBe(false);

      // One millisecond past 30 days should be considered older
      const slightlyOlderDate = new Date(now - 30 * 24 * 60 * 60 * 1000 - 1).toISOString();
      expect(isArtifactOlderThan(slightlyOlderDate, 30, now)).toBe(true);
    });
  });

  describe('filterArtifacts', () => {
    const now = Date.now();
    const patterns = ['ai-code-review-embeddings-', 'ai-review-feedback-'];

    const createArtifact = (name, daysAgo, expired = false) => ({
      name,
      id: Math.random().toString(36).slice(2),
      size_in_bytes: 1024 * 1024,
      created_at: new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
      expired,
    });

    it('should filter artifacts matching patterns', () => {
      const artifacts = [createArtifact('ai-code-review-embeddings-123', 40), createArtifact('unrelated-artifact', 40)];

      const result = filterArtifacts(artifacts, {
        patterns,
        excludePatterns: '',
        olderThanDays: 30,
        maxArtifacts: 50,
        currentTime: now,
      });

      expect(result.toDelete).toHaveLength(1);
      expect(result.toDelete[0].name).toBe('ai-code-review-embeddings-123');
    });

    it('should skip expired artifacts', () => {
      const artifacts = [createArtifact('ai-code-review-embeddings-123', 40, true)];

      const result = filterArtifacts(artifacts, {
        patterns,
        excludePatterns: '',
        olderThanDays: 30,
        maxArtifacts: 50,
        currentTime: now,
      });

      expect(result.toDelete).toHaveLength(0);
      expect(result.skipped[0].reason).toBe('expired');
    });

    it('should respect exclude patterns', () => {
      const artifacts = [
        createArtifact('ai-code-review-embeddings-important', 40),
        createArtifact('ai-code-review-embeddings-regular', 40),
      ];

      const result = filterArtifacts(artifacts, {
        patterns,
        excludePatterns: 'important',
        olderThanDays: 30,
        maxArtifacts: 50,
        currentTime: now,
      });

      expect(result.toDelete).toHaveLength(1);
      expect(result.toDelete[0].name).toBe('ai-code-review-embeddings-regular');
    });

    it('should respect age filter', () => {
      const artifacts = [createArtifact('ai-code-review-embeddings-old', 40), createArtifact('ai-code-review-embeddings-recent', 10)];

      const result = filterArtifacts(artifacts, {
        patterns,
        excludePatterns: '',
        olderThanDays: 30,
        maxArtifacts: 50,
        currentTime: now,
      });

      expect(result.toDelete).toHaveLength(1);
      expect(result.toDelete[0].name).toBe('ai-code-review-embeddings-old');
    });

    it('should respect max artifacts limit', () => {
      const artifacts = [
        createArtifact('ai-code-review-embeddings-1', 40),
        createArtifact('ai-code-review-embeddings-2', 40),
        createArtifact('ai-code-review-embeddings-3', 40),
      ];

      const result = filterArtifacts(artifacts, {
        patterns,
        excludePatterns: '',
        olderThanDays: 30,
        maxArtifacts: 2,
        currentTime: now,
      });

      expect(result.toDelete).toHaveLength(2);
      expect(result.processedCount).toBe(2);
      expect(result.limitReached).toBe(true);
    });

    it('should limit based on processed count, not delete count (matching bash behavior)', () => {
      const artifacts = [
        createArtifact('ai-code-review-embeddings-recent-1', 10), // Too recent
        createArtifact('ai-code-review-embeddings-recent-2', 10), // Too recent
        createArtifact('ai-code-review-embeddings-old-1', 40), // Old enough - would be deleted
        createArtifact('ai-code-review-embeddings-old-2', 40), // Old enough - but not reached due to limit
      ];

      const result = filterArtifacts(artifacts, {
        patterns,
        excludePatterns: '',
        olderThanDays: 30,
        maxArtifacts: 2, // Limit to 2 processed
        currentTime: now,
      });

      // Only 2 artifacts processed (the first 2 recent ones that match patterns)
      expect(result.processedCount).toBe(2);
      // But 0 actually deleted because both were too recent
      expect(result.toDelete).toHaveLength(0);
      // Limit reached after processing 2 artifacts
      expect(result.limitReached).toBe(true);
      // The old artifacts were never even checked
    });

    it('should track skipped artifacts with reasons', () => {
      const artifacts = [
        createArtifact('ai-code-review-embeddings-recent', 10),
        createArtifact('unrelated-artifact', 40),
        createArtifact('ai-code-review-embeddings-expired', 40, true),
      ];

      const result = filterArtifacts(artifacts, {
        patterns,
        excludePatterns: '',
        olderThanDays: 30,
        maxArtifacts: 50,
        currentTime: now,
      });

      expect(result.skipped).toHaveLength(3);
      expect(result.skipped.find((s) => s.reason === 'too_recent')).toBeDefined();
      expect(result.skipped.find((s) => s.reason === 'no_pattern_match')).toBeDefined();
      expect(result.skipped.find((s) => s.reason === 'expired')).toBeDefined();
    });

    it('should count artifacts matching patterns even if too recent', () => {
      const artifacts = [
        createArtifact('ai-code-review-embeddings-recent', 10), // Too recent
        createArtifact('ai-code-review-embeddings-old', 40), // Old enough
      ];

      const result = filterArtifacts(artifacts, {
        patterns,
        excludePatterns: '',
        olderThanDays: 30,
        maxArtifacts: 50,
        currentTime: now,
      });

      // Both artifacts match patterns, so processedCount should be 2
      expect(result.processedCount).toBe(2);
      // Only the old one should be in toDelete
      expect(result.toDelete).toHaveLength(1);
      expect(result.toDelete[0].name).toBe('ai-code-review-embeddings-old');
      // The recent one should be in skipped
      expect(result.skipped.find((s) => s.artifact.name === 'ai-code-review-embeddings-recent' && s.reason === 'too_recent')).toBeDefined();
    });
  });

  describe('generateSummary', () => {
    it('should generate summary for live cleanup', () => {
      const summary = generateSummary({
        artifactsDeleted: 10,
        spaceReclaimedMb: 50,
        errorsCount: 0,
        dryRun: false,
      });
      expect(summary).toBe('Deleted 10 artifacts, reclaimed ~50MB');
    });

    it('should generate summary for dry run', () => {
      const summary = generateSummary({
        artifactsDeleted: 10,
        spaceReclaimedMb: 50,
        errorsCount: 0,
        dryRun: true,
      });
      expect(summary).toBe('[DRY RUN] Would delete 10 artifacts, reclaiming ~50MB');
    });

    it('should include error count when errors occurred', () => {
      const summary = generateSummary({
        artifactsDeleted: 8,
        spaceReclaimedMb: 40,
        errorsCount: 2,
        dryRun: false,
      });
      expect(summary).toBe('Deleted 8 artifacts, reclaimed ~40MB (2 errors)');
    });
  });

  describe('createCleanupReport', () => {
    it('should create valid cleanup report', () => {
      const report = createCleanupReport({
        repository: 'owner/repo',
        cleanupType: 'all',
        olderThanDays: 30,
        dryRun: false,
        results: {
          artifactsProcessed: 10,
          artifactsDeleted: 5,
          spaceReclaimedMb: 100,
          errorsCount: 1,
          artifactsFound: [],
          deletedArtifacts: [],
          errors: [],
        },
      });

      expect(report.cleanup_metadata.repository).toBe('owner/repo');
      expect(report.cleanup_metadata.cleanup_type).toBe('all');
      expect(report.cleanup_metadata.older_than_days).toBe(30);
      expect(report.cleanup_metadata.dry_run).toBe(false);
      expect(report.cleanup_metadata.timestamp).toBeDefined();
      expect(report.results.artifacts_processed).toBe(10);
      expect(report.results.artifacts_deleted).toBe(5);
      expect(report.results.space_reclaimed_mb).toBe(100);
      expect(report.results.errors_count).toBe(1);
    });

    it('should include timestamp in ISO format', () => {
      const report = createCleanupReport({
        repository: 'owner/repo',
        cleanupType: 'all',
        olderThanDays: 30,
        dryRun: false,
        results: {
          artifactsProcessed: 0,
          artifactsDeleted: 0,
          spaceReclaimedMb: 0,
          errorsCount: 0,
        },
      });

      // Verify timestamp is valid ISO format
      const timestamp = new Date(report.cleanup_metadata.timestamp);
      expect(timestamp.toISOString()).toBe(report.cleanup_metadata.timestamp);
    });
  });

  describe('bytesToMb', () => {
    it('should convert bytes to megabytes', () => {
      expect(bytesToMb(1024 * 1024)).toBe(1); // 1 MB
      expect(bytesToMb(1024 * 1024 * 100)).toBe(100); // 100 MB
      expect(bytesToMb(1024 * 1024 * 1024)).toBe(1024); // 1 GB = 1024 MB
    });

    it('should round to nearest MB', () => {
      expect(bytesToMb(1024 * 1024 * 1.5)).toBe(2); // 1.5 MB rounds to 2
      expect(bytesToMb(1024 * 1024 * 1.4)).toBe(1); // 1.4 MB rounds to 1
    });

    it('should handle zero bytes', () => {
      expect(bytesToMb(0)).toBe(0);
    });

    it('should handle small byte counts', () => {
      expect(bytesToMb(1000)).toBe(0); // Less than 1 MB
    });
  });

  describe('setOutput', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should write to output file when provided', () => {
      const outputFile = '/tmp/test-output';
      setOutput('test-key', 'test-value', outputFile);
      expect(fs.appendFileSync).toHaveBeenCalledWith(outputFile, 'test-key=test-value\n');
      expect(console.log).toHaveBeenCalledWith('::set-output name=test-key::test-value');
    });

    it('should not write to file when output file is not provided', () => {
      setOutput('test-key', 'test-value', null);
      expect(fs.appendFileSync).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('::set-output name=test-key::test-value');
    });

    it('should handle empty values', () => {
      const outputFile = '/tmp/test-output';
      setOutput('empty-key', '', outputFile);
      expect(fs.appendFileSync).toHaveBeenCalledWith(outputFile, 'empty-key=\n');
    });
  });

  describe('setOutputs', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should set multiple outputs at once', () => {
      const outputFile = '/tmp/test-output';
      setOutputs(
        {
          'key-1': 'value-1',
          'key-2': 'value-2',
          'key-3': 'value-3',
        },
        outputFile
      );

      expect(fs.appendFileSync).toHaveBeenCalledWith(outputFile, 'key-1=value-1\n');
      expect(fs.appendFileSync).toHaveBeenCalledWith(outputFile, 'key-2=value-2\n');
      expect(fs.appendFileSync).toHaveBeenCalledWith(outputFile, 'key-3=value-3\n');
      expect(fs.appendFileSync).toHaveBeenCalledTimes(3);
    });

    it('should handle empty object', () => {
      const outputFile = '/tmp/test-output';
      setOutputs({}, outputFile);
      expect(fs.appendFileSync).not.toHaveBeenCalled();
    });
  });

  describe('fetchArtifacts', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      global.fetch = vi.fn();
    });

    it('should fetch artifacts successfully', async () => {
      const mockArtifacts = [
        { id: 1, name: 'artifact-1', size_in_bytes: 1024, created_at: '2024-01-01T00:00:00Z' },
        { id: 2, name: 'artifact-2', size_in_bytes: 2048, created_at: '2024-01-02T00:00:00Z' },
      ];

      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ artifacts: mockArtifacts }),
      });

      const result = await fetchArtifacts('owner/repo', 'token123');
      expect(result).toEqual(mockArtifacts);
      expect(global.fetch).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/actions/artifacts?per_page=100', {
        headers: {
          Authorization: 'Bearer token123',
          Accept: 'application/vnd.github.v3+json',
        },
      });
    });

    it('should return empty array when artifacts is null', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ artifacts: null }),
      });

      const result = await fetchArtifacts('owner/repo', 'token123');
      expect(result).toEqual([]);
    });

    it('should throw error when fetch fails', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(fetchArtifacts('owner/repo', 'token123')).rejects.toThrow('Failed to fetch artifacts: 404 Not Found');
    });

    it('should use default repository and token when not provided', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ artifacts: [] }),
      });

      // Call with undefined to use defaults
      await fetchArtifacts(undefined, undefined);

      expect(global.fetch).toHaveBeenCalled();
      const callUrl = global.fetch.mock.calls[0][0];
      expect(callUrl).toContain('/actions/artifacts');
    });
  });

  describe('deleteArtifact', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      global.fetch = vi.fn();
    });

    it('should delete artifact successfully', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
      });

      const result = await deleteArtifact(123, 'owner/repo', 'token123');
      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/actions/artifacts/123', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer token123',
          Accept: 'application/vnd.github.v3+json',
        },
      });
    });

    it('should return false when deletion fails', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
      });

      const result = await deleteArtifact(123, 'owner/repo', 'token123');
      expect(result).toBe(false);
    });
  });

  describe('runCleanup', () => {
    let originalEnv;
    let mockFetch;
    let mockExit;

    beforeEach(() => {
      originalEnv = { ...process.env };
      vi.clearAllMocks();

      // Mock fetch
      mockFetch = vi.fn();
      global.fetch = mockFetch;

      // Mock process.exit
      mockExit = vi.fn();
      process.exit = mockExit;

      // Mock fs
      fs.appendFileSync = vi.fn();
      fs.writeFileSync = vi.fn();

      // Suppress console output
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it('should successfully cleanup artifacts', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-123',
          size_in_bytes: 1024 * 1024 * 10, // 10 MB
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: false,
        outputFile: '/tmp/output',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2); // fetch + delete
      expect(fs.appendFileSync).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully deleted'));
    });

    it('should handle dry run mode', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-123',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ artifacts: mockArtifacts }),
      });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: true,
        outputFile: '/tmp/output',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1); // Only fetch, no delete
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN]'));
    });

    it('should handle no artifacts found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ artifacts: [] }),
      });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        outputFile: '/tmp/output',
      });

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No artifacts found'));
      expect(fs.appendFileSync).toHaveBeenCalledWith('/tmp/output', expect.stringContaining('artifacts-deleted=0'));
    });

    it('should handle fetch error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(
        runCleanup({
          repository: 'owner/repo',
          githubToken: 'token123',
          outputFile: '/tmp/output',
        })
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch artifacts'));
    });

    it('should handle deletion failures', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-123',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: false, // Deletion fails
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: false,
        outputFile: '/tmp/output',
      });

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Failed to delete'));
      expect(fs.appendFileSync).toHaveBeenCalledWith('/tmp/output', expect.stringContaining('errors-count=1'));
    });

    it('should skip artifacts when requireConfirmation is true', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-123',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ artifacts: mockArtifacts }),
      });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: false,
        requireConfirmation: true,
        outputFile: '/tmp/output',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1); // Only fetch, no delete
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Confirmation required'));
    });

    it('should generate report when enabled', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-123',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: false,
        generateReport: true,
        outputFile: '/tmp/output',
      });

      expect(fs.writeFileSync).toHaveBeenCalled();
      const reportPath = fs.writeFileSync.mock.calls[0][0];
      expect(reportPath).toMatch(/^cleanup-report-/);
      const reportContent = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(reportContent.cleanup_metadata.repository).toBe('owner/repo');
    });

    it('should not generate report when disabled', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-123',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: false,
        generateReport: false,
        outputFile: '/tmp/output',
      });

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should log skipped artifacts in verbose mode', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-old',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
        {
          id: 2,
          name: 'ai-code-review-embeddings-recent',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: recentDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: false,
        verbose: true,
        outputFile: '/tmp/output',
      });

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Skipping recent artifact'));
    });

    it('should log expired artifacts in verbose mode', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-expired',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: true,
        },
        {
          id: 2,
          name: 'ai-code-review-embeddings-old',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: false,
        verbose: true,
        outputFile: '/tmp/output',
      });

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Skipping expired artifact'));
    });

    it('should log excluded artifacts in verbose mode', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-important',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
        {
          id: 2,
          name: 'ai-code-review-embeddings-regular',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        excludePatterns: 'important',
        dryRun: false,
        verbose: true,
        outputFile: '/tmp/output',
      });

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Excluding artifact matching pattern'));
    });

    it('should handle limit reached', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        name: `ai-code-review-embeddings-${i + 1}`,
        size_in_bytes: 1024 * 1024 * 10,
        created_at: oldDate,
        expired: false,
      }));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ artifacts: mockArtifacts }),
      });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: true,
        maxArtifactsPerRun: 2,
        outputFile: '/tmp/output',
      });

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Reached maximum artifacts'));
    });

    it('should handle artifacts with no size_in_bytes', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-123',
          size_in_bytes: undefined,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        dryRun: false,
        outputFile: '/tmp/output',
      });

      // Should not throw and should handle undefined size
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should use custom patterns', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'custom-artifact-123',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'unknown',
        customPattern: 'custom-artifact',
        olderThanDays: 30,
        dryRun: false,
        outputFile: '/tmp/output',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2); // Should match custom pattern
    });

    it('should respect exclude patterns', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const mockArtifacts = [
        {
          id: 1,
          name: 'ai-code-review-embeddings-important',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
        {
          id: 2,
          name: 'ai-code-review-embeddings-regular',
          size_in_bytes: 1024 * 1024 * 10,
          created_at: oldDate,
          expired: false,
        },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ artifacts: mockArtifacts }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await runCleanup({
        repository: 'owner/repo',
        githubToken: 'token123',
        cleanupType: 'embeddings',
        olderThanDays: 30,
        excludePatterns: 'important',
        dryRun: false,
        outputFile: '/tmp/output',
      });

      // Should only delete the regular one, not the important one
      expect(mockFetch).toHaveBeenCalledTimes(2); // fetch + 1 delete
    });
  });
});
