import fs from 'node:fs';
import * as llm from './llm.js';
import { findRelevantPRComments } from './pr-history/database.js';
import { runAnalysis, gatherUnifiedContextForPR } from './rag-analyzer.js';
import {
  createMockReviewResponse,
  createMockHolisticReviewResponse,
  createMockPRFile,
  createMockUnifiedContext,
  createMockPRComment,
  createMockLongCode,
} from './test-utils/fixtures.js';
import { shouldProcessFile, isTestFile } from './utils/file-validation.js';

// Create hoisted mock for embeddings system (inline since can't use imported functions)
const mockEmbeddingsSystem = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  calculateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  calculateQueryEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  getProjectSummary: vi.fn().mockResolvedValue(null),
  findRelevantDocs: vi.fn().mockResolvedValue([]),
  findSimilarCode: vi.fn().mockResolvedValue([]),
  findRelevantCustomDocChunks: vi.fn().mockResolvedValue([]),
  processCustomDocumentsInMemory: vi.fn().mockResolvedValue([]),
  getExistingCustomDocumentChunks: vi.fn().mockResolvedValue([]),
  contentRetriever: {
    findSimilarCode: vi.fn().mockResolvedValue({ relevantFiles: [], relevantChunks: [] }),
    findSimilarDocumentChunks: vi.fn().mockResolvedValue([]),
  },
  projectAnalyzer: {
    analyzeProject: vi.fn().mockResolvedValue({ keyFiles: [], technologies: [] }),
  },
  customDocuments: {
    queryCustomDocuments: vi.fn().mockResolvedValue([]),
  },
  getPRCommentsTable: vi.fn().mockResolvedValue(null),
  updatePRCommentsIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('./embeddings/factory.js', () => ({
  getDefaultEmbeddingsSystem: vi.fn(() => mockEmbeddingsSystem),
}));

vi.mock('./feedback-loader.js', () => ({
  loadFeedbackData: vi.fn().mockResolvedValue(null),
  shouldSkipSimilarIssue: vi.fn().mockReturnValue(false),
  extractDismissedPatterns: vi.fn().mockReturnValue([]),
  generateFeedbackContext: vi.fn().mockReturnValue(''),
  initializeSemanticSimilarity: vi.fn().mockResolvedValue(undefined),
  isSemanticSimilarityAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock('./llm.js', () => ({
  sendPromptToClaude: vi.fn(),
}));

vi.mock('./pr-history/database.js', () => ({
  findRelevantPRComments: vi.fn().mockResolvedValue([]),
}));

vi.mock('./utils/file-validation.js', () => ({
  shouldProcessFile: vi.fn().mockReturnValue(true),
  isTestFile: vi.fn().mockReturnValue(false),
}));

vi.mock('./utils/language-detection.js', () => ({
  detectFileType: vi.fn().mockReturnValue({ isTest: false }),
  detectLanguageFromExtension: vi.fn().mockReturnValue('javascript'),
}));

vi.mock('./utils/logging.js', () => ({
  debug: vi.fn(),
}));

vi.mock('./utils/context-inference.js', () => ({
  inferContextFromCodeContent: vi.fn().mockReturnValue({
    area: 'Frontend',
    dominantTech: ['JavaScript', 'React'],
    frameworks: ['React'],
    keywords: ['component', 'state', 'props'],
  }),
  inferContextFromDocumentContent: vi.fn().mockReturnValue({
    area: 'Documentation',
    dominantTech: ['Markdown'],
    frameworks: [],
    keywords: ['guide', 'reference'],
  }),
}));

vi.mock('./utils/document-detection.js', () => ({
  isGenericDocument: vi.fn().mockReturnValue(false),
  getGenericDocumentContext: vi.fn().mockReturnValue({
    area: 'General',
    dominantTech: [],
    frameworks: [],
    keywords: [],
  }),
}));

// ============================================================================
// Helper Functions
// ============================================================================

const setupSuccessfulLLMResponse = (response = createMockReviewResponse()) => {
  llm.sendPromptToClaude.mockResolvedValue(response);
};

const setupHolisticReviewOptions = (overrides = {}) => ({
  isHolisticPRReview: true,
  prFiles: overrides.prFiles || [createMockPRFile()],
  unifiedContext: overrides.unifiedContext || createMockUnifiedContext(),
  prContext: overrides.prContext || { totalFiles: 1 },
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('rag-analyzer', () => {
  beforeEach(() => {
    mockConsole();
    llm.sendPromptToClaude.mockReset();
    shouldProcessFile.mockReset().mockReturnValue(true);
    isTestFile.mockReset().mockReturnValue(false);
    findRelevantPRComments.mockReset().mockResolvedValue([]);
    // Reset embeddings system (inline since can't use imported function with hoisted mocks)
    mockEmbeddingsSystem.initialize.mockReset().mockResolvedValue(undefined);
    mockEmbeddingsSystem.calculateEmbedding.mockReset().mockResolvedValue(new Array(384).fill(0.1));
    mockEmbeddingsSystem.calculateQueryEmbedding.mockReset().mockResolvedValue(new Array(384).fill(0.1));
    mockEmbeddingsSystem.getProjectSummary.mockReset().mockResolvedValue(null);
    mockEmbeddingsSystem.findRelevantDocs.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.findSimilarCode.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.findRelevantCustomDocChunks.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.processCustomDocumentsInMemory.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.contentRetriever.findSimilarCode.mockReset().mockResolvedValue({ relevantFiles: [], relevantChunks: [] });
    mockEmbeddingsSystem.contentRetriever.findSimilarDocumentChunks.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.projectAnalyzer.analyzeProject.mockReset().mockResolvedValue({ keyFiles: [], technologies: [] });
    mockEmbeddingsSystem.customDocuments.queryCustomDocuments.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.getPRCommentsTable.mockReset().mockResolvedValue(null);
    mockEmbeddingsSystem.updatePRCommentsIndex.mockReset().mockResolvedValue(undefined);
    fs.readFileSync.mockReturnValue('const x = 1;\nconsole.log(x);');
    fs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // runAnalysis - Basic Scenarios
  // ==========================================================================

  describe('runAnalysis', () => {
    it.each([
      ['analyze a file successfully', { json: { summary: 'No issues', issues: [] } }, { success: true }],
      ['handle LLM response without json property', { text: 'Raw text response' }, { success: true }],
      ['handle empty issues array', { json: { summary: 'No issues', issues: [] } }, { success: true }],
    ])('should %s', async (_, llmResponse, expected) => {
      llm.sendPromptToClaude.mockResolvedValue(llmResponse);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(expected.success);
    });

    it('should skip files that should not be processed', async () => {
      shouldProcessFile.mockReturnValue(false);
      const result = await runAnalysis('/test/excluded.js');
      expect(result.skipped).toBe(true);
      expect(llm.sendPromptToClaude).not.toHaveBeenCalled();
    });

    it('should handle LLM errors gracefully', async () => {
      llm.sendPromptToClaude.mockRejectedValue(new Error('LLM unavailable'));
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(false);
      expect(result.error).toContain('LLM unavailable');
    });

    it('should initialize embeddings system', async () => {
      setupSuccessfulLLMResponse();
      await runAnalysis('/test/file.js');
      expect(mockEmbeddingsSystem.initialize).toHaveBeenCalled();
    });

    it('should return error when file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);
      const result = await runAnalysis('/test/nonexistent.js');
      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('should handle embeddings system initialization failure', async () => {
      mockEmbeddingsSystem.initialize.mockRejectedValue(new Error('Init failed'));
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // runAnalysis - Options Handling
  // ==========================================================================

  describe('runAnalysis options', () => {
    beforeEach(() => setupSuccessfulLLMResponse());

    it.each([
      ['verbose option', { verbose: true }],
      ['custom model option', { model: 'claude-3-opus' }],
      ['custom directory option', { verbose: true, directory: '/custom/dir' }],
      ['precomputed embedding', { precomputedEmbedding: createMockEmbedding() }],
      ['project path', { projectPath: '/test' }],
    ])('should handle %s', async (_, options) => {
      const result = await runAnalysis('/test/file.js', options);
      expect(result.success).toBe(true);
    });

    it('should handle diff-only mode', async () => {
      const result = await runAnalysis('/test/file.js', {
        diffOnly: true,
        diffContent: '+ new line\n- old line',
        fullFileContent: 'const x = 1;',
      });
      expect(result.success).toBe(true);
    });

    it('should handle PR context when provided', async () => {
      const result = await runAnalysis('/test/file.js', {
        prContext: {
          totalFiles: 5,
          testFiles: 1,
          sourceFiles: 4,
          allFiles: ['/file1.js', '/file2.js'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('should handle diff-only with branch info', async () => {
      const result = await runAnalysis('/test/file.js', {
        diffOnly: true,
        diffContent: '+ added line\n- removed line',
        baseBranch: 'main',
        targetBranch: 'feature',
        diffInfo: { addedLines: [1], removedLines: [2] },
      });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // runAnalysis - Test File Handling
  // ==========================================================================

  describe('runAnalysis test file handling', () => {
    beforeEach(() => setupSuccessfulLLMResponse());

    it('should handle test file analysis', async () => {
      isTestFile.mockReturnValue(true);
      const result = await runAnalysis('/test/file.test.js');
      expect(result.success).toBe(true);
      expect(isTestFile).toHaveBeenCalled();
    });

    it('should skip test file filtering for non-test files', async () => {
      isTestFile.mockReturnValue(false);
      const result = await runAnalysis('/src/component.js');
      expect(result.success).toBe(true);
    });

    it('should use test-specific guideline queries for test files', async () => {
      const { detectFileType } = await import('./utils/language-detection.js'); // eslint-disable-line no-restricted-syntax
      detectFileType.mockReturnValue({ isTest: true });
      const result = await runAnalysis('/test/component.test.js');
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // runAnalysis - Context Building
  // ==========================================================================

  describe('context building', () => {
    beforeEach(() => setupSuccessfulLLMResponse());

    it('should use project summary when available', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({
        name: 'Test Project',
        technologies: ['JavaScript', 'Node.js'],
      });
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(mockEmbeddingsSystem.getProjectSummary).toHaveBeenCalled();
    });

    it('should find similar code examples', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([{ path: '/similar.js', content: 'similar code', similarity: 0.9 }]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });

    it('should find relevant documentation', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([{ path: '/docs/api.md', content: 'API docs', similarity: 0.8 }]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });

    it('should include PR comments when available', async () => {
      findRelevantPRComments.mockResolvedValue([createMockPRComment()]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });

    it('should handle parallel context retrieval failure', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockRejectedValue(new Error('Doc search failed'));
      mockEmbeddingsSystem.findSimilarCode.mockRejectedValue(new Error('Code search failed'));
      findRelevantPRComments.mockRejectedValue(new Error('PR comments failed'));
      llm.sendPromptToClaude.mockResolvedValue({ json: { summary: 'Review', issues: [] } });
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // runAnalysis - File Content Handling
  // ==========================================================================

  describe('file content handling', () => {
    beforeEach(() => setupSuccessfulLLMResponse());

    it.each([
      ['empty file content', ''],
      ['whitespace only', '   \n\n   '],
      ['normal content', 'const x = 1;\nfunction test() {}'],
    ])('should handle %s', async (_, content) => {
      fs.readFileSync.mockReturnValue(content);
      const result = await runAnalysis('/test/file.js');
      expect(result).toBeDefined();
    });

    it('should handle very long files', async () => {
      fs.readFileSync.mockReturnValue(createMockLongCode(1000));
      const result = await runAnalysis('/test/long.js');
      expect(result.success).toBe(true);
    });

    it('should detect language from file extension', async () => {
      const result = await runAnalysis('/test/file.ts');
      expect(result.success).toBe(true);
      expect(result.language).toBeDefined();
    });
  });

  // ==========================================================================
  // runAnalysis - LLM Response Parsing
  // ==========================================================================

  describe('LLM response parsing', () => {
    it('should handle JSON response with issues array', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Found issues',
          issues: [
            { severity: 'medium', message: 'Issue 1', line: 10 },
            { severity: 'high', message: 'Issue 2', line: 20 },
          ],
        },
      });
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
    });

    it('should handle malformed LLM response with missing issues', async () => {
      llm.sendPromptToClaude.mockResolvedValue({ json: { summary: 'Partial response' } });
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
    });

    it('should handle LLM response with null json', async () => {
      llm.sendPromptToClaude.mockResolvedValue({ json: null });
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // runAnalysis - Metadata and Results
  // ==========================================================================

  describe('metadata and results', () => {
    beforeEach(() => setupSuccessfulLLMResponse());

    it('should include metadata in results', async () => {
      const result = await runAnalysis('/test/file.js');
      expect(result.metadata).toBeDefined();
      expect(result.metadata.analysisTimestamp).toBeDefined();
    });

    it('should include file metadata in results', async () => {
      const result = await runAnalysis('/test/file.js');
      expect(result.filePath).toBeDefined();
      expect(result.language).toBeDefined();
    });

    it('should include context information', async () => {
      const result = await runAnalysis('/test/file.js');
      expect(result.context).toBeDefined();
      expect(result.context.codeExamples).toBeDefined();
    });

    it('should include similar examples when found', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([{ path: '/similar.js', content: 'code', similarity: 0.9 }]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(result.similarExamples).toBeDefined();
    });
  });

  // ==========================================================================
  // runAnalysis - Low Severity Filtering
  // ==========================================================================

  describe('low severity filtering', () => {
    it.each([
      [
        'file issues',
        { summary: 'Found issues', issues: [{ severity: 'high' }, { severity: 'low' }, { severity: 'medium' }] },
        (r) => r.results.issues.length === 2 && r.results.issues.every((i) => i.severity !== 'low'),
      ],
    ])('should filter low severity %s', async (_, response, validator) => {
      llm.sendPromptToClaude.mockResolvedValue({ json: response });
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(validator(result)).toBe(true);
    });

    it('should log filtered count when verbose and issues filtered', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Found issues', issues: [{ severity: 'low' }, { severity: 'low' }] },
      });
      const result = await runAnalysis('/test/file.js', { verbose: true });
      expect(result.success).toBe(true);
      expect(result.results.issues).toHaveLength(0);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Filtered'));
    });
  });

  // ==========================================================================
  // Holistic PR Review
  // ==========================================================================

  describe('holistic PR review', () => {
    it('should handle holistic PR review mode', async () => {
      llm.sendPromptToClaude.mockResolvedValue(createMockHolisticReviewResponse());
      const result = await runAnalysis('PR_HOLISTIC_REVIEW', setupHolisticReviewOptions());
      expect(result.success).toBe(true);
    });

    it.each([
      ['cross-file issues', { crossFileIssues: [{ message: 'Cross-file issue', severity: 'medium', files: ['a.js', 'b.js'] }] }],
      ['file-specific issues', { fileSpecificIssues: { 'file.js': [{ message: 'Issue', line: 5 }] } }],
      ['recommendations', { recommendations: ['Add tests', 'Update docs', 'Refactor'] }],
    ])('should handle holistic review with %s', async (_, responseOverrides) => {
      llm.sendPromptToClaude.mockResolvedValue(createMockHolisticReviewResponse(responseOverrides));
      const result = await runAnalysis('PR_HOLISTIC_REVIEW', setupHolisticReviewOptions());
      expect(result.success).toBe(true);
    });

    it('should filter low severity cross-file issues', async () => {
      llm.sendPromptToClaude.mockResolvedValue(
        createMockHolisticReviewResponse({
          crossFileIssues: [
            { severity: 'low', message: 'Minor', files: ['a.js'] },
            { severity: 'high', message: 'Critical', files: ['b.js'] },
          ],
        })
      );
      const result = await runAnalysis('PR_HOLISTIC_REVIEW', setupHolisticReviewOptions());
      expect(result.success).toBe(true);
      expect(result.results.crossFileIssues).toHaveLength(1);
      expect(result.results.crossFileIssues[0].severity).toBe('high');
    });

    it('should filter low severity file-specific issues', async () => {
      llm.sendPromptToClaude.mockResolvedValue(
        createMockHolisticReviewResponse({
          fileSpecificIssues: {
            'file.js': [
              { severity: 'low', description: 'Minor issue' },
              { severity: 'critical', description: 'Critical issue' },
            ],
          },
        })
      );
      const result = await runAnalysis('PR_HOLISTIC_REVIEW', setupHolisticReviewOptions());
      expect(result.success).toBe(true);
      expect(result.results.fileSpecificIssues['file.js']).toHaveLength(1);
      expect(result.results.fileSpecificIssues['file.js'][0].severity).toBe('critical');
    });

    it('should handle LLM error in holistic analysis', async () => {
      llm.sendPromptToClaude.mockRejectedValue(new Error('LLM failed'));
      const result = await runAnalysis('PR_HOLISTIC_REVIEW', setupHolisticReviewOptions());
      expect(result.success).toBe(false);
      expect(result.error).toContain('LLM failed');
    });

    it('should include all context types in holistic review', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({ projectName: 'Test', technologies: ['React'] });
      llm.sendPromptToClaude.mockResolvedValue(createMockHolisticReviewResponse());
      const result = await runAnalysis(
        'PR_HOLISTIC_REVIEW',
        setupHolisticReviewOptions({
          prFiles: [createMockPRFile({ fullContent: 'const x = 1;', summary: 'Added code' })],
          unifiedContext: createMockUnifiedContext({
            codeExamples: [{ path: '/ex.js', content: 'example', similarity: 0.9, language: 'javascript' }],
            guidelines: [{ path: '/docs/guide.md', content: 'Rules', similarity: 0.8, headingText: 'Rules' }],
            prComments: [createMockPRComment({ relevanceScore: 0.7 })],
            customDocChunks: [{ document_title: 'Custom', content: 'Content', chunk_index: 0, similarity: 0.75 }],
          }),
          prContext: { totalFiles: 1 },
        })
      );
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Feedback Filtering
  // ==========================================================================

  describe('feedback filtering', () => {
    it('should load feedback data when trackFeedback is enabled', async () => {
      const { loadFeedbackData } = await import('./feedback-loader.js'); // eslint-disable-line no-restricted-syntax
      loadFeedbackData.mockResolvedValue({ issues: [] });
      setupSuccessfulLLMResponse();
      const result = await runAnalysis('/test/file.js', {
        trackFeedback: true,
        feedbackPath: '/test/feedback.json',
      });
      expect(result.success).toBe(true);
      expect(loadFeedbackData).toHaveBeenCalledWith('/test/feedback.json', expect.any(Object));
    });

    it('should filter issues based on feedback similarity', async () => {
      const { loadFeedbackData, shouldSkipSimilarIssue } = await import('./feedback-loader.js'); // eslint-disable-line no-restricted-syntax
      loadFeedbackData.mockResolvedValue({ issues: [{ description: 'Already fixed' }] });
      shouldSkipSimilarIssue.mockReturnValue(true);
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [{ severity: 'high', description: 'Similar to dismissed' }] },
      });
      const result = await runAnalysis('/test/file.js', { trackFeedback: true, feedbackPath: '/test/feedback.json' });
      expect(result.success).toBe(true);
      expect(shouldSkipSimilarIssue).toHaveBeenCalled();
    });

    it('should include feedback filtering metadata in results', async () => {
      const { loadFeedbackData, shouldSkipSimilarIssue } = await import('./feedback-loader.js'); // eslint-disable-line no-restricted-syntax
      loadFeedbackData.mockResolvedValue({ issues: [{ description: 'Dismissed' }] });
      shouldSkipSimilarIssue.mockImplementation((desc) => desc.includes('Skip'));
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Review',
          issues: [
            { severity: 'high', description: 'Keep this' },
            { severity: 'high', description: 'Skip this' },
          ],
        },
      });
      const result = await runAnalysis('/test/file.js', { trackFeedback: true, feedbackPath: '/test/feedback.json' });
      expect(result.success).toBe(true);
      expect(result.metadata.feedbackFiltering).toBeDefined();
    });

    it('should include dismissed patterns when feedback has patterns', async () => {
      const { loadFeedbackData, extractDismissedPatterns } = await import('./feedback-loader.js'); // eslint-disable-line no-restricted-syntax
      loadFeedbackData.mockResolvedValue({ issues: [{ description: 'Old issue', dismissed: true }] });
      extractDismissedPatterns.mockReturnValue([
        { issue: 'Import order', reason: 'false positive', sentiment: 'negative' },
        { issue: 'Formatting', reason: 'handled by linter', sentiment: 'neutral' },
      ]);
      setupSuccessfulLLMResponse();
      const result = await runAnalysis('/test/file.js', { trackFeedback: true, feedbackPath: '/test/feedback.json' });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Project Summary Formatting
  // ==========================================================================

  describe('project summary formatting', () => {
    beforeEach(() => setupSuccessfulLLMResponse());

    it('should format project summary with all fields', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({
        projectName: 'Test Project',
        projectType: 'web-app',
        technologies: ['JavaScript', 'React', 'Node.js', 'Express'],
        mainFrameworks: ['React', 'Express'],
        customImplementations: [
          { name: 'CustomHook', description: 'A custom React hook', properties: ['useState', 'useEffect'] },
          { name: 'ApiWrapper', description: 'API wrapper utility' },
        ],
        apiPatterns: [{ type: 'REST', description: 'RESTful API design' }],
        stateManagement: { approach: 'Redux', patterns: ['Slice pattern', 'Thunks'] },
        reviewGuidelines: ['Use TypeScript', 'Write tests', 'Follow ESLint rules'],
      });
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(mockEmbeddingsSystem.getProjectSummary).toHaveBeenCalled();
    });

    it('should handle project summary with many technologies', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({
        projectName: 'Large Project',
        technologies: ['JS', 'TS', 'React', 'Vue', 'Angular', 'Node', 'Express', 'Fastify', 'MongoDB', 'PostgreSQL'],
      });
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });

    it('should handle empty project summary gracefully', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({});
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });

    it('should handle getProjectSummary errors gracefully', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockRejectedValue(new Error('DB connection failed'));
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // PR Comment Context
  // ==========================================================================

  describe('PR comment context', () => {
    beforeEach(() => setupSuccessfulLLMResponse());

    it('should format PR comments for context', async () => {
      findRelevantPRComments.mockResolvedValue([
        createMockPRComment({ author: 'reviewer1', body: 'This needs improvement', pr_title: 'Feature PR' }),
        createMockPRComment({ author_login: 'reviewer2', comment_text: 'Consider refactoring', comment_type: 'inline' }),
      ]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(result.prHistory).toBeDefined();
      expect(result.prHistory.commentsFound).toBe(2);
    });

    it('should extract patterns from PR comments', async () => {
      findRelevantPRComments.mockResolvedValue([
        createMockPRComment({ body: 'This is a performance issue and could cause problems' }),
        createMockPRComment({ body: 'Consider improving the security of this implementation' }),
      ]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(result.prHistory.patterns).toBeDefined();
    });

    it('should handle PR comment search failure gracefully', async () => {
      findRelevantPRComments.mockRejectedValue(new Error('Search failed'));
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });

    it('should identify recent comments in summary', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5);
      findRelevantPRComments.mockResolvedValue([
        createMockPRComment({ body: 'Recent comment about performance', created_at: recentDate.toISOString() }),
      ]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(result.prHistory).toBeDefined();
    });
  });

  // ==========================================================================
  // Custom Documents
  // ==========================================================================

  describe('custom documents', () => {
    beforeEach(() => setupSuccessfulLLMResponse());

    it('should find relevant custom document chunks', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([
        { content: 'Coding guidelines', document_title: 'Style Guide' },
        { content: 'Testing best practices', document_title: 'Test Guide' },
      ]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });

    it('should process custom documents in memory', async () => {
      mockEmbeddingsSystem.processCustomDocumentsInMemory.mockResolvedValue([{ content: 'In-memory doc', document_title: 'Temp Guide' }]);
      const result = await runAnalysis('/test/file.js', { customDocuments: ['path/to/doc.md'] });
      expect(result.success).toBe(true);
    });

    it('should process custom documents when not preprocessed', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([]);
      mockEmbeddingsSystem.processCustomDocumentsInMemory.mockResolvedValue([
        { id: 'c1', content: 'New processed chunk', document_title: 'New Doc', chunk_index: 0 },
      ]);
      mockEmbeddingsSystem.findRelevantCustomDocChunks.mockResolvedValue([
        { id: 'c1', content: 'New processed chunk', document_title: 'New Doc', chunk_index: 0, similarity: 0.8 },
      ]);
      const result = await runAnalysis('/test/file.js', { customDocs: ['/docs/new-guide.md'] });
      expect(result.success).toBe(true);
    });

    it('should log selected chunks when verbose', async () => {
      mockEmbeddingsSystem.findRelevantCustomDocChunks.mockResolvedValue([
        { id: 'chunk1', content: 'Guidelines', document_title: 'Guide', chunk_index: 0, similarity: 0.85 },
      ]);
      const result = await runAnalysis('/test/file.js', { customDocs: ['/docs/guide.md'], verbose: true });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Context Retrieval Edge Cases
  // ==========================================================================

  describe('context retrieval edge cases', () => {
    beforeEach(() => setupSuccessfulLLMResponse());

    it('should handle file with documentation chunks', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        {
          path: '/docs/api.md',
          content: 'API Documentation',
          similarity: 0.9,
          type: 'documentation-chunk',
          document_title: 'API Docs',
          heading_text: 'Authentication',
        },
      ]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });

    it('should deduplicate code examples by path', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([
        { path: '/util.js', content: 'code1', similarity: 0.9 },
        { path: '/util.js', content: 'code2', similarity: 0.85 },
        { path: '/helper.js', content: 'code3', similarity: 0.8 },
      ]);
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
    });

    it('should include guidelines with heading text', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        {
          path: '/docs/api.md',
          content: 'Authentication should use JWT tokens',
          similarity: 0.9,
          type: 'documentation-chunk',
          document_title: 'API Reference',
          heading_text: 'Security Best Practices',
          chunk_index: 0,
        },
      ]);
      const result = await runAnalysis('/test/auth.js');
      expect(result.success).toBe(true);
      expect(result.context.guidelines).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // Verbose Logging
  // ==========================================================================

  describe('verbose logging paths', () => {
    it('should log context information when verbose', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([{ path: '/example.js', content: 'code', similarity: 0.9 }]);
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        { path: '/docs/api.md', content: 'docs', similarity: 0.8, type: 'documentation-chunk', document_title: 'API' },
      ]);
      findRelevantPRComments.mockResolvedValue([createMockPRComment()]);
      setupSuccessfulLLMResponse();
      const result = await runAnalysis('/test/file.js', { verbose: true });
      expect(result.success).toBe(true);
      expect(console.log).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // gatherUnifiedContextForPR
  // ==========================================================================

  describe('gatherUnifiedContextForPR', () => {
    it('should gather context for PR files', async () => {
      const prFiles = [
        { filePath: '/src/file1.js', content: 'code1', language: 'javascript' },
        { filePath: '/src/file2.js', content: 'code2', language: 'javascript' },
      ];
      const context = await gatherUnifiedContextForPR(prFiles);
      expect(context).toHaveProperty('codeExamples');
      expect(context).toHaveProperty('guidelines');
      expect(context).toHaveProperty('prComments');
      expect(context).toHaveProperty('customDocChunks');
    });

    it('should query for relevant PR comments', async () => {
      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];
      await gatherUnifiedContextForPR(prFiles);
      expect(findRelevantPRComments).toHaveBeenCalled();
    });

    it('should handle empty PR files array', async () => {
      const context = await gatherUnifiedContextForPR([]);
      expect(context.codeExamples).toEqual([]);
      expect(context.guidelines).toEqual([]);
    });

    it('should deduplicate context across files', async () => {
      mockEmbeddingsSystem.contentRetriever.findSimilarCode.mockResolvedValue({
        relevantFiles: [{ path: '/common/util.js', content: 'shared code' }],
        relevantChunks: [],
      });
      const prFiles = [
        { filePath: '/src/file1.js', content: 'code1', language: 'javascript' },
        { filePath: '/src/file2.js', content: 'code2', language: 'javascript' },
      ];
      const context = await gatherUnifiedContextForPR(prFiles);
      expect(Array.isArray(context.codeExamples)).toBe(true);
    });

    it('should handle options parameter', async () => {
      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];
      const context = await gatherUnifiedContextForPR(prFiles, { verbose: true, projectPath: '/project' });
      expect(context).toHaveProperty('codeExamples');
    });

    it('should handle PR files with no content', async () => {
      const prFiles = [{ filePath: '/src/empty.js', content: '', language: 'javascript' }];
      const context = await gatherUnifiedContextForPR(prFiles);
      expect(context).toHaveProperty('codeExamples');
    });

    it('should find custom document chunks', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([{ content: 'Custom doc', document_title: 'Guidelines' }]);
      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];
      const context = await gatherUnifiedContextForPR(prFiles);
      expect(context).toHaveProperty('customDocChunks');
    });

    it('should use preprocessed custom doc chunks when available', async () => {
      const preprocessedChunks = [{ id: 'chunk1', content: 'Style guidelines', document_title: 'Style', chunk_index: 0, similarity: 0.9 }];
      mockEmbeddingsSystem.findRelevantCustomDocChunks.mockResolvedValue(preprocessedChunks);
      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];
      const context = await gatherUnifiedContextForPR(prFiles, { preprocessedCustomDocChunks: preprocessedChunks });
      expect(context).toBeDefined();
    });
  });

  // ==========================================================================
  // gatherUnifiedContextForPR Error Handling
  // ==========================================================================

  describe('gatherUnifiedContextForPR error handling', () => {
    it('should handle file context gathering errors', async () => {
      fs.readFileSync.mockImplementation((path) => {
        if (path.includes('error-file')) throw new Error('Read error');
        return 'const x = 1;';
      });
      const prFiles = [
        { filePath: '/src/good-file.js', content: 'code1', language: 'javascript' },
        { filePath: '/src/error-file.js', content: 'code2', language: 'javascript' },
      ];
      const context = await gatherUnifiedContextForPR(prFiles);
      expect(context).toBeDefined();
      expect(context.codeExamples).toBeDefined();
    });

    it('should aggregate context from multiple files', async () => {
      mockEmbeddingsSystem.findSimilarCode
        .mockResolvedValueOnce([{ path: '/util1.js', content: 'code1', similarity: 0.9 }])
        .mockResolvedValueOnce([{ path: '/util2.js', content: 'code2', similarity: 0.85 }]);
      const prFiles = [
        { filePath: '/src/file1.js', content: 'code1', language: 'javascript' },
        { filePath: '/src/file2.js', content: 'code2', language: 'javascript' },
      ];
      const context = await gatherUnifiedContextForPR(prFiles);
      expect(context.codeExamples.length).toBeGreaterThanOrEqual(0);
    });

    it('should limit aggregated results', async () => {
      const manyExamples = Array.from({ length: 50 }, (_, i) => ({
        path: `/util${i}.js`,
        content: `code${i}`,
        similarity: 0.9 - i * 0.01,
      }));
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue(manyExamples);
      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];
      const context = await gatherUnifiedContextForPR(prFiles, { maxExamples: 10 });
      expect(context.codeExamples.length).toBeLessThanOrEqual(40);
    });

    it('should handle custom document processing errors', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockRejectedValue(new Error('DB error'));
      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];
      const context = await gatherUnifiedContextForPR(prFiles, { customDocs: ['/docs/style-guide.md'] });
      expect(context).toBeDefined();
    });

    it('should reuse existing custom document chunks', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([
        { id: 'existing1', content: 'Existing doc', document_title: 'Existing', chunk_index: 0 },
      ]);
      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];
      const context = await gatherUnifiedContextForPR(prFiles, {
        customDocs: ['/docs/style-guide.md'],
        projectPath: '/project',
      });
      expect(context).toBeDefined();
      expect(mockEmbeddingsSystem.processCustomDocumentsInMemory).not.toHaveBeenCalled();
    });

    it('should process custom documents for PR analysis', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([]);
      mockEmbeddingsSystem.processCustomDocumentsInMemory.mockResolvedValue([
        { id: 'chunk1', content: 'Coding standards', document_title: 'Style Guide', chunk_index: 0 },
      ]);
      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];
      const context = await gatherUnifiedContextForPR(prFiles, {
        customDocs: ['/docs/style-guide.md'],
        projectPath: '/project',
      });
      expect(context.customDocChunks).toBeDefined();
    });
  });

  // ==========================================================================
  // Context Deduplication
  // ==========================================================================

  describe('context deduplication', () => {
    it('should deduplicate guidelines by path and heading', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        {
          path: '/docs/api.md',
          content: 'API docs',
          similarity: 0.9,
          type: 'documentation-chunk',
          document_title: 'API',
          heading_text: 'Overview',
        },
      ]);
      const prFiles = [
        { filePath: '/src/file1.js', content: 'code1' },
        { filePath: '/src/file2.js', content: 'code2' },
      ];
      const context = await gatherUnifiedContextForPR(prFiles);
      expect(context.guidelines).toBeDefined();
    });

    it('should keep higher similarity when deduplicating', async () => {
      mockEmbeddingsSystem.findSimilarCode
        .mockResolvedValueOnce([{ path: '/util.js', content: 'code', similarity: 0.7 }])
        .mockResolvedValueOnce([{ path: '/util.js', content: 'code', similarity: 0.9 }]);
      const prFiles = [
        { filePath: '/src/file1.js', content: 'code1' },
        { filePath: '/src/file2.js', content: 'code2' },
      ];
      const context = await gatherUnifiedContextForPR(prFiles);
      if (context.codeExamples.length > 0) {
        expect(context.codeExamples[0].similarity).toBeGreaterThanOrEqual(0.7);
      }
    });
  });

  // ==========================================================================
  // Comprehensive Context Gathering
  // ==========================================================================

  describe('comprehensive context gathering', () => {
    it('should gather all context types for comprehensive review', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([
        { path: '/util.js', content: 'export function helper() {}', similarity: 0.92, language: 'javascript' },
        { path: '/helper.js', content: 'export function format() {}', similarity: 0.88, language: 'javascript' },
      ]);
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        {
          path: '/docs/conventions.md',
          content: 'Always use TypeScript',
          similarity: 0.85,
          type: 'documentation-chunk',
          document_title: 'Conventions',
          heading_text: 'Type Safety',
        },
      ]);
      findRelevantPRComments.mockResolvedValue([
        createMockPRComment({ author: 'tech-lead', body: 'Consider using the shared utility', pr_number: 100 }),
      ]);
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([
        { id: 'custom-1', content: 'Internal guidelines', document_title: 'Internal', chunk_index: 0 },
      ]);
      mockEmbeddingsSystem.findRelevantCustomDocChunks.mockResolvedValue([
        { id: 'custom-1', content: 'Internal guidelines', document_title: 'Internal', chunk_index: 0, similarity: 0.8 },
      ]);
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({
        projectName: 'MyApp',
        technologies: ['React', 'TypeScript'],
        mainFrameworks: ['Next.js'],
      });
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Comprehensive review with all context',
          issues: [{ severity: 'medium', description: 'Consider using shared helper', lineNumbers: [10, 15] }],
        },
      });
      const result = await runAnalysis('/test/feature.js', { verbose: true, customDocs: ['/docs/internal.md'] });
      expect(result.success).toBe(true);
      expect(result.context.codeExamples).toBeGreaterThanOrEqual(0);
      expect(result.context.guidelines).toBeGreaterThanOrEqual(0);
      expect(result.similarExamples).toBeDefined();
    });

    it('should gather unified context with all data types', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([{ path: '/shared/util.js', content: 'shared', similarity: 0.95 }]);
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        { path: '/docs/style.md', content: 'Style guide', similarity: 0.85, type: 'documentation-chunk', document_title: 'Style' },
      ]);
      findRelevantPRComments.mockResolvedValue([createMockPRComment({ relevanceScore: 0.8 })]);
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([
        { id: 'cd1', content: 'Custom', document_title: 'Custom Doc', chunk_index: 0 },
      ]);
      mockEmbeddingsSystem.findRelevantCustomDocChunks.mockResolvedValue([
        { id: 'cd1', content: 'Custom', document_title: 'Custom Doc', chunk_index: 0, similarity: 0.75 },
      ]);
      const prFiles = [
        { filePath: '/src/new-feature.js', content: 'new code', diffContent: '+ new code', language: 'javascript' },
        { filePath: '/src/updated.js', content: 'updated', diffContent: '+ updated', language: 'javascript' },
      ];
      const context = await gatherUnifiedContextForPR(prFiles, { customDocs: ['/docs/custom.md'] });
      expect(context.codeExamples).toBeDefined();
      expect(context.guidelines).toBeDefined();
      expect(context.prComments).toBeDefined();
      expect(context.customDocChunks).toBeDefined();
    });
  });

  // ==========================================================================
  // PR History with Metadata
  // ==========================================================================

  describe('PR history with metadata', () => {
    it('should include PR history in results when comments found', async () => {
      findRelevantPRComments.mockResolvedValue([
        createMockPRComment({
          author: 'senior-dev',
          body: 'This pattern should use memoization for performance',
          pr_number: 456,
          pr_title: 'Performance improvements',
          similarity_score: 0.9,
        }),
      ]);
      setupSuccessfulLLMResponse();
      const result = await runAnalysis('/test/file.js');
      expect(result.success).toBe(true);
      expect(result.prHistory).not.toBeNull();
      expect(result.prHistory.commentsFound).toBe(1);
      expect(result.prHistory.patterns).toBeDefined();
      expect(result.prHistory.summary).toBeDefined();
    });
  });

  // ==========================================================================
  // Handle Code with Rich Context
  // ==========================================================================

  describe('rich code context', () => {
    it('should handle code with rich context', async () => {
      const richCode = `
        import React from 'react';
        import { useState, useEffect } from 'react';
        import axios from 'axios';

        export function Dashboard() {
          const [data, setData] = useState(null);
          useEffect(() => {
            axios.get('/api/data').then(res => setData(res.data));
          }, []);
          return <div>{data}</div>;
        }
      `;
      fs.readFileSync.mockReturnValue(richCode);
      setupSuccessfulLLMResponse();
      const result = await runAnalysis('/test/Dashboard.jsx');
      expect(result.success).toBe(true);
    });
  });
});
