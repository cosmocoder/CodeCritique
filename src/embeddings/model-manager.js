/**
 * Model Manager Module
 *
 * This module provides centralized embedding model management using FastEmbed.
 * It handles model initialization, caching, and all embedding generation operations.
 *
 * Features:
 * - Singleton model instance management
 * - Thread-safe model initialization
 * - Embedding generation with caching
 * - Batch embedding processing
 * - Query-specific embedding generation
 * - Comprehensive error handling
 */
/**
 * @typedef {import('./types.js').EmbeddingVector} EmbeddingVector
 * @typedef {import('./types.js').QueryEmbeddingOptions} QueryEmbeddingOptions
 * @typedef {import('./types.js').BatchProcessingOptions} BatchProcessingOptions
 */

import fs from 'node:fs';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { debug } from '../utils.js';
import { EMBEDDING_DIMENSIONS, MODEL_NAME_STRING, MAX_RETRIES } from './constants.js';
import { FASTEMBED_CACHE_DIR } from './constants.js';
import { createModelInitializationError, createEmbeddingGenerationError } from './errors.js';

// Load environment variables
dotenv.config();

// ============================================================================
// MODEL MANAGER CLASS
// ============================================================================

export class ModelManager {
  constructor(options = {}) {
    this.embeddingDimensions = options.embeddingDimensions || EMBEDDING_DIMENSIONS;
    this.modelNameString = options.modelNameString || MODEL_NAME_STRING;
    this.maxRetries = options.maxRetries || MAX_RETRIES;
    this.cacheDir = options.cacheDir || FASTEMBED_CACHE_DIR;
    this.cacheManager = options.cacheManager || null;

    // Model state
    this.embeddingModel = null;
    this.modelInitialized = false;
    this.modelInitializationPromise = null;
    this.cleaningUp = false;

    console.log(chalk.magenta(`[ModelManager] Using MODEL = ${this.modelNameString}, DIMENSIONS = ${this.embeddingDimensions}`));
  }

  // ============================================================================
  // MODEL INITIALIZATION
  // ============================================================================

  /**
   * Initialize the FastEmbed model instance
   * @returns {Promise<import('fastembed').FlagEmbedding>} Initialized model instance
   */
  async initialize() {
    // If model is already initialized, return it immediately
    if (this.embeddingModel) {
      return this.embeddingModel;
    }

    // If initialization is already in progress, wait for it
    if (this.modelInitializationPromise) {
      return await this.modelInitializationPromise;
    }

    // Start initialization and store the promise
    this.modelInitializationPromise = (async () => {
      const modelIdentifier = EmbeddingModel.BGESmallENV15;

      // Only print logs if we haven't initialized before
      if (!this.modelInitialized) {
        console.log(chalk.blue(`Attempting to initialize fastembed model. Identifier: ${this.modelNameString}`));
        console.log(chalk.blue(`FastEmbed Cache Directory: ${this.cacheDir}`));
      }

      try {
        if (!fs.existsSync(this.cacheDir)) {
          console.log(chalk.yellow(`Creating fastembed cache directory: ${this.cacheDir}`));
          fs.mkdirSync(this.cacheDir, { recursive: true });
        }

        let retries = 0;
        while (retries < this.maxRetries) {
          try {
            this.embeddingModel = await FlagEmbedding.init({
              model: modelIdentifier,
              cacheDir: this.cacheDir,
            });

            // Only print success message if we haven't initialized before
            if (!this.modelInitialized) {
              console.log(chalk.green('FastEmbed model initialized successfully.'));
              this.modelInitialized = true;
            }
            break; // Exit loop on success
          } catch (initError) {
            retries++;
            console.error(chalk.yellow(`Model initialization attempt ${retries}/${this.maxRetries} failed: ${initError.message}`));
            if (retries >= this.maxRetries) {
              throw createModelInitializationError(
                `Failed to initialize model after ${this.maxRetries} attempts: ${initError.message}`,
                initError,
                { modelIdentifier, cacheDir: this.cacheDir }
              );
            }
            await new Promise((resolve) => setTimeout(resolve, retries * 2000)); // Wait before retrying
          }
        }

        // Clear the initialization promise since we're done
        this.modelInitializationPromise = null;
        return this.embeddingModel;
      } catch (err) {
        // Clear the initialization promise on error
        this.modelInitializationPromise = null;
        console.error(chalk.red(`Fatal: Failed to initialize fastembed model: ${err.message}`), err);
        throw err; // Re-throw critical error
      }
    })();

    return await this.modelInitializationPromise;
  }

  /**
   * Check if the model is initialized
   * @returns {boolean} True if model is initialized
   */
  isInitialized() {
    return this.modelInitialized && this.embeddingModel !== null;
  }

  // ============================================================================
  // EMBEDDING GENERATION
  // ============================================================================

  /**
   * Calculate embedding for a text using fastembed
   * @param {string} text - The text to embed
   * @returns {Promise<EmbeddingVector|null>} The embedding vector or null on error
   */
  async calculateEmbedding(text) {
    // Ensure text is a non-empty string
    if (typeof text !== 'string' || text.trim().length === 0) {
      return null; // Return null for empty text to avoid errors downstream
    }

    // Check cache first
    const cacheKey = text.trim().substring(0, 200); // Use first 200 chars as cache key
    if (this.cacheManager) {
      const cachedResult = this.cacheManager.getEmbedding(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }
    }

    try {
      const model = await this.initialize();
      let embedding = null; // Initialize embedding as null

      // Use passageEmbed which is suitable for sentences/paragraphs/code snippets
      const embeddingGenerator = model.passageEmbed([text]);
      // FastEmbed's async generator yields batches, even for single input
      for await (const batch of embeddingGenerator) {
        if (batch && batch.length > 0 && batch[0]) {
          embedding = Array.from(batch[0]); // Convert Float32Array to regular array
          break; // Got the embedding for the single input text
        }
      }

      // Validate the generated embedding
      if (!embedding || !Array.isArray(embedding) || embedding.length !== this.embeddingDimensions) {
        console.error(
          chalk.red(
            `Generated embedding dimension (${embedding?.length}) does not match expected (${this.embeddingDimensions}) or embedding is invalid.`
          )
        );
        return null; // Return null if dimensions mismatch or invalid
      }

      // Cache the result
      if (this.cacheManager) {
        this.cacheManager.setEmbedding(cacheKey, embedding);
      }

      return embedding;
    } catch (error) {
      console.error(chalk.red(`Error calculating embedding: ${error.message}`), error);
      throw createEmbeddingGenerationError(`Failed to calculate embedding: ${error.message}`, error, { text: text.substring(0, 100) });
    }
  }

  /**
   * Calculate embeddings for a batch of texts using fastembed
   * @param {string[]} texts - An array of texts to embed
   * @param {BatchProcessingOptions} [options] - Batch processing options
   * @returns {Promise<Array<EmbeddingVector|null>>} A promise that resolves to an array of embedding vectors
   */
  async calculateEmbeddingBatch(texts) {
    // Ensure texts is a non-empty array of non-empty strings
    if (!Array.isArray(texts) || texts.length === 0 || texts.some((text) => typeof text !== 'string' || text.trim().length === 0)) {
      debug('Skipping batch embedding for empty or invalid texts array.');
      // Return an array of nulls corresponding to the input, or an empty array if appropriate
      return texts.map(() => null);
    }

    try {
      const model = await this.initialize();
      const embeddings = [];

      // passageEmbed is an async generator of batches
      for await (const batch of model.passageEmbed(texts)) {
        for (const vec of batch) {
          // Validate each generated embedding
          if (vec && typeof vec.length === 'number' && vec.length === this.embeddingDimensions) {
            embeddings.push(Array.from(vec)); // Convert Float32Array (or other array-like) to regular array
          } else {
            console.error(
              chalk.red(
                `Generated batch embedding dimension (${vec?.length}) does not match expected (${this.embeddingDimensions}) or embedding is invalid.`
              )
            );
            embeddings.push(null); // Add null for invalid embeddings in the batch
          }
        }
      }

      // Ensure the number of embeddings matches the number of input texts
      if (embeddings.length !== texts.length) {
        console.error(
          chalk.red(`Number of generated embeddings (${embeddings.length}) does not match number of input texts (${texts.length}).`)
        );
        // This case should ideally be handled by ensuring one embedding (or null) per input text.
        // For now, if there's a mismatch, it might indicate a deeper issue.
        // We'll return what we have, but this could lead to misaligned data.
      }

      debug(`Batch embeddings generated successfully, count: ${embeddings.filter((e) => e !== null).length}`);
      return embeddings;
    } catch (error) {
      console.error(chalk.red(`Error calculating batch embeddings: ${error.message}`), error);
      throw createEmbeddingGenerationError(`Failed to calculate batch embeddings: ${error.message}`, error, { textsCount: texts.length });
    }
  }

  /**
   * Calculate embedding for a query text using fastembed
   * @param {string} text - The query text to embed
   * @param {QueryEmbeddingOptions} [options] - Query embedding options
   * @returns {Promise<EmbeddingVector|null>} The embedding vector or null on error
   */
  async calculateQueryEmbedding(text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return null;
    }

    // Check cache first (use 'query:' prefix to distinguish from passage embeddings)
    const cacheKey = `query:${text.trim().substring(0, 200)}`;
    if (this.cacheManager) {
      const cachedResult = this.cacheManager.getEmbedding(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }
    }

    try {
      const model = await this.initialize();
      // queryEmbed directly returns the embedding for the single query text
      const embeddingArray = await model.queryEmbed(text);

      // Validate the generated query embedding
      if (embeddingArray && typeof embeddingArray.length === 'number' && embeddingArray.length === this.embeddingDimensions) {
        // queryEmbed in fastembed-js v0.2.0+ might return number[] directly or Float32Array
        // Array.from() handles both cases correctly, converting Float32Array to number[] or returning number[] as is.
        const embedding = Array.from(embeddingArray);

        // Cache the result
        if (this.cacheManager) {
          this.cacheManager.setEmbedding(cacheKey, embedding);
        }

        return embedding;
      } else {
        console.error(
          chalk.red(
            `Generated query embedding dimension (${embeddingArray?.length}) does not match expected (${this.embeddingDimensions}) or embedding is invalid.`
          )
        );
        return null;
      }
    } catch (error) {
      console.error(chalk.red(`Error calculating query embedding: ${error.message}`), error);
      throw createEmbeddingGenerationError(`Failed to calculate query embedding: ${error.message}`, error, {
        text: text.substring(0, 100),
      });
    }
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Clean up model resources
   */
  async cleanup() {
    if (this.cleaningUp) {
      return; // Already cleaning up, prevent duplicate calls
    }

    this.cleaningUp = true;

    try {
      // FastEmbed models don't have an explicit cleanup method
      // but we can clear our references
      this.embeddingModel = null;
      this.modelInitialized = false;
      this.modelInitializationPromise = null;

      if (this.cacheManager) {
        this.cacheManager.clearCache('embedding');
      }

      console.log(chalk.green('[ModelManager] Model resources cleaned up.'));
    } catch (error) {
      console.error(chalk.red(`[ModelManager] Error during cleanup: ${error.message}`));
    } finally {
      this.cleaningUp = false;
    }
  }
}
