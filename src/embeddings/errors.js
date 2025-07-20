/**
 * Embeddings Error Handling
 *
 * This module provides standardized error handling for the embeddings system.
 * It includes custom error classes and error codes for different failure scenarios.
 */

/**
 * Error codes for different embedding failure scenarios
 */
export const ERROR_CODES = {
  // Model initialization errors
  MODEL_INITIALIZATION_FAILED: 'MODEL_INITIALIZATION_FAILED',
  MODEL_NOT_INITIALIZED: 'MODEL_NOT_INITIALIZED',
  MODEL_LOADING_FAILED: 'MODEL_LOADING_FAILED',

  // Database errors
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  DB_QUERY_FAILED: 'DB_QUERY_FAILED',
  DB_INSERTION_FAILED: 'DB_INSERTION_FAILED',
  DB_TABLE_CREATION_FAILED: 'DB_TABLE_CREATION_FAILED',
  DB_SCHEMA_VALIDATION_FAILED: 'DB_SCHEMA_VALIDATION_FAILED',

  // Embedding generation errors
  EMBEDDING_GENERATION_FAILED: 'EMBEDDING_GENERATION_FAILED',
  EMBEDDING_DIMENSION_MISMATCH: 'EMBEDDING_DIMENSION_MISMATCH',
  EMBEDDING_INVALID_INPUT: 'EMBEDDING_INVALID_INPUT',
  EMBEDDING_TIMEOUT: 'EMBEDDING_TIMEOUT',

  // File processing errors
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_READ_FAILED: 'FILE_READ_FAILED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_INVALID_FORMAT: 'FILE_INVALID_FORMAT',
  FILE_PROCESSING_FAILED: 'FILE_PROCESSING_FAILED',

  // Search and similarity errors
  SEARCH_FAILED: 'SEARCH_FAILED',
  SIMILARITY_CALCULATION_FAILED: 'SIMILARITY_CALCULATION_FAILED',
  INVALID_SEARCH_QUERY: 'INVALID_SEARCH_QUERY',
  SEARCH_TIMEOUT: 'SEARCH_TIMEOUT',

  // Cache errors
  CACHE_WRITE_FAILED: 'CACHE_WRITE_FAILED',
  CACHE_READ_FAILED: 'CACHE_READ_FAILED',
  CACHE_INVALIDATION_FAILED: 'CACHE_INVALIDATION_FAILED',

  // Configuration errors
  CONFIG_VALIDATION_FAILED: 'CONFIG_VALIDATION_FAILED',
  CONFIG_MISSING_REQUIRED: 'CONFIG_MISSING_REQUIRED',
  CONFIG_INVALID_VALUE: 'CONFIG_INVALID_VALUE',

  // Network and external service errors
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  API_RATE_LIMITED: 'API_RATE_LIMITED',

  // Generic errors
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  MEMORY_ERROR: 'MEMORY_ERROR',
};

/**
 * Custom error class for embeddings-related errors
 */
export class EmbeddingError extends Error {
  /**
   * Create a new EmbeddingError
   *
   * @param {string} message - Error message
   * @param {string} code - Error code from ERROR_CODES
   * @param {Error} [originalError] - Original error that caused this error
   * @param {Object} [context] - Additional context information
   */
  constructor(message, code = ERROR_CODES.UNKNOWN_ERROR, originalError = null, context = {}) {
    super(message);

    this.name = 'EmbeddingError';
    this.code = code;
    this.originalError = originalError;
    this.context = context;
    this.timestamp = new Date().toISOString();

    // Maintain proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, EmbeddingError);
    }
  }

  /**
   * Convert error to JSON for logging
   *
   * @returns {Object} JSON representation of the error
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      timestamp: this.timestamp,
      context: this.context,
      stack: this.stack,
      originalError: this.originalError
        ? {
            name: this.originalError.name,
            message: this.originalError.message,
            stack: this.originalError.stack,
          }
        : null,
    };
  }

  /**
   * Check if this error is of a specific type
   *
   * @param {string} code - Error code to check
   * @returns {boolean} True if the error matches the code
   */
  is(code) {
    return this.code === code;
  }

  /**
   * Check if this error is retryable
   *
   * @returns {boolean} True if the error is retryable
   */
  isRetryable() {
    const retryableCodes = [
      ERROR_CODES.NETWORK_ERROR,
      ERROR_CODES.SERVICE_UNAVAILABLE,
      ERROR_CODES.EMBEDDING_TIMEOUT,
      ERROR_CODES.SEARCH_TIMEOUT,
      ERROR_CODES.DB_CONNECTION_FAILED,
      ERROR_CODES.CACHE_WRITE_FAILED,
      ERROR_CODES.CACHE_READ_FAILED,
    ];

    return retryableCodes.includes(this.code);
  }
}

/**
 * Custom error class for validation errors
 */
export class ValidationError extends EmbeddingError {
  /**
   * Create a new ValidationError
   *
   * @param {string} message - Error message
   * @param {Error} [originalError] - Original error that caused this error
   * @param {Object} [context] - Additional context information
   */
  constructor(message, originalError = null, context = {}) {
    super(message, ERROR_CODES.VALIDATION_ERROR, originalError, context);
    this.name = 'ValidationError';
  }
}

/**
 * Create a specific error for model initialization failures
 *
 * @param {string} message - Error message
 * @param {Error} [originalError] - Original error
 * @param {Object} [context] - Additional context
 * @returns {EmbeddingError} New EmbeddingError instance
 */
export function createModelInitializationError(message, originalError = null, context = {}) {
  return new EmbeddingError(message, ERROR_CODES.MODEL_INITIALIZATION_FAILED, originalError, context);
}

/**
 * Create a specific error for database failures
 *
 * @param {string} message - Error message
 * @param {Error} [originalError] - Original error
 * @param {Object} [context] - Additional context
 * @returns {EmbeddingError} New EmbeddingError instance
 */
export function createDatabaseError(message, originalError = null, context = {}) {
  return new EmbeddingError(message, ERROR_CODES.DB_QUERY_FAILED, originalError, context);
}

/**
 * Create a specific error for embedding generation failures
 *
 * @param {string} message - Error message
 * @param {Error} [originalError] - Original error
 * @param {Object} [context] - Additional context
 * @returns {EmbeddingError} New EmbeddingError instance
 */
export function createEmbeddingGenerationError(message, originalError = null, context = {}) {
  return new EmbeddingError(message, ERROR_CODES.EMBEDDING_GENERATION_FAILED, originalError, context);
}

/**
 * Create a specific error for file processing failures
 *
 * @param {string} message - Error message
 * @param {Error} [originalError] - Original error
 * @param {Object} [context] - Additional context
 * @returns {EmbeddingError} New EmbeddingError instance
 */
export function createFileProcessingError(message, originalError = null, context = {}) {
  return new EmbeddingError(message, ERROR_CODES.FILE_PROCESSING_FAILED, originalError, context);
}
