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
} from './cleanup-artifacts.js';

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
      expect(result.limitReached).toBe(true);
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
});
