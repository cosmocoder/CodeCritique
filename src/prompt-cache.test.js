import { describe, expect, it } from 'vitest';
import { PR_REVIEW_JSON_SCHEMA } from './prompt-cache.js';
import { collectPRLevelFindings } from './utils/review-results.js';

/**
 * The prompt tells the model which field names to emit. `review-results.js` reads
 * those names back. A divergence drops data silently, so these tests pin the
 * prompt to the names the consumers actually read.
 */
describe('PR_REVIEW_JSON_SCHEMA', () => {
  it('should name the cross-file issue fields that normalizePRLevelIssue reads', () => {
    expect(PR_REVIEW_JSON_SCHEMA).toContain('"message"');
    expect(PR_REVIEW_JSON_SCHEMA).toContain('"files"');
  });

  it('should name the recommendation fields that normalizeRecommendation reads', () => {
    // "suggestion" appears in three blocks, so bound the slice at both ends: a slice
    // that ran to the end of the schema would pass on any later block instead.
    const start = PR_REVIEW_JSON_SCHEMA.indexOf('"recommendations"');
    const recommendations = PR_REVIEW_JSON_SCHEMA.slice(start, PR_REVIEW_JSON_SCHEMA.indexOf(']', start) + 1);

    expect(recommendations).toContain('"category"');
    expect(recommendations).toContain('"suggestion"');
    expect(recommendations).toContain('"impact"');
  });

  it('should not name filesInvolved, which no consumer reads', () => {
    expect(PR_REVIEW_JSON_SCHEMA).not.toContain('filesInvolved');
  });
});

describe('collectPRLevelFindings with prompt-shaped input', () => {
  const holisticAnalysis = {
    results: {
      summary: 'PR summary',
      crossFileIssues: [
        {
          type: 'architecture',
          severity: 'high',
          message: 'Duplicated retry logic',
          suggestion: 'Extract a shared helper',
          files: ['a.js', 'b.js'],
        },
      ],
      recommendations: [{ category: 'testing', suggestion: 'Cover the retry path', impact: 'Fewer regressions' }],
    },
  };

  it('should keep the file list from a cross-file issue', () => {
    const findings = collectPRLevelFindings([], { holisticAnalysis });

    expect(findings.issues[0].files).toEqual(['a.js', 'b.js']);
    expect(findings.issues[0].description).toBe('Duplicated retry logic');
  });

  it('should render a recommendation as text rather than raw JSON', () => {
    const findings = collectPRLevelFindings([], { holisticAnalysis });

    expect(findings.recommendations[0]).toBe('testing: Cover the retry path: Fewer regressions');
  });
});
