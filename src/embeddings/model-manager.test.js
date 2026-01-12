import fs from 'node:fs';
import { FlagEmbedding, EmbeddingModel } from 'fastembed';
import { ModelManager } from './model-manager.js';

vi.mock('fastembed', () => ({
  EmbeddingModel: { BGESmallENV15: 'BGE-SMALL-EN-V1.5' },
  FlagEmbedding: {
    init: vi.fn(),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    default: {
      ...original,
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

describe('ModelManager', () => {
  let modelManager;
  let mockModel;
  let mockCacheManager;

  beforeEach(() => {
    mockConsoleSelective('log', 'error');

    // Create mock embedding model
    mockModel = {
      passageEmbed: vi.fn(),
      queryEmbed: vi.fn(),
    };

    // Create mock cache manager
    mockCacheManager = {
      getEmbedding: vi.fn(),
      setEmbedding: vi.fn(),
      clearCache: vi.fn(),
    };

    // Default: cache dir exists
    fs.existsSync.mockReturnValue(true);

    // Default: model init succeeds
    FlagEmbedding.init.mockResolvedValue(mockModel);

    modelManager = new ModelManager({
      cacheManager: mockCacheManager,
      embeddingDimensions: 384,
    });
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const manager = new ModelManager();
      expect(manager.embeddingDimensions).toBe(384);
      expect(manager.embeddingModel).toBeNull();
      expect(manager.modelInitialized).toBe(false);
    });

    it('should accept custom options', () => {
      const manager = new ModelManager({
        embeddingDimensions: 768,
        maxRetries: 5,
        cacheDir: '/custom/cache',
      });
      expect(manager.embeddingDimensions).toBe(768);
      expect(manager.maxRetries).toBe(5);
      expect(manager.cacheDir).toBe('/custom/cache');
    });
  });

  describe('initialize', () => {
    it('should initialize the FastEmbed model', async () => {
      await modelManager.initialize();

      expect(FlagEmbedding.init).toHaveBeenCalledWith({
        model: EmbeddingModel.BGESmallENV15,
        cacheDir: expect.any(String),
      });
      expect(modelManager.isInitialized()).toBe(true);
    });

    it('should return existing model if already initialized', async () => {
      await modelManager.initialize();
      await modelManager.initialize();

      // Should only call init once
      expect(FlagEmbedding.init).toHaveBeenCalledTimes(1);
    });

    it('should handle concurrent initialization calls', async () => {
      // Start multiple initializations
      const promise1 = modelManager.initialize();
      const promise2 = modelManager.initialize();
      const promise3 = modelManager.initialize();

      await Promise.all([promise1, promise2, promise3]);

      // Should only call init once
      expect(FlagEmbedding.init).toHaveBeenCalledTimes(1);
    });

    it('should create cache directory if it does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      await modelManager.initialize();

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('should retry on initialization failure', async () => {
      vi.useFakeTimers();
      const manager = new ModelManager({ maxRetries: 2 });

      FlagEmbedding.init.mockRejectedValueOnce(new Error('First attempt failed')).mockResolvedValueOnce(mockModel);

      const initPromise = manager.initialize();
      await vi.runAllTimersAsync();
      await initPromise;

      expect(FlagEmbedding.init).toHaveBeenCalledTimes(2);
      expect(manager.isInitialized()).toBe(true);
      vi.useRealTimers();
    });

    it('should throw after max retries', async () => {
      vi.useFakeTimers();
      const manager = new ModelManager({ maxRetries: 2 });

      FlagEmbedding.init.mockRejectedValue(new Error('Init failed'));

      // Start initialization and immediately attach error handler to prevent unhandled rejection
      const initPromise = manager.initialize().catch((err) => err);

      await vi.runAllTimersAsync();

      const result = await initPromise;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain('Failed to initialize model');

      vi.useRealTimers();
    });
  });

  describe('calculateEmbedding', () => {
    beforeEach(async () => {
      // Setup mock to return valid embedding
      const mockEmbedding = new Float32Array(384).fill(0.1);
      mockModel.passageEmbed.mockImplementation(async function* () {
        yield [mockEmbedding];
      });
    });

    it('should calculate embedding for valid text', async () => {
      mockCacheManager.getEmbedding.mockReturnValue(null);

      const result = await modelManager.calculateEmbedding('test text');

      expect(result).toHaveLength(384);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return null for empty text', async () => {
      const result = await modelManager.calculateEmbedding('');
      expect(result).toBeNull();
    });

    it('should return null for whitespace-only text', async () => {
      const result = await modelManager.calculateEmbedding('   ');
      expect(result).toBeNull();
    });

    it('should return null for non-string input', async () => {
      const result = await modelManager.calculateEmbedding(null);
      expect(result).toBeNull();
    });

    it('should use cache when available', async () => {
      const cachedEmbedding = createMockEmbedding();
      mockCacheManager.getEmbedding.mockReturnValue(cachedEmbedding);

      const result = await modelManager.calculateEmbedding('cached text');

      expect(result).toEqual(cachedEmbedding);
      expect(mockModel.passageEmbed).not.toHaveBeenCalled();
    });

    it('should cache generated embeddings', async () => {
      mockCacheManager.getEmbedding.mockReturnValue(null);

      await modelManager.calculateEmbedding('new text');

      expect(mockCacheManager.setEmbedding).toHaveBeenCalled();
    });

    it('should return null for invalid dimension embedding', async () => {
      const wrongSizeEmbedding = new Float32Array(100).fill(0.1);
      mockModel.passageEmbed.mockImplementation(async function* () {
        yield [wrongSizeEmbedding];
      });
      mockCacheManager.getEmbedding.mockReturnValue(null);

      const result = await modelManager.calculateEmbedding('test');

      expect(result).toBeNull();
    });
  });

  describe('calculateEmbeddingBatch', () => {
    beforeEach(() => {
      mockModel.passageEmbed.mockImplementation(async function* (texts) {
        const embeddings = texts.map(() => new Float32Array(384).fill(0.1));
        yield embeddings;
      });
    });

    it('should calculate embeddings for batch of texts', async () => {
      const texts = ['text 1', 'text 2', 'text 3'];
      const results = await modelManager.calculateEmbeddingBatch(texts);

      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result).toHaveLength(384);
      });
    });

    it('should return nulls for empty array', async () => {
      const results = await modelManager.calculateEmbeddingBatch([]);
      expect(results).toEqual([]);
    });

    it('should return nulls for array with invalid texts', async () => {
      const texts = ['valid', '', 'also valid'];
      const results = await modelManager.calculateEmbeddingBatch(texts);

      // Should return array of nulls due to invalid input
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result).toBeNull();
      });
    });

    it('should handle mixed valid and invalid embeddings', async () => {
      const validEmbedding = new Float32Array(384).fill(0.1);
      const invalidEmbedding = new Float32Array(100).fill(0.1);

      mockModel.passageEmbed.mockImplementation(async function* () {
        yield [validEmbedding, invalidEmbedding, validEmbedding];
      });

      const texts = ['text 1', 'text 2', 'text 3'];
      const results = await modelManager.calculateEmbeddingBatch(texts);

      expect(results[0]).toHaveLength(384);
      expect(results[1]).toBeNull();
      expect(results[2]).toHaveLength(384);
    });
  });

  describe('calculateQueryEmbedding', () => {
    beforeEach(() => {
      mockModel.queryEmbed.mockResolvedValue(new Float32Array(384).fill(0.1));
    });

    it('should calculate query embedding', async () => {
      mockCacheManager.getEmbedding.mockReturnValue(null);

      const result = await modelManager.calculateQueryEmbedding('search query');

      expect(result).toHaveLength(384);
      expect(mockModel.queryEmbed).toHaveBeenCalledWith('search query');
    });

    it('should return null for empty query', async () => {
      const result = await modelManager.calculateQueryEmbedding('');
      expect(result).toBeNull();
    });

    it('should use cache with query prefix', async () => {
      const cachedEmbedding = createMockEmbedding();
      mockCacheManager.getEmbedding.mockReturnValue(cachedEmbedding);

      await modelManager.calculateQueryEmbedding('cached query');

      expect(mockCacheManager.getEmbedding).toHaveBeenCalledWith(expect.stringContaining('query:'));
    });

    it('should cache with query prefix', async () => {
      mockCacheManager.getEmbedding.mockReturnValue(null);

      await modelManager.calculateQueryEmbedding('new query');

      expect(mockCacheManager.setEmbedding).toHaveBeenCalledWith(expect.stringContaining('query:'), expect.any(Array));
    });

    it('should return null for invalid dimension embedding', async () => {
      mockModel.queryEmbed.mockResolvedValue(new Float32Array(100).fill(0.1));
      mockCacheManager.getEmbedding.mockReturnValue(null);

      const result = await modelManager.calculateQueryEmbedding('test');

      expect(result).toBeNull();
    });
  });

  describe('isInitialized', () => {
    it('should return false before initialization', () => {
      expect(modelManager.isInitialized()).toBe(false);
    });

    it('should return true after initialization', async () => {
      await modelManager.initialize();
      expect(modelManager.isInitialized()).toBe(true);
    });

    it('should return false after cleanup', async () => {
      await modelManager.initialize();
      await modelManager.cleanup();
      expect(modelManager.isInitialized()).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should clear model references', async () => {
      await modelManager.initialize();
      await modelManager.cleanup();

      expect(modelManager.embeddingModel).toBeNull();
      expect(modelManager.modelInitialized).toBe(false);
    });

    it('should clear embedding cache', async () => {
      await modelManager.initialize();
      await modelManager.cleanup();

      expect(mockCacheManager.clearCache).toHaveBeenCalledWith('embedding');
    });

    it('should prevent duplicate cleanup calls', async () => {
      await modelManager.initialize();

      modelManager.cleaningUp = true;
      await modelManager.cleanup();

      // Should not clear cache because already cleaning up
      expect(mockCacheManager.clearCache).not.toHaveBeenCalled();
    });

    it('should reset cleaningUp flag after completion', async () => {
      await modelManager.cleanup();
      expect(modelManager.cleaningUp).toBe(false);
    });
  });
});
