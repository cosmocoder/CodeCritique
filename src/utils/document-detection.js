/**
 * Document Detection Module
 *
 * This module provides utilities for detecting different types of documents,
 * particularly focusing on generic documentation files and their classification.
 */

import path from 'path';
import { GENERIC_DOC_REGEX } from './constants.js';

/**
 * Check if a document is a generic documentation file (README, RUNBOOK, etc.)
 *
 * @param {string} docPath - Document file path
 * @param {string} docH1 - Document H1 title (optional)
 * @returns {boolean} True if document is generic documentation, false otherwise
 *
 * @example
 * const isGeneric = isGenericDocument('README.md');
 * // Returns: true
 *
 * const isGeneric2 = isGenericDocument('docs/api-guide.md', 'API Guide');
 * // Returns: false
 */
export function isGenericDocument(docPath, docH1 = null) {
  if (!docPath) return false;

  // Check filename pattern
  if (GENERIC_DOC_REGEX.test(docPath)) {
    return true;
  }

  // Check H1 title if provided
  if (docH1) {
    const lowerH1 = docH1.toLowerCase();
    const genericTitlePatterns = ['readme', 'runbook', 'changelog', 'contributing', 'license', 'setup', 'installation', 'getting started'];

    return genericTitlePatterns.some((pattern) => lowerH1.includes(pattern));
  }

  return false;
}

/**
 * Get pre-computed context for generic documents to avoid expensive inference
 *
 * @param {string} docPath - Document file path
 * @returns {Object} Pre-computed generic document context with area, tech, and metadata
 *
 * @example
 * const context = getGenericDocumentContext('README.md');
 * // Returns: { area: 'Documentation', dominantTech: ['markdown', 'documentation'], ... }
 */
export function getGenericDocumentContext(docPath) {
  const fileName = path.basename(docPath).toLowerCase();

  const baseContext = {
    area: 'General',
    dominantTech: [],
    isGeneralPurposeReadmeStyle: true,
    fastPath: true, // Mark as optimized fast-path
    docPath: docPath,
  };

  // Customize context based on document type
  if (fileName.includes('readme')) {
    return {
      ...baseContext,
      area: 'Documentation',
      dominantTech: ['markdown', 'documentation'],
    };
  } else if (fileName.includes('runbook')) {
    return {
      ...baseContext,
      area: 'Operations',
      dominantTech: ['operations', 'deployment', 'devops'],
    };
  } else if (fileName.includes('changelog')) {
    return {
      ...baseContext,
      area: 'Documentation',
      dominantTech: ['versioning', 'releases'],
    };
  } else if (fileName.includes('contributing')) {
    return {
      ...baseContext,
      area: 'Development',
      dominantTech: ['git', 'development', 'contribution'],
    };
  } else if (fileName.includes('license')) {
    return {
      ...baseContext,
      area: 'Legal',
      dominantTech: ['licensing'],
    };
  } else if (fileName.includes('setup') || fileName.includes('install')) {
    return {
      ...baseContext,
      area: 'Setup',
      dominantTech: ['installation', 'setup', 'configuration'],
    };
  }

  return baseContext;
}
