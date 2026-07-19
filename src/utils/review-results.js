/**
 * Helpers for summarizing review results across file-level and PR-level findings.
 */

export function getFileLevelIssueCount(reviewResults = []) {
  return reviewResults.reduce((sum, result) => sum + (result?.results?.issues?.length || 0), 0);
}

export function getReviewResultsForErrorOutput(error, aggregateResult = {}) {
  if (aggregateResult.results?.length > 0) {
    return aggregateResult.results;
  }

  return [{ filePath: 'review', success: false, error }];
}

export function hasPRLevelFindings(prLevelFindings = {}) {
  return Boolean(prLevelFindings.summary || prLevelFindings.issues?.length || prLevelFindings.recommendations?.length);
}

export function collectPRLevelFindings(reviewResults = [], aggregateResult = {}) {
  const findings = {
    summary: null,
    issues: [],
    recommendations: [],
  };
  const seenIssues = new Set();
  const seenRecommendations = new Set();

  const addRecommendation = (recommendation) => {
    if (!recommendation) {
      return;
    }

    const text = normalizeRecommendation(recommendation);
    if (!seenRecommendations.has(text)) {
      findings.recommendations.push(text);
      seenRecommendations.add(text);
    }
  };

  const addIssue = (issue, source) => {
    const normalized = normalizePRLevelIssue(issue, source);
    if (!normalized.description) {
      return;
    }

    const key = JSON.stringify({
      type: normalized.type,
      severity: normalized.severity,
      description: normalized.description,
      files: [...normalized.files].sort(),
      suggestion: normalized.suggestion,
    });
    if (seenIssues.has(key)) {
      return;
    }

    findings.issues.push(normalized);
    seenIssues.add(key);
  };

  const addHolisticAnalysis = (analysis) => {
    const results = analysis?.results || analysis;
    if (!results) {
      return;
    }

    findings.summary ||= results.overallSummary || results.summary || null;

    for (const issue of results.crossFileIssues || []) {
      addIssue(issue, 'cross-file');
    }
    for (const recommendation of results.recommendations || []) {
      addRecommendation(recommendation);
    }
  };

  addHolisticAnalysis(aggregateResult?.prContext?.holisticAnalysis);
  addHolisticAnalysis(aggregateResult?.holisticAnalysis);

  for (const issue of aggregateResult?.crossChunkIssues || []) {
    addRecommendation(normalizeCrossChunkPattern(issue));
  }

  for (const result of reviewResults) {
    addHolisticAnalysis(result?.holisticAnalysis);
  }

  return findings;
}

function normalizePRLevelIssue(issue = {}, source) {
  const files = issue.files || issue.affectedFiles || issue.filePaths || [];
  const fileList = Array.isArray(files) ? files : [files];

  return {
    type: issue.type || source,
    source,
    severity: issue.severity || 'info',
    description: issue.description || issue.message || '',
    suggestion: issue.suggestion || issue.recommendation || '',
    files: fileList.filter(Boolean),
    lineNumbers: issue.lineNumbers || [],
  };
}

function normalizeRecommendation(recommendation) {
  if (typeof recommendation === 'string') {
    return recommendation;
  }

  if (typeof recommendation === 'object') {
    const parts = [recommendation.category, recommendation.suggestion, recommendation.impact].filter(Boolean);
    return parts.join(': ') || JSON.stringify(recommendation);
  }

  return String(recommendation);
}

function normalizeCrossChunkPattern(issue = {}) {
  const description = issue.description || issue.message;
  const suggestion = issue.suggestion || issue.recommendation;
  const files = issue.affectedFiles || issue.files || [];
  const fileList = Array.isArray(files) ? files.filter(Boolean) : [files].filter(Boolean);
  const parts = [description, suggestion].filter(Boolean);

  if (fileList.length > 0) {
    parts.push(`Affected files: ${fileList.join(', ')}`);
  }

  return parts.join(' ');
}
