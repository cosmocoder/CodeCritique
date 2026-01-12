import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDefaultEmbeddingsSystem } from './embeddings/factory.js';
import * as llm from './llm.js';
import { ProjectAnalyzer } from './project-analyzer.js';
import { isDocumentationFile, isTestFile } from './utils/file-validation.js';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

vi.mock('node:crypto', () => ({
  default: {
    createHash: vi.fn(),
  },
}));

vi.mock('./embeddings/factory.js', () => ({
  getDefaultEmbeddingsSystem: vi.fn(),
}));

vi.mock('./llm.js', () => ({
  sendPromptToClaude: vi.fn(),
}));

vi.mock('./utils/file-validation.js', () => ({
  isDocumentationFile: vi.fn(),
  isTestFile: vi.fn(),
}));

describe('ProjectAnalyzer', () => {
  let analyzer;
  let mockEmbeddingsSystem;
  let mockDbConnection;
  let mockTable;
  let mockHash;

  const mockProjectPath = '/mock/project';
  const mockKeyFiles = [
    {
      relativePath: 'package.json',
      fullPath: '/mock/project/package.json',
      category: 'package',
      size: 1024,
      lastModified: new Date('2024-01-01'),
    },
    {
      relativePath: 'src/index.js',
      fullPath: '/mock/project/src/index.js',
      category: 'entry',
      size: 512,
      lastModified: new Date('2024-01-02'),
    },
  ];

  beforeEach(() => {
    analyzer = new ProjectAnalyzer();

    // Setup mock hash
    mockHash = {
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('mock-hash-value'),
    };
    crypto.createHash.mockReturnValue(mockHash);

    // Setup mock table
    mockTable = {
      query: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      }),
      optimize: vi.fn().mockResolvedValue(undefined),
    };

    // Setup mock database connection
    mockDbConnection = {
      openTable: vi.fn().mockResolvedValue(mockTable),
    };

    // Setup mock embeddings system
    mockEmbeddingsSystem = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getProjectSummary: vi.fn().mockResolvedValue(null),
      storeProjectSummary: vi.fn().mockResolvedValue(undefined),
      databaseManager: {
        getDB: vi.fn().mockResolvedValue(mockDbConnection),
        fileEmbeddingsTable: 'file_embeddings',
      },
    };
    getDefaultEmbeddingsSystem.mockReturnValue(mockEmbeddingsSystem);

    // Setup mock fs
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({
      size: 1024,
      mtime: new Date('2024-01-01'),
    });
    fs.readFileSync.mockReturnValue('{"name": "test-project", "dependencies": {}}');

    // Setup mock LLM
    llm.sendPromptToClaude.mockResolvedValue({
      content: '{"selectedFiles": ["package.json"]}',
      json: { selectedFiles: ['package.json'] },
    });

    // Setup mock file validation functions
    isDocumentationFile.mockReturnValue(false);
    isTestFile.mockReturnValue(false);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with null/empty default values', () => {
      expect(analyzer.llm).toBeNull();
      expect(analyzer.projectSummary).toBeNull();
      expect(analyzer.keyFiles).toEqual([]);
      expect(analyzer.lastAnalysisHash).toBeNull();
    });
  });

  describe('analyzeProject', () => {
    beforeEach(() => {
      // Setup default LLM response for project summary
      llm.sendPromptToClaude.mockResolvedValue({
        content: JSON.stringify({
          projectName: 'test-project',
          projectType: 'Node.js CLI',
          mainFrameworks: ['Node.js'],
          technologies: ['JavaScript', 'Node.js'],
          architecture: { pattern: 'Module-based', description: 'desc', layers: [] },
          keyComponents: [],
          customImplementations: [],
        }),
        json: {
          projectName: 'test-project',
          projectType: 'Node.js CLI',
          mainFrameworks: ['Node.js'],
          technologies: ['JavaScript', 'Node.js'],
          architecture: { pattern: 'Module-based', description: 'desc', layers: [] },
          keyComponents: [],
          customImplementations: [],
        },
      });
    });

    it('should return existing summary if up-to-date (hash matches)', async () => {
      const existingSummary = {
        projectName: 'test-project',
        keyFiles: mockKeyFiles,
        keyFilesHash: 'mock-hash-value',
      };
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue(existingSummary);

      const result = await analyzer.analyzeProject(mockProjectPath, { verbose: true });

      expect(result).toBeDefined();
      expect(mockEmbeddingsSystem.getProjectSummary).toHaveBeenCalledWith(mockProjectPath);
    });

    it('should regenerate analysis if key files hash changed', async () => {
      const existingSummary = {
        projectName: 'test-project',
        keyFiles: mockKeyFiles,
        keyFilesHash: 'old-hash-value', // Different from mock-hash-value
      };
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue(existingSummary);

      // Mock table query to return some files for discovery
      mockTable
        .query()
        .toArray.mockResolvedValue([{ path: 'package.json', name: 'package.json', content: '{}', type: 'json', language: 'json' }]);

      await analyzer.analyzeProject(mockProjectPath, { verbose: true });

      expect(llm.sendPromptToClaude).toHaveBeenCalled();
    });

    it('should force analysis when forceAnalysis option is true', async () => {
      const existingSummary = {
        projectName: 'test-project',
        keyFiles: mockKeyFiles,
        keyFilesHash: 'mock-hash-value',
      };
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue(existingSummary);

      // Mock table query to return some files for discovery
      mockTable
        .query()
        .toArray.mockResolvedValue([{ path: 'package.json', name: 'package.json', content: '{}', type: 'json', language: 'json' }]);

      await analyzer.analyzeProject(mockProjectPath, { forceAnalysis: true });

      expect(llm.sendPromptToClaude).toHaveBeenCalled();
    });

    it('should perform first-time analysis when no existing summary', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue(null);

      // Mock table query to return some files for discovery
      mockTable
        .query()
        .toArray.mockResolvedValue([{ path: 'package.json', name: 'package.json', content: '{}', type: 'json', language: 'json' }]);

      const result = await analyzer.analyzeProject(mockProjectPath, { verbose: true });

      expect(result).toBeDefined();
      expect(mockEmbeddingsSystem.storeProjectSummary).toHaveBeenCalled();
    });

    it('should return fallback summary on error', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockRejectedValue(new Error('DB Error'));
      llm.sendPromptToClaude.mockRejectedValue(new Error('LLM Error'));

      const result = await analyzer.analyzeProject(mockProjectPath);

      expect(result.fallback).toBe(true);
      expect(result.projectName).toBeDefined();
    });
  });

  describe('loadExistingAnalysis', () => {
    it('should load and transform existing analysis from database', async () => {
      const storedSummary = {
        projectName: 'test-project',
        keyFiles: [{ path: 'package.json', category: 'package', lastModified: '2024-01-01T00:00:00.000Z' }],
      };
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue(storedSummary);

      const result = await analyzer.loadExistingAnalysis(mockProjectPath);

      expect(result).toBeDefined();
      expect(result.keyFiles[0].relativePath).toBe('package.json');
      expect(result.keyFiles[0].fullPath).toBe(path.join(mockProjectPath, 'package.json'));
    });

    it('should return null if no existing analysis', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockResolvedValue(null);

      const result = await analyzer.loadExistingAnalysis(mockProjectPath);

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockEmbeddingsSystem.getProjectSummary.mockRejectedValue(new Error('DB Error'));

      const result = await analyzer.loadExistingAnalysis(mockProjectPath);

      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('storeAnalysis', () => {
    it('should store analysis to embeddings system', async () => {
      const summary = { projectName: 'test-project' };

      await analyzer.storeAnalysis(mockProjectPath, summary);

      expect(mockEmbeddingsSystem.storeProjectSummary).toHaveBeenCalledWith(mockProjectPath, summary);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Project analysis stored'));
    });

    it('should handle storage errors gracefully', async () => {
      mockEmbeddingsSystem.storeProjectSummary.mockRejectedValue(new Error('Storage failed'));
      const summary = { projectName: 'test-project' };

      await analyzer.storeAnalysis(mockProjectPath, summary);

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('validateAndUpdateKeyFiles', () => {
    it('should validate and keep existing key files', async () => {
      const existingFiles = [
        { relativePath: 'package.json', category: 'package' },
        { relativePath: 'src/index.js', category: 'entry' },
      ];

      const result = await analyzer.validateAndUpdateKeyFiles(existingFiles, mockProjectPath);

      expect(result.length).toBe(2);
      expect(result[0].relativePath).toBe('package.json');
      expect(result[0].fullPath).toBe(path.join(mockProjectPath, 'package.json'));
    });

    it('should trigger fresh discovery when too few files exist (<70%)', async () => {
      const existingFiles = [
        { relativePath: 'package.json', category: 'package' },
        { relativePath: 'missing.js', category: 'entry' },
        { relativePath: 'another.js', category: 'entry' },
      ];

      // Reset and set up the mock to only find package.json (1 of 3 = 33% < 70%)
      fs.existsSync.mockReset();
      fs.existsSync.mockImplementation((filePath) => {
        return filePath.endsWith('package.json');
      });
      fs.statSync.mockReturnValue({
        size: 1024,
        mtime: new Date('2024-01-01'),
      });

      await analyzer.validateAndUpdateKeyFiles(existingFiles, mockProjectPath);

      // With 1 of 3 files found (33%), it should trigger fresh discovery
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Many key files missing'));
    });

    it('should filter out missing files and keep existing ones', async () => {
      const existingFiles = [
        { relativePath: 'package.json', category: 'package' },
        { relativePath: 'src/index.js', category: 'entry' },
        { relativePath: 'src/app.js', category: 'entry' },
        { relativePath: 'missing.js', category: 'utility' },
      ];

      // Reset and set up the mock - 3 of 4 files exist (75% > 70% threshold)
      fs.existsSync.mockReset();
      fs.existsSync.mockImplementation((filePath) => {
        return !filePath.endsWith('missing.js');
      });
      fs.statSync.mockReturnValue({
        size: 1024,
        mtime: new Date('2024-01-01'),
      });

      const result = await analyzer.validateAndUpdateKeyFiles(existingFiles, mockProjectPath);

      expect(result.length).toBe(3);
      expect(result.map((f) => f.relativePath)).toContain('package.json');
      expect(result.map((f) => f.relativePath)).toContain('src/index.js');
      expect(result.map((f) => f.relativePath)).not.toContain('missing.js');
    });

    it('should trigger fresh discovery if too many files are missing (>30%)', async () => {
      fs.existsSync.mockReturnValue(false); // All files missing

      const existingFiles = [
        { relativePath: 'file1.js', category: 'entry' },
        { relativePath: 'file2.js', category: 'entry' },
        { relativePath: 'file3.js', category: 'entry' },
      ];

      // Mock for fresh discovery
      mockTable
        .query()
        .toArray.mockResolvedValue([{ path: 'package.json', name: 'package.json', content: '{}', type: 'json', language: 'json' }]);
      fs.existsSync.mockImplementation((p) => p.includes('package.json'));

      await analyzer.validateAndUpdateKeyFiles(existingFiles, mockProjectPath);

      // Should trigger discoverKeyFilesWithLLM
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Many key files missing'));
    });
  });

  describe('discoverKeyFilesWithLLM', () => {
    it('should discover key files using embeddings database', async () => {
      mockTable.query().toArray.mockResolvedValue([
        { path: 'package.json', name: 'package.json', content: '{"name": "test"}', type: 'json', language: 'json' },
        { path: 'src/index.js', name: 'index.js', content: 'export default {};', type: 'js', language: 'javascript' },
      ]);

      llm.sendPromptToClaude.mockResolvedValue({
        content: '["package.json", "src/index.js"]',
        json: { selectedFiles: ['package.json', 'src/index.js'] },
      });

      const result = await analyzer.discoverKeyFilesWithLLM(mockProjectPath);

      expect(mockEmbeddingsSystem.initialize).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('mineKeyFilesFromEmbeddings', () => {
    it('should query embeddings database for key files', async () => {
      mockTable
        .query()
        .toArray.mockResolvedValue([
          { path: 'webpack.config.js', name: 'webpack.config.js', content: 'module.exports = {}', type: 'js', language: 'javascript' },
        ]);

      await analyzer.mineKeyFilesFromEmbeddings(mockProjectPath);

      expect(mockDbConnection.openTable).toHaveBeenCalled();
      expect(mockTable.query).toHaveBeenCalled();
    });

    it('should handle table optimization errors gracefully', async () => {
      mockTable.optimize.mockRejectedValue(new Error('legacy format'));
      mockTable.query().toArray.mockResolvedValue([]);

      const result = await analyzer.mineKeyFilesFromEmbeddings(mockProjectPath);

      expect(result).toEqual([]);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Skipping optimization'));
    });

    it('should return empty array on query error', async () => {
      // Mock the table.query to throw an error inside the queryFiles function
      mockTable.query.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          throw new Error('Query failed');
        }),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Query failed')),
      });

      const result = await analyzer.mineKeyFilesFromEmbeddings(mockProjectPath);

      // Should return empty array since queries fail but error is caught
      expect(result).toEqual([]);
    });
  });

  describe('matchesFileType', () => {
    it('should match config files by regex', () => {
      expect(analyzer.matchesFileType('webpack.config.js', 'webpack.config.js', 'config')).toBe(true);
      expect(analyzer.matchesFileType('tsconfig.json', 'tsconfig.json', 'config')).toBe(true);
    });

    it('should match entry files by regex', () => {
      expect(analyzer.matchesFileType('src/index.js', 'index.js', 'entry')).toBe(true);
      expect(analyzer.matchesFileType('src/main.ts', 'main.ts', 'entry')).toBe(true);
    });

    it('should delegate to isDocumentationFile for docs type', () => {
      isDocumentationFile.mockReturnValue(true);
      expect(analyzer.matchesFileType('docs/README.md', 'README.md', 'docs')).toBe(true);
      expect(isDocumentationFile).toHaveBeenCalledWith('docs/README.md');
    });

    it('should delegate to isTestFile for tests type', () => {
      isTestFile.mockReturnValue(true);
      expect(analyzer.matchesFileType('src/utils.test.js', 'utils.test.js', 'tests')).toBe(true);
      expect(isTestFile).toHaveBeenCalledWith('src/utils.test.js');
    });

    it('should return false for unknown file types', () => {
      expect(analyzer.matchesFileType('random.txt', 'random.txt', 'unknown-type')).toBe(false);
    });
  });

  describe('selectFinalKeyFiles', () => {
    it('should use LLM to select final key files', async () => {
      const candidates = [
        { path: 'package.json', category: 'package', content: '{"name": "test"}', source: 'package-search' },
        { path: 'src/index.js', category: 'entry', content: 'export default {};', source: 'entry-search' },
      ];

      // Ensure analyzer.llm is set to the mocked llm module
      analyzer.llm = llm;

      llm.sendPromptToClaude.mockResolvedValue({
        content: '["package.json"]',
        json: { selectedFiles: ['package.json'] },
      });

      const result = await analyzer.selectFinalKeyFiles(candidates, mockProjectPath);

      expect(llm.sendPromptToClaude).toHaveBeenCalled();
      expect(result.length).toBe(1);
      expect(result[0].relativePath).toBe('package.json');
    });

    it('should return empty array if no candidates', async () => {
      const result = await analyzer.selectFinalKeyFiles([], mockProjectPath);

      expect(result).toEqual([]);
      expect(llm.sendPromptToClaude).not.toHaveBeenCalled();
    });

    it('should fallback to automatic selection on LLM error', async () => {
      const candidates = [{ path: 'package.json', category: 'package', content: '{}' }];

      llm.sendPromptToClaude.mockRejectedValue(new Error('LLM Error'));

      await analyzer.selectFinalKeyFiles(candidates, mockProjectPath);

      expect(console.error).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Falling back to automatic selection'));
    });

    it('should fallback if LLM returns invalid response', async () => {
      const candidates = [{ path: 'package.json', category: 'package', content: '{}' }];

      llm.sendPromptToClaude.mockResolvedValue({
        content: 'invalid response',
        json: { selectedFiles: null },
      });

      await analyzer.selectFinalKeyFiles(candidates, mockProjectPath);

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('fallbackFileSelection', () => {
    it('should select files based on category limits', () => {
      const candidates = [
        { path: 'package.json', category: 'package', content: '{}' },
        { path: 'package-lock.json', category: 'package', content: '{}' },
        { path: 'webpack.config.js', category: 'config', content: '{}' },
        { path: 'tsconfig.json', category: 'config', content: '{}' },
      ];

      const result = analyzer.fallbackFileSelection(candidates, mockProjectPath);

      expect(result.length).toBeLessThanOrEqual(15);
      expect(result.some((f) => f.relativePath === 'package.json')).toBe(true);
    });

    it('should filter out non-existent files', () => {
      fs.existsSync.mockImplementation((p) => !p.includes('nonexistent'));

      const candidates = [
        { path: 'package.json', category: 'package', content: '{}' },
        { path: 'nonexistent.js', category: 'entry', content: '{}' },
      ];

      const result = analyzer.fallbackFileSelection(candidates, mockProjectPath);

      expect(result.length).toBe(1);
      expect(result[0].relativePath).toBe('package.json');
    });
  });

  describe('calculateKeyFilesHash', () => {
    it('should calculate hash based on file paths and content', async () => {
      const keyFiles = [{ relativePath: 'package.json', fullPath: '/mock/project/package.json', size: 100, lastModified: new Date() }];

      const result = await analyzer.calculateKeyFilesHash(keyFiles);

      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
      expect(mockHash.update).toHaveBeenCalled();
      expect(mockHash.digest).toHaveBeenCalledWith('hex');
      expect(result).toBe('mock-hash-value');
    });

    it('should handle missing files gracefully', async () => {
      fs.existsSync.mockReturnValue(false);
      const keyFiles = [{ relativePath: 'missing.js', fullPath: '/mock/project/missing.js', size: 100 }];

      const result = await analyzer.calculateKeyFilesHash(keyFiles);

      expect(result).toBe('mock-hash-value');
    });

    it('should skip content for large files (>50KB)', async () => {
      const keyFiles = [{ relativePath: 'large.js', fullPath: '/mock/project/large.js', size: 60 * 1024, lastModified: new Date() }];

      await analyzer.calculateKeyFilesHash(keyFiles);

      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });

  describe('generateProjectSummary', () => {
    it('should generate project summary using LLM', async () => {
      const mockSummary = {
        projectName: 'test-project',
        projectType: 'Node.js CLI',
        mainFrameworks: ['Node.js'],
        technologies: ['JavaScript'],
        architecture: { pattern: 'Module-based', description: 'desc', layers: [] },
        keyComponents: [],
        customImplementations: [],
      };

      llm.sendPromptToClaude.mockResolvedValue({
        content: JSON.stringify(mockSummary),
        json: mockSummary,
      });

      const result = await analyzer.generateProjectSummary(mockKeyFiles, mockProjectPath);

      expect(result.projectName).toBe('test-project');
      expect(result.analysisDate).toBeDefined();
      expect(result.projectPath).toBe(mockProjectPath);
    });

    it('should return fallback summary on LLM error', async () => {
      llm.sendPromptToClaude.mockRejectedValue(new Error('LLM Error'));

      const result = await analyzer.generateProjectSummary(mockKeyFiles, mockProjectPath);

      expect(result.fallback).toBe(true);
      expect(console.error).toHaveBeenCalled();
    });

    it('should throw error if LLM returns invalid JSON', async () => {
      llm.sendPromptToClaude.mockResolvedValue({
        content: 'not valid json',
        json: null,
      });

      const result = await analyzer.generateProjectSummary(mockKeyFiles, mockProjectPath);

      expect(result.fallback).toBe(true);
    });
  });

  describe('extractFileContents', () => {
    it('should extract and format file contents', async () => {
      fs.readFileSync.mockReturnValue('file content here');

      const result = await analyzer.extractFileContents(mockKeyFiles);

      expect(result).toContain('package.json');
      expect(result).toContain('file content here');
    });

    it('should limit total content size to 100KB', async () => {
      const largeContent = 'x'.repeat(150 * 1024); // 150KB
      fs.readFileSync.mockReturnValue(largeContent);

      const result = await analyzer.extractFileContents(mockKeyFiles);

      expect(result.length).toBeLessThan(150 * 1024);
    });

    it('should handle file read errors gracefully', async () => {
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Cannot read file');
      });

      const result = await analyzer.extractFileContents(mockKeyFiles);

      expect(result).toContain('Could not read file');
    });

    it('should limit to 25 files maximum', async () => {
      const manyFiles = Array(30)
        .fill(0)
        .map((_, i) => ({
          relativePath: `file${i}.js`,
          fullPath: `/mock/project/file${i}.js`,
          category: 'entry',
        }));

      fs.readFileSync.mockReturnValue('content');
      await analyzer.extractFileContents(manyFiles);

      // Should read at most 25 files (or less if size limit is reached first)
      expect(fs.readFileSync).toHaveBeenCalledTimes(25);
    });
  });

  describe('validateProjectSummary', () => {
    it('should validate and fill in missing fields', () => {
      const partialSummary = {
        projectName: 'test',
        projectType: 'CLI',
      };

      const result = analyzer.validateProjectSummary(partialSummary);

      expect(result.projectName).toBe('test');
      expect(result.mainFrameworks).toEqual([]);
      expect(result.technologies).toEqual([]);
      expect(result.customImplementations).toEqual([]);
      expect(result.stateManagement.approach).toBe('Unknown');
    });

    it('should preserve existing fields', () => {
      const summary = {
        projectName: 'test',
        projectType: 'CLI',
        mainFrameworks: ['React'],
        technologies: ['TypeScript'],
        customImplementations: [{ name: 'hook', description: 'desc', extendsStandard: 'React' }],
        stateManagement: { approach: 'Redux', patterns: ['feature-based'] },
      };

      const result = analyzer.validateProjectSummary(summary);

      expect(result.mainFrameworks).toEqual(['React']);
      expect(result.stateManagement.approach).toBe('Redux');
    });
  });

  describe('createFallbackSummary', () => {
    it('should create fallback summary from package.json', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(
        JSON.stringify({
          name: 'my-project',
          dependencies: { react: '18.0.0', lodash: '4.0.0' },
          devDependencies: { jest: '29.0.0' },
        })
      );

      const result = analyzer.createFallbackSummary(mockProjectPath, mockKeyFiles);

      expect(result.projectName).toBe('my-project');
      expect(result.technologies).toContain('react');
      expect(result.fallback).toBe(true);
      expect(result.keyFilesCount).toBe(mockKeyFiles.length);
    });

    it('should use directory name if package.json is not available', () => {
      fs.existsSync.mockReturnValue(false);

      const result = analyzer.createFallbackSummary(mockProjectPath);

      expect(result.projectName).toBe('project');
      expect(result.fallback).toBe(true);
    });

    it('should handle package.json parse errors', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('invalid json');

      const result = analyzer.createFallbackSummary(mockProjectPath);

      expect(result.projectName).toBe('project');
      expect(result.technologies).toEqual([]);
    });

    it('should include default review guidelines', () => {
      fs.existsSync.mockReturnValue(false);

      const result = analyzer.createFallbackSummary(mockProjectPath);

      expect(result.reviewGuidelines.length).toBeGreaterThan(0);
      expect(result.reviewGuidelines[0]).toContain('Follow established patterns');
    });
  });
});
