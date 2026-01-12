import { execSync } from 'node:child_process';
import * as command from './command.js';
import { ensureBranchExists, findBaseBranch, getChangedLinesInfo, getFileContentFromGit } from './git.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('./command.js', () => ({
  execGitSafe: vi.fn(),
}));

describe('findBaseBranch', () => {
  beforeEach(() => {
    mockConsoleSelective('warn');
  });

  it('should return main if main branch exists locally', () => {
    // First call for 'main' local check succeeds
    command.execGitSafe.mockImplementation((cmd, args) => {
      if (args && args.includes('refs/heads/main')) {
        return ''; // Success - branch exists
      }
      throw new Error('Branch not found');
    });

    expect(findBaseBranch()).toBe('main');
  });

  it('should return master if main does not exist but master does', () => {
    command.execGitSafe.mockImplementation((cmd, args) => {
      if (args && args.includes('refs/heads/main')) {
        throw new Error('Branch not found');
      }
      if (args && args.includes('refs/remotes/origin/main')) {
        throw new Error('Branch not found');
      }
      if (args && args.includes('refs/heads/master')) {
        return ''; // Success
      }
      throw new Error('Branch not found');
    });

    expect(findBaseBranch()).toBe('master');
  });

  it('should return develop if neither main nor master exist', () => {
    command.execGitSafe.mockImplementation((cmd, args) => {
      if (args && args.includes('refs/heads/develop')) {
        return '';
      }
      throw new Error('Branch not found');
    });

    expect(findBaseBranch()).toBe('develop');
  });

  it('should check remote if local branch does not exist', () => {
    command.execGitSafe.mockImplementation((cmd, args) => {
      if (args && args.includes('refs/heads/main')) {
        throw new Error('Branch not found locally');
      }
      if (args && args.includes('refs/remotes/origin/main')) {
        return ''; // Exists on remote
      }
      throw new Error('Branch not found');
    });

    expect(findBaseBranch()).toBe('main');
  });

  it('should return HEAD~1 as fallback when no standard branches exist', () => {
    command.execGitSafe.mockImplementation(() => {
      throw new Error('Branch not found');
    });

    expect(findBaseBranch()).toBe('HEAD~1');
    expect(console.warn).toHaveBeenCalled();
  });

  it('should use provided working directory', () => {
    command.execGitSafe.mockImplementation((cmd, args, options) => {
      expect(options.cwd).toBe('/custom/path');
      return '';
    });

    findBaseBranch('/custom/path');
  });
});

describe('ensureBranchExists', () => {
  beforeEach(() => {
    mockConsoleSelective('log', 'error');
  });

  it('should do nothing if branch exists locally', () => {
    command.execGitSafe.mockReturnValue('');

    ensureBranchExists('feature-branch');

    // Should only check if branch exists, not fetch
    expect(command.execGitSafe).toHaveBeenCalledTimes(1);
    expect(command.execGitSafe).toHaveBeenCalledWith(
      'git show-ref',
      ['--verify', '--quiet', 'refs/heads/feature-branch'],
      expect.any(Object)
    );
  });

  it('should fetch branch if not found locally', () => {
    let callCount = 0;
    command.execGitSafe.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: check local branch - not found
        throw new Error('Branch not found');
      }
      if (callCount === 2) {
        // Second call: fetch from origin - success
        return '';
      }
      return '';
    });

    ensureBranchExists('feature-branch');

    expect(command.execGitSafe).toHaveBeenCalledWith('git fetch', ['origin', 'feature-branch:feature-branch'], expect.any(Object));
  });

  it('should try fetching all branches if direct fetch fails', () => {
    command.execGitSafe.mockImplementation((cmd, args) => {
      if (cmd === 'git show-ref' && args?.includes('refs/heads/feature-branch')) {
        throw new Error('Local branch not found');
      }
      if (cmd === 'git fetch') {
        throw new Error('Direct fetch failed');
      }
      if (cmd === 'git show-ref' && args?.includes('refs/remotes/origin/feature-branch')) {
        return ''; // Remote branch exists
      }
      if (cmd === 'git checkout') {
        return '';
      }
      throw new Error('Unexpected call');
    });

    execSync.mockReturnValue(''); // For git fetch origin

    ensureBranchExists('feature-branch');

    expect(execSync).toHaveBeenCalledWith('git fetch origin', expect.any(Object));
  });

  it('should throw error if branch not found anywhere', () => {
    command.execGitSafe.mockImplementation(() => {
      throw new Error('Branch not found');
    });
    execSync.mockReturnValue(''); // git fetch origin

    expect(() => ensureBranchExists('nonexistent')).toThrow("Branch 'nonexistent' not found locally or on remote origin");
  });
});

describe('getChangedLinesInfo', () => {
  beforeEach(() => {
    mockConsoleSelective('error');
  });

  it('should parse added lines from diff', () => {
    execSync.mockReturnValue(`@@ -10,3 +10,5 @@ function test() {
 context line
+added line 1
+added line 2
 another context
`);

    const result = getChangedLinesInfo('src/file.js', 'main', 'feature');

    expect(result.hasChanges).toBe(true);
    expect(result.addedLines).toHaveLength(2);
    expect(result.addedLines[0].content).toBe('added line 1');
    expect(result.addedLines[0].lineNumber).toBe(11);
    expect(result.addedLines[1].content).toBe('added line 2');
    expect(result.addedLines[1].lineNumber).toBe(12);
  });

  it('should parse removed lines from diff', () => {
    execSync.mockReturnValue(`@@ -10,4 +10,2 @@ function test() {
 context line
-removed line 1
-removed line 2
 another context
`);

    const result = getChangedLinesInfo('src/file.js', 'main', 'feature');

    expect(result.hasChanges).toBe(true);
    expect(result.removedLines).toHaveLength(2);
    expect(result.removedLines[0].content).toBe('removed line 1');
    expect(result.removedLines[1].content).toBe('removed line 2');
  });

  it('should parse context lines from diff', () => {
    execSync.mockReturnValue(`@@ -10,3 +10,4 @@ function test() {
 context before
+added line
 context after
`);

    const result = getChangedLinesInfo('src/file.js', 'main', 'feature');

    expect(result.contextLines).toHaveLength(2);
    expect(result.contextLines[0].content).toBe('context before');
    expect(result.contextLines[1].content).toBe('context after');
  });

  it('should return hasChanges false for empty diff', () => {
    execSync.mockReturnValue('');

    const result = getChangedLinesInfo('src/file.js', 'main', 'feature');

    expect(result.hasChanges).toBe(false);
    expect(result.addedLines).toEqual([]);
    expect(result.removedLines).toEqual([]);
  });

  it('should handle multiple hunks', () => {
    execSync.mockReturnValue(`@@ -5,3 +5,4 @@ first section
 context
+first add
 more context
@@ -20,2 +21,3 @@ second section
 context
+second add
`);

    const result = getChangedLinesInfo('src/file.js', 'main', 'feature');

    expect(result.addedLines).toHaveLength(2);
    expect(result.addedLines[0].lineNumber).toBe(6);
    expect(result.addedLines[1].lineNumber).toBe(22);
  });

  it('should handle hunk headers without line counts', () => {
    execSync.mockReturnValue(`@@ -10 +10 @@ function
+single line change
`);

    const result = getChangedLinesInfo('src/file.js', 'main', 'feature');

    expect(result.addedLines).toHaveLength(1);
    expect(result.addedLines[0].lineNumber).toBe(10);
  });

  it('should include full diff in result', () => {
    const diffContent = '@@ -1,1 +1,2 @@\n context\n+added';
    execSync.mockReturnValue(diffContent);

    const result = getChangedLinesInfo('src/file.js', 'main', 'feature');

    expect(result.fullDiff).toBe(diffContent);
  });

  it('should handle errors gracefully', () => {
    execSync.mockImplementation(() => {
      throw new Error('Git error');
    });

    const result = getChangedLinesInfo('src/file.js', 'main', 'feature');

    expect(result.hasChanges).toBe(false);
    expect(result.addedLines).toEqual([]);
  });
});

describe('getFileContentFromGit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should get file content from specified branch', () => {
    execSync.mockReturnValue('/repo/root');
    command.execGitSafe.mockReturnValue('file content from branch');

    const result = getFileContentFromGit('/repo/root/src/file.js', 'main', '/repo/root');

    expect(result).toBe('file content from branch');
    expect(command.execGitSafe).toHaveBeenCalledWith('git show', ['main:src/file.js'], expect.any(Object));
  });

  it('should handle commit hashes', () => {
    execSync.mockReturnValue('/repo');
    command.execGitSafe.mockReturnValue('content at commit');

    getFileContentFromGit('/repo/src/file.js', 'abc123', '/repo');

    expect(command.execGitSafe).toHaveBeenCalledWith('git show', ['abc123:src/file.js'], expect.any(Object));
  });

  it('should return empty string for new files', () => {
    execSync.mockReturnValue('/repo');
    const error = new Error('File not found');
    error.stderr = 'exists on disk, but not in main';
    command.execGitSafe.mockImplementation(() => {
      throw error;
    });

    const result = getFileContentFromGit('/repo/src/new-file.js', 'main', '/repo');

    expect(result).toBe('');
  });

  it('should throw error for other git errors', () => {
    execSync.mockReturnValue('/repo');
    command.execGitSafe.mockImplementation(() => {
      throw new Error('Some other git error');
    });

    expect(() => getFileContentFromGit('/repo/src/file.js', 'main', '/repo')).toThrow('Failed to get content');
  });

  it('should normalize path separators for git', () => {
    execSync.mockReturnValue('/repo');
    command.execGitSafe.mockReturnValue('content');

    getFileContentFromGit('/repo/src/nested/deep/file.js', 'main', '/repo');

    // Should use forward slashes regardless of OS
    expect(command.execGitSafe).toHaveBeenCalledWith('git show', ['main:src/nested/deep/file.js'], expect.any(Object));
  });
});
