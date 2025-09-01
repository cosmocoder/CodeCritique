/**
 * Feedback Loader Module
 *
 * Loads and processes feedback artifacts from previous PR review runs.
 * Used by CLI tool to filter dismissed issues and improve analysis quality.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

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

/**
 * Check if an issue should be skipped based on previous feedback
 *
 * @param {string} issueDescription - Description of the current issue
 * @param {Object} feedbackData - Loaded feedback data
 * @param {Object} options - Filtering options
 * @returns {boolean} True if issue should be skipped
 */
export function shouldSkipSimilarIssue(issueDescription, feedbackData, options = {}) {
  const { similarityThreshold = 0.7, verbose = false } = options;

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

  // Check similarity with dismissed issues
  for (const dismissed of dismissedIssues) {
    if (!dismissed.originalIssue) continue;

    const similarity = calculateSimilarity(issueDescription, dismissed.originalIssue);
    if (similarity > similarityThreshold) {
      if (verbose) {
        console.log(chalk.yellow(`⏭️ Skipping similar dismissed issue (${(similarity * 100).toFixed(1)}% similar)`));
        console.log(chalk.gray(`   Current: ${issueDescription.substring(0, 50)}...`));
        console.log(chalk.gray(`   Previous: ${dismissed.originalIssue.substring(0, 50)}...`));
      }
      return true;
    }
  }

  return false;
}

/**
 * Calculate text similarity between two strings
 *
 * @param {string} text1 - First text
 * @param {string} text2 - Second text
 * @returns {number} Similarity score (0-1)
 */
export function calculateSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;

  const words1 = text1.toLowerCase().split(/\s+/);
  const words2 = text2.toLowerCase().split(/\s+/);

  const commonWords = words1.filter((word) => words2.includes(word));
  const totalWords = new Set([...words1, ...words2]).size;

  return totalWords > 0 ? commonWords.length / totalWords : 0;
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
