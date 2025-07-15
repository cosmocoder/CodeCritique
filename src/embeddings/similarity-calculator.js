/**
 * Similarity Calculator
 *
 * This module contains pure mathematical functions for calculating similarity between vectors,
 * paths, and other data structures. These functions have no external dependencies and are
 * safe to extract for modular use.
 */

import path from 'node:path';
import { debug } from '../utils.js';

/**
 * Calculate cosine similarity between two vectors
 *
 * @param {Array<number>} vecA - First vector
 * @param {Array<number>} vecB - Second vector
 * @returns {number} Cosine similarity score between -1 and 1
 */
export function calculateCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || !Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
    // Add more robust checks
    debug(`Invalid input for cosine similarity: vecA length=${vecA?.length}, vecB length=${vecB?.length}`);
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

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
}

/**
 * Calculate path similarity between two file paths
 *
 * This function compares two file paths and returns a similarity score based on
 * the common directory prefix. The score is normalized between 0 and 1.
 *
 * @param {string} path1 - First file path
 * @param {string} path2 - Second file path
 * @returns {number} Similarity score between 0 and 1
 */
export function calculatePathSimilarity(path1, path2) {
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
