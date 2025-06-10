/**
 * PR Comment Processor
 *
 * Processes GitHub PR comments, extracts code context, generates embeddings,
 * and classifies comments for storage in the embeddings database.
 */

import { calculateEmbedding, calculateQueryEmbedding } from '../../embeddings.js';
import { createHash } from 'node:crypto';
import { filterBotComments, getBotFilterStats } from './bot-detector.js';
import chalk from 'chalk';

export class PRCommentProcessor {
  constructor() {
    // Classification patterns for different issue categories
    this.classificationPatterns = {
      security: [
        /sql injection/i,
        /xss/i,
        /cross.?site/i,
        /sanitize/i,
        /vulnerability/i,
        /security/i,
        /authentication/i,
        /authorization/i,
        /password/i,
        /token/i,
        /secret/i,
        /encryption/i,
        /sensitive/i,
        /exploit/i,
        /attack/i,
      ],
      performance: [
        /inefficient/i,
        /performance/i,
        /slow/i,
        /memory leak/i,
        /optimization/i,
        /algorithm/i,
        /complexity/i,
        /bottleneck/i,
        /cache/i,
        /database.*query/i,
        /n\+1/i,
        /timeout/i,
      ],
      style: [
        /naming/i,
        /convention/i,
        /documentation/i,
        /comment/i,
        /indentation/i,
        /formatting/i,
        /camelcase/i,
        /snake_case/i,
        /consistency/i,
        /readability/i,
        /typo/i,
      ],
      logic: [
        /condition/i,
        /always false/i,
        /always true/i,
        /error handling/i,
        /edge case/i,
        /logic/i,
        /simplified/i,
        /missing/i,
        /handle/i,
        /check/i,
        /validation/i,
      ],
    };

    // Severity patterns
    this.severityPatterns = {
      critical: [/critical/i, /crash/i, /security flaw/i, /data loss/i, /system down/i, /fatal/i],
      major: [/major/i, /serious/i, /important/i, /significant/i, /will cause/i, /breaks/i, /failure/i],
      style: [/typo/i, /formatting/i, /whitespace/i, /spacing/i, /minor style/i],
    };

    // Pattern recognition keywords
    this.patternKeywords = {
      error_handling: ['error handling', 'error', 'exception', 'try catch', 'handle'],
      input_validation: ['validation', 'validate', 'sanitize', 'check input'],
      null_check: ['null check', 'null', 'undefined', 'falsy'],
      async_await: ['async', 'await', 'promise', 'callback'],
      performance: ['performance', 'optimize', 'efficient', 'slow'],
      security: ['security', 'sanitize', 'escape', 'auth'],
      documentation: ['documentation', 'comment', 'doc', 'readme'],
      testing: ['test', 'unit test', 'coverage', 'spec'],
    };
  }

  /**
   * Process a single comment with its PR context
   * @param {Object} comment - The comment object from GitHub API
   * @param {Object} prContext - PR context including files and metadata
   * @returns {Promise<Object>} Processed comment with embeddings and classification
   */
  async processComment(comment, prContext) {
    try {
      // Validate comment data
      if (!comment || !comment.body || !comment.user) {
        throw new Error('Invalid comment data');
      }

      // Extract basic metadata
      const metadata = this.extractMetadata(comment, prContext);

      // Extract code context
      const codeContext = await this.extractCodeContext(comment, prContext);

      // Generate embeddings
      const commentEmbedding = await this.generateCommentEmbedding(comment.body);
      if (!commentEmbedding) {
        throw new Error('Failed to generate comment embedding');
      }

      let codeEmbedding = null;
      if (codeContext.original_code) {
        codeEmbedding = await this.generateCodeEmbedding(codeContext.original_code);
      }

      // Combine embeddings from concatenated text
      const combinedEmbedding = codeContext.original_code
        ? await this.combineEmbeddings(comment.body, codeContext.original_code)
        : commentEmbedding;

      // Classify comment
      let classification;
      try {
        classification = await this.classifyComment(comment.body, codeContext);
      } catch (classificationError) {
        // Graceful degradation on classification failure
        classification = {
          issue_category: 'unknown',
          severity: 'minor',
          pattern_tags: [],
        };
      }

      return {
        ...metadata,
        ...codeContext,
        comment_embedding: commentEmbedding,
        code_embedding: codeEmbedding,
        combined_embedding: combinedEmbedding,
        ...classification,
      };
    } catch (error) {
      console.error('Error processing comment:', error);
      throw error;
    }
  }

  /**
   * Extract metadata from comment
   * @param {Object} comment - Comment object
   * @param {Object} prContext - PR context
   * @returns {Object} Extracted metadata
   */
  extractMetadata(comment, prContext) {
    const commentType = this.determineCommentType(comment);

    return {
      id: comment.id.toString(),
      pr_number: prContext.pr?.number || null,
      repository: prContext.pr?.repository || null,
      comment_type: commentType,
      comment_text: comment.body,
      author: comment.user?.login || 'unknown',
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      review_id: comment.pull_request_review_id?.toString() || null,
      review_state: comment.review_state || null,
    };
  }

  /**
   * Determine the type of comment
   * @param {Object} comment - Comment object
   * @returns {string} Comment type: 'review', 'issue', or 'inline'
   */
  determineCommentType(comment) {
    if (comment.path && comment.position !== undefined) {
      return 'review';
    }
    if (comment.path && comment.line !== undefined) {
      return 'inline';
    }
    return 'issue';
  }

  /**
   * Extract code context from comment and PR context
   * @param {Object} comment - Comment object
   * @param {Object} prContext - PR context
   * @returns {Object} Code context
   */
  extractCodeContext(comment, prContext) {
    const result = {
      file_path: comment.path || null,
      line_number: comment.line || comment.position || null,
      line_range_start: null,
      line_range_end: null,
      original_code: null,
      suggested_code: null,
      diff_hunk: comment.diff_hunk || null,
    };

    // Extract line range from diff hunk
    if (comment.diff_hunk) {
      const lineRange = this.extractLineRange(comment.diff_hunk);
      result.line_range_start = lineRange.start;
      result.line_range_end = lineRange.end;

      // Extract code from diff
      const codeFromDiff = this.extractCodeFromDiff(comment.diff_hunk);
      result.original_code = codeFromDiff.original_code;
      result.suggested_code = codeFromDiff.suggested_code;
    }

    // If no diff hunk, try to extract from file patch
    if (!result.original_code && comment.path && prContext.files) {
      const file = prContext.files.find((f) => f.filename === comment.path);
      if (file && file.patch) {
        const codeFromPatch = this.extractCodeFromPatch(file.patch, comment.line);
        result.original_code = codeFromPatch.original_code;
        result.suggested_code = codeFromPatch.suggested_code;
        result.diff_hunk = file.patch;
      }
    }

    return result;
  }

  /**
   * Extract line range from diff hunk
   * @param {string} diffHunk - Git diff hunk
   * @returns {Object} Line range information
   */
  extractLineRange(diffHunk) {
    const hunkMatch = diffHunk.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
    if (hunkMatch) {
      const startLine = parseInt(hunkMatch[3]);
      const contextLines = parseInt(hunkMatch[4]) || 1;
      return {
        start: startLine,
        end: startLine + contextLines - 1,
        contextLines,
      };
    }
    return { start: null, end: null, contextLines: 0 };
  }

  /**
   * Extract code from diff hunk
   * @param {string} diffHunk - Git diff hunk
   * @returns {Object} Extracted code
   */
  extractCodeFromDiff(diffHunk) {
    const lines = diffHunk.split('\n');
    let originalCode = [];
    let suggestedCode = [];
    let contextLines = [];

    for (const line of lines) {
      if (line.startsWith('-')) {
        originalCode.push(line.substring(1));
      } else if (line.startsWith('+')) {
        suggestedCode.push(line.substring(1));
      } else if (!line.startsWith('@@') && line.trim()) {
        contextLines.push(line.substring(1) || line);
      }
    }

    return {
      original_code: originalCode.length > 0 ? originalCode.join('\n') : null,
      suggested_code: suggestedCode.length > 0 ? suggestedCode.join('\n') : null,
      context_lines: contextLines.join('\n'),
    };
  }

  /**
   * Extract code from file patch at specific line
   * @param {string} filePatch - Complete file patch
   * @param {number} line - Target line number
   * @returns {Object} Extracted code
   */
  extractCodeFromPatch(filePatch, line) {
    const lines = filePatch.split('\n');
    let currentLine = 0;
    let originalCode = null;
    let suggestedCode = null;

    for (const patchLine of lines) {
      if (patchLine.startsWith('@@')) {
        const match = patchLine.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
        if (match) {
          currentLine = parseInt(match[3]);
        }
        continue;
      }

      if (currentLine === line) {
        if (patchLine.startsWith('-')) {
          originalCode = patchLine.substring(1);
        } else if (patchLine.startsWith('+')) {
          suggestedCode = patchLine.substring(1);
        }
        break;
      }

      if (!patchLine.startsWith('-')) {
        currentLine++;
      }
    }

    return { original_code: originalCode, suggested_code: suggestedCode };
  }

  /**
   * Generate embedding for comment text
   * @param {string} text - Comment text
   * @returns {Promise<Array<number>>} Comment embedding
   */
  async generateCommentEmbedding(text) {
    const embedding = await calculateEmbedding(text);
    if (!embedding || embedding.length !== 384) {
      throw new Error(`Invalid embedding dimensions: expected 384, got ${embedding?.length}`);
    }
    return embedding;
  }

  /**
   * Generate embedding for code
   * @param {string} code - Code snippet
   * @returns {Promise<Array<number>>} Code embedding
   */
  async generateCodeEmbedding(code) {
    const embedding = await calculateEmbedding(code);
    if (!embedding || embedding.length !== 384) {
      throw new Error(`Invalid embedding dimensions: expected 384, got ${embedding?.length}`);
    }
    return embedding;
  }

  /**
   * Combine comment and code text, then generate embedding from concatenated content
   * @param {string} commentText - Comment text
   * @param {string} codeText - Code text
   * @returns {Promise<Array<number>>} Combined embedding from concatenated text
   */
  async combineEmbeddings(commentText, codeText) {
    if (!commentText && !codeText) {
      return null;
    }

    // Concatenate comment and code text with clear separation
    const combinedText = [commentText, codeText].filter(Boolean).join('\n\n--- CODE CONTEXT ---\n\n');

    // Generate embedding from the concatenated text
    const combinedEmbedding = await calculateEmbedding(combinedText);
    if (!combinedEmbedding || combinedEmbedding.length !== 384) {
      throw new Error(`Invalid combined embedding dimensions: expected 384, got ${combinedEmbedding?.length}`);
    }

    return combinedEmbedding;
  }

  /**
   * Classify comment by category and severity
   * @param {string} commentText - Comment text
   * @param {Object} codeContext - Code context
   * @returns {Promise<Object>} Classification result
   */
  async classifyComment(commentText, codeContext = {}) {
    const text = commentText.toLowerCase();
    const code = (codeContext.code || codeContext.original_code || '').toLowerCase();
    const filePath = (codeContext.file_path || '').toLowerCase();

    // Determine category
    let category = 'general';
    let maxScore = 0;

    for (const [cat, patterns] of Object.entries(this.classificationPatterns)) {
      let score = 0;
      for (const pattern of patterns) {
        if (pattern.test(text)) score += 2;
        if (pattern.test(code)) score += 1;
        if (pattern.test(filePath)) score += 0.5;
      }

      if (score > maxScore) {
        maxScore = score;
        category = cat;
      }
    }

    // Special handling for security context
    if (code.includes('password') || code.includes('token') || filePath.includes('auth')) {
      if (category === 'general') category = 'security';
    }

    // Determine severity
    let severity = 'minor';
    for (const [sev, patterns] of Object.entries(this.severityPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          severity = sev;
          break;
        }
      }
      if (severity !== 'minor') break;
    }

    // Adjust severity based on category
    if (category === 'security' && severity === 'minor') {
      severity = 'major';
    }

    // Generate pattern tags
    const patternTags = this.generatePatternTags(commentText);

    return {
      issue_category: category,
      severity,
      pattern_tags: patternTags,
    };
  }

  /**
   * Generate pattern tags for comment
   * @param {string} commentText - Comment text
   * @returns {Array<string>} Pattern tags
   */
  generatePatternTags(commentText) {
    const text = commentText.toLowerCase();
    const tags = [];

    for (const [pattern, keywords] of Object.entries(this.patternKeywords)) {
      for (const keyword of keywords) {
        if (text.includes(keyword.toLowerCase())) {
          tags.push(pattern);
          break;
        }
      }
    }

    return [...new Set(tags)]; // Remove duplicates
  }

  /**
   * Identify recurring patterns in comments
   * @param {Array<string>} comments - Array of comment texts
   * @returns {Array<string>} Identified patterns
   */
  identifyPatterns(comments) {
    const patterns = [];
    const patternCounts = {};

    for (const comment of comments) {
      const tags = this.generatePatternTags(comment);
      for (const tag of tags) {
        patternCounts[tag] = (patternCounts[tag] || 0) + 1;
      }
    }

    // Return patterns that appear in multiple comments
    for (const [pattern, count] of Object.entries(patternCounts)) {
      if (count >= 2) {
        patterns.push(pattern);
      }
    }

    return patterns;
  }

  /**
   * Calculate pattern weights by frequency
   * @param {Array<string>} commentHistory - Array of comment texts
   * @returns {Object} Pattern weights
   */
  calculatePatternWeights(commentHistory) {
    const weights = {};
    const totalComments = commentHistory.length;

    for (const comment of commentHistory) {
      const tags = this.generatePatternTags(comment);
      for (const tag of tags) {
        weights[tag] = (weights[tag] || 0) + 1;
      }
    }

    // Normalize weights
    for (const tag in weights) {
      weights[tag] = weights[tag] / totalComments;
    }

    return weights;
  }

  /**
   * Process comments in batch
   * @param {Array<Object>} comments - Array of comments
   * @param {Object} prContext - PR context
   * @returns {Promise<Array<Object>>} Processed comments
   */
  async processBatch(comments, prContext) {
    const results = [];
    const batchSize = 10; // Process in small batches to avoid rate limits

    if (comments.length === 0) {
      return results;
    }

    // Filter out bot comments before processing
    const humanComments = filterBotComments(comments);

    if (humanComments.length === 0) {
      return results;
    }

    for (let i = 0; i < humanComments.length; i += batchSize) {
      const batch = humanComments.slice(i, i + batchSize);

      const batchPromises = batch.map((comment) =>
        this.processComment(comment, prContext).catch((error) => {
          console.error(chalk.red(`Error processing comment ${comment.id}:`), error);
          return null; // Return null for failed comments
        })
      );

      const batchResults = await Promise.all(batchPromises);
      const validResults = batchResults.filter((result) => result !== null);
      results.push(...validResults);

      // Small delay between batches to be gentle on the embedding service
      if (i + batchSize < humanComments.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return results;
  }
}
