import { collectPRLevelFindings, getFileLevelIssueCount, hasPRLevelFindings } from './review-results.js';

describe('review-results utilities', () => {
  it('does not count synthetic cross-chunk patterns as additional issues', () => {
    const reviewResults = [
      { results: { issues: [{ description: 'File issue' }] } },
      { results: { issues: [{ description: 'Another file issue' }] } },
    ];
    const aggregateResult = {
      crossChunkIssues: [{ description: 'Pattern issue', severity: 'medium', affectedFiles: ['a.js', 'b.js'] }],
    };

    const findings = collectPRLevelFindings(reviewResults, aggregateResult);

    expect(getFileLevelIssueCount(reviewResults)).toBe(2);
    expect(getFileLevelIssueCount(reviewResults) + findings.issues.length).toBe(2);
    expect(findings.recommendations).toEqual(['Pattern issue Affected files: a.js, b.js']);
  });

  it('collects and deduplicates holistic cross-file findings from aggregate and file results', () => {
    const crossFileIssue = {
      message: 'State update is inconsistent across files',
      severity: 'high',
      files: ['src/a.js', 'src/unchanged-shared-state.js'],
      suggestion: 'Use the shared state updater in both files.',
    };
    const reviewResults = [
      {
        holisticAnalysis: {
          overallSummary: 'Holistic summary',
          crossFileIssues: [crossFileIssue],
          recommendations: [],
        },
      },
    ];
    const aggregateResult = {
      prContext: {
        holisticAnalysis: {
          results: {
            summary: 'Aggregate summary',
            crossFileIssues: [crossFileIssue],
            recommendations: [{ category: 'testing', suggestion: 'Add an integration test' }],
          },
        },
      },
    };

    const findings = collectPRLevelFindings(reviewResults, aggregateResult);

    expect(findings.summary).toBe('Aggregate summary');
    expect(hasPRLevelFindings(findings)).toBe(true);
    expect(findings.issues).toEqual([
      expect.objectContaining({
        source: 'cross-file',
        severity: 'high',
        description: 'State update is inconsistent across files',
        files: ['src/a.js', 'src/unchanged-shared-state.js'],
        suggestion: 'Use the shared state updater in both files.',
      }),
    ]);
    expect(findings.recommendations).toEqual(['testing: Add an integration test']);
  });

  it('recognizes summary-only PR-level findings', () => {
    const findings = collectPRLevelFindings([], {
      prContext: {
        holisticAnalysis: {
          results: {
            summary: 'The PR changes a shared integration flow.',
            crossFileIssues: [],
            recommendations: [],
          },
        },
      },
    });

    expect(findings).toEqual({
      summary: 'The PR changes a shared integration flow.',
      issues: [],
      recommendations: [],
    });
    expect(hasPRLevelFindings(findings)).toBe(true);
  });
});
