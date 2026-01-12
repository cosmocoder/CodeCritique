import { debug } from './logging.js';

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

    it('should log when VERBOSE is true', () => {
      delete process.env.DEBUG;
      process.env.VERBOSE = 'true';

      debug('Verbose message');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Verbose message'));
    });

    it('should log when --verbose flag is present', () => {
      delete process.env.DEBUG;
      delete process.env.VERBOSE;
      process.argv = [...process.argv, '--verbose'];

      debug('Verbose flag message');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Verbose flag message'));
    });

    it('should include [DEBUG] prefix in message', () => {
      process.env.DEBUG = 'true';

      debug('Test');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
    });
  });
});
