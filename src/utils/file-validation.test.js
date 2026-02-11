import fs from 'node:fs';
import * as command from './command.js';
import { isTestFile, isDocumentationFile, shouldProcessFile, batchCheckGitignore } from './file-validation.js';

// Mock the command module for shouldProcessFile git operations
vi.mock('./command.js', () => ({
  execGitSafe: vi.fn(),
}));

// Mock fs for file size checks
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    default: {
      ...original,
      statSync: vi.fn(),
    },
    statSync: vi.fn(),
  };
});

describe('isTestFile', () => {
  describe('should return true for test files', () => {
    it('should detect __tests__ directory', () => {
      expect(isTestFile('src/components/__tests__/Button.test.js')).toBe(true);
      expect(isTestFile('src/__tests__/utils.js')).toBe(true);
    });

    it('should detect /tests/ directory', () => {
      // Note: The regex requires a leading slash for directory matching
      expect(isTestFile('/tests/unit/validator.js')).toBe(true);
      expect(isTestFile('/tests/integration.spec.ts')).toBe(true);
      expect(isTestFile('src/tests/unit/validator.js')).toBe(true);
    });

    it('should detect /test/ directory', () => {
      expect(isTestFile('/test/helpers.js')).toBe(true);
      expect(isTestFile('src/test/helpers.js')).toBe(true);
    });

    it('should detect /specs/ directory', () => {
      expect(isTestFile('/specs/feature.spec.js')).toBe(true);
      expect(isTestFile('src/specs/feature.spec.js')).toBe(true);
    });

    it('should detect /spec/ directory', () => {
      expect(isTestFile('/spec/models/user_spec.rb')).toBe(true);
      expect(isTestFile('src/spec/models/user_spec.rb')).toBe(true);
    });

    it('should detect .test. pattern', () => {
      expect(isTestFile('component.test.js')).toBe(true);
      expect(isTestFile('service.test.ts')).toBe(true);
      expect(isTestFile('utils.test.tsx')).toBe(true);
    });

    it('should detect .spec. pattern', () => {
      expect(isTestFile('component.spec.js')).toBe(true);
      expect(isTestFile('service.spec.ts')).toBe(true);
    });

    it('should detect _test. pattern (Python style)', () => {
      expect(isTestFile('utils_test.py')).toBe(true);
      expect(isTestFile('handler_test.go')).toBe(true);
    });

    it('should detect _spec. pattern (Ruby style)', () => {
      expect(isTestFile('user_spec.rb')).toBe(true);
      expect(isTestFile('model_spec.rb')).toBe(true);
    });
  });

  describe('should return false for non-test files', () => {
    it('should not match regular source files', () => {
      expect(isTestFile('src/utils.js')).toBe(false);
      expect(isTestFile('src/components/Button.tsx')).toBe(false);
    });

    it('should not match files with "test" in name but not as pattern', () => {
      expect(isTestFile('src/testimony.js')).toBe(false);
      expect(isTestFile('src/contestant.ts')).toBe(false);
    });

    it('should not match config files', () => {
      expect(isTestFile('jest.config.js')).toBe(false);
      expect(isTestFile('vitest.config.ts')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should return false for null/undefined/empty', () => {
      expect(isTestFile(null)).toBe(false);
      expect(isTestFile(undefined)).toBe(false);
      expect(isTestFile('')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(isTestFile('Component.TEST.js')).toBe(true);
      expect(isTestFile('Component.Spec.ts')).toBe(true);
      expect(isTestFile('src/__TESTS__/file.js')).toBe(true);
    });
  });
});

describe('isDocumentationFile', () => {
  describe('should return true for documentation files', () => {
    it('should detect .md files', () => {
      expect(isDocumentationFile('README.md')).toBe(true);
      expect(isDocumentationFile('docs/api.md')).toBe(true);
    });

    it('should detect .rst files', () => {
      expect(isDocumentationFile('docs/index.rst')).toBe(true);
    });

    it('should detect common doc filenames regardless of extension', () => {
      expect(isDocumentationFile('README')).toBe(true);
      expect(isDocumentationFile('LICENSE')).toBe(true);
      expect(isDocumentationFile('CONTRIBUTING')).toBe(true);
      expect(isDocumentationFile('CHANGELOG')).toBe(true);
      expect(isDocumentationFile('COPYING')).toBe(true);
    });

    it('should detect files in documentation directories', () => {
      // Note: .html files are treated as code, not documentation (they're not in DOCUMENTATION_EXTENSIONS)
      // Directory-based detection works for .txt and other non-code extensions
      expect(isDocumentationFile('/docs/getting-started.txt')).toBe(true);
      expect(isDocumentationFile('/documentation/api.txt')).toBe(true);
      expect(isDocumentationFile('/doc/reference.txt')).toBe(true);
      expect(isDocumentationFile('/wiki/Home.txt')).toBe(true);
      expect(isDocumentationFile('/examples/basic.txt')).toBe(true);
      expect(isDocumentationFile('/guides/setup.txt')).toBe(true);
    });

    it('should detect files with doc terms in name', () => {
      expect(isDocumentationFile('user-guide.txt')).toBe(true);
      expect(isDocumentationFile('tutorial.txt')).toBe(true);
      expect(isDocumentationFile('manual.txt')).toBe(true);
      expect(isDocumentationFile('howto.txt')).toBe(true);
    });
  });

  describe('should return false for code files', () => {
    it('should not match JavaScript files', () => {
      expect(isDocumentationFile('src/utils.js')).toBe(false);
      expect(isDocumentationFile('index.ts')).toBe(false);
    });

    it('should not match Python files', () => {
      expect(isDocumentationFile('main.py')).toBe(false);
    });

    it('should not match files that happen to be in docs folder but are code', () => {
      // This is a limitation - code in docs folder might be detected as docs
      // But since the file has a code extension, it should be excluded
      expect(isDocumentationFile('docs/example.js')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should be case insensitive for filenames', () => {
      expect(isDocumentationFile('readme.md')).toBe(true);
      expect(isDocumentationFile('LICENSE.txt')).toBe(true);
    });
  });
});

describe('shouldProcessFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: file exists and is small enough
    fs.statSync.mockReturnValue({ size: 1000 });
    // Default: file is not gitignored (throws error = not ignored)
    command.execGitSafe.mockImplementation(() => {
      throw new Error('Not ignored');
    });
  });

  describe('file size checks', () => {
    it('should reject files larger than 1MB', () => {
      fs.statSync.mockReturnValue({ size: 2 * 1024 * 1024 }); // 2MB
      expect(shouldProcessFile('/path/to/large-file.js', '')).toBe(false);
    });

    it('should accept files smaller than 1MB', () => {
      fs.statSync.mockReturnValue({ size: 500 * 1024 }); // 500KB
      expect(shouldProcessFile('/path/to/small-file.js', '')).toBe(true);
    });

    it('should use provided fileStats instead of reading from disk', () => {
      const mockStats = { size: 500 };
      expect(shouldProcessFile('/path/to/file.js', '', { fileStats: mockStats })).toBe(true);
      expect(fs.statSync).not.toHaveBeenCalled();
    });

    it('should reject files based on provided fileStats', () => {
      const mockStats = { size: 2 * 1024 * 1024 }; // 2MB
      expect(shouldProcessFile('/path/to/file.js', '', { fileStats: mockStats })).toBe(false);
    });
  });

  describe('binary file checks', () => {
    it('should reject binary files', () => {
      expect(shouldProcessFile('/path/to/image.png', '')).toBe(false);
      expect(shouldProcessFile('/path/to/file.jpg', '')).toBe(false);
      expect(shouldProcessFile('/path/to/archive.zip', '')).toBe(false);
      expect(shouldProcessFile('/path/to/binary.exe', '')).toBe(false);
    });

    it('should accept non-binary files', () => {
      expect(shouldProcessFile('/path/to/code.js', '')).toBe(true);
      expect(shouldProcessFile('/path/to/data.json', '')).toBe(true);
    });
  });

  describe('directory exclusions', () => {
    it('should reject files in node_modules', () => {
      expect(shouldProcessFile('/project/node_modules/lodash/index.js', '')).toBe(false);
    });

    it('should reject files in dist directory', () => {
      expect(shouldProcessFile('/project/dist/bundle.js', '')).toBe(false);
    });

    it('should reject files in build directory', () => {
      expect(shouldProcessFile('/project/build/output.js', '')).toBe(false);
    });

    it('should accept files not in excluded directories', () => {
      expect(shouldProcessFile('/project/src/index.js', '')).toBe(true);
    });
  });

  describe('filename exclusions', () => {
    it('should reject lock files', () => {
      expect(shouldProcessFile('/project/package-lock.json', '')).toBe(false);
      expect(shouldProcessFile('/project/yarn.lock', '')).toBe(false);
    });

    it('should accept Makefile for review (build automation files are valid code)', () => {
      // Makefile should be reviewed as it contains build logic
      expect(shouldProcessFile('/project/Makefile', '')).toBe(true);
    });

    it('should still reject other config files like Dockerfile', () => {
      expect(shouldProcessFile('/project/Dockerfile', '')).toBe(false);
    });
  });

  describe('custom exclude patterns', () => {
    it('should respect custom exclude patterns', () => {
      const options = {
        // Use ** glob to match across directories
        excludePatterns: ['**/*.test.js'],
        baseDir: '/project',
        respectGitignore: false,
      };
      expect(shouldProcessFile('/project/src/utils.test.js', '', options)).toBe(false);
      expect(shouldProcessFile('/project/src/utils.js', '', options)).toBe(true);
    });

    it('should handle multiple exclude patterns', () => {
      const options = {
        // Use ** glob to match across directories
        excludePatterns: ['**/*.test.js', '**/*.spec.ts'],
        baseDir: '/project',
        respectGitignore: false,
      };
      expect(shouldProcessFile('/project/src/utils.test.js', '', options)).toBe(false);
      expect(shouldProcessFile('/project/src/utils.spec.ts', '', options)).toBe(false);
    });
  });

  describe('gitignore checks', () => {
    it('should reject gitignored files when respectGitignore is true', () => {
      // File is ignored (command succeeds silently)
      command.execGitSafe.mockReturnValue(undefined);
      expect(shouldProcessFile('/project/ignored.js', '', { respectGitignore: true, baseDir: '/project' })).toBe(false);
    });

    it('should accept non-gitignored files when respectGitignore is true', () => {
      // File is not ignored (command throws)
      command.execGitSafe.mockImplementation(() => {
        throw new Error('Not ignored');
      });
      expect(shouldProcessFile('/project/tracked.js', '', { respectGitignore: true, baseDir: '/project' })).toBe(true);
    });

    it('should skip gitignore check when respectGitignore is false', () => {
      expect(shouldProcessFile('/project/any.js', '', { respectGitignore: false })).toBe(true);
      expect(command.execGitSafe).not.toHaveBeenCalled();
    });

    it('should use gitignore cache if provided', () => {
      const cache = new Map();
      cache.set('cached-file.js', true); // true = is ignored

      expect(
        shouldProcessFile('/project/cached-file.js', '', {
          respectGitignore: true,
          baseDir: '/project',
          gitignoreCache: cache,
        })
      ).toBe(false);

      // Should not call git command when cache hit
      expect(command.execGitSafe).not.toHaveBeenCalled();
    });
  });
});

describe('batchCheckGitignore', () => {
  beforeEach(() => {
    mockConsole();
  });

  it('should return empty map for empty input', async () => {
    const result = await batchCheckGitignore([]);
    expect(result.size).toBe(0);
  });

  it('should mark files as not ignored when git check-ignore returns exit code 1', async () => {
    const error = new Error('No files ignored');
    error.status = 1;
    command.execGitSafe.mockImplementation(() => {
      throw error;
    });

    const result = await batchCheckGitignore(['/project/file1.js', '/project/file2.js'], '/project');
    expect(result.get('file1.js')).toBe(false);
    expect(result.get('file2.js')).toBe(false);
  });

  it('should mark ignored files correctly', async () => {
    command.execGitSafe.mockReturnValue('ignored-file.js\n');

    const result = await batchCheckGitignore(['/project/ignored-file.js', '/project/tracked-file.js'], '/project');
    expect(result.get('ignored-file.js')).toBe(true);
    expect(result.get('tracked-file.js')).toBe(false);
  });

  it('should handle fatal errors gracefully', async () => {
    const error = new Error('Fatal git error');
    error.status = 128;
    command.execGitSafe.mockImplementation(() => {
      throw error;
    });

    // Should not throw, should return map with all files marked as not ignored
    const result = await batchCheckGitignore(['/project/file.js'], '/project');
    expect(result.get('file.js')).toBe(false);
  });
});
