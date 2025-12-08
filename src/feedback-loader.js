/**
 * Feedback Loader Module
 *
 * Loads and processes feedback artifacts from previous PR review runs.
 * Used by CLI tool to filter dismissed issues and improve analysis quality.
 *
 * Features:
 * - Semantic similarity comparison using embeddings for accurate issue matching
 * - Fallback to word-based similarity when embeddings are not available
 * - Supports comparing LLM-generated text that may be lexically different but semantically similar
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { getDefaultEmbeddingsSystem } from './embeddings/factory.js';
import { calculateCosineSimilarity } from './embeddings/similarity-calculator.js';

/**
 * Load feedback data from artifacts directory
 *
 * @param {string} feedbackPath - Path to feedback artifacts directory
 * @param {Object} options - Loading options
 * @returns {Promise<Object>} Loaded feedback data
 */
export async function loadFeedbackData(feedbackPath, options = {}) {
  const { verbose = false } = options;

  if (!feedbackPath) {
    if (verbose) console.log(chalk.gray('No feedback path provided'));
    return {};
  }

  try {
    if (!fs.existsSync(feedbackPath)) {
      if (verbose) console.log(chalk.gray(`Feedback directory not found: ${feedbackPath}`));
      return {};
    }

    if (verbose) console.log(chalk.cyan(`📁 Loading feedback from: ${feedbackPath}`));

    // Look for feedback files in the directory
    const feedbackFiles = fs.readdirSync(feedbackPath).filter((file) => file.startsWith('feedback-') && file.endsWith('.json'));

    if (feedbackFiles.length === 0) {
      if (verbose) console.log(chalk.gray('No feedback files found'));
      return {};
    }

    if (verbose) console.log(chalk.cyan(`📥 Found ${feedbackFiles.length} feedback file(s)`));

    // Load and merge all feedback files
    const allFeedback = {};
    let totalItems = 0;

    for (const file of feedbackFiles) {
      try {
        const filePath = path.join(feedbackPath, file);
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const feedbackData = JSON.parse(fileContent);

        // Merge feedback data
        if (feedbackData.feedback) {
          Object.assign(allFeedback, feedbackData.feedback);
          const itemCount = Object.keys(feedbackData.feedback).length;
          totalItems += itemCount;
          if (verbose) {
            console.log(chalk.cyan(`📋 Loaded feedback from ${file}: ${itemCount} items`));
          }
        }
      } catch (parseError) {
        console.log(chalk.yellow(`⚠️ Error parsing feedback file ${file}: ${parseError.message}`));
      }
    }

    if (totalItems > 0) {
      if (verbose) {
        console.log(chalk.green(`✅ Successfully loaded ${totalItems} feedback items total`));
      }
      return allFeedback;
    }

    return {};
  } catch (error) {
    console.log(chalk.red(`❌ Error loading feedback data: ${error.message}`));
    return {};
  }
}

// ============================================================================
// SEMANTIC SIMILARITY USING EXISTING EMBEDDINGS SYSTEM
// ============================================================================

// Use the existing embeddings system from the codebase for semantic similarity
// This avoids code duplication with custom-documents.js and pr-history/comment-processor.js
let embeddingsSystem = null;
let semanticSimilarityInitialized = false;
let semanticSimilarityAvailable = false;

/**
 * Initialize semantic similarity using the existing embeddings system
 * This should be called early in the application lifecycle if semantic similarity is desired.
 *
 * @returns {Promise<void>}
 */
export async function initializeSemanticSimilarity() {
  if (semanticSimilarityInitialized) {
    return;
  }

  try {
    embeddingsSystem = getDefaultEmbeddingsSystem();
    await embeddingsSystem.initialize();
    semanticSimilarityInitialized = true;
    semanticSimilarityAvailable = true;
    console.log(chalk.green('[FeedbackLoader] Semantic similarity initialized using embeddings system'));
  } catch (error) {
    console.log(chalk.yellow(`[FeedbackLoader] Semantic similarity initialization failed: ${error.message}`));
    semanticSimilarityAvailable = false;
  }
}

/**
 * Check if semantic similarity is available
 * @returns {boolean} True if semantic similarity can be used
 */
export function isSemanticSimilarityAvailable() {
  return semanticSimilarityAvailable && embeddingsSystem !== null;
}

/**
 * Calculate semantic similarity between two texts using embeddings
 * Uses the existing embeddings system that's also used by content-retrieval and pr-history
 *
 * @param {string} text1 - First text
 * @param {string} text2 - Second text
 * @returns {Promise<number|null>} Similarity score (0-1) or null if calculation failed
 */
async function calculateSemanticSimilarity(text1, text2) {
  if (!text1 || !text2 || !isSemanticSimilarityAvailable()) {
    return null;
  }

  try {
    // Use the same embedding calculation as the rest of the codebase
    const [embedding1, embedding2] = await Promise.all([
      embeddingsSystem.calculateEmbedding(text1),
      embeddingsSystem.calculateEmbedding(text2),
    ]);

    if (!embedding1 || !embedding2) {
      return null;
    }

    // Use the shared cosine similarity function
    const similarity = calculateCosineSimilarity(embedding1, embedding2);
    // Cosine similarity ranges from -1 to 1, normalize to 0-1
    return (similarity + 1) / 2;
  } catch (error) {
    console.log(chalk.yellow(`[FeedbackLoader] Semantic similarity calculation failed: ${error.message}`));
    return null;
  }
}

// ============================================================================
// ISSUE SIMILARITY CHECKING
// ============================================================================

/**
 * Check if an issue should be skipped based on previous feedback
 * Uses semantic similarity when available, falls back to word-based similarity.
 *
 * @param {string} issueDescription - Description of the current issue
 * @param {Object} feedbackData - Loaded feedback data
 * @param {Object} options - Filtering options
 * @param {number} options.similarityThreshold - Threshold for considering issues similar (default: 0.7)
 * @param {boolean} options.verbose - Enable verbose logging
 * @param {boolean} options.useSemanticSimilarity - Use semantic similarity when available (default: true)
 * @returns {Promise<boolean>} True if issue should be skipped
 */
export async function shouldSkipSimilarIssue(issueDescription, feedbackData, options = {}) {
  const { similarityThreshold = 0.7, verbose = false, useSemanticSimilarity = true } = options;

  if (!feedbackData || Object.keys(feedbackData).length === 0) {
    return false;
  }

  // Check if similar issues were previously dismissed
  const dismissedIssues = Object.values(feedbackData).filter(
    (feedback) =>
      feedback?.overallSentiment === 'negative' ||
      feedback?.userReplies?.some(
        (reply) =>
          reply.body.toLowerCase().includes('false positive') ||
          reply.body.toLowerCase().includes('not relevant') ||
          reply.body.toLowerCase().includes('ignore') ||
          reply.body.toLowerCase().includes('resolved')
      )
  );

  if (dismissedIssues.length === 0) {
    return false;
  }

  // Determine if we should use semantic similarity
  const canUseSemanticSimilarity = useSemanticSimilarity && isSemanticSimilarityAvailable();

  if (verbose && canUseSemanticSimilarity) {
    console.log(chalk.cyan('🔍 Using semantic similarity for issue comparison'));
  }

  // Check similarity with dismissed issues
  for (const dismissed of dismissedIssues) {
    if (!dismissed.originalIssue) continue;

    let similarity;
    let similarityMethod;

    if (canUseSemanticSimilarity) {
      // Try semantic similarity first using existing embeddings system
      similarity = await calculateSemanticSimilarity(issueDescription, dismissed.originalIssue);
      similarityMethod = 'semantic';

      // Fall back to word similarity if semantic calculation failed
      if (similarity === null) {
        similarity = calculateWordSimilarity(issueDescription, dismissed.originalIssue);
        similarityMethod = 'word-based';
      }
    } else {
      // Use word-based similarity
      similarity = calculateWordSimilarity(issueDescription, dismissed.originalIssue);
      similarityMethod = 'word-based';
    }

    if (similarity > similarityThreshold) {
      if (verbose) {
        console.log(chalk.yellow(`⏭️ Skipping similar dismissed issue (${(similarity * 100).toFixed(1)}% ${similarityMethod} similarity)`));
        console.log(chalk.gray(`   Current: ${issueDescription.substring(0, 80)}...`));
        console.log(chalk.gray(`   Previous: ${dismissed.originalIssue.substring(0, 80)}...`));
      }
      return true;
    }
  }

  return false;
}

/**
 * Calculate combined similarity between two issue descriptions.
 * Uses both semantic and word-based similarity for robust comparison.
 *
 * @param {string} text1 - First text
 * @param {string} text2 - Second text
 * @param {Object} options - Options
 * @param {boolean} options.useSemanticSimilarity - Use semantic similarity when available (default: true)
 * @returns {Promise<{similarity: number, method: string}>} Similarity result with method used
 */
export async function calculateIssueSimilarity(text1, text2, options = {}) {
  const { useSemanticSimilarity = true } = options;

  if (!text1 || !text2) {
    return { similarity: 0, method: 'none' };
  }

  const canUseSemanticSimilarity = useSemanticSimilarity && isSemanticSimilarityAvailable();

  if (canUseSemanticSimilarity) {
    const semanticSimilarity = await calculateSemanticSimilarity(text1, text2);

    if (semanticSimilarity !== null) {
      // Also calculate word similarity for a hybrid score
      const wordSimilarity = calculateWordSimilarity(text1, text2);

      // Combine both scores with more weight on semantic similarity
      // This helps catch both semantically similar and lexically similar issues
      const combinedSimilarity = semanticSimilarity * 0.7 + wordSimilarity * 0.3;

      return {
        similarity: combinedSimilarity,
        method: 'hybrid',
        semanticScore: semanticSimilarity,
        wordScore: wordSimilarity,
      };
    }
  }

  // Fall back to word-based similarity
  return {
    similarity: calculateWordSimilarity(text1, text2),
    method: 'word-based',
  };
}

/**
 * Calculate word-based similarity between two strings using Jaccard similarity.
 * This is the fallback method when embeddings are not available.
 *
 * @param {string} text1 - First text
 * @param {string} text2 - Second text
 * @returns {number} Similarity score (0-1)
 */
export function calculateWordSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;

  // Normalize and tokenize
  const normalize = (text) =>
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Remove punctuation
      .split(/\s+/)
      .filter((word) => word.length > 2); // Filter short words

  const words1 = new Set(normalize(text1));
  const words2 = new Set(normalize(text2));

  if (words1.size === 0 || words2.size === 0) return 0;

  // Calculate Jaccard similarity (intersection over union)
  const intersection = [...words1].filter((word) => words2.has(word)).length;
  const union = new Set([...words1, ...words2]).size;

  return union > 0 ? intersection / union : 0;
}

/**
 * Extract dismissed issue patterns for LLM context
 *
 * @param {Object} feedbackData - Loaded feedback data
 * @param {Object} options - Extraction options
 * @returns {Array} Array of dismissed issue patterns
 */
export function extractDismissedPatterns(feedbackData, options = {}) {
  const { maxPatterns = 10, verbose = false } = options;

  if (!feedbackData || Object.keys(feedbackData).length === 0) {
    return [];
  }

  // Find dismissed issues with clear patterns
  const dismissedIssues = Object.values(feedbackData)
    .filter(
      (feedback) =>
        feedback?.overallSentiment === 'negative' ||
        feedback?.userReplies?.some(
          (reply) =>
            reply.body.toLowerCase().includes('false positive') ||
            reply.body.toLowerCase().includes('not relevant') ||
            reply.body.toLowerCase().includes('ignore')
        )
    )
    .map((feedback) => ({
      issue: feedback.originalIssue || 'Unknown issue',
      reason: feedback.userReplies?.[0]?.body?.substring(0, 100) || 'Negative feedback',
      sentiment: feedback.overallSentiment,
    }))
    .slice(0, maxPatterns);

  if (verbose && dismissedIssues.length > 0) {
    console.log(chalk.cyan(`📋 Extracted ${dismissedIssues.length} dismissed issue patterns for LLM context`));
  }

  return dismissedIssues;
}

/**
 * Generate LLM context about dismissed issues
 *
 * @param {Array} dismissedPatterns - Array of dismissed patterns
 * @returns {string} Context text for LLM
 */
export function generateFeedbackContext(dismissedPatterns) {
  if (!dismissedPatterns || dismissedPatterns.length === 0) {
    return '';
  }

  const contextLines = dismissedPatterns.map((pattern, index) => `${index + 1}. "${pattern.issue}" (Reason: ${pattern.reason})`);

  return `
IMPORTANT: The following types of issues have been previously dismissed or marked as not relevant by users in this project:

${contextLines.join('\n')}

Please avoid suggesting similar issues unless they represent genuinely different problems. Focus on identifying new, actionable, and relevant issues that haven't been previously dismissed.`;
}
