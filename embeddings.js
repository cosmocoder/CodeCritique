/**
 * Embeddings Module using fastembed-js
 *
 * This module provides functionality to generate and use embeddings
 * using fastembed-js and LanceDB for storage.
 *
 * Organization:
 * - Configuration & Constants
 * - Internal Helper Functions
 * - Database Management Functions
 * - Embedding Generation Functions
 * - Search & Similarity Functions
 * - Batch Processing Functions
 * - Cache & Cleanup Functions
 * - Public API Functions
 */

import * as lancedb from '@lancedb/lancedb';
import { createHash } from 'node:crypto';
import {
  debug,
  detectLanguageFromExtension,
  extractMarkdownChunks,
  inferContextFromDocumentContent,
  isDocumentationFile,
  slugify,
  shouldProcessFile as utilsShouldProcessFile,
} from './utils.js';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

// Load environment variables from .env file in current working directory
dotenv.config();

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

// FastEmbed Configuration
const EMBEDDING_DIMENSIONS = 384; // Dimension for bge-small-en-v1.5
const MODEL_NAME_STRING = 'bge-small-en-v1.5';
console.log(chalk.magenta(`[embeddings.js] Using MODEL = ${MODEL_NAME_STRING}, DIMENSIONS = ${EMBEDDING_DIMENSIONS}`));

// System Constants
const MAX_RETRIES = 3;

// Database Paths
const LANCEDB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || __dirname, '.ai-review-lancedb');
const FILE_EMBEDDINGS_TABLE = 'file_embeddings';
const DOCUMENT_CHUNK_TABLE = 'document_chunk_embeddings';
const PR_COMMENTS_TABLE = 'pr_comments'; // Add PR comments table

// FastEmbed Cache Directory
const FASTEMBED_CACHE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || __dirname, '.ai-review-fastembed-cache');

// ============================================================================
// STATE & CACHES
// ============================================================================

const processedFiles = new Map();
let dbConnection = null;
let embeddingModel = null; // Cache for fastembed model instance
let modelInitialized = false; // Flag to track if model has been initialized
let modelInitializationPromise = null; // Promise to prevent concurrent initialization
let projectEmbeddingsCache = null;
let tablesInitialized = false; // NEW: Track if tables have been initialized
let tableInitializationPromise = null; // Promise to prevent concurrent table initialization

// Cache for document contexts to avoid re-inferring for multiple chunks from the same doc
const documentContextCache = new Map();
// Cache for H1 embeddings to avoid re-calculating for H1 relevance bonus
const h1EmbeddingCache = new Map();
// Cache for embedding results to avoid redundant calculations
const embeddingCache = new Map();
const MAX_EMBEDDING_CACHE_SIZE = 1000;

// Progress Tracker
const progressTracker = {
  totalFiles: 0,
  processedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  startTime: 0,
  reset(total) {
    this.totalFiles = total;
    this.processedCount = 0;
    this.skippedCount = 0;
    this.failedCount = 0;
    this.startTime = Date.now();
  },
  update(type) {
    if (type === 'processed') this.processedCount++;
    if (type === 'skipped') this.skippedCount++;
    if (type === 'failed') this.failedCount++;
    // Progress logging is now handled by the spinner in index.js via onProgress callback
  },
};

// ============================================================================
// INTERNAL HELPER FUNCTIONS
// ============================================================================

/**
 * Check if content has extensive comments
 * @private
 */
function hasExtensiveComments(content) {
  if (!content || typeof content !== 'string') {
    return false;
  }

  // Calculate approximate comment density
  const contentLength = content.length;
  if (contentLength === 0) return false;

  let commentLines = 0;
  let codeLines = 0;

  // Count lines that appear to be comments
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === '') continue;

    // Check for common comment patterns across many languages
    if (
      // C-style comments
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      // Script-style comments
      trimmed.startsWith('#') ||
      // HTML/XML comments
      trimmed.startsWith('<!--') ||
      // Python doc comments
      trimmed.startsWith('"""') ||
      trimmed.startsWith("'''") ||
      // JavaDoc style
      trimmed.startsWith('///') ||
      trimmed.startsWith('//!') ||
      // Lisp/Clojure style
      trimmed.startsWith(';;') ||
      // Haskell style
      trimmed.startsWith('--') ||
      // Documentation-specific formats
      trimmed.startsWith('@param') ||
      trimmed.startsWith('@return') ||
      trimmed.startsWith('@example') ||
      // Plain English with minimal symbols likely indicates comments/docs
      (line.length > 30 && !/[;{}=()<>[\]]/.test(line) && /^[A-Z]/.test(trimmed))
    ) {
      commentLines++;
    } else {
      codeLines++;
    }
  }

  // More flexible criteria - recognize even modest commenting
  const totalLines = commentLines + codeLines;

  // Low threshold for small snippets, higher for larger ones
  if (totalLines < 10) {
    return commentLines >= 2; // For very small snippets, even a couple of comments is good
  } else if (totalLines < 30) {
    return commentLines >= 3; // For medium-sized snippets
  } else {
    // For larger files, use a percentage but with a reasonable minimum
    return commentLines >= 5 && commentLines / totalLines >= 0.15; // At least 15% comments
  }
}

/**
 * Check if two languages are similar
 * @private
 */
function isSimilarLanguage(lang1, lang2) {
  if (!lang1 || !lang2) return false;

  // Normalize languages
  lang1 = lang1.toLowerCase();
  lang2 = lang2.toLowerCase();

  // Don't penalize unknown languages
  if (lang1 === 'unknown' || lang2 === 'unknown') return true;

  // Define groups of similar languages
  const languageGroups = [
    // JavaScript ecosystem
    ['javascript', 'typescript', 'jsx', 'tsx'],
    // Web technologies
    ['html', 'css', 'scss', 'less', 'sass'],
    // JVM languages
    ['java', 'kotlin', 'scala', 'groovy'],
    // .NET languages
    ['csharp', 'fsharp', 'vb'],
    // C-like languages
    ['c', 'cpp', 'c++', 'cxx', 'h', 'hpp'],
    // Shell scripting
    ['bash', 'sh', 'zsh', 'shell'],
    // Python-like
    ['python', 'jupyter'],
  ];

  // Check if languages are in the same group
  return languageGroups.some((group) => group.includes(lang1) && group.includes(lang2));
}

// ============================================================================
// EMBEDDING MODEL MANAGEMENT
// ============================================================================

/**
 * Initialize the FastEmbed model instance
 * @private
 * @returns {Promise<FlagEmbedding>}
 */
async function initEmbeddingModel() {
  // If model is already initialized, return it immediately
  if (embeddingModel) {
    return embeddingModel;
  }

  // If initialization is already in progress, wait for it
  if (modelInitializationPromise) {
    return await modelInitializationPromise;
  }

  // Start initialization and store the promise
  modelInitializationPromise = (async () => {
    const modelIdentifier = EmbeddingModel.BGESmallENV15;

    // Only print logs if we haven't initialized before
    if (!modelInitialized) {
      console.log(chalk.blue(`Attempting to initialize fastembed model. Identifier: ${MODEL_NAME_STRING}`));
      console.log(chalk.blue(`FastEmbed Cache Directory: ${FASTEMBED_CACHE_DIR}`));
    }

    try {
      if (!fs.existsSync(FASTEMBED_CACHE_DIR)) {
        console.log(chalk.yellow(`Creating fastembed cache directory: ${FASTEMBED_CACHE_DIR}`));
        fs.mkdirSync(FASTEMBED_CACHE_DIR, { recursive: true });
      }
      let retries = 0;
      while (retries < MAX_RETRIES) {
        try {
          embeddingModel = await FlagEmbedding.init({
            model: modelIdentifier,
            cacheDir: FASTEMBED_CACHE_DIR,
          });

          // Only print success message if we haven't initialized before
          if (!modelInitialized) {
            console.log(chalk.green('FastEmbed model initialized successfully.'));
            modelInitialized = true;
          }
          break; // Exit loop on success
        } catch (initError) {
          retries++;
          console.error(chalk.yellow(`Model initialization attempt ${retries}/${MAX_RETRIES} failed: ${initError.message}`));
          if (retries >= MAX_RETRIES) {
            throw new Error(`Failed to initialize model after ${MAX_RETRIES} attempts: ${initError.message}`);
          }
          await new Promise((resolve) => setTimeout(resolve, retries * 2000)); // Wait before retrying
        }
      }

      // Clear the initialization promise since we're done
      modelInitializationPromise = null;
      return embeddingModel;
    } catch (err) {
      // Clear the initialization promise on error
      modelInitializationPromise = null;
      console.error(chalk.red(`Fatal: Failed to initialize fastembed model: ${err.message}`), err);
      throw err; // Re-throw critical error
    }
  })();

  return await modelInitializationPromise;
}

// ============================================================================
// EMBEDDING GENERATION FUNCTIONS
// ============================================================================

/**
 * Calculate embedding for a text using fastembed
 * @param {string} text - The text to embed
 * @returns {Promise<Array<number> | null>} - The embedding vector or null on error
 */
export async function calculateEmbedding(text) {
  // Ensure text is a non-empty string
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null; // Return null for empty text to avoid errors downstream
  }

  // Check cache first
  const cacheKey = text.trim().substring(0, 200); // Use first 200 chars as cache key
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  try {
    const model = await initEmbeddingModel();
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
    if (!embedding || !Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      console.error(
        chalk.red(
          `Generated embedding dimension (${embedding?.length}) does not match expected (${EMBEDDING_DIMENSIONS}) or embedding is invalid.`
        )
      );
      return null; // Return null if dimensions mismatch or invalid
    }

    // Cache the result
    if (embeddingCache.size >= MAX_EMBEDDING_CACHE_SIZE) {
      // Remove oldest entry
      const firstKey = embeddingCache.keys().next().value;
      embeddingCache.delete(firstKey);
    }
    embeddingCache.set(cacheKey, embedding);

    // Only log in debug mode and less frequently
    if (embeddingCache.size % 10 === 0) {
      debug(`Embedding cache size: ${embeddingCache.size}, latest dimensions: ${embedding.length}`);
    }

    return embedding;
  } catch (error) {
    console.error(chalk.red(`Error calculating embedding: ${error.message}`), error);
    return null; // Return null on error
  }
}

/**
 * Calculate embeddings for a batch of texts using fastembed.
 * @param {string[]} texts - An array of texts to embed.
 * @returns {Promise<Array<Array<number>>>} - A promise that resolves to an array of embedding vectors.
 */
async function calculateEmbeddingBatch(texts) {
  // Ensure texts is a non-empty array of non-empty strings
  if (!Array.isArray(texts) || texts.length === 0 || texts.some((text) => typeof text !== 'string' || text.trim().length === 0)) {
    debug('Skipping batch embedding for empty or invalid texts array.');
    // Return an array of nulls corresponding to the input, or an empty array if appropriate
    return texts.map(() => null);
  }

  try {
    const model = await initEmbeddingModel();
    const embeddings = [];
    // passageEmbed is an async generator of batches
    for await (const batch of model.passageEmbed(texts)) {
      for (const vec of batch) {
        // Validate each generated embedding
        if (vec && typeof vec.length === 'number' && vec.length === EMBEDDING_DIMENSIONS) {
          embeddings.push(Array.from(vec)); // Convert Float32Array (or other array-like) to regular array
        } else {
          console.error(
            chalk.red(
              `Generated batch embedding dimension (${vec?.length}) does not match expected (${EMBEDDING_DIMENSIONS}) or embedding is invalid.`
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
    // Return an array of nulls in case of a catastrophic error during batch processing
    return texts.map(() => null);
  }
}

/**
 * Calculate embedding for a query text using fastembed.
 * @param {string} text - The query text to embed.
 * @returns {Promise<Array<number> | null>} - The embedding vector or null on error.
 */
export async function calculateQueryEmbedding(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  // Check cache first (use 'query:' prefix to distinguish from passage embeddings)
  const cacheKey = `query:${text.trim().substring(0, 200)}`;
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  try {
    const model = await initEmbeddingModel();
    // queryEmbed directly returns the embedding for the single query text
    const embeddingArray = await model.queryEmbed(text);

    // Validate the generated query embedding
    if (embeddingArray && typeof embeddingArray.length === 'number' && embeddingArray.length === EMBEDDING_DIMENSIONS) {
      // queryEmbed in fastembed-js v0.2.0+ might return number[] directly or Float32Array
      // Array.from() handles both cases correctly, converting Float32Array to number[] or returning number[] as is.
      const embedding = Array.from(embeddingArray);

      // Cache the result
      if (embeddingCache.size >= MAX_EMBEDDING_CACHE_SIZE) {
        // Remove oldest entry
        const firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
      }
      embeddingCache.set(cacheKey, embedding);

      // Only log in debug mode and less frequently
      if (embeddingCache.size % 10 === 0) {
        debug(`Query embedding cache size: ${embeddingCache.size}, latest dimensions: ${embedding.length}`);
      }

      return embedding;
    } else {
      console.error(
        chalk.red(
          `Generated query embedding dimension (${embeddingArray?.length}) does not match expected (${EMBEDDING_DIMENSIONS}) or embedding is invalid.`
        )
      );
      return null;
    }
  } catch (error) {
    console.error(chalk.red(`Error calculating query embedding: ${error.message}`), error);
    return null;
  }
}

// ============================================================================
// DATABASE MANAGEMENT FUNCTIONS (SEPARATED: INIT vs ACCESS)
// ============================================================================

/**
 * Get database connection without triggering table creation
 * @private
 * @returns {Promise<lancedb.Connection>} Database connection
 */
async function getDBConnection() {
  if (!dbConnection) {
    console.log(chalk.blue(`Initializing DB connection. Target Path: ${LANCEDB_PATH}`));
    if (!fs.existsSync(LANCEDB_PATH)) {
      fs.mkdirSync(LANCEDB_PATH, { recursive: true });
    }
    dbConnection = await lancedb.connect(LANCEDB_PATH);
    console.log(chalk.green('LanceDB connected.'));
  }
  return dbConnection;
}

/**
 * Initialize all database tables and indices (ONE-TIME SETUP)
 * This should be called once during application startup or before batch processing
 * @returns {Promise<void>}
 */
export async function initializeTables() {
  if (tablesInitialized) {
    return;
  }

  // If initialization is already in progress, wait for it to complete.
  if (tableInitializationPromise) {
    await tableInitializationPromise;
    return;
  }

  // Start initialization and store the promise.
  tableInitializationPromise = (async () => {
    try {
      console.log(chalk.blue('Initializing database tables and indices...'));
      const db = await getDBConnection();
      await ensureTablesExist(db);
      tablesInitialized = true;
      console.log(chalk.green('Database tables and indices initialized successfully.'));
    } catch (error) {
      tablesInitialized = false;
      console.error(chalk.red('Failed to initialize database tables:'), error);
      throw error; // Re-throw to propagate the error to callers
    } finally {
      // The initialization attempt is over, clear the promise
      tableInitializationPromise = null;
    }
  })();

  await tableInitializationPromise;
}

/**
 * Get database connection and ensure tables exist (LEGACY - for backward compatibility)
 * @private
 * @returns {Promise<lancedb.Connection>} Initialized database object
 */
async function initializeDB() {
  const db = await getDBConnection();
  // The logic to ensure tables exist is now centralized in getDB -> initializeTables
  return db;
}

/**
 * Get database connection (alias for initializeDB - LEGACY)
 * @private
 * @returns {Promise<lancedb.Connection>} Database connection
 */
async function getDB() {
  const db = await getDBConnection();
  if (!tablesInitialized) {
    await initializeTables();
  }
  return db;
}

/**
 * Get a specific table instance (LIGHTWEIGHT OPERATION)
 * @param {string} tableName - Name of the table
 * @returns {Promise<lancedb.Table | null>} Table object or null if not found/error
 */
async function getTableInstance(tableName) {
  try {
    const db = await getDBConnection();
    const tableNames = await db.tableNames();
    if (tableNames.includes(tableName)) {
      return await db.openTable(tableName);
    }
    console.warn(chalk.yellow(`Table ${tableName} does not exist. Call initializeTables() first.`));
    return null;
  } catch (error) {
    console.error(chalk.red(`Error opening table ${tableName}: ${error.message}`), error);
    return null;
  }
}

/**
 * Get file embeddings table
 * @returns {Promise<lancedb.Table | null>}
 */
async function getFileEmbeddingsTable() {
  return getTableInstance(FILE_EMBEDDINGS_TABLE);
}

/**
 * Get document chunk embeddings table
 * @returns {Promise<lancedb.Table | null>}
 */
async function getDocumentChunkTable() {
  return getTableInstance(DOCUMENT_CHUNK_TABLE);
}

/**
 * Get PR comments table
 * @returns {Promise<lancedb.Table | null>}
 */
async function getPRCommentsTableInstance() {
  return getTableInstance(PR_COMMENTS_TABLE);
}

/**
 * Adaptive indexing strategy for any project size
 * @private
 * @param {lancedb.Table} table - Table to index
 * @param {string} tableName - Name of the table for logging
 * @param {string} vectorField - Name of the vector field to index (default: 'vector')
 * @returns {Promise<object>} Index information
 */
async function createAdaptiveVectorIndexes(table, tableName, vectorField = 'vector') {
  try {
    const rowCount = await table.countRows();
    console.log(chalk.blue(`[${tableName}] Row count: ${rowCount}`));

    if (rowCount < 100) {
      console.log(chalk.blue(`[${tableName}] Skipping indexing for small dataset (${rowCount} rows). Using exact search.`));
      return { indexType: 'exact', rowCount };
    } else if (rowCount < 1000) {
      console.log(chalk.blue(`[${tableName}] Using exact search for small dataset (${rowCount} rows) - no index needed`));
      // For small datasets, exact search is often faster than any index
      // LanceDB doesn't have a flat() index method, so we skip indexing
      return { indexType: 'exact', rowCount };
    } else if (rowCount < 10000) {
      const numPartitions = Math.max(Math.floor(Math.sqrt(rowCount / 50)), 2);
      console.log(chalk.blue(`[${tableName}] Creating IVF-Flat index for medium dataset (${rowCount} rows, ${numPartitions} partitions)`));
      await table.createIndex(vectorField, {
        config: lancedb.Index.ivfFlat({ numPartitions }),
      });
      return { indexType: 'ivf_flat', rowCount, numPartitions };
    } else {
      const numPartitions = Math.max(Math.floor(Math.sqrt(rowCount / 100)), 8);
      const numSubVectors = Math.floor(EMBEDDING_DIMENSIONS / 4);
      console.log(chalk.blue(`[${tableName}] Creating IVF-PQ index for large dataset (${rowCount} rows, ${numPartitions} partitions)`));
      await table.createIndex(vectorField, {
        config: lancedb.Index.ivfPq({
          numPartitions,
          numSubVectors,
          numBits: 8,
        }),
      });
      return { indexType: 'ivf_pq', rowCount, numPartitions, numSubVectors };
    }
  } catch (error) {
    console.warn(chalk.yellow(`[${tableName}] Index creation failed: ${error.message}. Falling back to exact search.`));
    return { indexType: 'exact_fallback', error: error.message };
  }
}

/**
 * Create PR comments table schema
 * @private
 * @returns {Schema} Apache Arrow schema for PR comments
 */
function createPRCommentsSchema() {
  const vectorType = new FixedSizeList(EMBEDDING_DIMENSIONS, new Field('item', new Float32(), true));

  const fields = [
    new Field('id', new Utf8(), false),
    new Field('pr_number', new Int32(), false),
    new Field('repository', new Utf8(), false),
    new Field('project_path', new Utf8(), false),
    new Field('comment_type', new Utf8(), false),
    new Field('comment_text', new Utf8(), false),
    new Field('comment_embedding', vectorType, false),

    // Code context fields
    new Field('file_path', new Utf8(), true),
    new Field('line_number', new Int32(), true),
    new Field('line_range_start', new Int32(), true),
    new Field('line_range_end', new Int32(), true),
    new Field('original_code', new Utf8(), true),
    new Field('suggested_code', new Utf8(), true),
    new Field('diff_hunk', new Utf8(), true),

    // Code embedding
    new Field('code_embedding', vectorType, true),
    new Field('combined_embedding', vectorType, false),

    // Metadata
    new Field('author', new Utf8(), false),
    new Field('created_at', new Utf8(), false),
    new Field('updated_at', new Utf8(), true),
    new Field('review_id', new Utf8(), true),
    new Field('review_state', new Utf8(), true),

    // Analysis metadata
    new Field('issue_category', new Utf8(), true),
    new Field('severity', new Utf8(), true),
    new Field('pattern_tags', new Utf8(), true),
  ];

  return new Schema(fields);
}

/**
 * Ensure necessary tables exist with adaptive indexing
 * @private
 * @param {lancedb.Connection} db - Database connection
 * @returns {Promise<void>}
 */
async function ensureTablesExist(db) {
  try {
    const tableNames = await db.tableNames();
    const vectorType = new FixedSizeList(EMBEDDING_DIMENSIONS, new Field('item', new Float32(), true));

    // File embeddings table schema
    const fileFields = [
      new Field('id', new Utf8(), false),
      new Field('content', new Utf8(), false),
      new Field('type', new Utf8(), false),
      new Field('name', new Utf8(), false),
      new Field('path', new Utf8(), false),
      new Field('project_path', new Utf8(), false), // Add project path for proper isolation
      new Field('language', new Utf8(), true),
      new Field('content_hash', new Utf8(), false),
      new Field('last_modified', new Utf8(), false), // Add modification time field
      new Field('vector', vectorType, false),
    ];
    const fileSchema = new Schema(fileFields);

    // Document chunk table schema
    const documentChunkFields = [
      new Field('id', new Utf8(), false),
      new Field('content', new Utf8(), false),
      new Field('original_document_path', new Utf8(), false),
      new Field('project_path', new Utf8(), false), // Add project path for proper isolation
      new Field('heading_text', new Utf8(), true),
      new Field('document_title', new Utf8(), true),
      new Field('language', new Utf8(), true),
      new Field('vector', vectorType, false),
      new Field('content_hash', new Utf8(), false),
      new Field('last_modified', new Utf8(), false), // Add modification time field
    ];
    const documentChunkSchema = new Schema(documentChunkFields);

    // PR comments table schema
    const prCommentsSchema = createPRCommentsSchema();

    // Create or open tables
    let fileTable, documentChunkTable, prCommentsTable;

    if (!tableNames.includes(FILE_EMBEDDINGS_TABLE)) {
      console.log(chalk.yellow(`Creating ${FILE_EMBEDDINGS_TABLE} table with optimized schema...`));
      fileTable = await db.createEmptyTable(FILE_EMBEDDINGS_TABLE, fileSchema, { mode: 'create' });
      console.log(chalk.green(`Created ${FILE_EMBEDDINGS_TABLE} table.`));
    } else {
      fileTable = await db.openTable(FILE_EMBEDDINGS_TABLE);

      // Check if schema needs migration (missing project_path field)
      try {
        const currentFileSchema = await fileTable.schema;
        if (currentFileSchema && currentFileSchema.fields) {
          const hasProjectPath = currentFileSchema.fields.some((field) => field.name === 'project_path');

          if (!hasProjectPath) {
            console.log(chalk.yellow(`Table ${FILE_EMBEDDINGS_TABLE} has old schema without project_path. Migration needed.`));
            console.log(chalk.yellow(`Please clear embeddings and regenerate them to use the new schema with project isolation.`));
            // For now, we'll work with the existing schema
            // In the future, we could implement automatic migration
          }
        }
      } catch (schemaError) {
        debug(`Could not check schema for ${FILE_EMBEDDINGS_TABLE}: ${schemaError.message}`);
        // Continue without schema check
      }
    }

    if (!tableNames.includes(DOCUMENT_CHUNK_TABLE)) {
      console.log(chalk.yellow(`Creating ${DOCUMENT_CHUNK_TABLE} table with optimized schema...`));
      documentChunkTable = await db.createEmptyTable(DOCUMENT_CHUNK_TABLE, documentChunkSchema, { mode: 'create' });
      console.log(chalk.green(`Created ${DOCUMENT_CHUNK_TABLE} table.`));
    } else {
      documentChunkTable = await db.openTable(DOCUMENT_CHUNK_TABLE);

      // Check if schema needs migration (missing project_path field)
      try {
        const currentDocSchema = await documentChunkTable.schema;
        if (currentDocSchema && currentDocSchema.fields) {
          const hasProjectPath = currentDocSchema.fields.some((field) => field.name === 'project_path');

          if (!hasProjectPath) {
            console.log(chalk.yellow(`Table ${DOCUMENT_CHUNK_TABLE} has old schema without project_path. Migration needed.`));
            console.log(chalk.yellow(`Please clear embeddings and regenerate them to use the new schema with project isolation.`));
            // For now, we'll work with the existing schema
            // In the future, we could implement automatic migration
          }
        }
      } catch (schemaError) {
        debug(`Could not check schema for ${DOCUMENT_CHUNK_TABLE}: ${schemaError.message}`);
        // Continue without schema check
      }
    }

    // Create PR comments table
    if (!tableNames.includes(PR_COMMENTS_TABLE)) {
      console.log(chalk.yellow(`Creating ${PR_COMMENTS_TABLE} table with optimized schema...`));
      prCommentsTable = await db.createEmptyTable(PR_COMMENTS_TABLE, prCommentsSchema, { mode: 'create' });
      console.log(chalk.green(`Created ${PR_COMMENTS_TABLE} table.`));
    } else {
      prCommentsTable = await db.openTable(PR_COMMENTS_TABLE);
    }

    // Create FTS indexes
    console.log(chalk.blue('Creating native FTS indexes...'));

    for (const [table, tableName, contentField] of [
      [fileTable, FILE_EMBEDDINGS_TABLE, 'content'],
      [documentChunkTable, DOCUMENT_CHUNK_TABLE, 'content'],
      [prCommentsTable, PR_COMMENTS_TABLE, 'comment_text'],
    ]) {
      try {
        await table.createIndex(contentField, { config: lancedb.Index.fts() });
        console.log(chalk.green(`FTS index created for ${tableName}`));
      } catch (error) {
        if (!error.message.toLowerCase().includes('already exists')) {
          console.warn(chalk.yellow(`FTS index warning for ${tableName}: ${error.message}`));
        }
      }
    }

    // Create adaptive vector indexes
    console.log(chalk.blue('Creating adaptive vector indexes...'));

    const fileIndexInfo = await createAdaptiveVectorIndexes(fileTable, FILE_EMBEDDINGS_TABLE);
    const docIndexInfo = await createAdaptiveVectorIndexes(documentChunkTable, DOCUMENT_CHUNK_TABLE);
    const prCommentsIndexInfo = await createAdaptiveVectorIndexes(prCommentsTable, PR_COMMENTS_TABLE, 'combined_embedding');

    console.log(
      chalk.green(
        `Indexing complete - File: ${JSON.stringify(fileIndexInfo)}, Docs: ${JSON.stringify(docIndexInfo)}, PR Comments: ${JSON.stringify(prCommentsIndexInfo)}`
      )
    );
  } catch (error) {
    console.error(chalk.red(`Error ensuring tables exist: ${error.message}`), error.stack);
    throw error;
  }
}

/**
 * Open an existing table (lightweight operation)
 * @private
 * @param {string} tableName - Name of the table
 * @returns {Promise<lancedb.Table | null>} Table object or null if not found/error
 */
async function getTable(tableName) {
  try {
    const db = await getDBConnection();
    const tableNames = await db.tableNames();
    if (tableNames.includes(tableName)) {
      return await db.openTable(tableName);
    }
    // Don't warn here, let the calling function decide if it's an error
    return null;
  } catch (error) {
    console.error(chalk.red(`Error opening table ${tableName}: ${error.message}`), error);
    return null; // Return null on error
  }
}

// ============================================================================
// FILE & DIRECTORY PROCESSING FUNCTIONS
// ============================================================================

/**
 * Generate embeddings for a specific file using fastembed and store them in LanceDB
 * @param {string} filePath - Path to the file
 * @param {string} content - Content of the file
 * @param {string} baseDir - Base directory for relative path calculation
 * @returns {Promise<{path: string, success: boolean} | null>} Result or null on error
 */
async function generateFileEmbeddings(filePath, content, baseDir = process.cwd()) {
  // Ensure consistent path handling - use the same base directory as batch processing
  const absoluteFilePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseDir, filePath);
  const relativePath = path.relative(baseDir, absoluteFilePath);
  console.log(chalk.blue(`[generateFileEmbeddings] Starting for: ${relativePath}`)); // Log entry

  try {
    const truncatedContent = content; // No truncation - use full content for embeddings

    if (content.length > 50000) {
      console.log(chalk.blue(`[INFO] Processing large file ${relativePath} with ${content.length} characters (no truncation)`));
    }

    // *** 1. Calculate embedding explicitly ***
    const embedding = await calculateEmbedding(truncatedContent);

    if (!embedding) {
      console.error(chalk.red(`[generateFileEmbeddings] Failed to calculate embedding for: ${relativePath}. Skipping add.`));
      return null; // Indicate failure if embedding is null
    }
    debug(`[generateFileEmbeddings] Embedding calculated for ${relativePath}, length: ${embedding.length}`);

    const db = await getDB();
    const table = await getTable(FILE_EMBEDDINGS_TABLE);
    if (!table) {
      // This might happen if ensureTablesExist failed earlier
      console.error(chalk.red(`[generateFileEmbeddings] Table ${FILE_EMBEDDINGS_TABLE} not found!`));
      throw new Error(`Table ${FILE_EMBEDDINGS_TABLE} not found during embedding generation.`);
    }

    const contentHash = createHash('md5').update(truncatedContent).digest('hex').substring(0, 8);
    const fileId = `${relativePath}#${contentHash}`; // Use relative path in ID for consistency

    // Get file stats for modification time
    const stats = fs.statSync(absoluteFilePath);

    const record = {
      vector: embedding, // Include calculated embedding (should be Array<number>)
      id: fileId,
      content: truncatedContent,
      type: 'file',
      name: path.basename(absoluteFilePath),
      path: relativePath, // Store consistent relative path
      project_path: path.resolve(baseDir), // Add project path for proper isolation
      language: detectLanguageFromExtension(path.extname(absoluteFilePath)),
      content_hash: contentHash, // Add the missing content_hash field
      last_modified: stats.mtime.toISOString(), // Add modification time
    };

    debug(`[generateFileEmbeddings] Prepared record for ${relativePath}: ID=${record.id}, Vector length=${record.vector?.length}`);
    if (record.vector?.length !== EMBEDDING_DIMENSIONS) {
      console.error(chalk.red(`[generateFileEmbeddings] !!! Vector dimension mismatch before add for ${relativePath} !!!`));
      return null; // Don't add invalid record
    }

    // Delete existing before adding (keep existing logic)
    try {
      await table.delete(`id = '${fileId.replace(/'/g, "''")}'`);
    } catch (deleteError) {
      if (!deleteError.message.includes('Record not found') && !deleteError.message.includes('cannot find')) {
        debug(`[generateFileEmbeddings] Error deleting existing record for id ${fileId}: ${deleteError.message}`);
      } else {
        debug(`[generateFileEmbeddings] No existing record to delete for id ${fileId}`);
      }
    }

    // *** 2. Add record with specific try/catch ***
    debug(`[generateFileEmbeddings] Attempting table.add for: ${record.path}`);
    try {
      await table.add([record]);
      console.log(chalk.green(`[generateFileEmbeddings] Successfully added record for: ${record.path}`)); // Log success
      return { path: absoluteFilePath, success: true };
    } catch (addError) {
      console.error(
        chalk.red(`[generateFileEmbeddings] !!! Error during table.add for ${record.path}: ${addError.message}`),
        addError.stack
      );
      // Rethrow or return null depending on how processFileWithRetries handles it
      // Let's return null to indicate failure for this specific file
      return null;
    }
  } catch (error) {
    // Catch errors from getDB, getTable, calculateEmbedding etc.
    console.error(chalk.red(`[generateFileEmbeddings] Overall error for ${relativePath}: ${error.message}`), error.stack);
    return null; // Indicate failure
  }
}

/**
 * Generate directory structure string
 * @param {Object} options - Options for generating directory structure
 * @returns {string} Directory structure as a string
 */
const generateDirectoryStructure = (options = {}) => {
  const { rootDir = process.cwd(), maxDepth = 5, ignorePatterns = [], showFiles = true } = options;
  debug(`Generating directory structure: rootDir=${rootDir}, maxDepth=${maxDepth}, showFiles=${showFiles}`);
  // Use path.sep for platform compatibility
  const pathSep = path.sep;
  // More robust ignore pattern matching (handles directory separators)
  const shouldIgnore = (relPath) =>
    ignorePatterns.some((pattern) => {
      const normalizedPattern = pattern.replace(/\//g, pathSep); // Normalize pattern separators
      const normalizedPath = relPath.replace(/\//g, pathSep);
      if (normalizedPattern.startsWith(`**${pathSep}`)) {
        return normalizedPath.includes(normalizedPattern.slice(3));
      }
      return normalizedPath.includes(normalizedPattern);
    });

  const buildStructure = (dir, depth = 0, prefix = '') => {
    if (depth > maxDepth) return '';
    let result = '';
    try {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const entryPath = path.join(dir, entry.name);
        const relativePath = path.relative(rootDir, entryPath);
        // Skip if ignored
        if (shouldIgnore(relativePath) || entry.name === '.ai-review-lancedb' || entry.name === '.ai-review-fastembed-cache') continue; // Also ignore DB/cache dirs

        const connector = isLast ? '└── ' : '├── ';
        const nextPrefix = isLast ? prefix + '    ' : prefix + '│   ';
        if (entry.isDirectory()) {
          result += `${prefix}${connector}${entry.name}/\n`;
          result += buildStructure(entryPath, depth + 1, nextPrefix);
        } else if (showFiles) {
          result += `${prefix}${connector}${entry.name}\n`;
        }
      }
    } catch (error) {
      console.error(`Error reading directory ${dir}:`, error.message);
    }
    return result;
  };
  return buildStructure(rootDir);
};

/**
 * Generate and store an embedding for the project directory structure
 * @param {Object} options - Options for generating the directory structure
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
const generateDirectoryStructureEmbedding = async (options = {}) => {
  console.log(chalk.cyan('[generateDirEmb] Starting...')); // Log entry
  try {
    const db = await getDB();
    const table = await getTable(FILE_EMBEDDINGS_TABLE);
    if (!table) {
      throw new Error(`[generateDirEmb] Table ${FILE_EMBEDDINGS_TABLE} not found.`);
    }

    // Create project-specific structure ID based on the root directory
    const rootDir = options.rootDir || process.cwd();
    const projectName = path.basename(path.resolve(rootDir));
    const structureId = `__project_structure__${projectName}`;
    try {
      await table.delete(`id = '${structureId}'`);
      debug('[generateDirEmb] Deleted existing project structure embedding');
    } catch (error) {
      if (!error.message.includes('Record not found') && !error.message.includes('cannot find')) {
        debug(`[generateDirEmb] Error deleting existing project structure: ${error.message}`);
      } else {
        debug('[generateDirEmb] No existing project structure to delete.');
      }
    }

    const directoryStructure = generateDirectoryStructure(options);
    if (!directoryStructure) throw new Error('[generateDirEmb] Failed to generate directory structure string');
    debug('[generateDirEmb] Directory structure string generated.');

    // *** Calculate embedding explicitly ***
    const embedding = await calculateEmbedding(directoryStructure);

    if (!embedding) {
      console.error(chalk.red('[generateDirEmb] Failed to calculate embedding for directory structure.'));
      return false; // Indicate failure
    }
    debug(`[generateDirEmb] Embedding calculated, length: ${embedding.length}`);

    const record = {
      vector: embedding, // Include calculated embedding
      id: structureId,
      content: directoryStructure,
      type: 'directory-structure',
      name: `${projectName} Project Structure`,
      path: `${projectName} Project Structure`, // Project-specific path
      project_path: path.resolve(rootDir), // Add project path for consistency with new schema
      language: 'text',
      content_hash: createHash('md5').update(directoryStructure).digest('hex').substring(0, 8),
      last_modified: new Date().toISOString(), // Use current timestamp for directory structure
    };

    debug(`[generateDirEmb] Prepared record: ID=${record.id}, Vector length=${record.vector?.length}`);
    if (record.vector?.length !== EMBEDDING_DIMENSIONS) {
      console.error(chalk.red(`[generateDirEmb] !!! Vector dimension mismatch before add !!!`));
      return false; // Don't add invalid record
    }

    // *** Add record with specific try/catch ***
    debug('[generateDirEmb] Attempting table.add...');
    try {
      await table.add([record]);
      console.log(chalk.green('[generateDirEmb] Successfully added directory structure embedding.'));
      return true; // Indicate success
    } catch (addError) {
      console.error(chalk.red(`[generateDirEmb] !!! Error during table.add: ${addError.message}`), addError.stack);
      return false; // Indicate failure
    }
  } catch (error) {
    console.error(chalk.red(`[generateDirEmb] Overall error: ${error.message}`), error.stack);
    return false; // Indicate failure
  }
};

// ============================================================================
// BATCH PROCESSING FUNCTIONS
// ============================================================================

/**
 * Process embeddings for multiple files in batch
 * @param {string[]} filePaths - Array of file paths to process
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Processing results
 */
async function processBatchEmbeddings(filePaths, options = {}) {
  const {
    concurrency = 10, // Concurrency for pLimit if we reintroduce it for I/O
    verbose = false,
    excludePatterns = [],
    respectGitignore = true,
    baseDir: optionBaseDir = process.cwd(),
    onProgress, // <<< Add onProgress here
  } = options;
  const resolvedCanonicalBaseDir = path.resolve(optionBaseDir);
  debug(`Resolved canonical base directory: ${resolvedCanonicalBaseDir}`);

  try {
    await initEmbeddingModel(); // Ensure model is ready
  } catch (modelError) {
    console.error(chalk.red('Failed to initialize embedding model. Aborting batch process.'));
    return { processed: 0, failed: filePaths.length, skipped: 0, excluded: 0, files: [], failedFiles: [...filePaths], excludedFiles: [] };
  }

  console.log(chalk.blue('Ensuring database tables exist before batch processing...'));
  let db;
  try {
    db = await getDB(); // This calls ensureTablesExist internally
    console.log(chalk.green('Database table check complete.'));
  } catch (dbError) {
    console.error(chalk.red(`Failed to initialize database or tables: ${dbError.message}. Aborting batch process.`));
    return { processed: 0, failed: filePaths.length, skipped: 0, excluded: 0, files: [], failedFiles: [...filePaths], excludedFiles: [] };
  }

  const results = { processed: 0, failed: 0, skipped: 0, excluded: 0, files: [], failedFiles: [], excludedFiles: [] };
  const exclusionOptions = { excludePatterns, respectGitignore, baseDir: resolvedCanonicalBaseDir };
  processedFiles.clear();
  progressTracker.reset(filePaths.length);
  console.log(chalk.blue(`Starting batch processing of ${filePaths.length} files...`));

  try {
    await generateDirectoryStructureEmbedding({
      rootDir: resolvedCanonicalBaseDir,
      maxDepth: 5,
      ignorePatterns: excludePatterns,
      showFiles: true,
    });
  } catch (structureError) {
    console.warn(chalk.yellow(`Warning: Failed to generate directory structure embedding: ${structureError.message}`));
  }

  const fileTable = await getTable(FILE_EMBEDDINGS_TABLE);
  if (!fileTable) {
    console.error(chalk.red(`Table ${FILE_EMBEDDINGS_TABLE} not found. Aborting batch file embedding.`));
    // Mark all as failed if table is missing
    results.failed = filePaths.length;
    results.failedFiles = [...filePaths];
    progressTracker.failedCount = filePaths.length; // Manually update tracker
    progressTracker.update('failed'); // Trigger a log
    return results;
  }

  // --- Phase 1: Batch process FILE embeddings ---
  console.log(chalk.cyan('--- Starting Phase 1: File Embeddings ---'));
  const allFileRecordsToAdd = []; // Accumulate all file records for a single DB add
  const allFileIdsToDelete = new Set(); // Accumulate all file IDs to delete before adding

  // OPTIMIZATION: Bulk query to get existing file records for the current project only
  let existingFileRecords = new Map();
  if (fileTable) {
    try {
      const queryStartTime = Date.now();
      console.log(chalk.cyan('Performing bulk query for existing project file records...'));
      const allExistingRecords = await fileTable.query().toArray();
      const queryTime = ((Date.now() - queryStartTime) / 1000).toFixed(2);
      console.log(chalk.gray(`Database query completed in ${queryTime}s (${allExistingRecords.length} total records)`));

      // Filter records to only include those belonging to the current project
      const filterStartTime = Date.now();
      const projectRecords = allExistingRecords.filter((record) => {
        if (!record.path) return false;

        // Check if this record belongs to the current project
        // Records store relative paths, so we check if they would resolve to files in this project
        try {
          const absolutePath = path.resolve(resolvedCanonicalBaseDir, record.path);
          return absolutePath.startsWith(resolvedCanonicalBaseDir);
        } catch (error) {
          return false;
        }
      });

      for (const record of projectRecords) {
        existingFileRecords.set(record.path, record);
      }

      const filterTime = ((Date.now() - filterStartTime) / 1000).toFixed(2);
      console.log(chalk.gray(`Record filtering completed in ${filterTime}s (${projectRecords.length} project records)`));
      debug(
        `Bulk query found ${projectRecords.length} existing file records for current project (${allExistingRecords.length} total in DB)`
      );
    } catch (bulkQueryError) {
      debug(`Error in bulk query for existing files: ${bulkQueryError.message}`);
    }
  }

  // ULTRA-AGGRESSIVE OPTIMIZATION: Batch file stats and minimal processing
  console.log(chalk.cyan(`Ultra-fast pre-filtering ${filePaths.length} files...`));
  const filesToActuallyProcess = [];
  const preFilterStartTime = Date.now();

  // Batch process file stats to minimize system calls
  const fileStatsMap = new Map();
  const validFiles = [];

  // First pass: get all file stats in batch and do basic filtering
  for (const filePath of filePaths) {
    if (processedFiles.has(filePath) && processedFiles.get(filePath) !== 'failed') continue;

    const absoluteFilePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(resolvedCanonicalBaseDir, filePath);
    const consistentRelativePath = path.relative(resolvedCanonicalBaseDir, absoluteFilePath);

    try {
      const stats = fs.statSync(absoluteFilePath);

      // Quick size check
      if (stats.size > 1024 * 1024) {
        results.skipped++;
        progressTracker.update('skipped');
        if (typeof onProgress === 'function') onProgress('skipped', filePath);
        processedFiles.set(filePath, 'skipped_large');
        continue;
      }

      // ULTRA-FAST CHECK: If file exists in DB and modification time hasn't changed, skip immediately
      const existingRecord = existingFileRecords.get(consistentRelativePath);
      if (existingRecord && existingRecord.last_modified) {
        const existingMtime = new Date(existingRecord.last_modified);
        if (stats.mtime <= existingMtime) {
          results.skipped++;
          progressTracker.update('skipped');
          if (typeof onProgress === 'function') onProgress('skipped', filePath);
          processedFiles.set(filePath, 'skipped_unchanged');
          continue;
        }
      }

      // Store for further processing
      fileStatsMap.set(filePath, { absoluteFilePath, consistentRelativePath, stats });
      validFiles.push(filePath);
    } catch (statError) {
      results.skipped++;
      progressTracker.update('skipped');
      if (typeof onProgress === 'function') onProgress('skipped', filePath);
      processedFiles.set(filePath, 'skipped_stat_error');
    }
  }

  // Second pass: only do expensive exclusion checks for files that might need processing
  for (const filePath of validFiles) {
    const { absoluteFilePath, consistentRelativePath } = fileStatsMap.get(filePath);

    // Only do expensive exclusion check for files that passed the fast checks
    if (
      !utilsShouldProcessFile(absoluteFilePath, '', {
        ...exclusionOptions,
        baseDir: resolvedCanonicalBaseDir,
        relativePathToCheck: consistentRelativePath,
      })
    ) {
      results.excluded++;
      results.excludedFiles.push(filePath);
      progressTracker.update('skipped');
      if (typeof onProgress === 'function') onProgress('excluded', filePath);
      processedFiles.set(filePath, 'excluded');
      continue;
    }

    // File needs processing
    filesToActuallyProcess.push(filePath);
  }

  const preFilterTime = ((Date.now() - preFilterStartTime) / 1000).toFixed(2);
  console.log(
    chalk.green(
      `Pre-filtering complete in ${preFilterTime}s: ${filesToActuallyProcess.length} files need processing (${
        filePaths.length - filesToActuallyProcess.length
      } skipped)`
    )
  );

  // If no files need processing, return early
  if (filesToActuallyProcess.length === 0) {
    console.log(chalk.yellow('No files need processing. All files are up to date.'));
    return results;
  }

  // Use larger batch size for better performance
  const OPTIMIZED_BATCH_SIZE = Math.min(256, Math.max(64, Math.floor(filesToActuallyProcess.length / 8)));
  debug(`Using optimized batch size: ${OPTIMIZED_BATCH_SIZE}`);

  for (let i = 0; i < filesToActuallyProcess.length; i += OPTIMIZED_BATCH_SIZE) {
    const batchFilePaths = filesToActuallyProcess.slice(i, i + OPTIMIZED_BATCH_SIZE);
    const filesToProcessInBatch = []; // To store {filePath, content, relativePath, ...}
    const contentsForBatch = []; // To store raw content strings for calculateEmbeddingBatch

    for (const filePath of batchFilePaths) {
      // Generate consistent relative path for DB storage and querying
      const absoluteFilePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(resolvedCanonicalBaseDir, filePath);
      const consistentRelativePath = path.relative(resolvedCanonicalBaseDir, absoluteFilePath);

      try {
        const stats = fs.statSync(absoluteFilePath);
        const existingRecord = existingFileRecords.get(consistentRelativePath);

        // Read file content (all files in this list need processing)
        let content = '';
        try {
          content = await fs.promises.readFile(absoluteFilePath, 'utf8');
        } catch (readError) {
          if (verbose) console.warn(chalk.yellow(`Skipping unreadable file: ${consistentRelativePath} - ${readError.message}`));
          results.skipped++;
          progressTracker.update('skipped');
          if (typeof onProgress === 'function') onProgress('skipped', filePath);
          processedFiles.set(filePath, 'skipped_unreadable');
          continue;
        }

        if (content.trim().length === 0) {
          if (verbose) console.log(chalk.yellow(`Skipping empty file: ${consistentRelativePath}`));
          results.skipped++;
          progressTracker.update('skipped');
          if (typeof onProgress === 'function') onProgress('skipped', filePath);
          processedFiles.set(filePath, 'skipped_empty');
          continue;
        }

        // Calculate content hash for files that we do need to check
        const currentContentHash = createHash('md5').update(content).digest('hex').substring(0, 8);

        // Final check: if we have an existing record with the same content hash, skip processing
        if (existingRecord && existingRecord.content_hash === currentContentHash) {
          if (verbose) console.log(chalk.green(`Skipping unchanged file (content hash match): ${consistentRelativePath}`));
          results.skipped++;
          progressTracker.update('skipped');
          if (typeof onProgress === 'function') onProgress('skipped', filePath);
          processedFiles.set(filePath, 'skipped_unchanged');
          continue;
        }

        filesToProcessInBatch.push({
          filePath: absoluteFilePath,
          originalInputPath: filePath,
          content,
          relativePath: consistentRelativePath,
          currentContentHash,
          stats, // Include file stats for modification time
        });
        contentsForBatch.push(content); // Use content directly
      } catch (fileStatError) {
        if (verbose) console.warn(chalk.yellow(`Skipping file due to stat error: ${consistentRelativePath} - ${fileStatError.message}`));
        results.failed++;
        results.failedFiles.push(filePath);
        progressTracker.update('failed');
        if (typeof onProgress === 'function') onProgress('failed', filePath);
        processedFiles.set(filePath, 'failed_stat');
      }
    }

    if (contentsForBatch.length > 0) {
      debug(
        `Processing batch of ${contentsForBatch.length} files for embeddings (Batch starting with: ${filesToProcessInBatch[0].relativePath})`
      );
      const embeddings = await calculateEmbeddingBatch(contentsForBatch);

      for (let j = 0; j < embeddings.length; j++) {
        const fileData = filesToProcessInBatch[j];
        const embeddingVector = embeddings[j];

        if (embeddingVector) {
          const truncatedContent = contentsForBatch[j];
          const contentHash = fileData.currentContentHash;
          const fileId = `${fileData.relativePath}#${contentHash}`;

          const record = {
            vector: embeddingVector,
            id: fileId,
            content: truncatedContent,
            type: 'file',
            name: path.basename(fileData.filePath), // Use basename of absolute path
            path: fileData.relativePath, // Store consistent relative path
            project_path: resolvedCanonicalBaseDir, // Store the project path for proper isolation
            language: detectLanguageFromExtension(path.extname(fileData.filePath)),
            content_hash: contentHash,
            last_modified: fileData.stats.mtime.toISOString(), // Store modification time
          };
          allFileIdsToDelete.add(record.id);
          allFileRecordsToAdd.push(record);
        } else {
          console.warn(chalk.yellow(`Failed to generate embedding for: ${fileData.relativePath}. Skipping file embedding.`));
          results.failed++;
          results.failedFiles.push(fileData.originalInputPath); // Use originalInputPath for reporting
          processedFiles.set(fileData.originalInputPath, 'failed_embedding');
          progressTracker.update('failed');
          if (typeof onProgress === 'function') onProgress('failed', fileData.originalInputPath);
        }
      }

      // Removed per-batch DB add and delete from here. Accumulation happens above.
      // The logging for successfully added records per batch also needs to move or be rethought.
      // For now, just signal that the batch of file contents was processed for embedding.
      if (filesToProcessInBatch.length > 0) {
        debug(`Processed batch of ${filesToProcessInBatch.length} files; ${embeddings.filter((e) => e).length} embeddings generated.`);
        // Update progress based on successful embedding generation, not DB add yet
        filesToProcessInBatch.forEach((fileData, index) => {
          if (embeddings[index]) {
            // If an embedding was generated for this fileData
            // These counts will be adjusted after the actual DB add below
            // results.processed++;
            // results.files.push(fileData.filePath);
            // processedFiles.set(fileData.filePath, 'processed_file_embedding');
            // progressTracker.update('processed');
          } else {
            // Failure to generate embedding was already logged and results updated
          }
        });
      }
    }
  }

  // Perform batch delete and single add for all accumulated file records
  if (allFileIdsToDelete.size > 0) {
    debug(`Attempting to delete ${allFileIdsToDelete.size} old file records from DB before batch add.`);
    try {
      const idListString = Array.from(allFileIdsToDelete)
        .map((id) => `'${id.replace(/'/g, "''")}'`)
        .join(',');
      if (idListString) {
        await fileTable.delete(`id IN (${idListString})`);
        debug(`Finished bulk deleting ${allFileIdsToDelete.size} old file records via IN clause.`);
      }
    } catch (deleteError) {
      // Fallback to individual deletes if bulk delete fails (e.g., IN clause not supported or too long)
      console.warn(chalk.yellow(`Bulk delete for file records failed (${deleteError.message}). Falling back to individual deletes.`));
      let deletedCount = 0;
      for (const idToDelete of allFileIdsToDelete) {
        try {
          await fileTable.delete(`id = '${idToDelete.replace(/'/g, "''")}'`);
          deletedCount++;
        } catch (indDeleteError) {
          if (!indDeleteError.message.includes('Record not found') && !indDeleteError.message.includes('cannot find')) {
            debug(`Error deleting old file record (fallback) for id ${idToDelete}: ${indDeleteError.message}`);
          }
        }
      }
      debug(`Finished fallback individual deleting ${deletedCount} old file records.`);
    }
  }

  if (allFileRecordsToAdd.length > 0) {
    try {
      debug(`Attempting to batch add ${allFileRecordsToAdd.length} file records to DB.`);
      await fileTable.add(allFileRecordsToAdd);
      if (verbose) {
        console.log(
          chalk.green(`Successfully added ${allFileRecordsToAdd.length} file embeddings to ${FILE_EMBEDDINGS_TABLE} in a single batch.`)
        );
      }
      // Update results and progress tracker after successful DB add
      allFileRecordsToAdd.forEach((record) => {
        // Find the original file path from filePaths by matching the consistentRelativePath (record.path)
        const matchedInputPath = filePaths.find((fp) => {
          const absFp = path.isAbsolute(fp) ? path.resolve(fp) : path.resolve(resolvedCanonicalBaseDir, fp);
          const relFp = path.relative(resolvedCanonicalBaseDir, absFp);
          return relFp === record.path;
        });
        const keyForMaps = matchedInputPath;

        if (keyForMaps) {
          if (!results.failedFiles.includes(keyForMaps) && processedFiles.get(keyForMaps) !== 'skipped_unchanged') {
            results.processed++;
            results.files.push(keyForMaps); // Use the original path string from input for results
            processedFiles.set(keyForMaps, 'processed_file_embedding');
            progressTracker.update('processed');
            if (typeof onProgress === 'function') onProgress('processed', keyForMaps);
          }
        } else {
          debug(`Could not map record path ${record.path} back to an original input file path for results tracking.`);
        }
      });
    } catch (addError) {
      console.error(chalk.red(`Error batch adding file embeddings to DB: ${addError.message}`), addError.stack);
      allFileRecordsToAdd.forEach((record) => {
        // Find the original keyForMaps for failed records
        const matchedInputPath = filePaths.find((fp) => {
          const absFp = path.isAbsolute(fp) ? path.resolve(fp) : path.resolve(resolvedCanonicalBaseDir, fp);
          const relFp = path.relative(resolvedCanonicalBaseDir, absFp);
          return relFp === record.path;
        });
        const keyForMaps = matchedInputPath;

        if (keyForMaps) {
          if (!results.failedFiles.includes(keyForMaps) && processedFiles.get(keyForMaps) !== 'skipped_unchanged') {
            results.failed++;
            results.failedFiles.push(keyForMaps); // Use original path string for reporting
            processedFiles.set(keyForMaps, 'failed_db_add_batch');
            progressTracker.update('failed');
            if (typeof onProgress === 'function') onProgress('failed', keyForMaps);
          }
        }
      });
    }
  }
  // +++ Create Vector index for fileTable AFTER bulk add and FTS +++
  if (fileTable && allFileRecordsToAdd.length > 0) {
    console.log(chalk.blue(`Attempting to create/verify Vector (IVF_PQ) index on 'vector' for ${FILE_EMBEDDINGS_TABLE}...`));
    try {
      const numPartitions = Math.max(1, Math.min(Math.floor(allFileRecordsToAdd.length / 100), 64));
      const numSubVectors = 96; // Dimension 384 is divisible by 96
      await fileTable.createIndex('vector', {
        config: {
          type: 'ivf_pq',
          metric_type: 'cosine',
          num_partitions: numPartitions,
          num_sub_vectors: numSubVectors,
        },
        replace: true,
      });
      console.log(chalk.green(`Vector (IVF_PQ) index created/verified for ${FILE_EMBEDDINGS_TABLE} on 'vector'.`));
    } catch (vecIndexError) {
      // Check if error is due to index already existing, which is fine
      if (
        vecIndexError.message &&
        !vecIndexError.message.toLowerCase().includes('already exists') &&
        !vecIndexError.message.toLowerCase().includes('index already built')
      ) {
        console.warn(
          chalk.yellow(`Warning creating Vector index for ${FILE_EMBEDDINGS_TABLE}: ${vecIndexError.message}`),
          vecIndexError.stack
        );
      } else {
        console.log(chalk.green(`Vector (IVF_PQ) index already exists for ${FILE_EMBEDDINGS_TABLE} on 'vector'.`));
      }
    }
  }
  // --- End Vector Index Creation ---
  console.log(chalk.green('--- Finished Phase 1: File Embeddings ---'));

  // --- Phase 2: Batch process DOCUMENT CHUNK embeddings ---
  console.log(chalk.cyan('--- Starting Phase 2: Document Chunk Embeddings ---'));
  const documentChunkTable = await getTable(DOCUMENT_CHUNK_TABLE);
  if (documentChunkTable) {
    const allDocChunksToEmbed = [];
    const allDocChunkRecordsToAdd = [];
    const allDocChunkIdsToDelete = new Set(); // For specific chunk IDs if needed for granular updates
    const processedDocPathsForDeletion = new Set(); // Track parent doc paths whose chunks need deletion

    for (const filePath of filePaths) {
      // Iterate through all original filePaths
      const absoluteFilePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(resolvedCanonicalBaseDir, filePath);
      const consistentRelativePath = path.relative(resolvedCanonicalBaseDir, absoluteFilePath);
      const language = detectLanguageFromExtension(path.extname(absoluteFilePath));

      if (isDocumentationFile(absoluteFilePath, language)) {
        console.log(chalk.blueBright(`[Phase 3 DEBUG] Identified doc file: ${consistentRelativePath}`)); // <<< LOG DOC FILE
        debug(`Processing document file for chunking: ${consistentRelativePath}`);
        try {
          const stats = fs.statSync(absoluteFilePath);
          if (stats.size > 5 * 1024 * 1024) {
            // 5MB limit for docs, can adjust
            if (verbose) console.log(chalk.yellow(`Skipping large document (>5MB): ${consistentRelativePath}`));
            // results.skipped++; progressTracker.update('skipped'); // Consider how to count this
            continue;
          }

          let content = '';
          try {
            content = await fs.promises.readFile(absoluteFilePath, 'utf8');
          } catch (readError) {
            if (verbose) console.warn(chalk.yellow(`Skipping unreadable document: ${consistentRelativePath} - ${readError.message}`));
            // results.skipped++; progressTracker.update('skipped');
            continue;
          }

          if (content.trim().length === 0) {
            if (verbose) console.log(chalk.yellow(`Skipping empty document: ${consistentRelativePath}`));
            // results.skipped++; progressTracker.update('skipped');
            continue;
          }

          // Check for existing, unchanged document based on full file hash (optional, could be slow)
          // For simplicity, we'll delete all old chunks for a doc and re-add new ones if it's processed.
          // This means if a doc file is *not* in filePaths but was previously processed, its chunks remain.
          // If a doc file *is* in filePaths, its old chunks are wiped before new ones are added.
          if (!processedDocPathsForDeletion.has(consistentRelativePath)) {
            debug(`Marking document for old chunk deletion: ${consistentRelativePath}`);
            // We'll delete by original_document_path before adding new chunks for this file.
            // This is simpler than content hashing each chunk if the file itself is reprocessed.
            processedDocPathsForDeletion.add(consistentRelativePath);
          }

          const { chunks, documentH1 } = extractMarkdownChunks(absoluteFilePath, content, consistentRelativePath);
          console.log(
            chalk.blueBright(
              `[Phase 3 DEBUG] For ${consistentRelativePath}: Extracted ${chunks.length} chunks. DocumentH1: "${documentH1?.substring(
                0,
                50
              )}..."`
            )
          ); // <<< LOG CHUNKS & H1

          if (chunks.length > 0) {
            chunks.forEach((chunk) => {
              const chunkWithTitle = {
                ...chunk,
                documentTitle: documentH1 || path.basename(absoluteFilePath, path.extname(absoluteFilePath)),
                fileStats: stats, // Pass file stats for modification time
              };
              // --- Log the object being pushed to allDocChunksToEmbed ---
              if (consistentRelativePath.includes('diagrams.md') && chunk.content.startsWith('# Diagrams')) {
                // Log only for the specific first chunk of diagrams.md
                console.log(chalk.greenBright('[Phase 3 DEBUG] Adding to allDocChunksToEmbed:', JSON.stringify(chunkWithTitle, null, 2)));
              }
              allDocChunksToEmbed.push(chunkWithTitle);
            });
          }
        } catch (docError) {
          console.warn(chalk.yellow(`Error processing document ${consistentRelativePath} for chunking: ${docError.message}`));
          // results.failed++; results.failedFiles.push(filePath); progressTracker.update('failed');
        }
      }
    }

    if (allDocChunksToEmbed.length > 0) {
      console.log(chalk.blue(`Extracted ${allDocChunksToEmbed.length} total document chunks to process for embeddings.`));
      const chunkContentsForBatching = allDocChunksToEmbed.map((chunk) => chunk.content);
      const chunkEmbeddings = await calculateEmbeddingBatch(chunkContentsForBatching);
      console.log(
        chalk.blueBright(
          `[Phase 3 DEBUG] Batch embedding for ${chunkEmbeddings.filter((e) => e !== null).length} / ${
            chunkContentsForBatching.length
          } doc chunks successful.`
        )
      ); // <<< LOG EMBEDDING SUCCESS

      for (let i = 0; i < chunkEmbeddings.length; i++) {
        const chunkData = allDocChunksToEmbed[i];
        const chunkEmbeddingVector = chunkEmbeddings[i];

        if (chunkEmbeddingVector) {
          const chunkContentHash = createHash('md5').update(chunkData.content).digest('hex').substring(0, 8);
          // chunkData now contains: content, heading (H2/H3), original_document_path, start_line_in_doc, language, documentTitle (H1 or fallback)
          const chunkId = `${chunkData.original_document_path}#${slugify(chunkData.heading || 'section')}_${chunkData.start_line_in_doc}`;

          const record = {
            id: chunkId,
            content: chunkData.content,
            original_document_path: chunkData.original_document_path,
            project_path: resolvedCanonicalBaseDir, // Store the project path for proper isolation
            heading_text: chunkData.heading || '',
            document_title: chunkData.documentTitle, // This is the H1 or filename fallback. Schema field is 'document_title'
            language: chunkData.language || 'markdown',
            vector: chunkEmbeddingVector,
            content_hash: chunkContentHash,
            last_modified: chunkData.fileStats ? chunkData.fileStats.mtime.toISOString() : new Date().toISOString(), // Use file modification time
          };
          // Ensure the key matches the schema EXACTLY, even if JS is flexible with object properties
          // This is mostly for sanity checking; the above should work.
          // const recordForDb = {
          //   id: record.id,
          //   content: record.content,
          //   original_document_path: record.original_document_path,
          //   heading_text: record.heading_text,
          //   document_title: record.document_title, // Explicitly using snake_case key
          //   language: record.language,
          //   vector: record.vector,
          //   content_hash: record.content_hash,
          // };
          allDocChunkRecordsToAdd.push(record); // Push the original record
        } else {
          console.warn(
            chalk.yellow(
              `Failed to generate embedding for a document chunk from ${chunkData.original_document_path} (heading: ${chunkData.heading}). Skipping.`
            )
          );
        }
      }
    }

    // Perform batch delete for all documents that were re-processed
    if (processedDocPathsForDeletion.size > 0) {
      debug(`Attempting to delete all existing chunks for ${processedDocPathsForDeletion.size} re-processed documents.`);
      // This needs to be an array of promises if we delete one by one, or build a complex OR query
      let deletedPathsCount = 0;
      for (const docPathToDelete of processedDocPathsForDeletion) {
        try {
          await documentChunkTable.delete(`original_document_path = '${docPathToDelete.replace(/'/g, "''")}'`);
          deletedPathsCount++;
        } catch (deleteError) {
          console.warn(chalk.yellow(`Error deleting chunks for document ${docPathToDelete}: ${deleteError.message}`));
        }
      }
      console.log(chalk.blue(`Finished deleting existing chunks for ${deletedPathsCount} documents.`));
    }

    if (allDocChunkRecordsToAdd.length > 0) {
      try {
        debug(`Attempting to batch add ${allDocChunkRecordsToAdd.length} document chunk records to DB.`);
        await documentChunkTable.add(allDocChunkRecordsToAdd);
        console.log(
          chalk.green(
            `Successfully added ${allDocChunkRecordsToAdd.length} document chunk embeddings to ${DOCUMENT_CHUNK_TABLE} in a single batch.`
          )
        );
      } catch (addError) {
        console.error(chalk.red(`Error batch adding document chunk embeddings to DB: ${addError.message}`), addError.stack);
        // Potentially mark these as failed in results if tracking doc processing status
      }
    }

    if (documentChunkTable && allDocChunkRecordsToAdd.length > 0) {
      // Only attempt IVF_PQ if there's a reasonable amount of data
      if (allDocChunkRecordsToAdd.length >= 256) {
        // Threshold of 256 for PQ training
        console.log(chalk.blue(`Attempting to create/verify Vector (IVF_PQ) index on 'vector' for ${DOCUMENT_CHUNK_TABLE}...`));
        try {
          const numPartitions = Math.max(1, Math.min(Math.floor(allDocChunkRecordsToAdd.length / 100), 64));
          const numSubVectors = 96; // Dimension 384 is divisible by 96
          await documentChunkTable.createIndex('vector', {
            config: {
              type: 'ivf_pq',
              metric_type: 'cosine',
              num_partitions: numPartitions,
              num_sub_vectors: numSubVectors,
            },
            replace: true,
          });
          console.log(chalk.green(`Vector (IVF_PQ) index created/verified for ${DOCUMENT_CHUNK_TABLE} on 'vector'.`));
        } catch (vecIndexError) {
          if (
            vecIndexError.message &&
            !vecIndexError.message.toLowerCase().includes('already exists') &&
            !vecIndexError.message.toLowerCase().includes('index already built')
          ) {
            console.warn(
              chalk.yellow(`Warning creating Vector index for ${DOCUMENT_CHUNK_TABLE}: ${vecIndexError.message}`),
              vecIndexError.stack
            );
          } else {
            console.log(chalk.green(`Vector (IVF_PQ) index already exists for ${DOCUMENT_CHUNK_TABLE} on 'vector'.`));
          }
        }
      } else {
        console.log(
          chalk.yellow(
            `Skipping IVF_PQ index creation for ${DOCUMENT_CHUNK_TABLE} due to insufficient data (${allDocChunkRecordsToAdd.length} rows). Vector searches may be exact/slower.`
          )
        );
        // LanceDB will likely use a flat index (exact search) by default here if no index is explicitly created or if an attempted creation fails due to data size.
      }
    }
  } else {
    console.warn(chalk.yellow(`Skipping Phase 2: Document Chunk Embeddings because table ${DOCUMENT_CHUNK_TABLE} was not found.`));
  }
  console.log(chalk.green('--- Finished Phase 2: Document Chunk Embeddings ---'));

  console.log(chalk.green(`Batch processing complete!`));
  // Final progress update. This needs to be accurate based on actual counts.
  // The progressTracker.update() calls within the loops should handle most of it.
  // We might need a final recount if the total wasn't hit.
  const finalProcessed = results.processed;
  const finalSkipped = results.excluded + results.skipped;
  const finalFailed = results.failed;

  // Update progress tracker counts for internal tracking (no logging)
  progressTracker.processedCount = finalProcessed;
  progressTracker.skippedCount = finalSkipped; // Combines excluded and other skips
  progressTracker.failedCount = finalFailed;
  // Progress logging is handled by the spinner in index.js, no need for duplicate logging

  return results;
}

// processFileWithRetries - Modified slightly for clarity and error handling
// THIS FUNCTION IS NO LONGER CALLED BY processBatchEmbeddings for file/block generation.
// It might be kept for other single-file processing scenarios if any exist,
// or removed if processBatchEmbeddings is the sole entry point for bulk processing.
// For now, its content is largely absorbed/replaced.
/**
 * Process a file with retries on failure
 * @private
 * @param {string} filePath - Path to the file
 * @param {boolean} verbose - Whether to log verbose output
 * @param {Object} options - Processing options
 * @returns {Promise<Object|null>} Processing result or null on failure
 */
async function processFileWithRetries(filePath, verbose, options = {}) {
  console.warn(
    chalk.magenta(
      `[WARN] processFileWithRetries was called for ${filePath}, but batch processing is now preferred. This path might be deprecated.`
    )
  );
  let retries = 0;
  let lastError = null;
  const baseDir = options.baseDir || process.cwd();
  const absoluteFilePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseDir, filePath);
  const relativePath = path.relative(baseDir, absoluteFilePath); // Use consistent relative path for logging

  while (retries < MAX_RETRIES) {
    try {
      const stats = fs.statSync(absoluteFilePath);
      if (stats.size > 1024 * 1024) {
        // 1MB limit
        if (verbose) console.log(chalk.yellow(`Skipping large file (>1MB): ${relativePath}`));
        // Need to update tracker here if skipped
        // progressTracker.update('skipped'); // Add if skipped files aren't counted elsewhere
        return; // Consider this skipped, not failed
      }

      let content = '';
      try {
        content = await fs.promises.readFile(absoluteFilePath, 'utf8');
      } catch (readError) {
        if (verbose) console.warn(chalk.yellow(`Skipping unreadable file: ${relativePath} - ${readError.message}`));
        // progressTracker.update('skipped'); // Add if skipped files aren't counted elsewhere
        return; // Consider this skipped, not failed
      }

      if (content.trim().length === 0) {
        if (verbose) console.log(chalk.yellow(`Skipping empty file: ${relativePath}`));
        // progressTracker.update('skipped'); // Add if skipped files aren't counted elsewhere
        return; // Consider this skipped, not failed
      }

      // Generate file-level embedding and add to DB
      const fileResult = await generateFileEmbeddings(absoluteFilePath, content, baseDir);
      // generateFileEmbeddings now returns null on failure
      if (fileResult === null) {
        throw new Error(`generateFileEmbeddings failed for ${relativePath}`); // Throw to trigger retry
      }

      return; // Successfully processed file and blocks
    } catch (error) {
      lastError = error;
      retries++;
      console.error(chalk.yellow(`Retry ${retries}/${MAX_RETRIES} for ${relativePath}: ${error.message}`));
      if (retries < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retries - 1))); // Exponential backoff
      }
    }
  }

  // If loop finishes, all retries failed
  console.error(chalk.red(`Failed processing ${relativePath} after ${MAX_RETRIES} retries: ${lastError?.message || 'Unknown error'}`));
  throw lastError || new Error(`Failed processing ${relativePath} after ${MAX_RETRIES} retries.`); // Ensure an error is thrown
}

// --- Search and Similarity (Using Vector Search + Cosine) ---

// +++ NEW HELPER FUNCTION +++
/**
 * Calculates a path similarity score based on the longest common directory prefix.
 * @param {string} path1 - First file path (absolute or relative).
 * @param {string} path2 - Second file path (absolute or relative).
 * @returns {number} Similarity score between 0 and 1.
 */
function calculatePathSimilarity(path1, path2) {
  if (!path1 || !path2) return 0;

  try {
    // Normalize paths and split into directory components
    const parts1 = path
      .dirname(path.normalize(path1))
      .split(path.sep)
      .filter((p) => p);
    const parts2 = path
      .dirname(path.normalize(path2))
      .split(path.sep)
      .filter((p) => p);

    let commonPrefixLength = 0;
    const minLength = Math.min(parts1.length, parts2.length);

    for (let i = 0; i < minLength; i++) {
      if (parts1[i] === parts2[i]) {
        commonPrefixLength++;
      } else {
        break;
      }
    }

    // Calculate score: common prefix length relative to the average length
    // Avoid division by zero
    const avgLength = (parts1.length + parts2.length) / 2;
    if (avgLength === 0) {
      return 1; // Both paths are likely in the root or identical
    }

    const score = commonPrefixLength / avgLength;
    return Math.max(0, Math.min(1, score)); // Clamp score between 0 and 1
  } catch (error) {
    debug(`[calculatePathSimilarity] Error comparing paths '${path1}' and '${path2}': ${error.message}`);
    return 0; // Return 0 similarity on error
  }
}
// +++ END NEW HELPER FUNCTION +++

/**
 * Find similar documentation using native LanceDB hybrid search
 * @param {string} queryText - The text query
 * @param {Object} options - Search options
 * @returns {Promise<Array<object>>} Search results
 */
export const findRelevantDocs = async (queryText, options = {}) => {
  const {
    limit = 10,
    similarityThreshold = 0.1,
    useReranking = true,
    queryFilePath = null,
    queryContextForReranking = null,
    projectPath = process.cwd(),
    precomputedQueryEmbedding = null,
  } = options;

  console.log(
    chalk.cyan(`Native hybrid documentation search - limit: ${limit}, threshold: ${similarityThreshold}, reranking: ${useReranking}`)
  );

  try {
    if (!queryText?.trim()) {
      console.warn(chalk.yellow('Empty query text provided for documentation search'));
      return [];
    }

    const db = await getDB();
    const tableName = DOCUMENT_CHUNK_TABLE;
    const table = await getTable(tableName);

    if (!table) {
      console.warn(chalk.yellow(`Documentation table ${tableName} not found`));
      return [];
    }

    console.log(chalk.cyan('Performing native hybrid search for documentation...'));
    let query = table.search(queryText).nearestToText(queryText);

    const resolvedProjectPath = path.resolve(projectPath);
    try {
      const tableSchema = await table.schema;
      if (tableSchema?.fields?.some((field) => field.name === 'project_path')) {
        query = query.where(`project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`);
        debug(`Filtering documentation by project_path: ${resolvedProjectPath}`);
      }
    } catch (schemaError) {
      debug(`Could not check schema for project_path field: ${schemaError.message}`);
    }

    const results = await query.limit(Math.max(limit * 3, 20)).toArray();
    console.log(chalk.green(`Native hybrid search returned ${results.length} documentation results`));

    // OPTIMIZATION: Batch file existence checks for better performance
    const docsToCheck = [];
    const docProjectMatchMap = new Map();

    // First pass: collect files that need existence checking
    for (let i = 0; i < results.length; i++) {
      const result = results[i];

      if (result.project_path) {
        docProjectMatchMap.set(i, result.project_path === resolvedProjectPath);
        continue;
      }

      if (!result.original_document_path) {
        docProjectMatchMap.set(i, false);
        continue;
      }

      const filePath = result.original_document_path;
      try {
        if (path.isAbsolute(filePath)) {
          docProjectMatchMap.set(i, filePath.startsWith(resolvedProjectPath));
          continue;
        }

        const absolutePath = path.resolve(resolvedProjectPath, filePath);
        if (absolutePath.startsWith(resolvedProjectPath)) {
          // Mark for batch existence check
          docsToCheck.push({ result, index: i, absolutePath, filePath });
        } else {
          docProjectMatchMap.set(i, false);
        }
      } catch (error) {
        debug(`Error filtering result for project: ${error.message}`);
        docProjectMatchMap.set(i, false);
      }
    }

    // Batch check file existence for better performance
    if (docsToCheck.length > 0) {
      debug(`[OPTIMIZATION] Batch checking existence of ${docsToCheck.length} documentation files`);
      const existencePromises = docsToCheck.map(async ({ result, index, absolutePath, filePath }) => {
        try {
          await fs.promises.access(absolutePath, fs.constants.F_OK);
          return { index, exists: true };
        } catch {
          debug(`Filtering out non-existent documentation file: ${filePath}`);
          return { index, exists: false };
        }
      });

      const existenceResults = await Promise.all(existencePromises);
      for (const { index, exists } of existenceResults) {
        docProjectMatchMap.set(index, exists);
      }
    }

    // Filter results based on project match using the map
    const projectFilteredResults = results.filter((result, index) => docProjectMatchMap.get(index) === true);

    console.log(chalk.blue(`Filtered to ${projectFilteredResults.length} documentation results from current project`));

    let finalResults = projectFilteredResults.map((result) => {
      let similarity;
      if (result._distance !== undefined) {
        similarity = Math.max(0, Math.min(1, 1 - result._distance));
      } else if (result._score !== undefined) {
        similarity = Math.max(0, Math.min(1, result._score));
      } else {
        similarity = 0.5;
      }

      return {
        similarity,
        type: 'documentation-chunk',
        content: result.content,
        path: result.original_document_path,
        file_path: result.original_document_path,
        language: result.language,
        headingText: result.heading_text,
        document_title: result.document_title,
        startLine: result.start_line,
        reranked: false,
      };
    });

    finalResults = finalResults.filter((result) => result.similarity >= similarityThreshold);

    let queryEmbedding = null;
    if (useReranking && queryContextForReranking && finalResults.length >= 3) {
      console.log(chalk.cyan('Applying sophisticated contextual reranking to documentation...'));
      const WEIGHT_INITIAL_SIM = 0.3;
      const WEIGHT_H1_CHUNK_RERANK = 0.15;
      const HEAVY_BOOST_SAME_AREA = 0.4;
      const MODERATE_BOOST_TECH_MATCH = 0.2;
      const HEAVY_PENALTY_AREA_MISMATCH = -0.1;
      const PENALTY_GENERIC_DOC_LOW_CONTEXT_MATCH = -0.1;

      queryEmbedding = precomputedQueryEmbedding || (await calculateQueryEmbedding(queryText));
      if (precomputedQueryEmbedding) {
        debug(`[CACHE] Using pre-computed query embedding for reranking, dimensions: ${queryEmbedding?.length || 'null'}`);
      } else {
        debug(`[CACHE] Query embedding calculated for reranking, dimensions: ${queryEmbedding?.length || 'null'}`);
      }

      // OPTIMIZATION 1: Batch calculate missing H1 embeddings
      const uniqueH1Titles = new Set();
      const h1TitlesToCalculate = [];

      for (const result of finalResults) {
        const docH1 = result.document_title;
        if (docH1 && !uniqueH1Titles.has(docH1)) {
          uniqueH1Titles.add(docH1);
          if (!h1EmbeddingCache.has(docH1)) {
            h1TitlesToCalculate.push(docH1);
          }
        }
      }

      // Batch calculate H1 embeddings for cache misses
      if (h1TitlesToCalculate.length > 0) {
        debug(`[OPTIMIZATION] Batch calculating ${h1TitlesToCalculate.length} H1 embeddings`);
        const h1Embeddings = await calculateEmbeddingBatch(h1TitlesToCalculate);
        for (let i = 0; i < h1TitlesToCalculate.length; i++) {
          if (h1Embeddings[i]) {
            h1EmbeddingCache.set(h1TitlesToCalculate[i], h1Embeddings[i]);
          }
        }
      }

      // OPTIMIZATION 2: Batch calculate missing document contexts
      const uniqueDocPaths = new Set();
      const docContextsToCalculate = [];

      for (const result of finalResults) {
        const docPath = result.path;
        if (docPath && !uniqueDocPaths.has(docPath)) {
          uniqueDocPaths.add(docPath);
          if (!documentContextCache.has(docPath)) {
            docContextsToCalculate.push({ docPath, docH1: result.document_title, result });
          }
        }
      }

      // Batch calculate document contexts for cache misses
      if (docContextsToCalculate.length > 0) {
        debug(`[OPTIMIZATION] Batch calculating ${docContextsToCalculate.length} document contexts`);
        const contextPromises = docContextsToCalculate.map(async ({ docPath, docH1, result }) => {
          const context = await inferContextFromDocumentContent(
            docPath,
            docH1,
            [result],
            queryContextForReranking.language || 'typescript'
          );
          return { docPath, context };
        });

        const contextResults = await Promise.all(contextPromises);
        for (const { docPath, context } of contextResults) {
          documentContextCache.set(docPath, context);
        }
      }

      // OPTIMIZATION 3: Parallelize main reranking calculations
      const rerankingPromises = finalResults.map(async (result) => {
        let chunkInitialScore = result.similarity * WEIGHT_INITIAL_SIM;
        let contextMatchBonus = 0;
        let h1RelevanceBonus = 0;
        let genericDocPenalty = 0;
        let pathSimilarityScore = 0;

        const docPath = result.path;
        const docH1 = result.document_title;

        // Context should now be cached from batch operation above
        const chunkParentDocContext = documentContextCache.get(docPath);

        if (
          chunkParentDocContext &&
          queryContextForReranking.area !== 'Unknown' &&
          chunkParentDocContext.area !== 'Unknown' &&
          chunkParentDocContext.area !== 'General'
        ) {
          if (queryContextForReranking.area === chunkParentDocContext.area) {
            contextMatchBonus += HEAVY_BOOST_SAME_AREA;
            if (queryContextForReranking.dominantTech && chunkParentDocContext.dominantTech) {
              const techIntersection = queryContextForReranking.dominantTech.some((tech) =>
                chunkParentDocContext.dominantTech.map((t) => t.toLowerCase()).includes(tech.toLowerCase())
              );
              if (techIntersection) {
                contextMatchBonus += MODERATE_BOOST_TECH_MATCH;
              }
            }
          } else if (queryContextForReranking.area !== 'GeneralJS_TS') {
            contextMatchBonus += HEAVY_PENALTY_AREA_MISMATCH;
          }
        }

        // H1 embedding should now be cached from batch operation above
        if (docH1) {
          const h1Emb = h1EmbeddingCache.get(docH1);
          if (h1Emb && queryEmbedding) {
            h1RelevanceBonus = calculateCosineSimilarity(queryEmbedding, h1Emb) * WEIGHT_H1_CHUNK_RERANK;
          }
        }

        if (chunkParentDocContext && chunkParentDocContext.isGeneralPurposeReadmeStyle) {
          const contextMatchScore = queryContextForReranking.area === chunkParentDocContext.area ? 1.0 : 0.0;
          if (contextMatchScore < 0.4) {
            genericDocPenalty = PENALTY_GENERIC_DOC_LOW_CONTEXT_MATCH;
            debug(
              `[findSimilarDocumentation] Doc ${result.path} is generic with low context match, applying penalty: ${genericDocPenalty}`
            );
          }
        }

        if (queryFilePath && result.path) {
          pathSimilarityScore = calculatePathSimilarity(queryFilePath, result.path) * 0.1;
        }

        const finalScore = chunkInitialScore + contextMatchBonus + h1RelevanceBonus + pathSimilarityScore + genericDocPenalty;
        result.similarity = Math.max(0, Math.min(1, finalScore));
        result.reranked = true;

        return result;
      });

      // Wait for all reranking calculations to complete
      await Promise.all(rerankingPromises);

      // Log debug info for first few results
      for (let i = 0; i < Math.min(5, finalResults.length); i++) {
        const result = finalResults[i];
        debug(`[SophisticatedRerank] ${result.path?.substring(0, 30)}... Final=${result.similarity.toFixed(4)}`);
      }

      finalResults.sort((a, b) => b.similarity - a.similarity);
      debug(`[CACHE STATS] Document context cache size: ${documentContextCache.size}`);
      debug(`[CACHE STATS] H1 embedding cache size: ${h1EmbeddingCache.size}`);
      debug('Sophisticated contextual reranking of documentation complete.');
    }

    finalResults.sort((a, b) => b.similarity - a.similarity);
    if (finalResults.length > limit) {
      finalResults = finalResults.slice(0, limit);
    }

    console.log(chalk.green(`Returning ${finalResults.length} documentation results`));
    return finalResults;
  } catch (error) {
    console.error(chalk.red(`Error in findSimilarDocumentation: ${error.message}`), error);
    return [];
  }
};

/**
 * Find similar code using native LanceDB hybrid search
 * Optimized implementation using LanceDB's built-in vector + FTS + RRF
 * @param {string} queryText - The text query
 * @param {Object} options - Search options
 * @returns {Promise<Array<object>>} Search results
 */
export const findSimilarCode = async (queryText, options = {}) => {
  const {
    limit = 5,
    similarityThreshold = 0.7,
    includeProjectStructure = false,
    queryFilePath = null,
    projectPath = process.cwd(), // Add project path for filtering
    isTestFile = null,
    precomputedQueryEmbedding = null,
  } = options;

  console.log(chalk.cyan(`Native hybrid code search - limit: ${limit}, threshold: ${similarityThreshold}, isTestFile: ${isTestFile}`));

  try {
    if (!queryText?.trim()) {
      console.warn(chalk.yellow('Empty query text provided'));
      return [];
    }

    const db = await getDB();
    const tableName = FILE_EMBEDDINGS_TABLE;
    const table = await getTable(tableName);

    if (!table) {
      console.warn(chalk.yellow(`Table ${tableName} not found`));
      return [];
    }

    // Native hybrid search with automatic vector + FTS + RRF
    console.log(chalk.cyan('Performing native hybrid search for code...'));
    let query = table.search(queryText).nearestToText(queryText);

    // Add filtering conditions
    const conditions = [];
    conditions.push("type != 'directory-structure'");

    // Add filtering for test files.
    if (isTestFile !== null) {
      if (isTestFile) {
        // Only include test files
        conditions.push(`(path LIKE '%.test.%' OR path LIKE '%.spec.%' OR path LIKE '%_test.py' OR path LIKE 'test_%.py')`);
        console.log(chalk.blue(`Filtering to include only test files.`));
      } else {
        // Exclude test files
        conditions.push(
          `(path NOT LIKE '%.test.%' AND path NOT LIKE '%.spec.%' AND path NOT LIKE '%_test.py' AND path NOT LIKE 'test_%.py')`
        );
        console.log(chalk.blue(`Filtering to exclude test files.`));
      }
    }

    // Resolve project path once for use in multiple places
    const resolvedProjectPath = path.resolve(projectPath);

    // Exclude the file being reviewed if queryFilePath is provided
    if (queryFilePath) {
      const normalizedQueryPath = path.resolve(queryFilePath);
      // Add condition to exclude the file being reviewed
      const escapedPath = normalizedQueryPath.replace(/'/g, "''");
      conditions.push(`path != '${escapedPath}'`);

      // Also check for relative path variants to be thorough
      const relativePath = path.relative(resolvedProjectPath, normalizedQueryPath);
      if (relativePath && !relativePath.startsWith('..')) {
        const escapedRelativePath = relativePath.replace(/'/g, "''");
        conditions.push(`path != '${escapedRelativePath}'`);
      }

      debug(`Excluding file being reviewed from similar code search: ${normalizedQueryPath}`);
    }

    // Add project path filtering if the field exists in the schema
    // Check if the table has project_path field
    try {
      const tableSchema = await table.schema;
      if (tableSchema && tableSchema.fields) {
        const hasProjectPathField = tableSchema.fields.some((field) => field.name === 'project_path');

        if (hasProjectPathField) {
          // Use exact match for project path
          conditions.push(`project_path = '${resolvedProjectPath.replace(/'/g, "''")}'`);
          debug(`Filtering by project_path: ${resolvedProjectPath}`);
        }
      }
    } catch (schemaError) {
      debug(`Could not check schema for project_path field: ${schemaError.message}`);
      // Continue without project_path filtering in query
    }

    if (conditions.length > 0) {
      query = query.where(conditions.join(' AND '));
    }

    const results = await query.limit(Math.max(limit * 3, 20)).toArray();

    console.log(chalk.green(`Native hybrid search returned ${results.length} results`));

    // OPTIMIZATION: Batch file existence checks for better performance
    const resultsToCheck = [];
    const projectMatchMap = new Map();

    // First pass: collect files that need existence checking
    for (let i = 0; i < results.length; i++) {
      const result = results[i];

      // Use project_path field if available (new schema)
      if (result.project_path) {
        projectMatchMap.set(i, result.project_path === resolvedProjectPath);
        continue;
      }

      // Fallback for old embeddings without project_path field
      if (!result.path && !result.original_document_path) {
        projectMatchMap.set(i, false);
        continue;
      }

      const filePath = result.original_document_path || result.path;
      try {
        // Check if this result belongs to the current project
        // First try as absolute path
        if (path.isAbsolute(filePath)) {
          projectMatchMap.set(i, filePath.startsWith(resolvedProjectPath));
          continue;
        }

        // For relative paths, check if the file actually exists in the project
        const absolutePath = path.resolve(resolvedProjectPath, filePath);

        // Verify the path is within project bounds
        if (absolutePath.startsWith(resolvedProjectPath)) {
          // Mark for batch existence check
          resultsToCheck.push({ result, index: i, absolutePath });
        } else {
          projectMatchMap.set(i, false);
        }
      } catch (error) {
        debug(`Error filtering result for project: ${error.message}`);
        projectMatchMap.set(i, false);
      }
    }

    // Batch check file existence for better performance
    if (resultsToCheck.length > 0) {
      debug(`[OPTIMIZATION] Batch checking existence of ${resultsToCheck.length} files`);
      const existencePromises = resultsToCheck.map(async ({ result, index, absolutePath }) => {
        try {
          await fs.promises.access(absolutePath, fs.constants.F_OK);
          return { index, exists: true };
        } catch {
          debug(`Filtering out non-existent file: ${result.original_document_path || result.path}`);
          return { index, exists: false };
        }
      });

      const existenceResults = await Promise.all(existencePromises);
      for (const { index, exists } of existenceResults) {
        projectMatchMap.set(index, exists);
      }
    }

    // Filter results based on project match using the map
    const projectFilteredResults = results.filter((result, index) => projectMatchMap.get(index) === true);

    console.log(chalk.blue(`Filtered to ${projectFilteredResults.length} results from current project`));

    // Map results to expected format
    let finalResults = projectFilteredResults.map((result) => {
      // Handle different score types from native hybrid search
      let similarity;
      if (result._distance !== undefined) {
        // Vector search distance (0 = perfect match, higher = less similar)
        // Apply more precise normalization to avoid all scores being 1.000
        similarity = Math.max(0, Math.min(1, Math.exp(-result._distance * 2)));
      } else if (result._score !== undefined) {
        // FTS or hybrid score - normalize to 0-1 range with better scaling
        similarity = Math.max(0, Math.min(1, result._score / Math.max(result._score, 1)));
      } else {
        // Fallback
        similarity = 0.5;
      }

      // Determine if this is a documentation file using the utility function
      const isDocumentation = isDocumentationFile(result.path, result.language);

      return {
        similarity,
        type: 'file',
        content: result.content,
        path: result.path,
        file_path: result.path,
        language: result.language,
        reranked: false,
        isDocumentation, // Add the missing flag that cag-analyzer expects
      };
    });

    // Apply similarity threshold
    finalResults = finalResults.filter((result) => result.similarity >= similarityThreshold);

    // PERFORMANCE FIX: Calculate query embedding once and reuse for both reranking and project structure
    let queryEmbedding = null;

    // Include project structure if requested (project-specific)
    if (includeProjectStructure) {
      try {
        const fileTable = await getTable(FILE_EMBEDDINGS_TABLE);
        if (fileTable) {
          // Look for project-specific structure ID
          const projectStructureId = `__project_structure__${path.basename(resolvedProjectPath)}`;
          let structureResults = await fileTable.query().where(`id = '${projectStructureId}'`).limit(1).toArray();

          // Fall back to generic project structure if project-specific one doesn't exist
          if (structureResults.length === 0) {
            structureResults = await fileTable.query().where("id = '__project_structure__'").limit(1).toArray();
          }

          if (structureResults.length > 0) {
            const structureRecord = structureResults[0];
            if (structureRecord.vector) {
              // PERFORMANCE FIX: Use pre-computed query embedding if available, otherwise calculate once
              if (!queryEmbedding) {
                queryEmbedding = precomputedQueryEmbedding || (await calculateQueryEmbedding(queryText));
                if (precomputedQueryEmbedding) {
                  debug(
                    `[CACHE] Using pre-computed query embedding for project structure, dimensions: ${queryEmbedding?.length || 'null'}`
                  );
                } else {
                  debug(`[CACHE] Query embedding calculated for project structure, dimensions: ${queryEmbedding?.length || 'null'}`);
                }
              } else {
                debug(`[CACHE] Query embedding reused from reranking for project structure`);
              }
              if (queryEmbedding) {
                const similarity = calculateCosineSimilarity(queryEmbedding, Array.from(structureRecord.vector));
                if (similarity > 0.5) {
                  finalResults.push({
                    similarity,
                    type: 'project-structure',
                    content: structureRecord.content,
                    path: structureRecord.path,
                    file_path: structureRecord.path,
                    language: 'text',
                    reranked: false,
                  });
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn(chalk.yellow(`Project structure inclusion failed: ${error.message}`));
      }
    }

    // Final sorting and limiting
    finalResults.sort((a, b) => b.similarity - a.similarity);
    if (finalResults.length > limit) {
      finalResults = finalResults.slice(0, limit);
    }

    console.log(chalk.green(`Returning ${finalResults.length} optimized hybrid search results`));
    return finalResults;
  } catch (error) {
    console.error(chalk.red(`Error in optimized findSimilarCode: ${error.message}`), error);
    return [];
  }
};

/**
 * Calculate cosine similarity between two vectors
 */
export const calculateCosineSimilarity = (vecA, vecB) => {
  if (!vecA || !vecB || !Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
    // Add more robust checks
    debug(`Invalid input for cosine similarity: vecA length=${vecA?.length}, vecB length=${vecB?.length}`);
    return 0;
  }
  let dotProduct = 0,
    normA = 0,
    normB = 0;
  const len = vecA.length; // Cache length
  for (let i = 0; i < len; i++) {
    const a = vecA[i]; // Cache values
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  // Check for zero vectors, handle potential floating point inaccuracies
  if (normA <= 1e-9 || normB <= 1e-9) {
    return 0;
  }
  // Clamp result to handle potential floating point errors leading to > 1 or < -1
  return Math.max(-1.0, Math.min(1.0, dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))));
};

// --- Cleanup and Utility Functions ---

/**
 * Cleanup resources
 */
export async function cleanup() {
  try {
    if (dbConnection) {
      console.log('Closing LanceDB connection...');
      await dbConnection.close();
      dbConnection = null;
      console.log('LanceDB connection closed.');
    }
    embeddingModel = null; // Allow embedding model to be GC'd if not held elsewhere
    modelInitialized = false; // Reset initialization flag
    modelInitializationPromise = null; // Reset initialization promise
    tablesInitialized = false; // Reset tables initialization flag
    // Clear caches to free memory
    clearCaches();
    console.log(chalk.green('Embeddings resources potentially released (connection nulled).'));
  } catch (error) {
    console.error(`Error during cleanup: ${error.message}`);
  }
}

/**
 * Clear all embedding and context caches
 * This prevents expensive recomputation during reranking by caching:
 * - Document context analysis (area, technologies, document type)
 * - H1 title embeddings (not stored in database, calculated on-demand)
 */
function clearCaches() {
  const docCacheSize = documentContextCache.size;
  const h1CacheSize = h1EmbeddingCache.size;
  const embeddingCacheSize = embeddingCache.size;

  documentContextCache.clear();
  h1EmbeddingCache.clear();
  embeddingCache.clear();

  console.log(
    chalk.yellow(
      `[CACHE] Cleared caches - Document contexts: ${docCacheSize}, H1 embeddings: ${h1CacheSize}, Embeddings: ${embeddingCacheSize}`
    )
  );
}

/**
 * Clear embeddings for the current project only
 * @param {string} projectPath - The base path of the current project (defaults to process.cwd())
 */
async function clearProjectEmbeddings(projectPath = process.cwd()) {
  let db = null;
  try {
    const resolvedProjectPath = path.resolve(projectPath);
    const projectName = path.basename(resolvedProjectPath);
    console.log(chalk.cyan(`Clearing embeddings for project: ${resolvedProjectPath} (${projectName})`));

    // Ensure directory exists before connecting
    if (!fs.existsSync(LANCEDB_PATH)) {
      console.log(chalk.yellow('LanceDB directory does not exist, nothing to clear.'));
      return true;
    }

    db = await lancedb.connect(LANCEDB_PATH);
    const tableNames = await db.tableNames();
    let deletedCount = 0;

    // Clear file embeddings for this project
    if (tableNames.includes(FILE_EMBEDDINGS_TABLE)) {
      const fileTable = await db.openTable(FILE_EMBEDDINGS_TABLE);

      // Get all records for this project (paths that start with relative paths from this project)
      const allRecords = await fileTable.query().toArray();
      const projectRecords = allRecords.filter((record) => {
        if (!record.path) return false;

        // Check for project-specific structure
        if (record.id === `__project_structure__${projectName}` || record.id === '__project_structure__') {
          return true;
        }

        // Check if this record belongs to the current project
        // Records store relative paths, so we need to check if they would resolve to files in this project
        try {
          const absolutePath = path.resolve(resolvedProjectPath, record.path);
          return absolutePath.startsWith(resolvedProjectPath);
        } catch (error) {
          return false;
        }
      });

      if (projectRecords.length > 0) {
        console.log(chalk.blue(`Found ${projectRecords.length} file embeddings for this project`));

        // Delete records by ID
        for (const record of projectRecords) {
          try {
            await fileTable.delete(`id = '${record.id.replace(/'/g, "''")}'`);
            deletedCount++;
          } catch (deleteError) {
            console.warn(chalk.yellow(`Warning: Could not delete record ${record.id}: ${deleteError.message}`));
          }
        }

        console.log(chalk.green(`Deleted ${deletedCount} file embeddings for this project`));
      } else {
        console.log(chalk.yellow('No file embeddings found for this project'));
      }
    }

    // Clear document chunk embeddings for this project
    if (tableNames.includes(DOCUMENT_CHUNK_TABLE)) {
      const docTable = await db.openTable(DOCUMENT_CHUNK_TABLE);

      // Delete document chunks by original_document_path
      const allDocRecords = await docTable.query().toArray();
      const projectDocRecords = allDocRecords.filter((record) => {
        if (!record.original_document_path) return false;

        try {
          const absolutePath = path.resolve(resolvedProjectPath, record.original_document_path);
          return absolutePath.startsWith(resolvedProjectPath);
        } catch (error) {
          return false;
        }
      });

      if (projectDocRecords.length > 0) {
        console.log(chalk.blue(`Found ${projectDocRecords.length} document chunk embeddings for this project`));

        for (const record of projectDocRecords) {
          try {
            await docTable.delete(`id = '${record.id.replace(/'/g, "''")}'`);
            deletedCount++;
          } catch (deleteError) {
            console.warn(chalk.yellow(`Warning: Could not delete document chunk ${record.id}: ${deleteError.message}`));
          }
        }

        console.log(chalk.green(`Deleted ${projectDocRecords.length} document chunk embeddings for this project`));
      } else {
        console.log(chalk.yellow('No document chunk embeddings found for this project'));
      }
    }

    if (deletedCount > 0) {
      console.log(chalk.green(`Successfully cleared ${deletedCount} embeddings for project: ${resolvedProjectPath}`));
    } else {
      console.log(chalk.yellow(`No embeddings found for project: ${resolvedProjectPath}`));
    }

    return true;
  } catch (error) {
    console.error(chalk.red(`Error clearing project embeddings: ${error.message}`), error);
    throw error;
  }
}

/**
 * Clear embeddings by dropping tables (affects all projects - use with caution)
 */
export async function clearAllEmbeddings() {
  let db = null; // Use local variable for connection
  try {
    console.log(chalk.cyan('Clearing ALL embeddings by dropping tables...'));
    console.log(chalk.red('WARNING: This will affect all projects on this machine!'));

    // Ensure directory exists before connecting
    if (!fs.existsSync(LANCEDB_PATH)) {
      console.log(chalk.yellow('LanceDB directory does not exist, nothing to clear.'));
      return true;
    }
    db = await lancedb.connect(LANCEDB_PATH); // Connect directly
    const tableNames = await db.tableNames();
    let droppedCount = 0;

    for (const tableName of [FILE_EMBEDDINGS_TABLE, DOCUMENT_CHUNK_TABLE]) {
      if (tableNames.includes(tableName)) {
        console.log(chalk.yellow(`Dropping table ${tableName}...`));
        await db.dropTable(tableName);
        console.log(chalk.green(`Table ${tableName} dropped.`));
        droppedCount++;
      } else {
        console.log(chalk.yellow(`Table ${tableName} does not exist.`));
      }
    }
    if (droppedCount > 0) {
      console.log(chalk.green('All embedding tables have been dropped.'));
      console.log(chalk.yellow('Run the embedding generation process again to recreate tables.'));
    } else {
      console.log(chalk.green('No embedding tables found to drop.'));
    }
    dbConnection = null; // <<< Force connection to be re-established on next getDB() call
    tablesInitialized = false; // Reset tables initialization flag since tables were dropped
    return true;
  } catch (error) {
    console.error(chalk.red(`Error clearing embeddings: ${error.message}`), error);
    dbConnection = null; // Also nullify on error to be safe for next attempt
    tablesInitialized = false; // Reset tables initialization flag on error
    throw error; // Re-throw
  }
}

/**
 * Clear embeddings (backward compatibility wrapper)
 * @param {string} projectPath - Path to the project
 * @returns {Promise<boolean>} True if successful
 */
export async function clearEmbeddings(projectPath = process.cwd()) {
  return clearProjectEmbeddings(projectPath);
}

// ============================================================================
// PUBLIC API FUNCTIONS
// ============================================================================

/**
 * Get singleton project embeddings interface
 * @param {string} projectPath - Path to the project
 * @returns {Object} Project embeddings interface
 */
export function getProjectEmbeddings(projectPath = process.cwd()) {
  if (projectEmbeddingsCache) return projectEmbeddingsCache;

  // Create project-specific wrappers
  const projectSpecificSimilaritySearch = (queryText, options = {}) => {
    return findSimilarCode(queryText, { ...options, projectPath });
  };

  const projectSpecificGenerateEmbeddings = (filePaths, options = {}) => {
    return processBatchEmbeddings(filePaths, { ...options, baseDir: projectPath });
  };

  projectEmbeddingsCache = {
    generateEmbeddings: projectSpecificGenerateEmbeddings,
    similaritySearch: projectSpecificSimilaritySearch,
    clearEmbeddings: clearProjectEmbeddings,
    getStats: async () => {
      const stats = { totalCount: 0, dimensions: EMBEDDING_DIMENSIONS, tables: {}, lastUpdated: null };
      try {
        // Use getDB to ensure DB is initialized if needed, but handle potential errors
        let db;
        try {
          db = await getDB();
        } catch (dbInitError) {
          console.warn(chalk.yellow(`Could not initialize DB for getStats: ${dbInitError.message}`));
          return stats; // Return empty stats if DB init fails
        }

        const tableNames = await db.tableNames();
        debug(`[getStats] Found tables: ${tableNames.join(', ')}`);
        let total = 0;
        for (const tableName of [FILE_EMBEDDINGS_TABLE, DOCUMENT_CHUNK_TABLE]) {
          stats.tables[tableName] = 0; // Initialize count
          if (tableNames.includes(tableName)) {
            try {
              const table = await getTable(tableName); // Use getTable which handles non-existence
              if (table) {
                const count = await table.countRows();
                stats.tables[tableName] = count;
                total += count;
                debug(`[getStats] Count for ${tableName}: ${count}`);
              }
            } catch (countError) {
              console.warn(chalk.yellow(`Could not count rows for table ${tableName}: ${countError.message}`));
            }
          }
        }
        stats.totalCount = total;
        try {
          // Check if DB path exists before stating
          if (fs.existsSync(LANCEDB_PATH)) {
            stats.lastUpdated = fs.statSync(LANCEDB_PATH).mtime;
          }
        } catch (statError) {
          debug(`[getStats] Could not get stats for DB path: ${statError.message}`);
        }
      } catch (error) {
        console.error(chalk.red(`Error getting stats: ${error.message}`), error);
      }
      debug(`[getStats] Returning stats: ${JSON.stringify(stats)}`);
      return stats;
    },
  };
  return projectEmbeddingsCache;
}

/**
 * Get PR Comments table from database
 * @param {string} projectPath - Project path for context
 * @returns {Promise<lancedb.Table|null>} PR comments table or null
 */
export async function getPRCommentsTable(projectPath = process.cwd()) {
  try {
    const db = await getDB();
    return await getTable(PR_COMMENTS_TABLE);
  } catch (error) {
    console.error(chalk.red(`Error getting PR comments table: ${error.message}`));
    return null;
  }
}

/**
 * Export constants for use by PR history modules
 */
export const CONSTANTS = {
  EMBEDDING_DIMENSIONS,
  PR_COMMENTS_TABLE,
  LANCEDB_PATH,
};

// ============================================================================
// MODULE EXPORTS SUMMARY
// ============================================================================
/**
 * Export approach for this module:
 * - All public functions are exported directly at their definition using 'export function' or 'export const'
 * - Helper/internal functions are not exported and remain module-private
 * - When adding new functions, export them directly at their definition if they're meant to be public
 *
 * Public API:
 * - calculateEmbedding: Generate embedding for a single text
 * - calculateQueryEmbedding: Generate embedding for a query text
 * - generateFileEmbeddings: Generate and store embeddings for a file
 * - generateDirectoryStructure: Generate directory structure string
 * - generateDirectoryStructureEmbedding: Generate and store directory structure embedding
 * - processBatchEmbeddings: Process embeddings for multiple files
 * - findSimilarCode: Find similar code snippets
 * - findRelevantDocs: Find relevant documentation files based on query text
 * - calculateCosineSimilarity: Calculate similarity between vectors
 * - cleanup: Close database connections
 * - clearCaches: Clear all caches
 * - clearProjectEmbeddings: Clear project-specific embeddings
 * - clearAllEmbeddings: Clear all embeddings
 * - clearEmbeddings: Backward compatibility wrapper
 * - getProjectEmbeddings: Get project embeddings interface
 */
