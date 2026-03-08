import { debug, verboseLog, isDebugEnabled, isVerboseEnabled } from './logging.js';

describe('logging', () => {
  let originalEnv;
  let originalArgv;

  beforeEach(() => {
    mockConsole();
    originalEnv = { ...process.env };
    originalArgv = [...process.argv];
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  describe('debug', () => {
    it('should not log when DEBUG is not set', () => {
      delete process.env.DEBUG;
      delete process.env.VERBOSE;
      process.argv = process.argv.filter((arg) => arg !== '--verbose');

      debug('Test message');

      expect(console.log).not.toHaveBeenCalled();
    });

    it('should log when DEBUG is set', () => {
      process.env.DEBUG = 'true';

      debug('Debug message');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Debug message'));
    });

    it('should not log when VERBOSE is true without DEBUG', () => {
      delete process.env.DEBUG;
      process.env.VERBOSE = 'true';

      debug('Verbose message');

      expect(console.log).not.toHaveBeenCalled();
    });

    it('should not log when --verbose flag is present without DEBUG', () => {
      delete process.env.DEBUG;
      delete process.env.VERBOSE;
      process.argv = [...process.argv, '--verbose'];

      debug('Verbose flag message');

      expect(console.log).not.toHaveBeenCalled();
    });

    it('should include [DEBUG] prefix in message', () => {
      process.env.DEBUG = 'true';

      debug('Test');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
    });
  });

  describe('isVerboseEnabled', () => {
    it('should be false by default', () => {
      delete process.env.VERBOSE;
      process.argv = process.argv.filter((arg) => arg !== '--verbose');

      expect(isVerboseEnabled()).toBe(false);
    });

    it('should be true when VERBOSE is true', () => {
      process.env.VERBOSE = 'true';

      expect(isVerboseEnabled()).toBe(true);
    });

    it('should be true when --verbose flag is present', () => {
      delete process.env.VERBOSE;
      process.argv = [...process.argv, '--verbose'];

      expect(isVerboseEnabled()).toBe(true);
    });

    it('should be true when options.verbose is true', () => {
      expect(isVerboseEnabled({ verbose: true })).toBe(true);
    });

    it('should ignore DEBUG when checking verbose mode', () => {
      process.env.DEBUG = 'true';

      expect(isVerboseEnabled()).toBe(false);
    });
  });

  describe('isDebugEnabled', () => {
    it('should be false by default', () => {
      delete process.env.DEBUG;

      expect(isDebugEnabled()).toBe(false);
    });

    it('should be true when DEBUG is set', () => {
      process.env.DEBUG = 'true';

      expect(isDebugEnabled()).toBe(true);
    });
  });

  describe('verboseLog', () => {
    it('should log when VERBOSE is true', () => {
      process.env.VERBOSE = 'true';

      verboseLog({}, 'Verbose message');

      expect(console.log).toHaveBeenCalledWith('Verbose message');
    });

    it('should log when options.verbose is true', () => {
      verboseLog({ verbose: true }, 'Option verbose message');

      expect(console.log).toHaveBeenCalledWith('Option verbose message');
    });

    it('should not log when only DEBUG is set', () => {
      process.env.DEBUG = 'true';

      verboseLog({}, 'Debug only message');

      expect(console.log).not.toHaveBeenCalled();
    });
  });
});
