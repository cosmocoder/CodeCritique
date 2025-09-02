/**
 * MobileBERT Tokenizer Utility
 *
 * Shared tokenizer functionality for MobileBERT models to handle token counting
 * and text truncation while staying within the 512 token limit.
 */

import { AutoTokenizer } from '@huggingface/transformers';
import chalk from 'chalk';

// Shared tokenizer instance and initialization state
let tokenizer = null;
let isInitializing = false;
let initializationPromise = null;

/**
 * Initialize and get the MobileBERT tokenizer (singleton pattern)
 * @returns {Promise<AutoTokenizer|null>} Tokenizer instance or null if initialization fails
 */
async function getTokenizer() {
  // If already initialized, return immediately
  if (tokenizer) return tokenizer;

  // If currently initializing, wait for the existing initialization
  if (isInitializing && initializationPromise) {
    return await initializationPromise;
  }

  // Start initialization
  isInitializing = true;
  initializationPromise = _initializeTokenizer();

  try {
    tokenizer = await initializationPromise;
    return tokenizer;
  } finally {
    isInitializing = false;
    initializationPromise = null;
  }
}

/**
 * Internal tokenizer initialization
 * @returns {Promise<AutoTokenizer|null>}
 */
async function _initializeTokenizer() {
  try {
    console.log(chalk.blue('Initializing MobileBERT tokenizer...'));
    const tok = await AutoTokenizer.from_pretrained('Xenova/mobilebert-uncased-mnli');
    console.log(chalk.green('✓ MobileBERT tokenizer initialized successfully'));
    return tok;
  } catch (error) {
    console.warn(chalk.yellow('⚠ Failed to initialize tokenizer, falling back to character estimation'), error.message);
    return null;
  }
}

/**
 * Count exact tokens for MobileBERT model
 * @param {string} text - Text to count tokens for
 * @returns {Promise<number>} Number of tokens
 */
async function countTokens(text) {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  try {
    const tok = await getTokenizer();
    if (!tok) {
      // Fallback to character estimation if tokenizer fails
      return Math.ceil(text.length / 3); // Conservative estimate for MobileBERT
    }

    const encoded = await tok.encode(text);
    return encoded.length;
  } catch (error) {
    console.warn(chalk.gray('Token counting failed, using character estimation'), error.message);
    return Math.ceil(text.length / 3);
  }
}

/**
 * Truncate text to fit within token limit while preserving important content
 * @param {string} text - Text to truncate
 * @param {number} maxTokens - Maximum tokens allowed (default: 450 for MobileBERT safety)
 * @returns {Promise<string>} Truncated text
 */
export async function truncateToTokenLimit(text, maxTokens = 450) {
  if (!text) return '';

  const currentTokens = await countTokens(text);
  if (currentTokens <= maxTokens) {
    return text;
  }

  // Binary search to find the right length
  let left = 0;
  let right = text.length;
  let bestLength = 0;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const truncated = text.substring(0, mid);
    const tokens = await countTokens(truncated);

    if (tokens <= maxTokens) {
      bestLength = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  // Ensure we don't cut off in the middle of a word
  let result = text.substring(0, bestLength);
  const lastSpaceIndex = result.lastIndexOf(' ');
  if (lastSpaceIndex > bestLength * 0.8) {
    result = result.substring(0, lastSpaceIndex);
  }

  return result;
}

/**
 * Clean up tokenizer resources
 */
export async function cleanupTokenizer() {
  if (tokenizer) {
    try {
      if (typeof tokenizer.dispose === 'function') {
        await tokenizer.dispose();
      }
      tokenizer = null;
      console.log(chalk.green('✓ MobileBERT tokenizer resources cleaned up'));
    } catch (error) {
      console.warn(chalk.yellow('⚠ Error cleaning up tokenizer:'), error.message);
      tokenizer = null;
    }
  }
}
