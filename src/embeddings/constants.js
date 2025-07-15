/**
 * Embeddings Constants
 *
 * This module contains all shared constants used across the embeddings system.
 * These constants are extracted from the original embeddings.js for better modularity.
 */

import path from 'node:path';

// FastEmbed Model Configuration
export const EMBEDDING_DIMENSIONS = 384; // Dimension for bge-small-en-v1.5
export const MODEL_NAME_STRING = 'bge-small-en-v1.5';

// System Constants
export const MAX_RETRIES = 3;

// Directory Names
export const LANCEDB_DIR_NAME = '.ai-review-lancedb';
export const FASTEMBED_CACHE_DIR_NAME = '.ai-review-fastembed-cache';

// Directory Paths
export const LANCEDB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), LANCEDB_DIR_NAME);
export const FASTEMBED_CACHE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), FASTEMBED_CACHE_DIR_NAME);

// Database Table Names
export const TABLE_NAMES = {
  FILE_EMBEDDINGS: 'file_embeddings',
  DOCUMENT_CHUNK: 'document_chunk_embeddings',
  PR_COMMENTS: 'pr_comments',
};

// Cache Configuration
export const MAX_EMBEDDING_CACHE_SIZE = 1000;
