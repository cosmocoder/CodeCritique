import { AutoTokenizer } from '@huggingface/transformers';
import { truncateToTokenLimit, cleanupTokenizer } from './mobilebert-tokenizer.js';

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: vi.fn(),
  },
}));

describe('mobilebert-tokenizer', () => {
  let mockTokenizer;

  beforeEach(() => {
    mockConsoleSelective('log', 'warn');

    mockTokenizer = {
      encode: vi.fn(),
      dispose: vi.fn(),
    };
    AutoTokenizer.from_pretrained.mockResolvedValue(mockTokenizer);
  });

  afterEach(async () => {
    // Clean up tokenizer state between tests (while mocks are still active)
    await cleanupTokenizer();
    vi.restoreAllMocks();
  });

  describe('truncateToTokenLimit', () => {
    it('should return empty string for empty input', async () => {
      const result = await truncateToTokenLimit('');
      expect(result).toBe('');
    });

    it('should return empty string for null input', async () => {
      const result = await truncateToTokenLimit(null);
      expect(result).toBe('');
    });

    it('should return original text if within token limit', async () => {
      mockTokenizer.encode.mockResolvedValue(new Array(100)); // 100 tokens

      const text = 'Short text that fits within limit';
      const result = await truncateToTokenLimit(text, 450);

      expect(result).toBe(text);
    });

    it('should truncate text if exceeds token limit', async () => {
      // Mock encode to return different lengths based on input length
      mockTokenizer.encode.mockImplementation(async (text) => {
        // Approximate: 1 token per 4 characters
        return new Array(Math.ceil(text.length / 4));
      });

      const longText = 'a'.repeat(2000); // ~500 tokens
      const result = await truncateToTokenLimit(longText, 100);

      expect(result.length).toBeLessThan(longText.length);
    });

    it('should use binary search for efficient truncation', async () => {
      let callCount = 0;
      mockTokenizer.encode.mockImplementation(async (text) => {
        callCount++;
        return new Array(Math.ceil(text.length / 4));
      });

      const longText = 'word '.repeat(500);
      await truncateToTokenLimit(longText, 100);

      // Binary search should call encode roughly log2(n) times
      expect(callCount).toBeLessThan(30); // Much less than linear
    });

    it('should not cut in the middle of a word', async () => {
      mockTokenizer.encode.mockImplementation(async (text) => {
        return new Array(Math.ceil(text.length / 3));
      });

      const text = 'This is a sentence with multiple words that needs truncation';
      const result = await truncateToTokenLimit(text, 10);

      // Should end at a word boundary
      expect(result.endsWith(' ')).toBe(false);
      expect(result.split(' ').pop()).not.toBe('');
    });

    it('should fallback to character estimation if tokenizer fails', async () => {
      AutoTokenizer.from_pretrained.mockRejectedValue(new Error('Model load failed'));

      const text = 'Some text to truncate';
      const result = await truncateToTokenLimit(text, 450);

      // Should still return something (fallback to character estimation)
      expect(result).toBeDefined();
    });
  });

  describe('cleanupTokenizer', () => {
    it('should dispose tokenizer resources', async () => {
      // Initialize tokenizer first
      mockTokenizer.encode.mockResolvedValue([1, 2, 3]);
      await truncateToTokenLimit('test', 100);

      await cleanupTokenizer();

      expect(mockTokenizer.dispose).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('cleaned up'));
    });

    it('should handle missing dispose method gracefully', async () => {
      mockTokenizer.dispose = undefined;
      mockTokenizer.encode.mockResolvedValue([1, 2, 3]);

      await truncateToTokenLimit('test', 100);
      await cleanupTokenizer();

      // Should not throw
      expect(console.log).toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully', async () => {
      mockTokenizer.dispose.mockRejectedValue(new Error('Cleanup failed'));
      mockTokenizer.encode.mockResolvedValue([1, 2, 3]);

      await truncateToTokenLimit('test', 100);
      await cleanupTokenizer();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Error cleaning up'), expect.any(String));
    });

    it('should be safe to call when tokenizer not initialized', async () => {
      // Should not throw when called without initialization
      await expect(cleanupTokenizer()).resolves.not.toThrow();
    });
  });
});
