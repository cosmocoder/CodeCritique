import fs from 'node:fs';
import * as factory from './embeddings/factory.js';
import {
  loadFeedbackData,
  shouldSkipSimilarIssue,
  calculateWordSimilarity,
  calculateIssueSimilarity,
  extractDismissedPatterns,
  generateFeedbackContext,
  isSemanticSimilarityAvailable,
  initializeSemanticSimilarity,
} from './feedback-loader.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    default: {
      ...original,
      existsSync: vi.fn(),
      readdirSync: vi.fn(),
      readFileSync: vi.fn(),
    },
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('./embeddings/factory.js', () => ({
  getDefaultEmbeddingsSystem: vi.fn(),
}));

describe('calculateWordSimilarity', () => {
  it('should return 1.0 for identical texts', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    expect(calculateWordSimilarity(text, text)).toBe(1);
  });

  it('should return 0 for completely different texts', () => {
    const text1 = 'apple banana cherry date';
    const text2 = 'elephant fox giraffe hippo';
    expect(calculateWordSimilarity(text1, text2)).toBe(0);
  });

  it('should return value between 0 and 1 for partially similar texts', () => {
    const text1 = 'missing null check in error handler';
    const text2 = 'add null check before accessing property';
    const similarity = calculateWordSimilarity(text1, text2);
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });

  it('should return 0 for empty texts', () => {
    expect(calculateWordSimilarity('', 'some text')).toBe(0);
    expect(calculateWordSimilarity('some text', '')).toBe(0);
    expect(calculateWordSimilarity('', '')).toBe(0);
  });

  it('should return 0 for null/undefined texts', () => {
    expect(calculateWordSimilarity(null, 'text')).toBe(0);
    expect(calculateWordSimilarity('text', undefined)).toBe(0);
  });

  it('should be case insensitive', () => {
    expect(calculateWordSimilarity('Hello World', 'hello world')).toBe(1);
  });

  it('should ignore punctuation', () => {
    expect(calculateWordSimilarity('hello, world!', 'hello world')).toBe(1);
  });

  it('should filter short words (length <= 2)', () => {
    // "a" and "an" are filtered out, only "cat" remains
    const text1 = 'a cat';
    const text2 = 'an cat';
    expect(calculateWordSimilarity(text1, text2)).toBe(1);
  });
});

describe('loadFeedbackData', () => {
  beforeEach(() => {
    mockConsoleSelective('log');
  });

  it('should return empty object for null path', async () => {
    const result = await loadFeedbackData(null);
    expect(result).toEqual({});
  });

  it('should return empty object for non-existent directory', async () => {
    fs.existsSync.mockReturnValue(false);

    const result = await loadFeedbackData('/nonexistent');

    expect(result).toEqual({});
  });

  it('should return empty object when no feedback files found', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['other-file.txt']);

    const result = await loadFeedbackData('/feedback');

    expect(result).toEqual({});
  });

  it('should load and merge feedback files', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['feedback-1.json', 'feedback-2.json']);
    fs.readFileSync.mockImplementation((path) => {
      if (path.includes('feedback-1')) {
        return JSON.stringify({ feedback: { issue1: { id: 1 } } });
      }
      return JSON.stringify({ feedback: { issue2: { id: 2 } } });
    });

    const result = await loadFeedbackData('/feedback');

    expect(result.issue1).toBeDefined();
    expect(result.issue2).toBeDefined();
  });

  it('should handle parsing errors gracefully', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['feedback-bad.json']);
    fs.readFileSync.mockReturnValue('invalid json');

    const result = await loadFeedbackData('/feedback');

    expect(result).toEqual({});
  });

  it('should only read files matching feedback-*.json pattern', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['feedback-1.json', 'other.json', 'feedback-2.txt', 'config.json']);
    fs.readFileSync.mockReturnValue(JSON.stringify({ feedback: { item: {} } }));

    await loadFeedbackData('/feedback');

    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('shouldSkipSimilarIssue', () => {
  it('should return false for empty feedback data', async () => {
    const result = await shouldSkipSimilarIssue('some issue', {});
    expect(result).toBe(false);
  });

  it('should return false for null feedback data', async () => {
    const result = await shouldSkipSimilarIssue('some issue', null);
    expect(result).toBe(false);
  });

  it('should return true for similar dismissed issue', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'negative',
        originalIssue: 'Missing null check in handler function',
      },
    };

    const result = await shouldSkipSimilarIssue('Missing null check in handler function', feedbackData, { similarityThreshold: 0.5 });

    expect(result).toBe(true);
  });

  it('should return false for dissimilar issues', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'negative',
        originalIssue: 'CSS styling issue in button component',
      },
    };

    const result = await shouldSkipSimilarIssue('Database connection timeout handling', feedbackData, { similarityThreshold: 0.5 });

    expect(result).toBe(false);
  });

  it('should detect dismissed issues from user replies', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'neutral',
        originalIssue: 'Consider adding error handling',
        userReplies: [{ body: 'This is a false positive' }],
      },
    };

    const result = await shouldSkipSimilarIssue('Consider adding error handling', feedbackData, { similarityThreshold: 0.5 });

    expect(result).toBe(true);
  });

  it('should detect resolved issues from user replies', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'neutral',
        originalIssue: 'Fix memory leak',
        userReplies: [{ body: 'This has been resolved in another PR' }],
      },
    };

    const result = await shouldSkipSimilarIssue('Fix memory leak', feedbackData, { similarityThreshold: 0.5 });

    expect(result).toBe(true);
  });

  it('should respect similarity threshold', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'negative',
        originalIssue: 'Add logging to error handler',
      },
    };

    // With high threshold, should not skip
    const result = await shouldSkipSimilarIssue('Add logging to success handler', feedbackData, { similarityThreshold: 0.95 });

    expect(result).toBe(false);
  });
});

describe('calculateIssueSimilarity', () => {
  it('should return zero similarity for empty texts', async () => {
    const result = await calculateIssueSimilarity('', 'text');
    expect(result.similarity).toBe(0);
    expect(result.method).toBe('none');
  });

  it('should use word-based similarity when embeddings not available', async () => {
    const result = await calculateIssueSimilarity('hello world', 'hello world', { useSemanticSimilarity: false });

    expect(result.method).toBe('word-based');
    expect(result.similarity).toBe(1);
  });

  it('should return similarity between 0 and 1', async () => {
    const result = await calculateIssueSimilarity('missing error handling', 'add error handling to function');

    expect(result.similarity).toBeGreaterThanOrEqual(0);
    expect(result.similarity).toBeLessThanOrEqual(1);
  });
});

describe('extractDismissedPatterns', () => {
  it('should return empty array for empty feedback', () => {
    expect(extractDismissedPatterns({})).toEqual([]);
    expect(extractDismissedPatterns(null)).toEqual([]);
  });

  it('should extract negative sentiment issues', () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'negative',
        originalIssue: 'Add type annotations',
      },
    };

    const patterns = extractDismissedPatterns(feedbackData);

    expect(patterns.length).toBe(1);
    expect(patterns[0].issue).toBe('Add type annotations');
    expect(patterns[0].sentiment).toBe('negative');
  });

  it('should extract issues dismissed as false positive', () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'neutral',
        originalIssue: 'Missing semicolon',
        userReplies: [{ body: 'This is a false positive, we use ASI' }],
      },
    };

    const patterns = extractDismissedPatterns(feedbackData);

    expect(patterns.length).toBe(1);
    expect(patterns[0].reason).toContain('false positive');
  });

  it('should limit patterns to maxPatterns', () => {
    const feedbackData = {};
    for (let i = 0; i < 20; i++) {
      feedbackData[`issue${i}`] = {
        overallSentiment: 'negative',
        originalIssue: `Issue ${i}`,
      };
    }

    const patterns = extractDismissedPatterns(feedbackData, { maxPatterns: 5 });

    expect(patterns.length).toBe(5);
  });
});

describe('generateFeedbackContext', () => {
  it('should return empty string for empty patterns', () => {
    expect(generateFeedbackContext([])).toBe('');
    expect(generateFeedbackContext(null)).toBe('');
  });

  it('should generate context text from patterns', () => {
    const patterns = [
      { issue: 'Add error handling', reason: 'Not applicable here' },
      { issue: 'Missing tests', reason: 'Tests are in another file' },
    ];

    const context = generateFeedbackContext(patterns);

    expect(context).toContain('Add error handling');
    expect(context).toContain('Missing tests');
    expect(context).toContain('previously dismissed');
  });

  it('should include numbered list', () => {
    const patterns = [
      { issue: 'Issue 1', reason: 'Reason 1' },
      { issue: 'Issue 2', reason: 'Reason 2' },
    ];

    const context = generateFeedbackContext(patterns);

    expect(context).toContain('1.');
    expect(context).toContain('2.');
  });
});

describe('semantic similarity', () => {
  let mockEmbeddingsSystem;

  beforeEach(() => {
    mockConsoleSelective('log', 'warn', 'error');

    mockEmbeddingsSystem = {
      initialize: vi.fn().mockResolvedValue(undefined),
      calculateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding()),
    };

    factory.getDefaultEmbeddingsSystem.mockReturnValue(mockEmbeddingsSystem);
  });

  it('should report semantic similarity as unavailable initially', () => {
    // Before initialization, semantic similarity should not be available
    expect(isSemanticSimilarityAvailable()).toBe(false);
  });

  it('should attempt to initialize semantic similarity', async () => {
    // This test just verifies initializeSemanticSimilarity can be called without error
    await expect(initializeSemanticSimilarity()).resolves.not.toThrow();
  });
});

describe('shouldSkipSimilarIssue edge cases', () => {
  beforeEach(() => {
    mockConsoleSelective('log', 'warn');
  });

  it('should handle feedback entries without originalIssue', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'negative',
        // No originalIssue field
      },
    };

    const result = await shouldSkipSimilarIssue('some issue', feedbackData);

    expect(result).toBe(false);
  });

  it('should handle feedback entries with empty userReplies', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'neutral',
        originalIssue: 'Some issue',
        userReplies: [],
      },
    };

    const result = await shouldSkipSimilarIssue('Some issue', feedbackData, { similarityThreshold: 0.9 });

    // Should not match since no replies and sentiment is neutral
    expect(result).toBe(false);
  });

  it('should detect "ignore" dismissal phrase', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'neutral',
        originalIssue: 'Missing validation',
        userReplies: [{ body: 'Please ignore this issue' }],
      },
    };

    const result = await shouldSkipSimilarIssue('Missing validation', feedbackData, { similarityThreshold: 0.5 });

    expect(result).toBe(true);
  });

  it('should detect "not relevant" dismissal phrase', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'neutral',
        originalIssue: 'Unusual pattern',
        userReplies: [{ body: 'Not relevant for this codebase' }],
      },
    };

    const result = await shouldSkipSimilarIssue('Unusual pattern', feedbackData, { similarityThreshold: 0.5 });

    expect(result).toBe(true);
  });

  it('should detect "resolved" dismissal phrase', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'neutral',
        originalIssue: 'Different approach',
        userReplies: [{ body: 'This has been resolved in another PR' }],
      },
    };

    const result = await shouldSkipSimilarIssue('Different approach', feedbackData, { similarityThreshold: 0.5 });

    expect(result).toBe(true);
  });

  it('should use verbose logging when enabled', async () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'negative',
        originalIssue: 'Some issue',
      },
    };

    await shouldSkipSimilarIssue('Some issue', feedbackData, { similarityThreshold: 0.5, verbose: true });

    expect(console.log).toHaveBeenCalled();
  });
});

describe('extractDismissedPatterns edge cases', () => {
  it('should detect "not relevant" dismissal in replies', () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'neutral',
        originalIssue: 'Old code style',
        userReplies: [{ body: 'Not relevant for this codebase' }],
      },
    };

    const patterns = extractDismissedPatterns(feedbackData);

    expect(patterns.length).toBe(1);
    expect(patterns[0].reason).toContain('Not relevant');
  });

  it('should detect "ignore" dismissal in replies', () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'neutral',
        originalIssue: 'Already fixed',
        userReplies: [{ body: 'Please ignore this issue' }],
      },
    };

    const patterns = extractDismissedPatterns(feedbackData);

    expect(patterns.length).toBe(1);
    expect(patterns[0].reason).toContain('ignore');
  });

  it('should not extract positive sentiment issues without dismissal phrases', () => {
    const feedbackData = {
      issue1: {
        overallSentiment: 'positive',
        originalIssue: 'Good suggestion',
        userReplies: [{ body: 'Great catch, fixed!' }],
      },
    };

    const patterns = extractDismissedPatterns(feedbackData);

    expect(patterns.length).toBe(0);
  });

  it('should use verbose logging when enabled', () => {
    mockConsoleSelective('log');

    const feedbackData = {
      issue1: {
        overallSentiment: 'negative',
        originalIssue: 'Some issue',
      },
    };

    extractDismissedPatterns(feedbackData, { verbose: true });

    expect(console.log).toHaveBeenCalled();
  });
});

describe('loadFeedbackData edge cases', () => {
  beforeEach(() => {
    mockConsoleSelective('log', 'warn');
  });

  it('should handle files with no feedback property', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['feedback-1.json']);
    fs.readFileSync.mockReturnValue(JSON.stringify({ other: 'data' }));

    const result = await loadFeedbackData('/feedback');

    expect(result).toEqual({});
  });

  it('should use default verbose option', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['feedback-1.json']);
    fs.readFileSync.mockReturnValue(JSON.stringify({ feedback: { item: { id: 1 } } }));

    const result = await loadFeedbackData('/feedback', { verbose: true });

    expect(result).toHaveProperty('item');
  });
});
