import {
  EmbeddingError,
  ValidationError,
  ERROR_CODES,
  createModelInitializationError,
  createDatabaseError,
  createEmbeddingGenerationError,
  createFileProcessingError,
} from './errors.js';

describe('embeddings errors', () => {
  describe('EmbeddingError', () => {
    it('should create error with message and default code', () => {
      const error = new EmbeddingError('Test error');

      expect(error.message).toBe('Test error');
      expect(error.code).toBe(ERROR_CODES.UNKNOWN_ERROR);
      expect(error.name).toBe('EmbeddingError');
    });

    it('should create error with custom code', () => {
      const error = new EmbeddingError('DB failed', ERROR_CODES.DB_CONNECTION_FAILED);

      expect(error.code).toBe(ERROR_CODES.DB_CONNECTION_FAILED);
    });

    it('should store original error', () => {
      const original = new Error('Original error');
      const error = new EmbeddingError('Wrapped error', ERROR_CODES.UNKNOWN_ERROR, original);

      expect(error.originalError).toBe(original);
    });

    it('should store context', () => {
      const context = { file: 'test.js', line: 42 };
      const error = new EmbeddingError('Error', ERROR_CODES.UNKNOWN_ERROR, null, context);

      expect(error.context).toEqual(context);
    });

    it('should have timestamp', () => {
      const error = new EmbeddingError('Error');

      expect(error.timestamp).toBeDefined();
      expect(typeof error.timestamp).toBe('string');
    });

    describe('toJSON', () => {
      it('should convert error to JSON', () => {
        const error = new EmbeddingError('Test', ERROR_CODES.DB_QUERY_FAILED, null, { key: 'value' });
        const json = error.toJSON();

        expect(json.name).toBe('EmbeddingError');
        expect(json.message).toBe('Test');
        expect(json.code).toBe(ERROR_CODES.DB_QUERY_FAILED);
        expect(json.context).toEqual({ key: 'value' });
        expect(json.originalError).toBeNull();
      });

      it('should include original error in JSON', () => {
        const original = new Error('Original');
        const error = new EmbeddingError('Wrapped', ERROR_CODES.UNKNOWN_ERROR, original);
        const json = error.toJSON();

        expect(json.originalError).not.toBeNull();
        expect(json.originalError.message).toBe('Original');
      });
    });

    describe('is', () => {
      it('should return true for matching code', () => {
        const error = new EmbeddingError('Error', ERROR_CODES.FILE_NOT_FOUND);

        expect(error.is(ERROR_CODES.FILE_NOT_FOUND)).toBe(true);
      });

      it('should return false for non-matching code', () => {
        const error = new EmbeddingError('Error', ERROR_CODES.FILE_NOT_FOUND);

        expect(error.is(ERROR_CODES.DB_QUERY_FAILED)).toBe(false);
      });
    });

    describe('isRetryable', () => {
      it('should return true for network error', () => {
        const error = new EmbeddingError('Network failed', ERROR_CODES.NETWORK_ERROR);

        expect(error.isRetryable()).toBe(true);
      });

      it('should return true for service unavailable', () => {
        const error = new EmbeddingError('Service down', ERROR_CODES.SERVICE_UNAVAILABLE);

        expect(error.isRetryable()).toBe(true);
      });

      it('should return true for timeout errors', () => {
        const embedTimeout = new EmbeddingError('Timeout', ERROR_CODES.EMBEDDING_TIMEOUT);
        const searchTimeout = new EmbeddingError('Timeout', ERROR_CODES.SEARCH_TIMEOUT);

        expect(embedTimeout.isRetryable()).toBe(true);
        expect(searchTimeout.isRetryable()).toBe(true);
      });

      it('should return true for connection failures', () => {
        const error = new EmbeddingError('DB failed', ERROR_CODES.DB_CONNECTION_FAILED);

        expect(error.isRetryable()).toBe(true);
      });

      it('should return true for cache errors', () => {
        const writeError = new EmbeddingError('Cache write', ERROR_CODES.CACHE_WRITE_FAILED);
        const readError = new EmbeddingError('Cache read', ERROR_CODES.CACHE_READ_FAILED);

        expect(writeError.isRetryable()).toBe(true);
        expect(readError.isRetryable()).toBe(true);
      });

      it('should return false for non-retryable errors', () => {
        const error = new EmbeddingError('Invalid input', ERROR_CODES.EMBEDDING_INVALID_INPUT);

        expect(error.isRetryable()).toBe(false);
      });
    });
  });

  describe('ValidationError', () => {
    it('should create validation error', () => {
      const error = new ValidationError('Invalid input');

      expect(error.name).toBe('ValidationError');
      expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(error.message).toBe('Invalid input');
    });

    it('should inherit from EmbeddingError', () => {
      const error = new ValidationError('Test');

      expect(error).toBeInstanceOf(EmbeddingError);
    });

    it('should support original error and context', () => {
      const original = new Error('Original');
      const context = { field: 'email' };
      const error = new ValidationError('Invalid email', original, context);

      expect(error.originalError).toBe(original);
      expect(error.context).toEqual(context);
    });
  });

  describe('error factory functions', () => {
    describe('createModelInitializationError', () => {
      it('should create model initialization error', () => {
        const error = createModelInitializationError('Model failed');

        expect(error.code).toBe(ERROR_CODES.MODEL_INITIALIZATION_FAILED);
        expect(error.message).toBe('Model failed');
      });

      it('should include original error', () => {
        const original = new Error('Original');
        const error = createModelInitializationError('Failed', original);

        expect(error.originalError).toBe(original);
      });
    });

    describe('createDatabaseError', () => {
      it('should create database error', () => {
        const error = createDatabaseError('Query failed');

        expect(error.code).toBe(ERROR_CODES.DB_QUERY_FAILED);
        expect(error.message).toBe('Query failed');
      });
    });

    describe('createEmbeddingGenerationError', () => {
      it('should create embedding generation error', () => {
        const error = createEmbeddingGenerationError('Generation failed');

        expect(error.code).toBe(ERROR_CODES.EMBEDDING_GENERATION_FAILED);
        expect(error.message).toBe('Generation failed');
      });
    });

    describe('createFileProcessingError', () => {
      it('should create file processing error', () => {
        const error = createFileProcessingError('File processing failed');

        expect(error.code).toBe(ERROR_CODES.FILE_PROCESSING_FAILED);
        expect(error.message).toBe('File processing failed');
      });
    });
  });

  describe('ERROR_CODES', () => {
    it('should have model error codes', () => {
      expect(ERROR_CODES.MODEL_INITIALIZATION_FAILED).toBeDefined();
      expect(ERROR_CODES.MODEL_NOT_INITIALIZED).toBeDefined();
      expect(ERROR_CODES.MODEL_LOADING_FAILED).toBeDefined();
    });

    it('should have database error codes', () => {
      expect(ERROR_CODES.DB_CONNECTION_FAILED).toBeDefined();
      expect(ERROR_CODES.DB_QUERY_FAILED).toBeDefined();
      expect(ERROR_CODES.DB_INSERTION_FAILED).toBeDefined();
    });

    it('should have embedding error codes', () => {
      expect(ERROR_CODES.EMBEDDING_GENERATION_FAILED).toBeDefined();
      expect(ERROR_CODES.EMBEDDING_DIMENSION_MISMATCH).toBeDefined();
      expect(ERROR_CODES.EMBEDDING_INVALID_INPUT).toBeDefined();
    });

    it('should have file error codes', () => {
      expect(ERROR_CODES.FILE_NOT_FOUND).toBeDefined();
      expect(ERROR_CODES.FILE_READ_FAILED).toBeDefined();
      expect(ERROR_CODES.FILE_TOO_LARGE).toBeDefined();
    });
  });
});
