import { pipeline } from '@huggingface/transformers';
import { openClassifier } from './zero-shot-classifier-open.js';

vi.mock('@huggingface/transformers', () => ({
  env: {
    allowLocalModels: false,
    useBrowserCache: false,
  },
  pipeline: vi.fn(),
}));

vi.mock('./utils/mobilebert-tokenizer.js', () => ({
  truncateToTokenLimit: vi.fn((text) => Promise.resolve(text.substring(0, 500))),
}));

describe('OpenZeroShotClassifier', () => {
  let mockClassifier;

  beforeEach(() => {
    mockConsoleSelective('log', 'error');

    mockClassifier = vi.fn();
    pipeline.mockResolvedValue(mockClassifier);

    // Reset classifier state
    openClassifier.classifier = null;
    openClassifier.isInitialized = false;
    openClassifier.initializationPromise = null;
    openClassifier.cache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialize', () => {
    it('should initialize the classifier pipeline', async () => {
      await openClassifier.initialize();

      expect(pipeline).toHaveBeenCalledWith('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli', {
        quantized: true,
      });
      expect(openClassifier.isInitialized).toBe(true);
    });

    it('should only initialize once', async () => {
      await openClassifier.initialize();
      await openClassifier.initialize();

      expect(pipeline).toHaveBeenCalledTimes(1);
    });

    it('should wait for existing initialization', async () => {
      const promise1 = openClassifier.initialize();
      const promise2 = openClassifier.initialize();

      await Promise.all([promise1, promise2]);

      expect(pipeline).toHaveBeenCalledTimes(1);
    });

    it('should handle initialization errors', async () => {
      pipeline.mockRejectedValue(new Error('Model load failed'));

      await expect(openClassifier.initialize()).rejects.toThrow('Model load failed');
      expect(openClassifier.isInitialized).toBe(false);
    });
  });

  describe('extractTechnologyCandidates', () => {
    it('should extract known technologies', () => {
      const text = 'We use React and TypeScript with Node.js';
      const candidates = openClassifier.extractTechnologyCandidates(text);

      expect(candidates).toContain('react');
      expect(candidates).toContain('typescript');
    });

    it('should extract CamelCase words', () => {
      const text = 'The project uses GraphQL and NextJS';
      const candidates = openClassifier.extractTechnologyCandidates(text);

      expect(candidates.some((c) => c.toLowerCase() === 'graphql')).toBe(true);
    });

    it('should extract kebab-case patterns', () => {
      const text = 'We use styled-components and react-router';
      const candidates = openClassifier.extractTechnologyCandidates(text);

      expect(candidates).toContain('styled-components');
      expect(candidates).toContain('react-router');
    });

    it('should exclude common words', () => {
      const text = 'The system uses modern architecture';
      const candidates = openClassifier.extractTechnologyCandidates(text);

      expect(candidates).not.toContain('system');
      expect(candidates).not.toContain('modern');
      expect(candidates).not.toContain('architecture');
    });

    it('should extract acronyms', () => {
      const text = 'We use REST APIs and SQL databases';
      const candidates = openClassifier.extractTechnologyCandidates(text);

      expect(candidates).toContain('REST');
      expect(candidates).toContain('SQL');
    });
  });

  describe('classifyTechnologies', () => {
    beforeEach(async () => {
      mockClassifier.mockResolvedValue({
        labels: ['This text is about React', 'This text is about TypeScript'],
        scores: [0.9, 0.7],
      });
      await openClassifier.initialize();
    });

    it('should classify technologies with confidence scores', async () => {
      const result = await openClassifier.classifyTechnologies('Building a React app with TypeScript');

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('technology');
      expect(result[0]).toHaveProperty('confidence');
    });

    it('should filter results below minimum confidence', async () => {
      mockClassifier.mockResolvedValue({
        labels: ['This text is about React', 'This text is about obscure-lib'],
        scores: [0.9, 0.1],
      });

      const result = await openClassifier.classifyTechnologies('React app', 0.3);

      expect(result.length).toBe(1);
      expect(result[0].technology).toBe('React');
    });

    it('should use cache for repeated queries', async () => {
      const text = 'Using React for frontend';
      await openClassifier.classifyTechnologies(text);
      await openClassifier.classifyTechnologies(text);

      expect(mockClassifier).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no candidates found', async () => {
      const result = await openClassifier.classifyTechnologies('');

      expect(result).toEqual([]);
    });

    it('should handle classification errors gracefully', async () => {
      mockClassifier.mockRejectedValue(new Error('Classification failed'));

      const result = await openClassifier.classifyTechnologies('Some text with React');

      expect(result).toEqual([]);
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('classifyDomain', () => {
    beforeEach(async () => {
      mockClassifier.mockResolvedValue({
        labels: ['This is frontend/UI documentation', 'This is API documentation'],
        scores: [0.85, 0.6],
      });
      await openClassifier.initialize();
    });

    it('should classify document domains', async () => {
      const result = await openClassifier.classifyDomain('Building React components for the UI');

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('domain');
      expect(result[0]).toHaveProperty('confidence');
    });

    it('should filter results below minimum confidence', async () => {
      mockClassifier.mockResolvedValue({
        labels: ['This is frontend/UI documentation', 'This is security documentation'],
        scores: [0.9, 0.2],
      });

      const result = await openClassifier.classifyDomain('Frontend guide', 0.3);

      expect(result.length).toBe(1);
      expect(result[0].domain).toBe('frontend/UI');
    });

    it('should use cache for repeated queries', async () => {
      const text = 'API documentation for REST endpoints';
      await openClassifier.classifyDomain(text);
      await openClassifier.classifyDomain(text);

      expect(mockClassifier).toHaveBeenCalledTimes(1);
    });

    it('should handle classification errors gracefully', async () => {
      mockClassifier.mockRejectedValue(new Error('Classification failed'));

      const result = await openClassifier.classifyDomain('Some text');

      expect(result).toEqual([]);
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('classifyDocument', () => {
    beforeEach(async () => {
      mockClassifier.mockImplementation((text, hypotheses) => {
        if (hypotheses[0].includes('This text is about')) {
          return {
            labels: hypotheses,
            scores: hypotheses.map(() => 0.5),
          };
        }
        return {
          labels: hypotheses,
          scores: hypotheses.map(() => 0.5),
        };
      });
      await openClassifier.initialize();
    });

    it('should return combined technology and domain classification', async () => {
      const result = await openClassifier.classifyDocument('React frontend with REST API');

      expect(result).toHaveProperty('technologies');
      expect(result).toHaveProperty('domains');
      expect(result).toHaveProperty('primaryTechnology');
      expect(result).toHaveProperty('primaryDomain');
    });

    it('should return Unknown for primary technology when none found', async () => {
      mockClassifier.mockResolvedValue({
        labels: [],
        scores: [],
      });

      const result = await openClassifier.classifyDocument('Generic text with no tech');

      expect(result.primaryTechnology).toBe('Unknown');
    });
  });

  describe('buildTechPatterns', () => {
    it('should create patterns for common tech naming conventions', () => {
      const patterns = openClassifier.techPatterns;

      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.some((p) => p.test('vue.js'))).toBe(true);
    });
  });

  describe('buildKnownTechnologies', () => {
    it('should include technologies from JSON file', () => {
      expect(openClassifier.knownTechnologies.size).toBeGreaterThan(0);
      expect(openClassifier.knownTechnologies.has('react')).toBe(true);
    });

    it('should include languages from linguist', () => {
      expect(openClassifier.knownTechnologies.has('javascript')).toBe(true);
      expect(openClassifier.knownTechnologies.has('python')).toBe(true);
    });
  });

  describe('escapeRegex', () => {
    it('should escape special regex characters', () => {
      expect(openClassifier.escapeRegex('node.js')).toBe('node\\.js');
      expect(openClassifier.escapeRegex('c++')).toBe('c\\+\\+');
      expect(openClassifier.escapeRegex('$.ajax()')).toBe('\\$\\.ajax\\(\\)');
    });
  });
});
