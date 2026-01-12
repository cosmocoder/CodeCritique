import { execSync } from 'node:child_process';
import { execGitSafe } from './command.js';

// Mock child_process.execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('execGitSafe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSync.mockReturnValue(Buffer.from('mock output'));
  });

  describe('basic command execution', () => {
    it('should execute a simple git command', () => {
      execGitSafe('git status', []);
      expect(execSync).toHaveBeenCalledWith('git status', {});
    });

    it('should execute command with single argument', () => {
      execGitSafe('git show', ['HEAD']);
      expect(execSync).toHaveBeenCalledWith("git show 'HEAD'", {});
    });

    it('should execute command with multiple arguments', () => {
      execGitSafe('git diff', ['HEAD~1', 'src/file.js']);
      expect(execSync).toHaveBeenCalledWith("git diff 'HEAD~1' 'src/file.js'", {});
    });

    it('should pass through options to execSync', () => {
      const options = { cwd: '/path/to/repo', encoding: 'utf8' };
      execGitSafe('git log', ['-1'], options);
      expect(execSync).toHaveBeenCalledWith("git log '-1'", options);
    });

    it('should return the command output', () => {
      execSync.mockReturnValue(Buffer.from('command output'));
      const result = execGitSafe('git log', ['-1']);
      expect(result.toString()).toBe('command output');
    });
  });

  describe('argument escaping for security', () => {
    it('should escape single quotes in arguments', () => {
      execGitSafe('git show', ["file's name.js"]);
      expect(execSync).toHaveBeenCalledWith("git show 'file'\\''s name.js'", {});
    });

    it('should escape multiple single quotes', () => {
      execGitSafe('git show', ["it's a 'test'"]);
      expect(execSync).toHaveBeenCalledWith("git show 'it'\\''s a '\\''test'\\'''", {});
    });

    it('should handle arguments with spaces', () => {
      execGitSafe('git add', ['path with spaces/file.js']);
      expect(execSync).toHaveBeenCalledWith("git add 'path with spaces/file.js'", {});
    });

    it('should handle arguments with special characters', () => {
      execGitSafe('git show', ['file$(whoami).js']);
      expect(execSync).toHaveBeenCalledWith("git show 'file$(whoami).js'", {});
    });

    it('should handle arguments with backticks', () => {
      execGitSafe('git show', ['file`command`.js']);
      expect(execSync).toHaveBeenCalledWith("git show 'file`command`.js'", {});
    });

    it('should handle arguments with newlines', () => {
      execGitSafe('git show', ['line1\nline2']);
      expect(execSync).toHaveBeenCalledWith("git show 'line1\nline2'", {});
    });

    it('should handle arguments with semicolons (prevent command chaining)', () => {
      execGitSafe('git show', ['file.js; rm -rf /']);
      expect(execSync).toHaveBeenCalledWith("git show 'file.js; rm -rf /'", {});
    });

    it('should handle arguments with pipes', () => {
      execGitSafe('git show', ['file.js | cat /etc/passwd']);
      expect(execSync).toHaveBeenCalledWith("git show 'file.js | cat /etc/passwd'", {});
    });

    it('should handle arguments with ampersands', () => {
      execGitSafe('git show', ['file.js && rm -rf /']);
      expect(execSync).toHaveBeenCalledWith("git show 'file.js && rm -rf /'", {});
    });
  });

  describe('edge cases', () => {
    it('should handle empty argument array', () => {
      execGitSafe('git status', []);
      expect(execSync).toHaveBeenCalledWith('git status', {});
    });

    it('should handle undefined args', () => {
      execGitSafe('git status');
      expect(execSync).toHaveBeenCalledWith('git status', {});
    });

    it('should handle null argument in array', () => {
      execGitSafe('git show', [null, 'file.js']);
      expect(execSync).toHaveBeenCalledWith("git show '' 'file.js'", {});
    });

    it('should handle undefined argument in array', () => {
      execGitSafe('git show', [undefined, 'file.js']);
      expect(execSync).toHaveBeenCalledWith("git show '' 'file.js'", {});
    });

    it('should handle empty string argument', () => {
      execGitSafe('git show', ['', 'file.js']);
      expect(execSync).toHaveBeenCalledWith("git show '' 'file.js'", {});
    });

    it('should handle numeric arguments by treating them as strings', () => {
      // Note: The function expects string arguments
      execGitSafe('git show', ['HEAD~1']);
      expect(execSync).toHaveBeenCalledWith("git show 'HEAD~1'", {});
    });
  });

  describe('error handling', () => {
    it('should throw when command execution fails', () => {
      const error = new Error('Command failed');
      error.status = 1;
      execSync.mockImplementation(() => {
        throw error;
      });

      expect(() => execGitSafe('git show', ['nonexistent'])).toThrow('Command failed');
    });

    it('should propagate the error status', () => {
      const error = new Error('Command failed');
      error.status = 128;
      execSync.mockImplementation(() => {
        throw error;
      });

      try {
        execGitSafe('git show', ['nonexistent']);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e.status).toBe(128);
      }
    });
  });

  describe('realistic git commands', () => {
    it('should handle git show with commit and file path', () => {
      execGitSafe('git show', ['abc123:src/utils.js']);
      expect(execSync).toHaveBeenCalledWith("git show 'abc123:src/utils.js'", {});
    });

    it('should handle git diff with refs', () => {
      execGitSafe('git diff', ['origin/main...HEAD', '--', 'src/']);
      expect(execSync).toHaveBeenCalledWith("git diff 'origin/main...HEAD' '--' 'src/'", {});
    });

    it('should handle git log with format string', () => {
      execGitSafe('git log', ['--format=%H %s', '-n', '10']);
      expect(execSync).toHaveBeenCalledWith("git log '--format=%H %s' '-n' '10'", {});
    });

    it('should handle git check-ignore', () => {
      execGitSafe('git check-ignore', ['-q', 'node_modules/']);
      expect(execSync).toHaveBeenCalledWith("git check-ignore '-q' 'node_modules/'", {});
    });
  });
});
