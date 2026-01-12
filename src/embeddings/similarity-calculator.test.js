import { calculateCosineSimilarity, calculatePathSimilarity } from './similarity-calculator.js';

describe('calculateCosineSimilarity', () => {
  describe('basic similarity calculations', () => {
    it('should return 1.0 for identical vectors', () => {
      const vec = [1, 2, 3, 4, 5];
      expect(calculateCosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
    });

    it('should return 1.0 for parallel vectors with different magnitudes', () => {
      const vecA = [1, 2, 3];
      const vecB = [2, 4, 6]; // Same direction, different magnitude
      expect(calculateCosineSimilarity(vecA, vecB)).toBeCloseTo(1.0, 5);
    });

    it('should return -1.0 for opposite vectors', () => {
      const vecA = [1, 2, 3];
      const vecB = [-1, -2, -3];
      expect(calculateCosineSimilarity(vecA, vecB)).toBeCloseTo(-1.0, 5);
    });

    it('should return 0 for orthogonal vectors', () => {
      const vecA = [1, 0];
      const vecB = [0, 1];
      expect(calculateCosineSimilarity(vecA, vecB)).toBeCloseTo(0, 5);
    });

    it('should return a value between -1 and 1 for arbitrary vectors', () => {
      const vecA = [1, 2, 3, 4];
      const vecB = [4, 3, 2, 1];
      const similarity = calculateCosineSimilarity(vecA, vecB);
      expect(similarity).toBeGreaterThanOrEqual(-1);
      expect(similarity).toBeLessThanOrEqual(1);
    });
  });

  describe('edge cases and error handling', () => {
    it('should return 0 for null first vector', () => {
      expect(calculateCosineSimilarity(null, [1, 2, 3])).toBe(0);
    });

    it('should return 0 for null second vector', () => {
      expect(calculateCosineSimilarity([1, 2, 3], null)).toBe(0);
    });

    it('should return 0 for undefined vectors', () => {
      expect(calculateCosineSimilarity(undefined, undefined)).toBe(0);
    });

    it('should return 0 for empty vectors', () => {
      expect(calculateCosineSimilarity([], [])).toBe(0);
    });

    it('should return 0 for vectors with different lengths', () => {
      expect(calculateCosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it('should return 0 for zero vectors', () => {
      const zeroVec = [0, 0, 0];
      expect(calculateCosineSimilarity(zeroVec, zeroVec)).toBe(0);
    });

    it('should return 0 for near-zero vectors', () => {
      const nearZeroVec = [1e-10, 1e-10, 1e-10];
      expect(calculateCosineSimilarity(nearZeroVec, nearZeroVec)).toBe(0);
    });

    it('should return 0 for non-array inputs', () => {
      expect(calculateCosineSimilarity('not an array', [1, 2, 3])).toBe(0);
      expect(calculateCosineSimilarity([1, 2, 3], 'not an array')).toBe(0);
      expect(calculateCosineSimilarity({}, [])).toBe(0);
    });
  });

  describe('realistic embedding vectors', () => {
    it('should handle 384-dimension embedding vectors', () => {
      const dim = 384;
      const vecA = createMockEmbedding(dim, 0.1);
      const vecB = createMockEmbedding(dim, 0.1);
      expect(calculateCosineSimilarity(vecA, vecB)).toBeCloseTo(1.0, 5);
    });

    it('should calculate similarity for different 384-dim vectors', () => {
      const dim = 384;
      const vecA = createMockEmbedding(dim, 0.1);
      const vecB = createMockEmbedding(dim, 0.2);
      const similarity = calculateCosineSimilarity(vecA, vecB);
      // Both vectors have same direction (all positive), so similarity should be 1
      expect(similarity).toBeCloseTo(1.0, 5);
    });

    it('should handle mixed positive and negative values', () => {
      const vecA = [0.5, -0.3, 0.8, -0.1];
      const vecB = [0.4, -0.2, 0.7, -0.2];
      const similarity = calculateCosineSimilarity(vecA, vecB);
      expect(similarity).toBeGreaterThan(0.9); // Similar vectors
    });
  });
});

describe('calculatePathSimilarity', () => {
  describe('basic path comparisons', () => {
    it('should return high similarity for paths in the same directory', () => {
      const path1 = '/src/utils/file1.js';
      const path2 = '/src/utils/file2.js';
      const similarity = calculatePathSimilarity(path1, path2);
      expect(similarity).toBeGreaterThan(0.5);
    });

    it('should return lower similarity for paths in different directories', () => {
      const path1 = '/src/utils/file.js';
      const path2 = '/src/components/file.js';
      const similarSame = calculatePathSimilarity('/src/utils/a.js', '/src/utils/b.js');
      const similarDiff = calculatePathSimilarity(path1, path2);
      expect(similarDiff).toBeLessThan(similarSame);
    });

    it('should return 0 for completely different paths', () => {
      const path1 = '/frontend/components/Button.tsx';
      const path2 = '/backend/services/auth.js';
      const similarity = calculatePathSimilarity(path1, path2);
      expect(similarity).toBeLessThan(0.5);
    });
  });

  describe('edge cases and error handling', () => {
    it('should return 0 for null first path', () => {
      expect(calculatePathSimilarity(null, '/some/path')).toBe(0);
    });

    it('should return 0 for null second path', () => {
      expect(calculatePathSimilarity('/some/path', null)).toBe(0);
    });

    it('should return 0 for undefined paths', () => {
      expect(calculatePathSimilarity(undefined, undefined)).toBe(0);
    });

    it('should return 0 for empty string paths', () => {
      expect(calculatePathSimilarity('', '/some/path')).toBe(0);
      expect(calculatePathSimilarity('/some/path', '')).toBe(0);
    });

    it('should handle root-level files', () => {
      const path1 = '/file1.js';
      const path2 = '/file2.js';
      const similarity = calculatePathSimilarity(path1, path2);
      // Root files have empty dirname after filtering, avgLength is 0, returns 1
      expect(similarity).toBe(1);
    });
  });

  describe('relative paths', () => {
    it('should handle relative paths', () => {
      const path1 = 'src/utils/helpers.js';
      const path2 = 'src/utils/validators.js';
      const similarity = calculatePathSimilarity(path1, path2);
      expect(similarity).toBeGreaterThan(0.5);
    });

    it('should compare relative paths with different depths', () => {
      const path1 = 'src/components/Button.js';
      const path2 = 'src/components/forms/Input.js';
      const similarity = calculatePathSimilarity(path1, path2);
      expect(similarity).toBeGreaterThan(0);
      expect(similarity).toBeLessThanOrEqual(1);
    });
  });
});
