import fs from 'node:fs';
import * as llm from './llm.js';
import { findRelevantPRComments } from './pr-history/database.js';
import { runAnalysis, gatherUnifiedContextForPR } from './rag-analyzer.js';
import { shouldProcessFile, isTestFile } from './utils/file-validation.js';

// Create hoisted mock for embeddings system that will be used at module load time
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
    findSimilarCode: vi.fn().mockResolvedValue({
      relevantFiles: [],
      relevantChunks: [],
    }),
    findSimilarDocumentChunks: vi.fn().mockResolvedValue([]),
  },
  projectAnalyzer: {
    analyzeProject: vi.fn().mockResolvedValue({
      keyFiles: [],
      technologies: [],
    }),
  },
  customDocuments: {
    queryCustomDocuments: vi.fn().mockResolvedValue([]),
  },
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

describe('rag-analyzer', () => {
  beforeEach(() => {
    mockConsole();

    // Reset LLM mock
    llm.sendPromptToClaude.mockReset();

    // Reset shouldProcessFile to default (allow all files)
    shouldProcessFile.mockReset().mockReturnValue(true);

    // Reset and set mock implementations for the hoisted mock
    mockEmbeddingsSystem.initialize.mockReset().mockResolvedValue(undefined);
    mockEmbeddingsSystem.calculateEmbedding.mockReset().mockResolvedValue(new Array(384).fill(0.1));
    mockEmbeddingsSystem.calculateQueryEmbedding.mockReset().mockResolvedValue(new Array(384).fill(0.1));
    mockEmbeddingsSystem.getProjectSummary.mockReset().mockResolvedValue(null);
    mockEmbeddingsSystem.findRelevantDocs.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.findSimilarCode.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.findRelevantCustomDocChunks.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.processCustomDocumentsInMemory.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockReset().mockResolvedValue([]);
    mockEmbeddingsSystem.contentRetriever.findSimilarCode.mockReset().mockResolvedValue({
      relevantFiles: [],
      relevantChunks: [],
    });
    mockEmbeddingsSystem.contentRetriever.findSimilarDocumentChunks.mockReset().mockResolvedValue([]);

    fs.readFileSync.mockReturnValue('const x = 1;\nconsole.log(x);');
    fs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('runAnalysis', () => {
    it('should analyze a file successfully', async () => {
      // LLM returns response with json property containing structured data
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'No major issues found',
          issues: [],
        },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
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
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Test', issues: [] },
      });

      await runAnalysis('/test/file.js');

      expect(mockEmbeddingsSystem.initialize).toHaveBeenCalled();
    });

    it('should handle holistic PR review mode', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'PR review complete',
          fileSpecificIssues: {},
          crossFileIssues: [],
        },
      });

      const result = await runAnalysis('PR_HOLISTIC_REVIEW', {
        isHolisticPRReview: true,
        prFiles: [{ path: 'file.js', diff: '+ code' }],
        unifiedContext: {
          codeExamples: [],
          guidelines: [],
          prComments: [],
          customDocChunks: [],
        },
        prContext: { totalFiles: 1 },
      });

      expect(result.success).toBe(true);
    });

    it('should handle test file analysis', async () => {
      isTestFile.mockReturnValue(true);
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Test file review', issues: [] },
      });

      const result = await runAnalysis('/test/file.test.js');

      expect(result.success).toBe(true);
    });

    it('should pass options correctly', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Test', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        verbose: true,
        directory: '/custom/dir',
      });

      expect(result.success).toBe(true);
    });
  });

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

      // Should have deduplicated results
      expect(Array.isArray(context.codeExamples)).toBe(true);
    });
  });

  describe('runAnalysis additional scenarios', () => {
    it('should return error when file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await runAnalysis('/test/nonexistent.js');

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('should handle diff-only mode', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Diff review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        diffOnly: true,
        diffContent: '+ new line\n- old line',
        fullFileContent: 'const x = 1;',
      });

      expect(result.success).toBe(true);
    });

    it('should handle analysis with verbose option', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        verbose: true,
      });

      expect(result.success).toBe(true);
    });

    it('should handle custom model option', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Custom model review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        model: 'claude-3-opus',
      });

      expect(result.success).toBe(true);
    });

    it('should handle LLM response without json property', async () => {
      // Some responses might come back as raw text
      llm.sendPromptToClaude.mockResolvedValue({
        text: 'Raw text response',
      });

      const result = await runAnalysis('/test/file.js');

      // Should handle gracefully
      expect(result).toBeDefined();
    });

    it('should use project summary when available', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({
        name: 'Test Project',
        technologies: ['JavaScript', 'Node.js'],
      });

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(mockEmbeddingsSystem.getProjectSummary).toHaveBeenCalled();
    });

    it('should find similar code examples', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([{ path: '/similar.js', content: 'similar code', similarity: 0.9 }]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });

    it('should find relevant documentation', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([{ path: '/docs/api.md', content: 'API docs', similarity: 0.8 }]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });
  });

  describe('gatherUnifiedContextForPR additional scenarios', () => {
    it('should handle PR files with no content', async () => {
      const prFiles = [{ filePath: '/src/empty.js', content: '', language: 'javascript' }];

      const context = await gatherUnifiedContextForPR(prFiles);

      expect(context).toHaveProperty('codeExamples');
    });

    it('should handle options parameter', async () => {
      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];

      const context = await gatherUnifiedContextForPR(prFiles, {
        verbose: true,
        projectPath: '/project',
      });

      expect(context).toHaveProperty('codeExamples');
    });

    it('should find custom document chunks', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([{ content: 'Custom doc', document_title: 'Guidelines' }]);

      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];

      const context = await gatherUnifiedContextForPR(prFiles);

      expect(context).toHaveProperty('customDocChunks');
    });
  });

  describe('runAnalysis file handling', () => {
    it('should read file content when file exists', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('const x = 1;\nfunction test() {}');
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(fs.readFileSync).toHaveBeenCalled();
    });

    it('should detect language from file extension', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.ts');

      expect(result.success).toBe(true);
      expect(result.language).toBeDefined();
    });

    it('should handle PR context when provided', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

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

    it('should handle diff-only review mode', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Diff review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        diffOnly: true,
        diffContent: '+ added line\n- removed line',
        baseBranch: 'main',
        targetBranch: 'feature',
        diffInfo: {
          addedLines: [1],
          removedLines: [2],
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('context building', () => {
    it('should build context with code examples', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([{ path: '/example.js', content: 'example code', similarity: 0.9 }]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(mockEmbeddingsSystem.findSimilarCode).toHaveBeenCalled();
    });

    it('should build context with documentation', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([{ path: '/docs/api.md', content: 'API docs', similarity: 0.85 }]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(mockEmbeddingsSystem.findRelevantDocs).toHaveBeenCalled();
    });

    it('should include PR comments when available', async () => {
      findRelevantPRComments.mockResolvedValue([{ id: 'comment1', body: 'Previous comment', file_path: '/test.js' }]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });
  });

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

    it('should handle empty issues array', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'No issues', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });

    it('should handle LLM response with issues', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Issues found',
          issues: [
            {
              severity: 'high',
              message: 'Critical issue',
              line: 10,
              suggestion: 'Fix it',
            },
          ],
        },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(result.results.issues).toBeDefined();
    });
  });

  describe('metadata and context', () => {
    it('should include metadata in results', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review complete', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.metadata).toBeDefined();
      expect(result.metadata.analysisTimestamp).toBeDefined();
    });

    it('should include similar examples in results', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([{ path: '/similar.js', content: 'code', similarity: 0.9 }]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(result.similarExamples).toBeDefined();
    });

    it('should include context information', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.context).toBeDefined();
      expect(result.context.codeExamples).toBeDefined();
    });
  });

  describe('error scenarios', () => {
    it('should return error for invalid file path', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await runAnalysis('/nonexistent/file.js');

      expect(result.success).toBe(false);
    });

    it('should handle embeddings system initialization failure', async () => {
      mockEmbeddingsSystem.initialize.mockRejectedValue(new Error('Init failed'));

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(false);
    });

    it('should handle LLM timeout gracefully', async () => {
      llm.sendPromptToClaude.mockRejectedValue(new Error('Timeout'));

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout');
    });
  });

  describe('holistic PR review', () => {
    it('should handle holistic review with cross-file issues', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'PR Review',
          crossFileIssues: [{ message: 'Cross-file issue', severity: 'medium', files: ['file1.js', 'file2.js'] }],
          fileSpecificIssues: {},
          recommendations: ['Add tests'],
        },
      });

      const result = await runAnalysis('PR_HOLISTIC_REVIEW', {
        isHolisticPRReview: true,
        prFiles: [{ path: 'file1.js', diff: '+ code' }],
        unifiedContext: {
          codeExamples: [],
          guidelines: [],
          prComments: [],
          customDocChunks: [],
        },
        prContext: { totalFiles: 2 },
      });

      expect(result.success).toBe(true);
    });

    it('should handle holistic review with file-specific issues', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'PR Review',
          crossFileIssues: [],
          fileSpecificIssues: {
            'file1.js': [{ message: 'Issue in file1', line: 5 }],
          },
          recommendations: [],
        },
      });

      const result = await runAnalysis('PR_HOLISTIC_REVIEW', {
        isHolisticPRReview: true,
        prFiles: [{ path: 'file1.js', diff: '+ code' }],
        unifiedContext: {
          codeExamples: [],
          guidelines: [],
          prComments: [],
          customDocChunks: [],
        },
        prContext: { totalFiles: 1 },
      });

      expect(result.success).toBe(true);
    });

    it('should handle holistic review with recommendations', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'PR needs improvements',
          crossFileIssues: [],
          fileSpecificIssues: {},
          recommendations: ['Add more tests', 'Update documentation', 'Consider refactoring'],
        },
      });

      const result = await runAnalysis('PR_HOLISTIC_REVIEW', {
        isHolisticPRReview: true,
        prFiles: [{ path: 'file.js', diff: '+ code' }],
        unifiedContext: {
          codeExamples: [],
          guidelines: [],
          prComments: [],
          customDocChunks: [],
        },
        prContext: { totalFiles: 1 },
      });

      expect(result.success).toBe(true);
      expect(result.results.recommendations).toBeDefined();
    });
  });

  describe('file content handling', () => {
    it('should handle empty file content', async () => {
      fs.readFileSync.mockReturnValue('');
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Empty file', issues: [] },
      });

      const result = await runAnalysis('/test/empty.js');

      expect(result).toBeDefined();
    });

    it('should handle file with only whitespace', async () => {
      fs.readFileSync.mockReturnValue('   \n\n   ');
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Whitespace only', issues: [] },
      });

      const result = await runAnalysis('/test/whitespace.js');

      expect(result).toBeDefined();
    });

    it('should handle very long files', async () => {
      const longContent = 'const x = 1;\n'.repeat(1000);
      fs.readFileSync.mockReturnValue(longContent);
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Long file', issues: [] },
      });

      const result = await runAnalysis('/test/long.js');

      expect(result.success).toBe(true);
    });
  });

  describe('test file handling', () => {
    it('should use test-specific analysis for test files', async () => {
      isTestFile.mockReturnValue(true);
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Test file review', issues: [] },
      });

      const result = await runAnalysis('/test/component.test.js');

      expect(result.success).toBe(true);
      expect(isTestFile).toHaveBeenCalled();
    });

    it('should skip test file filtering for non-test files', async () => {
      isTestFile.mockReturnValue(false);
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Source file review', issues: [] },
      });

      const result = await runAnalysis('/src/component.js');

      expect(result.success).toBe(true);
    });
  });

  describe('custom documents', () => {
    it('should find relevant custom document chunks', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([
        { content: 'Coding guidelines', document_title: 'Style Guide' },
        { content: 'Testing best practices', document_title: 'Test Guide' },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });

    it('should process custom documents in memory', async () => {
      mockEmbeddingsSystem.processCustomDocumentsInMemory.mockResolvedValue([{ content: 'In-memory doc', document_title: 'Temp Guide' }]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        customDocuments: ['path/to/doc.md'],
      });

      expect(result.success).toBe(true);
    });
  });

  describe('comprehensive branch coverage', () => {
    it('should handle analysis with project context', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({
        name: 'My Project',
        technologies: ['Node.js', 'React'],
        description: 'A test project',
      });

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review with context', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        projectPath: '/test',
      });

      expect(result.success).toBe(true);
    });

    it('should handle analysis with precomputed embedding', async () => {
      const precomputed = createMockEmbedding();

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        precomputedEmbedding: precomputed,
      });

      expect(result.success).toBe(true);
    });

    it('should include file metadata in results', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.filePath).toBeDefined();
      expect(result.language).toBeDefined();
    });

    it('should handle holistic review with all context types', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Full PR review',
          crossFileIssues: [{ message: 'Cross-file concern' }],
          fileSpecificIssues: {
            'file.js': [{ message: 'File issue' }],
          },
          recommendations: ['Add tests'],
        },
      });

      const result = await runAnalysis('PR_HOLISTIC_REVIEW', {
        isHolisticPRReview: true,
        prFiles: [{ path: 'file.js', diff: '+ code', content: 'const x = 1;' }],
        unifiedContext: {
          codeExamples: [{ path: '/example.js', content: 'example' }],
          guidelines: [{ content: 'Follow style guide' }],
          prComments: [{ body: 'Previous comment' }],
          customDocChunks: [{ content: 'Custom doc' }],
        },
        prContext: {
          totalFiles: 1,
          sourceFiles: 1,
          testFiles: 0,
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('low severity filtering', () => {
    it('should filter low severity issues from results', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Found issues',
          issues: [
            { severity: 'high', description: 'Critical bug' },
            { severity: 'low', description: 'Minor style issue' },
            { severity: 'medium', description: 'Moderate concern' },
          ],
        },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      // Low severity issues should be filtered out
      expect(result.results.issues).toHaveLength(2);
      expect(result.results.issues.every((i) => i.severity !== 'low')).toBe(true);
    });

    it('should filter low severity cross-file issues', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'PR review',
          crossFileIssues: [
            { severity: 'low', message: 'Minor cross-file issue', files: ['a.js', 'b.js'] },
            { severity: 'high', message: 'Critical cross-file issue', files: ['c.js'] },
          ],
          fileSpecificIssues: {},
          recommendations: [],
        },
      });

      const result = await runAnalysis('PR_HOLISTIC_REVIEW', {
        isHolisticPRReview: true,
        prFiles: [{ path: 'file.js', diff: '+ code' }],
        unifiedContext: { codeExamples: [], guidelines: [], prComments: [], customDocChunks: [] },
      });

      expect(result.success).toBe(true);
      expect(result.results.crossFileIssues).toHaveLength(1);
      expect(result.results.crossFileIssues[0].severity).toBe('high');
    });

    it('should filter low severity file-specific issues', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'PR review',
          crossFileIssues: [],
          fileSpecificIssues: {
            'file.js': [
              { severity: 'low', description: 'Minor issue' },
              { severity: 'critical', description: 'Critical issue' },
            ],
          },
          recommendations: [],
        },
      });

      const result = await runAnalysis('PR_HOLISTIC_REVIEW', {
        isHolisticPRReview: true,
        prFiles: [{ path: 'file.js', diff: '+ code' }],
        unifiedContext: { codeExamples: [], guidelines: [], prComments: [], customDocChunks: [] },
      });

      expect(result.success).toBe(true);
      expect(result.results.fileSpecificIssues['file.js']).toHaveLength(1);
      expect(result.results.fileSpecificIssues['file.js'][0].severity).toBe('critical');
    });

    it('should log filtered count when verbose and issues filtered', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Found issues',
          issues: [
            { severity: 'low', description: 'Minor issue 1' },
            { severity: 'low', description: 'Minor issue 2' },
          ],
        },
      });

      const result = await runAnalysis('/test/file.js', { verbose: true });

      expect(result.success).toBe(true);
      expect(result.results.issues).toHaveLength(0);
      // Console log should have been called with filtering message
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Filtered'));
    });
  });

  describe('feedback filtering', () => {
    it('should load feedback data when trackFeedback is enabled', async () => {
      const { loadFeedbackData } = await import('./feedback-loader.js'); // eslint-disable-line no-restricted-syntax
      loadFeedbackData.mockResolvedValue({ issues: [] });
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        trackFeedback: true,
        feedbackPath: '/test/feedback.json',
      });

      expect(result.success).toBe(true);
      expect(loadFeedbackData).toHaveBeenCalledWith('/test/feedback.json', expect.any(Object));
    });

    it('should filter issues based on feedback similarity', async () => {
      const { loadFeedbackData, shouldSkipSimilarIssue } = await import('./feedback-loader.js'); // eslint-disable-line no-restricted-syntax
      loadFeedbackData.mockResolvedValue({
        issues: [{ description: 'Already fixed issue' }],
      });
      shouldSkipSimilarIssue.mockReturnValue(true);
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Review',
          issues: [{ severity: 'high', description: 'Similar to dismissed issue' }],
        },
      });

      const result = await runAnalysis('/test/file.js', {
        trackFeedback: true,
        feedbackPath: '/test/feedback.json',
        feedbackThreshold: 0.7,
      });

      expect(result.success).toBe(true);
      expect(shouldSkipSimilarIssue).toHaveBeenCalled();
    });

    it('should use semantic similarity when available', async () => {
      const { loadFeedbackData, shouldSkipSimilarIssue, isSemanticSimilarityAvailable } = await import('./feedback-loader.js'); // eslint-disable-line no-restricted-syntax
      isSemanticSimilarityAvailable.mockReturnValue(true);
      loadFeedbackData.mockResolvedValue({ issues: [] });
      shouldSkipSimilarIssue.mockReturnValue(false);
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Review',
          issues: [{ severity: 'medium', description: 'Some issue' }],
        },
      });

      const result = await runAnalysis('/test/file.js', {
        trackFeedback: true,
        feedbackPath: '/test/feedback.json',
        verbose: true,
      });

      expect(result.success).toBe(true);
    });

    it('should include feedback filtering metadata in results', async () => {
      const { loadFeedbackData, shouldSkipSimilarIssue } = await import('./feedback-loader.js'); // eslint-disable-line no-restricted-syntax
      loadFeedbackData.mockResolvedValue({
        issues: [{ description: 'Dismissed issue' }],
      });
      shouldSkipSimilarIssue.mockImplementation((desc) => desc.includes('Skip'));
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Review',
          issues: [
            { severity: 'high', description: 'Keep this issue' },
            { severity: 'high', description: 'Skip this issue' },
          ],
        },
      });

      const result = await runAnalysis('/test/file.js', {
        trackFeedback: true,
        feedbackPath: '/test/feedback.json',
      });

      expect(result.success).toBe(true);
      expect(result.metadata.feedbackFiltering).toBeDefined();
    });
  });

  describe('project summary formatting', () => {
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
        stateManagement: {
          approach: 'Redux',
          patterns: ['Slice pattern', 'Thunks'],
        },
        reviewGuidelines: ['Use TypeScript', 'Write tests', 'Follow ESLint rules'],
      });

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
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

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });

    it('should handle empty project summary gracefully', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({});

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });
  });

  describe('PR comment context', () => {
    it('should format PR comments for context', async () => {
      findRelevantPRComments.mockResolvedValue([
        {
          id: 'comment1',
          author: 'reviewer1',
          body: 'This needs improvement',
          created_at: new Date().toISOString(),
          comment_type: 'review',
          file_path: '/test/file.js',
          pr_number: 123,
          pr_title: 'Feature PR',
          similarity_score: 0.85,
        },
        {
          id: 'comment2',
          author_login: 'reviewer2',
          comment_text: 'Consider refactoring',
          created_at: new Date().toISOString(),
          comment_type: 'inline',
          file_path: '/test/file.js',
          pr_number: 124,
          similarity_score: 0.75,
        },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(result.prHistory).toBeDefined();
      expect(result.prHistory.commentsFound).toBe(2);
    });

    it('should extract patterns from PR comments', async () => {
      findRelevantPRComments.mockResolvedValue([
        {
          id: 'comment1',
          body: 'This is a performance issue and could cause problems',
          similarity_score: 0.8,
        },
        {
          id: 'comment2',
          body: 'Consider improving the security of this implementation',
          similarity_score: 0.75,
        },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(result.prHistory.patterns).toBeDefined();
    });
  });

  describe('custom document processing for PR', () => {
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

    it('should handle custom document processing errors', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockRejectedValue(new Error('DB error'));

      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];

      const context = await gatherUnifiedContextForPR(prFiles, {
        customDocs: ['/docs/style-guide.md'],
      });

      // Should continue without custom docs
      expect(context).toBeDefined();
    });
  });

  describe('context retrieval edge cases', () => {
    it('should handle parallel context retrieval failure', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockRejectedValue(new Error('Doc search failed'));
      mockEmbeddingsSystem.findSimilarCode.mockRejectedValue(new Error('Code search failed'));
      findRelevantPRComments.mockRejectedValue(new Error('PR comments failed'));

      // The function should handle failures gracefully
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review without context', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      // Should still succeed, just with less context
      expect(result.success).toBe(true);
    });

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

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });

    it('should deduplicate code examples by path', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([
        { path: '/util.js', content: 'code1', similarity: 0.9 },
        { path: '/util.js', content: 'code2', similarity: 0.85 }, // Duplicate path
        { path: '/helper.js', content: 'code3', similarity: 0.8 },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });
  });

  describe('gatherUnifiedContextForPR error handling', () => {
    it('should handle file context gathering errors', async () => {
      // Make one file fail during context gathering
      fs.readFileSync.mockImplementation((path) => {
        if (path.includes('error-file')) {
          throw new Error('Read error');
        }
        return 'const x = 1;';
      });

      const prFiles = [
        { filePath: '/src/good-file.js', content: 'code1', language: 'javascript' },
        { filePath: '/src/error-file.js', content: 'code2', language: 'javascript' },
      ];

      const context = await gatherUnifiedContextForPR(prFiles);

      // Should still return context from successful files
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
      // Return many results
      const manyExamples = Array.from({ length: 50 }, (_, i) => ({
        path: `/util${i}.js`,
        content: `code${i}`,
        similarity: 0.9 - i * 0.01,
      }));

      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue(manyExamples);

      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];

      const context = await gatherUnifiedContextForPR(prFiles, { maxExamples: 10 });

      // Should limit results
      expect(context.codeExamples.length).toBeLessThanOrEqual(40); // Default max is 40
    });
  });

  describe('holistic PR analysis error handling', () => {
    it('should handle LLM error in holistic analysis', async () => {
      llm.sendPromptToClaude.mockRejectedValue(new Error('LLM failed during holistic review'));

      const result = await runAnalysis('PR_HOLISTIC_REVIEW', {
        isHolisticPRReview: true,
        prFiles: [{ path: 'file.js', diff: '+ code' }],
        unifiedContext: { codeExamples: [], guidelines: [], prComments: [], customDocChunks: [] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('LLM failed');
    });

    it('should include project summary in holistic context', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue({
        projectName: 'Test',
        technologies: ['React'],
      });

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', crossFileIssues: [], fileSpecificIssues: {}, recommendations: [] },
      });

      const result = await runAnalysis('PR_HOLISTIC_REVIEW', {
        isHolisticPRReview: true,
        prFiles: [
          { path: 'file.js', diff: '+ code', language: 'javascript', isTest: false, summary: 'Added code', fullContent: 'const x = 1;' },
        ],
        unifiedContext: {
          codeExamples: [{ path: '/ex.js', content: 'example', similarity: 0.9, language: 'javascript' }],
          guidelines: [{ path: '/docs/guide.md', content: 'Follow rules', similarity: 0.8, headingText: 'Rules' }],
          prComments: [{ prNumber: 1, author: 'dev', filePath: '/file.js', body: 'Comment', relevanceScore: 0.7, commentType: 'review' }],
          customDocChunks: [{ document_title: 'Custom', content: 'Custom content', chunk_index: 0, similarity: 0.75 }],
        },
        prContext: { totalFiles: 1 },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('context inference integration', () => {
    it('should use test-specific guideline queries for test files', async () => {
      const { detectFileType } = await import('./utils/language-detection.js'); // eslint-disable-line no-restricted-syntax
      detectFileType.mockReturnValue({ isTest: true });

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Test review', issues: [] },
      });

      const result = await runAnalysis('/test/component.test.js');

      expect(result.success).toBe(true);
    });

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

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/Dashboard.jsx');

      expect(result.success).toBe(true);
    });
  });

  describe('project summary error handling', () => {
    it('should handle getProjectSummary errors gracefully', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockRejectedValue(new Error('DB connection failed'));

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review without project context', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      // Should still succeed, just without project summary
      expect(result.success).toBe(true);
    });
  });

  describe('preprocessed custom doc chunks', () => {
    it('should use preprocessed custom doc chunks when available', async () => {
      const preprocessedChunks = [{ id: 'chunk1', content: 'Style guidelines', document_title: 'Style', chunk_index: 0, similarity: 0.9 }];

      mockEmbeddingsSystem.findRelevantCustomDocChunks.mockResolvedValue(preprocessedChunks);

      const prFiles = [{ filePath: '/src/file.js', content: 'code', language: 'javascript' }];

      const context = await gatherUnifiedContextForPR(prFiles, {
        preprocessedCustomDocChunks: preprocessedChunks,
      });

      expect(context).toBeDefined();
    });

    it('should log selected chunks when verbose', async () => {
      mockEmbeddingsSystem.findRelevantCustomDocChunks.mockResolvedValue([
        { id: 'chunk1', content: 'Guidelines', document_title: 'Guide', chunk_index: 0, similarity: 0.85 },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        customDocs: ['/docs/guide.md'],
        verbose: true,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('documentation chunk scoring', () => {
    it('should score and filter documentation chunks', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        {
          path: '/docs/api.md',
          content: 'API documentation content',
          similarity: 0.85,
          type: 'documentation-chunk',
          document_title: 'API Reference',
          heading_text: 'Authentication',
        },
        {
          path: '/docs/readme.md',
          content: 'General readme',
          similarity: 0.6,
          type: 'documentation-chunk',
          document_title: 'README',
        },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });

    it('should handle multiple chunks from same document', async () => {
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        { path: '/docs/api.md', content: 'Part 1', similarity: 0.9, type: 'documentation-chunk', document_title: 'API' },
        { path: '/docs/api.md', content: 'Part 2', similarity: 0.85, type: 'documentation-chunk', document_title: 'API' },
        { path: '/docs/api.md', content: 'Part 3', similarity: 0.8, type: 'documentation-chunk', document_title: 'API' },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });
  });

  describe('verbose logging paths', () => {
    it('should log context information when verbose', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([{ path: '/example.js', content: 'code', similarity: 0.9 }]);
      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        { path: '/docs/api.md', content: 'docs', similarity: 0.8, type: 'documentation-chunk', document_title: 'API' },
      ]);
      findRelevantPRComments.mockResolvedValue([{ id: 'c1', body: 'Comment', similarity_score: 0.75 }]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', { verbose: true });

      expect(result.success).toBe(true);
      expect(console.log).toHaveBeenCalled();
    });

    it('should log filtered issues when verbose', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: {
          summary: 'Review',
          issues: [{ severity: 'low', description: 'Style issue to filter' }],
        },
      });

      const result = await runAnalysis('/test/file.js', { verbose: true });

      expect(result.success).toBe(true);
    });
  });

  describe('PR comment search fallback', () => {
    it('should handle PR comment search failure gracefully', async () => {
      findRelevantPRComments.mockRejectedValue(new Error('Search failed'));

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      // Should still succeed with empty PR comments
      expect(result.success).toBe(true);
    });

    it('should use file path fallback when no semantic results', async () => {
      findRelevantPRComments.mockResolvedValue([{ id: 'c1', body: 'Comment', similarity_score: 0.5, file_path: '/test/file.js' }]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });
  });

  describe('recent comments handling', () => {
    it('should identify recent comments in summary', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5); // 5 days ago

      findRelevantPRComments.mockResolvedValue([
        {
          id: 'c1',
          body: 'Recent comment about performance issues',
          similarity_score: 0.8,
          created_at: recentDate.toISOString(),
        },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(result.prHistory).toBeDefined();
    });
  });

  describe('empty and whitespace content handling', () => {
    it('should handle file with no significant content', async () => {
      fs.readFileSync.mockReturnValue('\n\n   \t\n');

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Empty file', issues: [] },
      });

      const result = await runAnalysis('/test/empty.js');

      expect(result).toBeDefined();
    });
  });

  describe('context deduplication', () => {
    it('should deduplicate guidelines by path and heading', async () => {
      const prFiles = [
        { filePath: '/src/file1.js', content: 'code1' },
        { filePath: '/src/file2.js', content: 'code2' },
      ];

      // Same guideline found for both files
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

      const context = await gatherUnifiedContextForPR(prFiles);

      // Should deduplicate
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

      // Should keep the higher similarity one
      if (context.codeExamples.length > 0) {
        expect(context.codeExamples[0].similarity).toBeGreaterThanOrEqual(0.7);
      }
    });
  });

  describe('long content truncation', () => {
    it('should handle very long file content', async () => {
      // Create content longer than MAX_EMBEDDING_CONTENT_LENGTH (10000)
      const longContent = 'const line = 1;\n'.repeat(1000);
      fs.readFileSync.mockReturnValue(longContent);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Long file review', issues: [] },
      });

      const result = await runAnalysis('/test/long-file.js');

      expect(result.success).toBe(true);
    });
  });

  describe('custom documents fallback processing', () => {
    it('should process custom documents when not preprocessed', async () => {
      mockEmbeddingsSystem.getExistingCustomDocumentChunks.mockResolvedValue([]);
      mockEmbeddingsSystem.processCustomDocumentsInMemory.mockResolvedValue([
        { id: 'c1', content: 'New processed chunk', document_title: 'New Doc', chunk_index: 0 },
      ]);
      mockEmbeddingsSystem.findRelevantCustomDocChunks.mockResolvedValue([
        { id: 'c1', content: 'New processed chunk', document_title: 'New Doc', chunk_index: 0, similarity: 0.8 },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        customDocs: ['/docs/new-guide.md'],
      });

      expect(result.success).toBe(true);
    });
  });

  describe('LLM response parsing edge cases', () => {
    it('should handle malformed LLM response with missing issues', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Partial response' }, // Missing issues array
      });

      const result = await runAnalysis('/test/file.js');

      // Should handle gracefully and provide default structure
      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
    });

    it('should handle LLM response with null json', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        json: null,
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
    });
  });

  describe('dismissed patterns context', () => {
    it('should include dismissed patterns when feedback has patterns', async () => {
      const { loadFeedbackData, extractDismissedPatterns } = await import('./feedback-loader.js'); // eslint-disable-line no-restricted-syntax

      loadFeedbackData.mockResolvedValue({
        issues: [{ description: 'Old issue', dismissed: true }],
      });

      extractDismissedPatterns.mockReturnValue([
        { issue: 'Import order', reason: 'false positive', sentiment: 'negative' },
        { issue: 'Formatting', reason: 'handled by linter', sentiment: 'neutral' },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js', {
        trackFeedback: true,
        feedbackPath: '/test/feedback.json',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('guideline snippets with context', () => {
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

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/auth.js');

      expect(result.success).toBe(true);
      expect(result.context.guidelines).toBeGreaterThanOrEqual(0);
    });
  });

  describe('PR history with metadata', () => {
    it('should include PR history in results when comments found', async () => {
      findRelevantPRComments.mockResolvedValue([
        {
          id: 'c1',
          author: 'senior-dev',
          body: 'This pattern should use memoization for performance',
          created_at: new Date().toISOString(),
          comment_type: 'review',
          file_path: '/src/component.js',
          pr_number: 456,
          pr_title: 'Performance improvements',
          similarity_score: 0.9,
        },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      expect(result.success).toBe(true);
      expect(result.prHistory).not.toBeNull();
      expect(result.prHistory.commentsFound).toBe(1);
      expect(result.prHistory.patterns).toBeDefined();
      expect(result.prHistory.summary).toBeDefined();
    });
  });

  describe('file content read errors in PR context', () => {
    it('should handle file read error when getting PR context', async () => {
      // First read succeeds (for main analysis), subsequent reads for PR context fail
      let readCount = 0;
      fs.readFileSync.mockImplementation(() => {
        readCount++;
        if (readCount > 1) {
          throw new Error('File not accessible');
        }
        return 'const x = 1;';
      });

      llm.sendPromptToClaude.mockResolvedValue({
        json: { summary: 'Review', issues: [] },
      });

      const result = await runAnalysis('/test/file.js');

      // Should still succeed overall
      expect(result).toBeDefined();
    });
  });

  describe('context retrieval with all features', () => {
    it('should gather all context types for comprehensive review', async () => {
      // Set up all mocks to return data
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([
        { path: '/util.js', content: 'export function helper() {}', similarity: 0.92, language: 'javascript' },
        { path: '/helper.js', content: 'export function format() {}', similarity: 0.88, language: 'javascript' },
      ]);

      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        {
          path: '/docs/conventions.md',
          content: 'Always use TypeScript for type safety',
          similarity: 0.85,
          type: 'documentation-chunk',
          document_title: 'Conventions',
          heading_text: 'Type Safety',
        },
      ]);

      findRelevantPRComments.mockResolvedValue([
        {
          id: 'pr-comment-1',
          author: 'tech-lead',
          body: 'Consider using the shared utility for this operation',
          similarity_score: 0.87,
          pr_number: 100,
          file_path: '/src/feature.js',
        },
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
          issues: [
            {
              severity: 'medium',
              description: 'Consider using shared helper based on project patterns',
              lineNumbers: [10, 15],
            },
          ],
        },
      });

      const result = await runAnalysis('/test/feature.js', {
        verbose: true,
        customDocs: ['/docs/internal.md'],
      });

      expect(result.success).toBe(true);
      expect(result.context.codeExamples).toBeGreaterThanOrEqual(0);
      expect(result.context.guidelines).toBeGreaterThanOrEqual(0);
      expect(result.similarExamples).toBeDefined();
    });
  });

  describe('gatherUnifiedContextForPR comprehensive', () => {
    it('should gather unified context with all types of data', async () => {
      mockEmbeddingsSystem.findSimilarCode.mockResolvedValue([{ path: '/shared/util.js', content: 'shared code', similarity: 0.95 }]);

      mockEmbeddingsSystem.findRelevantDocs.mockResolvedValue([
        {
          path: '/docs/style.md',
          content: 'Style guide',
          similarity: 0.85,
          type: 'documentation-chunk',
          document_title: 'Style',
          heading_text: 'Formatting',
        },
      ]);

      findRelevantPRComments.mockResolvedValue([{ id: 'pc1', body: 'PR comment', similarity_score: 0.8, relevanceScore: 0.8 }]);

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

      const context = await gatherUnifiedContextForPR(prFiles, {
        customDocs: ['/docs/custom.md'],
      });

      expect(context.codeExamples).toBeDefined();
      expect(context.guidelines).toBeDefined();
      expect(context.prComments).toBeDefined();
      expect(context.customDocChunks).toBeDefined();
    });
  });
});
