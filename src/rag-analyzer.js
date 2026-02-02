/**
 * RAG Analyzer Module
 *
 * This module provides functionality for analyzing code using context
 * extracted by the Retrieval Augmented Generation (RAG) approach for code review.
 * It identifies patterns, best practices, and generates review comments.
 */

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { getDefaultEmbeddingsSystem } from './embeddings/factory.js';
import { calculateCosineSimilarity } from './embeddings/similarity-calculator.js';
import {
  loadFeedbackData,
  shouldSkipSimilarIssue,
  extractDismissedPatterns,
  generateFeedbackContext,
  initializeSemanticSimilarity,
  isSemanticSimilarityAvailable,
} from './feedback-loader.js';
import * as llm from './llm.js';
import { findRelevantPRComments } from './pr-history/database.js';
import { inferContextFromCodeContent, inferContextFromDocumentContent } from './utils/context-inference.js';
import { isGenericDocument, getGenericDocumentContext } from './utils/document-detection.js';
import { isTestFile, shouldProcessFile } from './utils/file-validation.js';
import { detectFileType, detectLanguageFromExtension } from './utils/language-detection.js';
import { debug } from './utils/logging.js';

// Constants for content processing
const MAX_QUERY_CONTEXT_LENGTH = 1500;
const MAX_EMBEDDING_CONTENT_LENGTH = 10000;
const DEFAULT_TRUNCATE_LINES = 300;
const GUIDELINE_TRUNCATE_LINES = 400;
const MAX_PR_COMMENTS_FOR_CONTEXT = 15;

// Create embeddings system instance
const embeddingsSystem = getDefaultEmbeddingsSystem();

// Track if semantic similarity has been initialized
let semanticSimilarityInitialized = false;

/**
 * Initialize semantic similarity for feedback filtering
 * Uses the shared embeddings system from feedback-loader.js
 */
async function ensureSemanticSimilarityInitialized() {
  if (semanticSimilarityInitialized) {
    return;
  }

  try {
    // Initialize semantic similarity using the shared embeddings system
    await initializeSemanticSimilarity();
    semanticSimilarityInitialized = true;
  } catch (error) {
    console.log(chalk.yellow(`⚠️ Could not initialize semantic similarity: ${error.message}`));
    // Continue without semantic similarity - word-based fallback will be used
  }
}

// ============================================================================
// COMMON PROMPT INSTRUCTIONS
// ============================================================================

/**
 * Generate the common critical rules block for all prompts
 * @param {Object} options - Options for customization
 * @param {string} options.importRuleContext - Context-specific text for import rule ('code', 'test', or 'pr')
 * @returns {string} Critical rules block
 */
function getCriticalRulesBlock(options = {}) {
  const { importRuleContext = 'code' } = options;

  // Customize import rule based on context
  let importRuleText;
  switch (importRuleContext) {
    case 'test':
      importRuleText =
        'DO NOT flag missing imports or files referenced in import statements as issues. Focus only on test quality, logic, and patterns within the provided test files.';
      break;
    case 'pr':
      importRuleText =
        'DO NOT flag missing imports or files referenced in import statements as issues. In PR analysis, some files (especially assets like images, fonts, or excluded files) may not be included in the review scope. Focus only on code quality, logic, and patterns within the provided PR files.';
      break;
    default:
      importRuleText =
        'DO NOT flag missing imports or files referenced in import statements as issues. Focus only on code quality, logic, and patterns within the provided files.';
  }

  return `**🚨 CRITICAL: LINE NUMBER REPORTING RULE - READ CAREFULLY 🚨**
When reporting issues in the JSON output, NEVER provide exhaustive lists of line numbers. For repeated issues, list only 3-5 representative line numbers maximum. Exhaustive line number lists are considered errors and must be avoided.

**🚨 CRITICAL: IMPORT STATEMENT RULE - READ CAREFULLY 🚨**
${importRuleText}

**🚨 CRITICAL: NO LOW SEVERITY ISSUES - READ CAREFULLY 🚨**
DO NOT report "low" severity issues. Low severity issues typically include:
- Import statement ordering or grouping
- Code formatting and whitespace
- Minor stylistic preferences
- Comment placement or formatting
- Line length or wrapping suggestions
These concerns are handled by project linters (ESLint, Prettier, etc.) and should NOT be included in your review.
Only report issues with severity: "critical", "high", or "medium".

**🚨 CRITICAL: ACTIONABLE CODE ISSUES ONLY - NO VERIFICATION REQUESTS 🚨**
Your review must contain ONLY issues where you have identified a DEFINITE problem and can provide a SPECIFIC code fix.

**AUTOMATIC REJECTION - If your suggestion contains ANY of these phrases, DO NOT include it:**
- "Verify that..." / "Verify the..." / "Verify if..."
- "Ensure that..." / "Ensure the..."
- "Confirm that..." / "Confirm the..."
- "Validate that..." / "Validate the..."
- "Check that..." / "Check if..." / "Check whether..."
- "Add a comment explaining..." / "Add documentation..."
- "Review the documentation..." / "Reference the migration guide..."
- "Consider whether..." / "Consider if..."
- "This could potentially..." / "This might..." / "This may..."
- "If this is intentional..." / "If this change is to fix..."
- "...should be validated" / "...should be verified"
- "...but there's no validation..." / "...but there's no verification..."

**AUTOMATIC REJECTION - Process/workflow suggestions that are NOT code fixes:**
- "Create a follow-up task..." / "Create a task to..."
- "Document the migration..." / "Document this change..." / "Document the experiment..."
- "Update any analytics..." / "Update any dashboards..." / "Update any reports..."
- "Update any queries..." / "Update downstream..."
- "Notify the team..." / "Communicate this change..." / "Make sure consumers are aware..."
- "Archive the data..." / "Migrate the data..." / "Ensure historical data..."
- "Plan the rollout..." / "Consider a phased rollout..." / "Manage this transition..."
- "Once the migration is complete..." / "Once all consumers have migrated..."
- "...can handle the new..." / "...can handle this change..."
- "...are aware of this change" / "...is properly archived"

**THE RULE**: If you cannot point to a SPECIFIC BUG or SPECIFIC VIOLATION and provide EXACT CODE to fix it, do not report it.

**GOOD issue**: "The function returns null on line 42 but the return type doesn't allow null. Fix: Change return type to \`string | null\`"
**BAD issue**: "Verify that the function handles null correctly" (This asks for verification, not a code fix)
**BAD issue**: "The type cast may bypass type safety" (This expresses uncertainty - "may" - without identifying a definite problem)
**BAD issue**: "Add a comment explaining why this type was changed" (This requests documentation, not a code fix)

When in doubt, leave it out. Only report issues you are CERTAIN about.`;
}

/**
 * Generate the common citation requirement block
 * @returns {string} Citation requirement block
 */
function getCitationRequirementBlock() {
  return `**🚨 CRITICAL CITATION REQUIREMENT 🚨**
When you identify issues that violate custom instructions provided at the beginning of this prompt, you MUST:
- Include the source document name in your issue description (e.g., "violates the coding standards specified in '[Document Name]'")
- Reference the source document in your suggestion (e.g., "as required by '[Document Name]'" or "according to '[Document Name]'")
- Do NOT provide generic suggestions - always tie violations back to the specific custom instruction source`;
}

/**
 * Generate the common code suggestions format block
 * @returns {string} Code suggestions format block
 */
function getCodeSuggestionsFormatBlock() {
  return `**🚨 CODE SUGGESTIONS FORMAT 🚨**
When suggesting code changes, you can optionally include a codeSuggestion object with:
- startLine: The starting line number of the code to replace
- endLine: (optional) The ending line number if replacing multiple lines
- oldCode: The exact current code that should be replaced (must match exactly)
- newCode: The proposed replacement code

Code suggestions enable reviewers to apply fixes directly as GitHub suggestions. Only provide code suggestions when:
1. The fix is concrete and can be applied automatically
2. You have the exact current code from the file content
3. The suggestion is a direct code replacement (not architectural changes)`;
}

/**
 * Generate the final reminder block for custom instructions
 * @returns {string} Final reminder block
 */
function getFinalReminderBlock() {
  return `**FINAL REMINDER: If custom instructions were provided at the start of this prompt, they MUST be followed and take precedence over all other guidelines.**`;
}

/**
 * Format custom docs section for prompts
 * @param {Array} customDocs - Array of custom document chunks
 * @returns {string} Formatted custom docs section
 */
function formatCustomDocsSection(customDocs) {
  if (!customDocs || customDocs.length === 0) {
    return '';
  }

  let section = `

CRITICAL: CUSTOM INSTRUCTIONS - FOLLOW THESE BEFORE ALL OTHER INSTRUCTIONS
=====================================================================

`;

  // Group chunks by document title to provide better context
  const chunksByDocument = new Map();
  customDocs.forEach((doc) => {
    const title = doc.document_title || doc.title;
    if (!chunksByDocument.has(title)) {
      chunksByDocument.set(title, []);
    }
    chunksByDocument.get(title).push(doc);
  });

  chunksByDocument.forEach((chunks, docTitle) => {
    section += `
### AUTHORITATIVE CUSTOM INSTRUCTION: "${docTitle}"

IMPORTANT: This is an authoritative document that defines mandatory review standards for this project.
When you find violations of these standards, you MUST cite "${docTitle}" as the source in your response.

`;
    chunks.forEach((chunk, index) => {
      section += `
**Section ${index + 1}${chunk.chunk_index !== undefined ? ` (Chunk ${chunk.chunk_index + 1})` : ''}:**

${chunk.content}

`;
    });
    section += `
---

`;
  });

  section += `
=====================================================================
END OF CUSTOM INSTRUCTIONS - These are authoritative project guidelines that take precedence over all other standards
`;

  return section;
}

/**
 * Build role definition with custom instructions references
 * @param {string} baseRole - Base role description
 * @param {Array} customDocs - Array of custom document chunks
 * @param {string} reviewType - Type of review ('code', 'test', or 'pr')
 * @returns {string} Complete role definition
 */
function buildRoleDefinition(baseRole, customDocs, reviewType = 'code') {
  let roleDefinition = baseRole;

  if (customDocs && customDocs.length > 0) {
    const docTitles = [...new Set(customDocs.map((doc) => doc.document_title || doc.title))];
    const reviewTypeText = reviewType === 'test' ? 'test reviews' : reviewType === 'pr' ? 'PR reviews' : 'review';

    roleDefinition += `\n\nIMPORTANT: You have been given specific custom instructions that define how you should conduct your ${reviewTypeText}:`;
    docTitles.forEach((title, index) => {
      roleDefinition += `\n\n**CUSTOM INSTRUCTION SOURCE ${index + 1}: "${title}"**`;
      roleDefinition += `\nThis contains specific instructions for your ${reviewType === 'test' ? 'test review' : 'review'} approach and criteria.`;
    });
    roleDefinition +=
      '\n\nThese custom instructions define your review methodology and must be followed throughout your analysis. When you apply these instructions, reference the source document that informed your decision.';
  }

  return roleDefinition;
}

/**
 * Format code examples for prompts
 * @param {Array} codeExamples - Array of code examples
 * @param {string} labelPrefix - Label prefix (e.g., 'CODE EXAMPLE', 'TEST EXAMPLE')
 * @returns {string} Formatted code examples
 */
function formatCodeExamplesBlock(codeExamples, labelPrefix = 'CODE EXAMPLE') {
  if (!codeExamples || codeExamples.length === 0) {
    return labelPrefix.includes('TEST') ? 'No relevant test examples found.' : 'No relevant code examples found.';
  }

  return codeExamples
    .map((ex) => {
      const langIdentifier = ex.language || '';
      return `
${labelPrefix} ${ex.index} (Similarity: ${ex.similarity})
Path: ${ex.path}
Language: ${ex.language}

\`\`\`${langIdentifier}
${ex.content}
\`\`\`
`;
    })
    .join('\n');
}

/**
 * Format guideline snippets for prompts
 * @param {Array} guidelineSnippets - Array of guideline snippets
 * @param {string} labelPrefix - Label prefix (e.g., 'GUIDELINE', 'TESTING GUIDELINE')
 * @returns {string} Formatted guideline snippets
 */
function formatGuidelinesBlock(guidelineSnippets, labelPrefix = 'GUIDELINE') {
  if (!guidelineSnippets || guidelineSnippets.length === 0) {
    return labelPrefix.includes('TESTING') ? 'No specific testing guideline snippets found.' : 'No specific guideline snippets found.';
  }

  return guidelineSnippets
    .map((ex) => {
      const langIdentifier = ex.language || 'text';
      let title = `${labelPrefix} ${ex.index} (Source: ${ex.path}, Similarity: ${ex.similarity})`;
      if (ex.headingText) {
        title += `, Heading: "${ex.headingText}"`;
      }

      return `
${title}

\`\`\`${langIdentifier}
${ex.content}
\`\`\`
`;
    })
    .join('\n');
}

// ============================================================================
// END COMMON PROMPT INSTRUCTIONS
// ============================================================================

/**
 * Get project summary for the given project path
 * @param {string} projectPath - Project path
 * @returns {Promise<Object|null>} Project summary or null
 */
async function getProjectSummary(projectPath) {
  const resolvedPath = path.resolve(projectPath);

  try {
    // Retrieve from database
    const summary = await embeddingsSystem.getProjectSummary(resolvedPath);

    if (summary) {
      console.log(chalk.cyan(`📋 Retrieved project summary for: ${path.basename(resolvedPath)}`));
    }

    return summary;
  } catch (error) {
    console.error(chalk.red(`Error retrieving project summary: ${error.message}`));
    return null;
  }
}

/**
 * Format project summary for LLM context
 * @param {Object} summary - Project summary object
 * @returns {string} Formatted context string
 */
function formatProjectSummaryForLLM(summary) {
  if (!summary) return '';

  let context = `\n## PROJECT ARCHITECTURE CONTEXT\n\n`;

  context += `**Project:** ${summary.projectName || 'Unknown'} (${summary.projectType || 'Unknown'})\n`;

  // Safe access to technologies array
  if (summary.technologies && Array.isArray(summary.technologies) && summary.technologies.length > 0) {
    context += `**Technologies:** ${summary.technologies.slice(0, 8).join(', ')}${summary.technologies.length > 8 ? '...' : ''}\n`;
  }

  // Safe access to mainFrameworks array
  if (summary.mainFrameworks && Array.isArray(summary.mainFrameworks) && summary.mainFrameworks.length > 0) {
    context += `**Main Frameworks:** ${summary.mainFrameworks.join(', ')}\n`;
  }

  context += '\n';

  if (summary.customImplementations && Array.isArray(summary.customImplementations) && summary.customImplementations.length > 0) {
    context += `**Custom Implementations to Recognize:**\n`;
    summary.customImplementations.forEach((impl, i) => {
      if (i < 5 && impl) {
        // Limit to top 5 to avoid overwhelming the LLM
        context += `- **${impl.name || 'Unknown'}**: ${impl.description || 'No description'}\n`;
        if (impl.properties && Array.isArray(impl.properties) && impl.properties.length > 0) {
          context += `  Properties: ${impl.properties.slice(0, 3).join(', ')}\n`;
        }
      }
    });
    context += '\n';
  }

  if (summary.apiPatterns && Array.isArray(summary.apiPatterns) && summary.apiPatterns.length > 0) {
    context += `**API Patterns:**\n`;
    summary.apiPatterns.forEach((pattern) => {
      if (pattern) {
        context += `- ${pattern.type || 'Unknown'}: ${pattern.description || 'No description'}\n`;
      }
    });
    context += '\n';
  }

  if (summary.stateManagement && summary.stateManagement.approach && summary.stateManagement.approach !== 'Unknown') {
    context += `**State Management:** ${summary.stateManagement.approach}\n`;
    if (
      summary.stateManagement.patterns &&
      Array.isArray(summary.stateManagement.patterns) &&
      summary.stateManagement.patterns.length > 0
    ) {
      context += `- Patterns: ${summary.stateManagement.patterns.join(', ')}\n`;
    }
    context += '\n';
  }

  if (summary.reviewGuidelines && Array.isArray(summary.reviewGuidelines) && summary.reviewGuidelines.length > 0) {
    context += `**Project-Specific Review Guidelines:**\n`;
    summary.reviewGuidelines.slice(0, 6).forEach((guideline) => {
      if (guideline) {
        context += `- ${guideline}\n`;
      }
    });
  }

  return context;
}

// Helper function for truncating content with line count
function truncateContent(content, maxLines = DEFAULT_TRUNCATE_LINES) {
  const lines = content.split('\n');
  if (lines.length > maxLines) {
    return {
      content: lines.slice(0, maxLines).join('\n') + `\n... (truncated, ${lines.length - maxLines} more lines)`,
      wasTruncated: true,
      originalLineCount: lines.length,
    };
  }
  return {
    content: content,
    wasTruncated: false,
    originalLineCount: lines.length,
  };
}

// Helper function for formatting context items (code examples or guidelines)
function formatContextItems(items, type = 'code') {
  return items.map((item, idx) => {
    // Format similarity score
    const similarityFormatted = typeof item.similarity === 'number' ? item.similarity.toFixed(2) : 'N/A';

    // Truncate content based on type
    const maxLines = type === 'guideline' ? GUIDELINE_TRUNCATE_LINES : DEFAULT_TRUNCATE_LINES;
    const truncated = truncateContent(item.content, maxLines);

    const baseFormatted = {
      index: idx + 1,
      path: item.path,
      similarity: similarityFormatted,
      language: item.language || (type === 'guideline' ? 'text' : 'unknown'),
      content: truncated.content,
    };

    // Add type-specific fields
    if (type === 'guideline') {
      baseFormatted.headingText = item.headingText || null;
      baseFormatted.type = item.type || 'documentation';
    }

    return baseFormatted;
  });
}

// --- Helper: createGuidelineQueryForLLMRetrieval ---
function createGuidelineQueryForLLMRetrieval(codeSnippet, reviewedSnippetContext, language) {
  const codeContext = codeSnippet.substring(0, MAX_QUERY_CONTEXT_LENGTH); // Limit snippet length in query
  let query = 'Retrieve technical documentation, architectural guidelines, and best practices. ';

  if (
    reviewedSnippetContext.area !== 'Unknown' &&
    reviewedSnippetContext.area !== 'GeneralJS_TS' &&
    reviewedSnippetContext.area !== 'General'
  ) {
    query += `Specifically looking for ${reviewedSnippetContext.area} related information. `;
  }
  if (reviewedSnippetContext.dominantTech.length > 0) {
    query += `Focus on technologies like: ${reviewedSnippetContext.dominantTech.join(', ')}. `;
  }
  const generalKeywords = reviewedSnippetContext.keywords.filter(
    (kw) => !reviewedSnippetContext.dominantTech.map((t) => t.toLowerCase()).includes(kw.toLowerCase())
  );
  if (generalKeywords.length > 0) {
    query += `Consider relevance to concepts such as: ${generalKeywords.slice(0, 3).join(', ')}. `;
  }
  query += `Relevant to the following ${language} code snippet context: \\n\`\`\`${language}\\n${codeContext}...\\n\`\`\``;
  return query;
}

// --- Helper: createTestGuidelineQueryForLLMRetrieval ---
function createTestGuidelineQueryForLLMRetrieval(codeSnippet, reviewedSnippetContext, language) {
  const codeContext = codeSnippet.substring(0, MAX_QUERY_CONTEXT_LENGTH); // Limit snippet length in query
  let query = 'Retrieve testing documentation, test patterns, and testing best practices. ';

  query += 'Focus on test coverage, test naming conventions, assertion patterns, mocking strategies, and test organization. ';

  if (
    reviewedSnippetContext.area !== 'Unknown' &&
    reviewedSnippetContext.area !== 'GeneralJS_TS' &&
    reviewedSnippetContext.area !== 'General'
  ) {
    query += `Specifically looking for ${reviewedSnippetContext.area} testing patterns and practices. `;
  }

  if (reviewedSnippetContext.dominantTech.length > 0) {
    query += `Focus on testing frameworks and patterns for: ${reviewedSnippetContext.dominantTech.join(', ')}. `;
  }

  const testingKeywords = [
    'test',
    'spec',
    'mock',
    'stub',
    'assertion',
    'coverage',
    'fixture',
    'beforeEach',
    'afterEach',
    'describe',
    'it',
    'expect',
  ];
  const relevantKeywords = reviewedSnippetContext.keywords.filter((kw) => testingKeywords.some((tk) => kw.toLowerCase().includes(tk)));

  if (relevantKeywords.length > 0) {
    query += `Consider testing concepts such as: ${relevantKeywords.slice(0, 3).join(', ')}. `;
  }

  query += `Relevant to the following ${language} test file context: \\n\`\`\`${language}\\n${codeContext}...\\n\`\`\``;
  return query;
}

/**
 * Run an analysis using the RAG approach (single file or holistic PR)
 *
 * @param {string} filePath - Path to the file to analyze, or a special marker for PR reviews
 * @param {Object} options - Analysis options
 * @returns {Promise<Object>} Analysis results
 */
async function runAnalysis(filePath, options = {}) {
  try {
    // Check if this is a holistic PR review
    if (options.isHolisticPRReview && filePath === 'PR_HOLISTIC_REVIEW') {
      console.log(chalk.blue(`Performing holistic PR review for ${options.prFiles?.length || 0} files`));
      return await performHolisticPRAnalysis(options);
    }

    console.log(chalk.blue(`Analyzing file: ${filePath}`));

    // Load feedback data if feedback tracking is enabled
    let feedbackData = {};
    if (options.trackFeedback && options.feedbackPath) {
      console.log(chalk.cyan('--- Loading Feedback Data ---'));
      feedbackData = await loadFeedbackData(options.feedbackPath, { verbose: options.verbose });
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read file content - use diff content if this is a diff-only review
    let content;
    let fullFileContent;
    if (options.diffOnly && options.diffContent) {
      content = options.diffContent;
      // For PR reviews, always read the full file content for context awareness
      fullFileContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
      console.log(chalk.blue(`Analyzing diff only for ${path.basename(filePath)}`));
    } else {
      content = fs.readFileSync(filePath, 'utf8');
      fullFileContent = content;
      console.log(chalk.blue(`Analyzing full file ${path.basename(filePath)}`));
    }

    // Check if file should be processed
    if (!shouldProcessFile(filePath, content)) {
      console.log(chalk.yellow(`Skipping file based on exclusion patterns: ${filePath}`));
      return {
        success: true,
        skipped: true,
        message: 'File skipped based on exclusion patterns',
      };
    }

    // --- Stage 1: CONTEXT RETRIEVAL ---
    console.log(chalk.blue('--- Stage 1: Context Retrieval ---'));
    const {
      language,
      isTestFile,
      finalCodeExamples,
      finalGuidelineSnippets,
      prCommentContext,
      prContextAvailable,
      relevantCustomDocChunks,
    } = await getContextForFile(filePath, content, options);

    // --- Stage 1.5: PROJECT ARCHITECTURE CONTEXT ---
    console.log(chalk.blue('--- Stage 1.5: Retrieving Project Architecture Context ---'));
    const projectPath = options.projectPath || process.cwd();
    const projectSummary = await getProjectSummary(projectPath);

    // --- Stage 2: PREPARE CONTEXT FOR LLM ---
    console.log(chalk.blue('--- Stage 2: Preparing Context for LLM ---'));

    // Format the lists that will be passed
    const formattedCodeExamples = formatContextItems(finalCodeExamples, 'code');
    const formattedGuidelines = formatContextItems(finalGuidelineSnippets, 'guideline');

    // --- Log the context being sent to the LLM --- >
    console.log(chalk.magenta('--- Guidelines Sent to LLM ---'));
    if (formattedGuidelines.length > 0) {
      formattedGuidelines.forEach((g, i) => {
        console.log(chalk.magenta(`  [${i + 1}] Path: ${g.path} ${g.headingText ? `(Heading: "${g.headingText}")` : ''}`));
        console.log(chalk.gray(`      Content: ${g.content.substring(0, 100).replace(/\\n/g, ' ')}...`));
      });
    } else {
      console.log(chalk.magenta('  (None)'));
    }

    console.log(chalk.magenta('--- Code Examples Sent to LLM ---'));
    if (finalCodeExamples.length > 0) {
      finalCodeExamples.forEach((ex, i) => {
        console.log(chalk.magenta(`  [${i + 1}] Path: ${ex.path} (Similarity: ${ex.similarity?.toFixed(3) || 'N/A'})`));
        console.log(chalk.gray(`      Content: ${ex.content.substring(0, 100).replace(/\\n/g, ' ')}...`));
      });
    } else {
      console.log(chalk.magenta('  (None)'));
    }

    console.log(chalk.magenta('--- Custom Document Chunks Sent to LLM ---'));
    if (relevantCustomDocChunks && relevantCustomDocChunks.length > 0) {
      relevantCustomDocChunks.forEach((chunk, i) => {
        console.log(chalk.magenta(`  [${i + 1}] Document: "${chunk.document_title}" (Chunk ${chunk.chunk_index + 1})`));
        console.log(chalk.magenta(`      Similarity: ${chunk.similarity?.toFixed(3) || 'N/A'}`));
        console.log(chalk.gray(`      Content: ${chunk.content.substring(0, 100).replace(/\\n/g, ' ')}...`));
      });
    } else {
      console.log(chalk.magenta('  (None)'));
    }
    console.log(chalk.magenta('---------------------------------'));
    // --- End Logging --->

    // Prepare context for LLM with the potentially reduced lists
    const context = prepareContextForLLM(
      filePath,
      content,
      language,
      // Pass the formatted lists
      formattedCodeExamples,
      formattedGuidelines, // Always pass the formatted guidelines
      prCommentContext, // Pass PR comment context
      { ...options, isTestFile, relevantCustomDocChunks, feedbackData, projectSummary, fullFileContent } // Pass full file content for context
    );

    // Call LLM for analysis
    const analysisResults = await callLLMForAnalysis(context, { ...options, isTestFile, feedbackData });

    // Filter out low severity issues (formatting/style concerns handled by linters)
    // Note: The LLM prompt instructs not to generate low severity issues, but this filter
    // serves as a safety net in case any slip through despite the prompt instructions
    const lowSeverityFiltered = filterLowSeverityIssues(analysisResults, { verbose: options.verbose });

    // Post-process results to filter dismissed issues
    let filteredResults = lowSeverityFiltered;
    if (options.trackFeedback && feedbackData && Object.keys(feedbackData).length > 0) {
      console.log(chalk.cyan('--- Filtering Results Based on Feedback ---'));
      filteredResults = await filterAnalysisResults(lowSeverityFiltered, feedbackData, {
        similarityThreshold: options.feedbackThreshold || 0.7,
        verbose: options.verbose,
      });
    }

    return {
      success: true,
      filePath,
      language,
      results: filteredResults,
      context: {
        codeExamples: finalCodeExamples.length,
        guidelines: finalGuidelineSnippets.length,
        prComments: prCommentContext.length,
        prContextAvailable,
      },
      prHistory: prContextAvailable
        ? {
            commentsFound: prCommentContext.length,
            patterns: extractCommentPatterns(prCommentContext),
            summary: generateContextSummary(prCommentContext, extractCommentPatterns(prCommentContext)),
          }
        : null,
      similarExamples: finalCodeExamples.map((ex) => ({
        path: ex.path,
        similarity: ex.similarity,
      })),
      metadata: {
        analysisTimestamp: new Date().toISOString(),
        featuresUsed: {
          codeExamples: finalCodeExamples.length > 0,
          guidelines: finalGuidelineSnippets.length > 0,
          prHistory: prContextAvailable,
          feedbackFiltering: options.trackFeedback && Object.keys(feedbackData).length > 0,
        },
        ...(filteredResults.metadata || {}),
      },
    };
  } catch (error) {
    console.error(chalk.red(`Error analyzing file: ${error.message}`));
    return {
      success: false,
      error: error.message,
      filePath,
    };
  }
}

/**
 * Prepare context for LLM analysis
 *
 * @param {string} filePath - Path to the file
 * @param {string} content - File content
 * @param {string} language - File language
 * @param {Array<Object>} codeExamples - Processed list of code examples
 * @param {Array<Object>} guidelineSnippets - Processed list of guideline snippets
 * @param {Array<Object>} prCommentContext - PR comment context
 * @param {Object} options - Options
 * @returns {Object} Context for LLM
 */
function prepareContextForLLM(filePath, content, language, finalCodeExamples, finalGuidelineSnippets, prCommentContext = [], options = {}) {
  const { customDocs, relevantCustomDocChunks, feedbackData, projectSummary } = options;

  // Extract file name and directory
  const fileName = path.basename(filePath);
  const dirPath = path.dirname(filePath);
  const dirName = path.basename(dirPath);

  // Determine if this is a diff-only review
  const isDiffReview = options.diffOnly && options.diffContent;
  const reviewType = isDiffReview ? 'DIFF REVIEW' : 'FULL FILE REVIEW';

  // For PR reviews, we need both the full file content and the diff
  // content represents the diff (what to review)
  // options.fullFileContent represents the complete file context
  const fullFileContent = isDiffReview && options.fullFileContent ? options.fullFileContent : content;

  // Format similar code examples and guideline snippets
  const codeExamples = formatContextItems(finalCodeExamples, 'code');
  const guidelineSnippets = formatContextItems(finalGuidelineSnippets, 'guideline');

  const contextSections = [];

  // Add existing context sections
  if (codeExamples.length > 0) {
    contextSections.push({
      title: 'Similar Code Examples',
      description: 'Code patterns from the project that are similar to the file being reviewed',
      items: codeExamples,
    });
  }

  if (guidelineSnippets.length > 0) {
    contextSections.push({
      title: 'Project Guidelines',
      description: 'Documentation and guidelines relevant to this code',
      items: guidelineSnippets,
    });
  }

  // Add PR Comment Context Section
  if (prCommentContext && prCommentContext.length > 0) {
    contextSections.push({
      title: 'Historical Review Comments',
      description: 'Similar code patterns and issues identified by human reviewers in past PRs',
      items: prCommentContext,
    });
  }

  // Add feedback context if available
  const dismissedPatterns = feedbackData ? extractDismissedPatterns(feedbackData, { maxPatterns: 10 }) : [];
  if (dismissedPatterns.length > 0) {
    contextSections.push({
      title: 'Dismissed Issue Patterns',
      description: 'Types of issues previously dismissed or marked as not relevant by users',
      items: dismissedPatterns.map((pattern, index) => ({
        index: index + 1,
        issue: pattern.issue,
        reason: pattern.reason,
        sentiment: pattern.sentiment,
      })),
    });
  }

  return {
    file: {
      path: filePath,
      name: fileName,
      directory: dirPath,
      directoryName: dirName,
      language,
      content,
      fullFileContent, // Include full file content for context awareness
      reviewType: reviewType,
      isDiffReview: isDiffReview,
      // Add PR context if available
      ...(options.prContext && {
        prContext: {
          totalFiles: options.prContext.totalFiles,
          testFiles: options.prContext.testFiles,
          sourceFiles: options.prContext.sourceFiles,
          allFiles: options.prContext.allFiles,
        },
      }),
      // Add diff-specific info if this is a diff review
      ...(isDiffReview &&
        options.diffInfo && {
          diffInfo: {
            addedLines: options.diffInfo.addedLines.length,
            removedLines: options.diffInfo.removedLines.length,
            baseBranch: options.baseBranch,
            targetBranch: options.targetBranch,
          },
        }),
    },
    context: contextSections,
    codeExamples,
    guidelineSnippets,
    customDocs: relevantCustomDocChunks || customDocs, // Use relevant chunks if available, fallback to full docs
    feedbackContext: generateFeedbackContext(dismissedPatterns), // Add feedback context for LLM
    projectSummary: projectSummary, // Add project architecture summary
    metadata: {
      hasCodeExamples: finalCodeExamples.length > 0,
      hasGuidelines: finalGuidelineSnippets.length > 0,
      hasPRHistory: prCommentContext.length > 0,
      hasFeedbackContext: dismissedPatterns.length > 0,
      hasProjectSummary: !!projectSummary,
      analysisTimestamp: new Date().toISOString(),
      reviewType: reviewType,
      isPRReview: options.isPRReview || false,
    },
    options,
  };
}

/**
 * Call LLM for code analysis
 *
 * @param {Object} context - Context for LLM
 * @param {Object} options - Options
 * @returns {Promise<Object>} Analysis results
 */
async function callLLMForAnalysis(context, options = {}) {
  try {
    let prompt;
    const model = options.model || 'claude-sonnet-4-5';
    const maxTokens = options.maxTokens || 8192; // Default to a safe limit

    if (options.isHolisticPRReview) {
      prompt = generateHolisticPRAnalysisPrompt(context);
    } else {
      prompt = options.isTestFile ? generateTestFileAnalysisPrompt(context) : generateAnalysisPrompt(context);
    }

    // Call LLM with the prompt
    const llmResponse = await sendPromptToLLM(prompt, {
      temperature: 0,
      maxTokens: maxTokens,
      model: model,
      isJsonMode: true, // Standardize on using JSON mode if available
    });

    console.log(chalk.blue('Received LLM response, attempting to parse...'));

    console.log(chalk.gray(`Response type: ${typeof llmResponse}`));
    console.log(chalk.gray(`Response length: ${llmResponse?.length || 0} characters`));

    // Parse the raw LLM response
    const analysisResponse = parseAnalysisResponse(llmResponse);

    // Validate the parsed response has the expected structure
    if (!options.isHolisticPRReview && (!analysisResponse.summary || !Array.isArray(analysisResponse.issues))) {
      console.warn(chalk.yellow('Parsed response missing expected structure, attempting to reconstruct...'));

      return {
        summary: analysisResponse.summary || 'Analysis completed with parsing issues',
        issues: Array.isArray(analysisResponse.issues) ? analysisResponse.issues : [],
        rawResponse: analysisResponse.rawResponse || llmResponse.substring(0, 500),
        parseWarning: 'Response structure was reconstructed due to parsing issues',
      };
    }

    console.log(chalk.green('Successfully parsed LLM response with expected structure'));
    return analysisResponse;
  } catch (error) {
    console.error(chalk.red(`Error calling LLM for analysis: ${error.message}`));
    console.error(error.stack);
    throw error;
  }
}

/**
 * Appends critical JSON formatting requirements to a prompt.
 * @param {string} promptBody - The main body of the prompt.
 * @returns {string} The finalized prompt with JSON formatting instructions.
 */
function finalizePrompt(promptBody) {
  return `${promptBody}

CRITICAL FORMATTING REQUIREMENTS:
- Respond ONLY with a valid JSON object
- Do not include any text before or after the JSON
- Do not wrap the JSON in markdown code blocks
- Ensure all strings are properly escaped
- Use double quotes for all string values
- Do not include trailing commas
- Validate that your response is parseable JSON before sending

MARKDOWN FORMATTING IN DESCRIPTIONS AND SUGGESTIONS:
- Use backticks (\`) around code elements like commands, flags, file names, variable names, function names, etc.
- Examples: \`git fetch\`, \`--unshallow\`, \`timeout-minutes\`, \`process.env.NODE_ENV\`, \`handleClick()\`
- Use backticks for any technical terms that would be considered "code" including:
  - Command line tools and commands
  - Command line flags and options
  - Configuration keys and values
  - File names and extensions
  - Environment variables
  - Function and variable names
  - CSS classes and IDs
  - HTML attributes
  - API endpoints and parameters
- Do NOT use backticks around regular English words or common nouns
- Use proper markdown formatting for emphasis (*italics*, **bold**) when appropriate

Your response must start with { and end with } with no additional text.`;
}

// LLM call function
async function sendPromptToLLM(prompt, llmOptions) {
  try {
    if (!llm || typeof llm.sendPromptToClaude !== 'function') {
      throw new Error('LLM module does not contain required function: sendPromptToClaude');
    }

    // Define schema for code review responses
    const codeReviewSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              severity: { type: 'string' },
              description: { type: 'string' },
              lineNumbers: {
                type: 'array',
                items: { type: 'number' },
              },
              suggestion: { type: 'string' },
              codeSuggestion: {
                type: 'object',
                properties: {
                  startLine: { type: 'number' },
                  endLine: { type: 'number' },
                  oldCode: { type: 'string' },
                  newCode: { type: 'string' },
                },
                required: ['startLine', 'oldCode', 'newCode'],
              },
              category: { type: 'string' },
            },
            required: ['type', 'severity', 'description', 'lineNumbers'],
          },
        },
        crossFileIssues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              severity: { type: 'string' },
              message: { type: 'string' },
              files: {
                type: 'array',
                items: { type: 'string' },
              },
              suggestion: { type: 'string' },
              category: { type: 'string' },
            },
            required: ['type', 'severity', 'message', 'files'],
          },
        },
        fileSpecificIssues: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                severity: { type: 'string' },
                description: { type: 'string' },
                lineNumbers: {
                  type: 'array',
                  items: { type: 'number' },
                },
                suggestion: { type: 'string' },
                codeSuggestion: {
                  type: 'object',
                  properties: {
                    startLine: { type: 'number' },
                    endLine: { type: 'number' },
                    oldCode: { type: 'string' },
                    newCode: { type: 'string' },
                  },
                  required: ['startLine', 'oldCode', 'newCode'],
                },
                category: { type: 'string' },
              },
              required: ['type', 'severity', 'description', 'lineNumbers'],
            },
          },
        },
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string' },
              suggestion: { type: 'string' },
              priority: { type: 'string' },
              impact: { type: 'string' },
            },
            required: ['category', 'suggestion'],
          },
        },
      },
      required: ['summary'],
    };

    const response = await llm.sendPromptToClaude(prompt, {
      ...llmOptions,
      jsonSchema: codeReviewSchema,
    });

    // Return the response object so parseAnalysisResponse can access the json property
    return response;
  } catch (error) {
    console.error(chalk.red(`Error in LLM call: ${error.message}`));
    throw error; // Re-throw to properly handle the error
  }
}

/**
 * Generate analysis prompt for LLM
 *
 * @param {Object} context - Context for LLM
 * @returns {string} Analysis prompt
 */
function generateAnalysisPrompt(context) {
  const { file, codeExamples, guidelineSnippets, customDocs, feedbackContext } = context;

  // Format code examples and guidelines using shared helpers
  const formattedCodeExamples = formatCodeExamplesBlock(codeExamples, 'CODE EXAMPLE');
  const formattedGuidelines = formatGuidelinesBlock(guidelineSnippets, 'GUIDELINE');

  // Check for PR comment context in the context object
  const { context: contextSections } = context;
  let prHistorySection = '';

  console.log(chalk.blue(`🔍 Checking for PR comments in prompt generation...`));
  console.log(chalk.gray(`Context sections available: ${contextSections ? contextSections.length : 0}`));

  if (contextSections && contextSections.length > 0) {
    contextSections.forEach((section, idx) => {
      console.log(chalk.gray(`  Section ${idx + 1}: ${section.title} (${section.items?.length || 0} items)`));
    });

    const prComments = contextSections.find((section) => section.title === 'Historical Review Comments');
    if (prComments && prComments.items.length > 0) {
      console.log(chalk.green(`✅ Adding ${prComments.items.length} PR comments to LLM prompt`));
      prHistorySection += `

CONTEXT C: HISTORICAL REVIEW COMMENTS
Similar code patterns and issues identified by human reviewers in past PRs

`;
      prComments.items.slice(0, MAX_PR_COMMENTS_FOR_CONTEXT).forEach((comment, idx) => {
        prHistorySection += `### Historical Comment ${idx + 1}\n`;
        prHistorySection += `- **PR**: #${comment.pr_number} by ${comment.author}\n`;
        prHistorySection += `- **File**: ${comment.file_path}\n`;
        prHistorySection += `- **Type**: ${comment.comment_type}\n`;
        prHistorySection += `- **Relevance**: ${(comment.similarity_score * 100).toFixed(1)}%\n`;
        prHistorySection += `- **Review**: ${comment.comment_text}\n\n`;
      });

      prHistorySection += `Use these historical patterns to identify DEFINITE issues in the current code. `;
      prHistorySection += `Only report issues that EXACTLY match historical patterns with SPECIFIC code fixes.\n\n`;

      console.log(chalk.blue(`PR History section preview: ${prHistorySection.substring(0, 200)}...`));
    } else {
      console.log(chalk.yellow(`❌ No PR comments section found in context`));
    }
  } else {
    console.log(chalk.yellow(`❌ No context sections available for PR comments`));
  }

  // Detect if this is a diff review
  const isDiffReview = file.reviewType === 'DIFF REVIEW';
  const reviewInstructions = isDiffReview
    ? 'Your task is to review the git diff by performing a two-stage analysis based **only** on the provided context, prioritizing documented guidelines and historical review patterns. Follow the context awareness instructions provided with the file content below.'
    : 'Your task is to review the following code file by performing a two-stage analysis based **only** on the provided context, prioritizing documented guidelines and historical review patterns.';

  const fileSection = isDiffReview
    ? `GIT DIFF TO REVIEW (FOCUS ONLY ON CHANGED LINES):
Path: ${file.path}
Language: ${file.language}
Base Branch: ${file.diffInfo?.baseBranch || 'master'}
Target Branch: ${file.diffInfo?.targetBranch || 'HEAD'}

**CRITICAL CONTEXT AWARENESS INSTRUCTIONS:**

You have access to TWO pieces of information:
1. **FULL FILE CONTENT** - The complete file for understanding context
2. **GIT DIFF** - Only the changes to review

**Review Rules:**
- ONLY critique the CHANGED lines shown in the diff (lines with + or -)
- USE the full file content to understand context and dependencies
- DO NOT suggest adding code that already exists in the unchanged portions
- DO NOT flag issues about missing code if it exists in the full file
- Do NOT flag functions/variables as missing if they exist elsewhere in the full file
- The unchanged code is part of the file - check it before making assumptions

**FULL FILE CONTENT (for context - DO NOT review unchanged code):**

\`\`\`${file.language}
${file.fullFileContent || file.content}
\`\`\`

**GIT DIFF TO REVIEW (critique ONLY these changes):**

\`\`\`diff
${file.content}
\`\`\``
    : `FILE TO REVIEW:
Path: ${file.path}
Language: ${file.language}

\`\`\`${file.language}
${file.content}
\`\`\``;

  // Add project architecture context if available
  let projectArchitectureSection = '';
  if (context.projectSummary) {
    projectArchitectureSection = formatProjectSummaryForLLM(context.projectSummary);
  }

  // Use shared helpers for custom docs and role definition
  const customDocsSection = formatCustomDocsSection(customDocs);
  const roleDefinition = buildRoleDefinition(
    'You are an expert code reviewer acting as a senior developer on this specific project.',
    customDocs,
    'code'
  );

  // Corrected prompt with full two-stage analysis + combined output stage
  return finalizePrompt(`
${roleDefinition}

${reviewInstructions}

${customDocsSection}

${fileSection}

CONTEXT FROM PROJECT:
${projectArchitectureSection}

CONTEXT A: EXPLICIT GUIDELINES FROM DOCUMENTATION
${formattedGuidelines}

CONTEXT B: SIMILAR CODE EXAMPLES FROM PROJECT
${formattedCodeExamples}

${prHistorySection}

${feedbackContext || ''}

INSTRUCTIONS:

${getCriticalRulesBlock({ importRuleContext: 'code' })}

**Perform the following analysis stages sequentially:**

**STAGE 1: Custom Instructions & Guideline-Based Review**
1.  **FIRST AND MOST IMPORTANT**: If custom instructions were provided at the beginning of this prompt, analyze the 'FILE TO REVIEW' against those custom instructions BEFORE all other analysis. Custom instructions always take precedence.
2.  Analyze the 'FILE TO REVIEW' strictly against the standards, rules, and explanations provided in 'CONTEXT A: EXPLICIT GUIDELINES'.
3.  Identify any specific deviations where the reviewed code violates custom instructions OR explicit guidelines. **CRITICAL**: When you find violations of custom instructions, you MUST cite the specific custom instruction source document name in your issue description and suggestion.
4.  Temporarily ignore 'CONTEXT B: SIMILAR CODE EXAMPLES' during this stage.

**STAGE 2: Code Example-Based Review (CRITICAL FOR IMPLICIT PATTERNS)**
1.  **CRITICAL FIRST STEP**: Scan ALL code examples in Context B and create a mental list of:
    - Common import statements (especially those containing 'helper', 'util', 'shared', 'common', 'test')
    - Frequently used function calls that appear across multiple examples
    - Project-specific wrappers or utilities (e.g., \`renderWithTestHelpers\` instead of direct \`render\`)
    - Consistent patterns in how operations are performed
2.  **IMPORTANT**: For each common utility or pattern you identify, note:
    - Which files use it (cite specific examples)
    - What the pattern appears to do
    - Whether the reviewed file is using this pattern or not
3.  Analyze the 'FILE TO REVIEW' against these discovered patterns. Focus on:
    - Missing imports of commonly used utilities
    - Direct library usage where others use project wrappers
    - Deviations from established patterns
4.  **HIGH PRIORITY**: Flag any instances where:
    - The reviewed code uses a direct library call (e.g., \`render\`) when multiple examples use a project wrapper (e.g., \`renderWithTestHelpers\`)
    - Common utility functions available in the project are not being imported or used
    - The code deviates from patterns that appear in 3+ examples
5.  Pay special attention to imports - if most similar files import certain utilities, the reviewed file should too.

**STAGE 3: Historical Review Comments Analysis**
1.  **CRITICAL**: If 'CONTEXT C: HISTORICAL REVIEW COMMENTS' is present, analyze each historical comment:
    - Look for patterns in the types of issues human reviewers have identified in similar code
    - Identify if the SAME DEFINITE issue exists in the current file (not similar - the SAME)
    - Pay special attention to comments with high relevance scores (>70%)
2.  **Apply Historical Insights**: For each historical comment:
    - Only report if the EXACT same issue type exists with a SPECIFIC code fix
    - Do NOT report speculative issues based on historical patterns
3.  **Prioritize Historical Issues**: Issues DEFINITELY matching historical patterns get high priority

**STAGE 4: Consolidate, Prioritize, and Generate Output**
1.  **CRITICAL REMINDER**: If custom instructions were provided at the beginning of this prompt, they take ABSOLUTE PRECEDENCE over all other guidelines and must be followed strictly.
2.  Combine the potential issues identified in Stage 1 (Guideline-Based), Stage 2 (Example-Based), and Stage 3 (Historical Review Comments).
3.  **Apply Conflict Resolution AND Citation Rules:**
    *   **Guideline Precedence:** If an issue identified in Stage 2 (from code examples) or Stage 3 (from historical comments) **contradicts** an explicit guideline from Stage 1, **discard the conflicting issue**. Guidelines always take precedence.
    *   **Citation Priority:** When reporting an issue:
       *   **CRITICAL FOR CUSTOM INSTRUCTIONS**: If the issue violates a custom instruction provided at the beginning of this prompt, you MUST include the source document name in both the description and suggestion. For example: "violates the coding standards specified in '[Document Name]'" or "as required by '[Document Name]'".
       *   If the relevant convention or standard is defined in 'CONTEXT A: EXPLICIT GUIDELINES', cite the guideline document.
       *   For implicit patterns discovered from code examples (like helper utilities, common practices), cite the specific code examples that demonstrate the pattern.
       *   For issues identified from historical review comments, report them as standard code review findings without referencing the historical source.
       *   **IMPORTANT**: When citing implicit patterns from Context B, be specific about which files demonstrate the pattern and what the pattern is.
4.  **Special attention to implicit patterns**: Issues related to not using project-specific utilities or helpers should be marked as high priority if the pattern appears consistently across multiple examples in Context B.
5.  **Special attention to historical patterns**: Issues DEFINITELY matching historical patterns get high priority.
6.  Assess for DEFINITE logic errors or bugs only - do NOT report speculative issues.
7.  **CRITICAL OUTPUT FILTER**: Before reporting ANY issue, ask yourself: "Do I have a SPECIFIC code fix?" If not, do NOT report it. Do NOT ask the developer to verify, ensure, or check anything.
8.  **CRITICAL 'lineNumbers' RULE - MANDATORY COMPLIANCE**:
    - **ALWAYS provide line numbers** - this field is REQUIRED for every issue
    - If you can identify specific lines, provide them (max 3-5 for repeated issues)
    - If the issue affects the entire file or cannot be pinpointed, provide [1] or relevant section line numbers
    - For ANY issue that occurs multiple times in a file, list ONLY the first 3-5 occurrences maximum
    - NEVER provide exhaustive lists of line numbers (e.g., [1,2,3,4,5,6,7,8,9,10...])
    - If an issue affects many lines, use representative examples only
    - Exhaustive line number lists are considered hallucination and must be avoided
    - Example: Instead of listing 20+ line numbers, use [15, 23, 47]
    - **NEVER omit lineNumbers** - empty arrays [] are not allowed
9.  Format the final, consolidated, and prioritized list of issues, along with a brief overall summary, **strictly** according to the JSON structure below.
10. CRITICAL: Respond ONLY with valid JSON - start with { and end with }, no additional text.

${getFinalReminderBlock()}

${getCitationRequirementBlock()}

REQUIRED JSON OUTPUT FORMAT:

**REMINDER: lineNumbers is REQUIRED - always provide at least one line number. Use ONLY 3-5 representative line numbers for repeated issues. NEVER provide exhaustive lists or empty arrays.**

${getCodeSuggestionsFormatBlock()}

You must respond with EXACTLY this JSON structure, with no additional text:

{
  "summary": "Brief summary of the review, highlighting adherence to documented guidelines and consistency with code examples, plus any major issues found.",
  "issues": [
    {
      "type": "bug | improvement | convention | performance | security",
      "severity": "critical | high | medium",
      "description": "Description of the issue, clearly stating the deviation from the prioritized project pattern (guideline or example) OR the nature of the bug/improvement.",
      "lineNumbers": [42, 55, 61],
      "suggestion": "Concrete suggestion for fixing the issue or aligning with the prioritized inferred pattern. Ensure the suggestion is additive if adding missing functionality (like a hook) and doesn't wrongly suggest replacing existing, unrelated code.",
      "codeSuggestion": {
        "startLine": 42,
        "endLine": 44,
        "oldCode": "    const result = data.map(item => item.value);",
        "newCode": "    const result = data?.map(item => item?.value) ?? [];"
      }
    }
  ]
}
`);
}

/**
 * Generate test file analysis prompt for LLM
 *
 * @param {Object} context - Context for LLM
 * @returns {string} Test file analysis prompt
 */
function generateTestFileAnalysisPrompt(context) {
  const { file, codeExamples, guidelineSnippets, customDocs } = context;

  // Format code examples and guidelines using shared helpers
  const formattedCodeExamples = formatCodeExamplesBlock(codeExamples, 'TEST EXAMPLE');
  const formattedGuidelines = formatGuidelinesBlock(guidelineSnippets, 'TESTING GUIDELINE');

  // Detect if this is a diff review
  const isDiffReview = file.reviewType === 'DIFF REVIEW';
  const reviewInstructions = isDiffReview
    ? 'Your task is to review the test file git diff by performing a comprehensive analysis focused on testing best practices and patterns. Follow the context awareness instructions provided with the file content below.'
    : 'Your task is to review the following test file by performing a comprehensive analysis focused on testing best practices and patterns.';

  const fileSection = isDiffReview
    ? `TEST FILE GIT DIFF TO REVIEW (FOCUS ONLY ON CHANGED LINES):
Path: ${file.path}
Language: ${file.language}
Base Branch: ${file.diffInfo?.baseBranch || 'master'}
Target Branch: ${file.diffInfo?.targetBranch || 'HEAD'}

**CRITICAL CONTEXT AWARENESS INSTRUCTIONS:**

You have access to TWO pieces of information:
1. **FULL TEST FILE CONTENT** - The complete test file for understanding existing test coverage
2. **GIT DIFF** - Only the test changes to review

**Review Rules:**
- ONLY critique the CHANGED lines in the diff (lines with + or -)
- USE the full file to verify existing test coverage before suggesting new tests
- DO NOT suggest adding tests that already exist in the unchanged portions
- DO NOT flag missing test coverage if tests exist elsewhere in the file
- Check the full file for existing test cases before making assumptions
- The unchanged test code is part of the file - review it before suggesting additions

**FULL TEST FILE CONTENT (for context - check for existing tests):**

\`\`\`${file.language}
${file.fullFileContent || file.content}
\`\`\`

**GIT DIFF TO REVIEW (critique ONLY these changes):**

\`\`\`diff
${file.content}
\`\`\``
    : `TEST FILE TO REVIEW:
Path: ${file.path}
Language: ${file.language}

\`\`\`${file.language}
${file.content}
\`\`\``;

  // Use shared helpers for custom docs and role definition
  const customDocsSection = formatCustomDocsSection(customDocs);
  const roleDefinition = buildRoleDefinition(
    'You are an expert test code reviewer acting as a senior developer on this specific project.',
    customDocs,
    'test'
  );

  // Add project architecture context if available
  let projectArchitectureSection = '';
  if (context.projectSummary) {
    projectArchitectureSection = formatProjectSummaryForLLM(context.projectSummary);
  }

  // Test-specific prompt
  return finalizePrompt(`
${roleDefinition}

${reviewInstructions}

${fileSection}

## ANALYSIS CONTEXT
${customDocsSection}

CONTEXT FROM PROJECT:
${projectArchitectureSection}

CONTEXT A: TESTING GUIDELINES AND BEST PRACTICES
${formattedGuidelines}

CONTEXT B: SIMILAR TEST EXAMPLES FROM PROJECT
${formattedCodeExamples}

INSTRUCTIONS:

${getCriticalRulesBlock({ importRuleContext: 'test' })}

**Perform the following test-specific analysis:**

**STAGE 1: Custom Instructions & Test Coverage Analysis**
1. **FIRST AND MOST IMPORTANT**: If custom instructions were provided at the beginning of this prompt, analyze the test file against those custom instructions BEFORE all other analysis. Custom instructions always take precedence.
2. Analyze test coverage - identify SPECIFIC missing test cases only if you can name the exact scenario that should be tested.
3. Only report coverage gaps where you can provide a concrete test case to add.

**STAGE 2: Test Quality and Best Practices**
1. Evaluate test naming conventions - report only DEFINITE violations where you can show the correct naming.
2. Analyze test organization - report only if tests are clearly misorganized with a specific fix.
3. Assess assertion quality - report only weak assertions where you can provide a stronger alternative.
4. Review test isolation - report only if you find a DEFINITE side effect issue with a specific fix.

**STAGE 3: Testing Patterns and Conventions (CRITICAL)**
1. **IMPORTANT**: Carefully analyze ALL code examples in Context B to identify:
   - Common helper functions or utilities that appear across multiple test files
   - Consistent patterns in how certain operations are performed (e.g., rendering, mocking, assertions)
   - Any project-specific abstractions or wrappers around standard testing libraries
2. **CRITICAL**: Compare the reviewed test file against these discovered patterns. Flag ONLY instances where:
   - The test DEFINITELY uses a direct library call when a project wrapper exists (cite the wrapper)
   - A common utility is DEFINITELY available but not used (cite where it's defined)
   - The test CLEARLY deviates from a pattern shown in 3+ examples (cite the examples)
3. Report mocking/stubbing issues only with a specific code fix.
4. Report fixture issues only with a specific code fix showing the correct pattern.
5. Report async handling issues only with specific code showing the correct approach.

**STAGE 4: Performance and Maintainability**
1. Report slow tests only if you can identify the specific cause and fix.
2. Report code duplication only with a specific refactoring suggestion.

**STAGE 5: Consolidate and Generate Output**
1. **CRITICAL**: Prioritize issues where the test deviates from implicit project patterns shown in Context B (similar test examples), especially regarding test utilities and helper functions.
2. Provide concrete suggestions that align with the project's testing patterns, referencing specific examples from Context B when applicable.
3. Assess for any potential logic errors or bugs within the reviewed code itself, independent of conventions, and include them as separate issues.
4. **CRITICAL 'lineNumbers' RULE - MANDATORY COMPLIANCE**:
   - For ANY issue that occurs multiple times in a test file, list ONLY the first 3-5 occurrences maximum
   - NEVER provide exhaustive lists of line numbers (e.g., [1,2,3,4,5,6,7,8,9,10...])
   - If an issue affects many lines, use representative examples only
   - Exhaustive line number lists are considered hallucination and must be avoided
   - Example: Instead of listing 20+ line numbers, use [15, 23, 47, "...and 12 other occurrences"]
5. Format the output according to the JSON structure below.

${getFinalReminderBlock()}

${getCitationRequirementBlock()}

REQUIRED JSON OUTPUT FORMAT:

**REMINDER: For lineNumbers array, use ONLY 3-5 representative line numbers for repeated issues. NEVER provide exhaustive lists.**

${getCodeSuggestionsFormatBlock()}

You must respond with EXACTLY this JSON structure, with no additional text:

{
  "summary": "Brief summary of the test file review, highlighting coverage completeness, adherence to testing best practices, and any critical issues found.",
  "issues": [
    {
      "type": "bug | improvement | convention | performance | coverage",
      "severity": "critical | high | medium",
      "description": "Description of the issue, clearly stating the problem with the test implementation or coverage gap.",
      "lineNumbers": [25, 38],
      "suggestion": "Concrete suggestion for improving the test, adding missing coverage, or following testing best practices.",
      "codeSuggestion": {
        "startLine": 25,
        "endLine": 27,
        "oldCode": "    expect(result).toBe(true);",
        "newCode": "    expect(result).toBe(true);\n    expect(result).not.toBeNull();"
      }
    }
  ]
}
`);
}

/**
 * Generate holistic PR analysis prompt for LLM
 *
 * @param {Object} context - Holistic context for LLM
 * @returns {string} Holistic PR analysis prompt
 */
function generateHolisticPRAnalysisPrompt(context) {
  const { file, context: contextSections, customDocs } = context;

  // Format unified context sections
  const formattedCodeExamples =
    contextSections
      .find((s) => s.title === 'Similar Code Examples')
      ?.items?.slice(0, 10)
      .map((ex, idx) => {
        return `
CODE EXAMPLE ${idx + 1} (Similarity: ${ex.similarity?.toFixed(3) || 'N/A'})
Path: ${ex.path}
Language: ${ex.language}

\`\`\`${ex.language || ''}
${ex.content}
\`\`\`
`;
      })
      .join('\n') || 'No relevant code examples found.';

  const formattedGuidelines =
    contextSections
      .find((s) => s.title === 'Project Guidelines')
      ?.items?.slice(0, 8)
      .map((g, idx) => {
        return `
GUIDELINE ${idx + 1} (Source: ${g.path})
${g.headingText ? `Heading: "${g.headingText}"` : ''}

\`\`\`
${g.content}
\`\`\`
`;
      })
      .join('\n') || 'No specific guidelines found.';

  const formattedPRComments =
    contextSections
      .find((s) => s.title === 'Historical Review Comments')
      ?.items?.slice(0, MAX_PR_COMMENTS_FOR_CONTEXT)
      .map((comment, idx) => {
        return `### Historical Comment ${idx + 1}
- **PR**: #${comment.prNumber} by ${comment.author}
- **File**: ${comment.filePath}
- **Type**: ${comment.commentType || 'review'}
- **Relevance**: ${(comment.relevanceScore * 100).toFixed(1)}%
- **Review**: ${comment.body}

`;
      })
      .join('\n') || 'No historical PR comments found.';

  // Format PR files with their diffs
  const prFiles = file.prFiles || [];
  const formattedPRFiles = prFiles
    .map((prFile, idx) => {
      return `
## FILE ${idx + 1}: ${prFile.path}
**Language**: ${prFile.language}
**Type**: ${prFile.isTest ? 'Test' : 'Source'} file
**Summary**: ${prFile.summary}

### Changes (Git Diff):
\`\`\`diff
${prFile.diff}
\`\`\`

### Full File Content (For Context):
\`\`\`${prFile.language}
${prFile.fullContent}
\`\`\`
`;
    })
    .join('\n');

  // Use shared helper for custom docs section
  const customDocsSection = formatCustomDocsSection(customDocs);

  // Build the role definition - PR analysis has additional context awareness instructions
  const baseRole = `You are an expert code reviewer performing a holistic review of a Pull Request with ${prFiles.length} files.

**CRITICAL CONTEXT AWARENESS INSTRUCTIONS:**

For each file in this PR, you have access to:
1. **FULL FILE CONTENT** - The complete file for understanding context and existing code
2. **GIT DIFF** - Only the changes to review

**Review Rules:**
- ONLY critique the CHANGED lines shown in each file's diff (lines with + or -)
- USE the full file content to understand context, dependencies, and existing implementations
- DO NOT suggest adding code that already exists in the unchanged portions of any file
- DO NOT flag issues about missing code if it exists elsewhere in the full file
- Before flagging cross-file issues, verify the code doesn't already exist in unchanged portions
- Do NOT flag functions/variables as missing if they exist elsewhere in the full file
- The unchanged code is part of each file - always check it before making assumptions`;

  let roleDefinition = buildRoleDefinition(baseRole, customDocs, 'pr');
  roleDefinition += '\nAnalyze ALL files together to identify cross-file issues, consistency problems, and overall code quality.';

  // Add project architecture context if available
  let projectArchitectureSection = '';
  if (context.projectSummary) {
    projectArchitectureSection = formatProjectSummaryForLLM(context.projectSummary);
  }

  return finalizePrompt(`
${roleDefinition}

## PULL REQUEST OVERVIEW
- **Total Files**: ${prFiles.length}
- **Source Files**: ${prFiles.filter((f) => !f.isTest).length}
- **Test Files**: ${prFiles.filter((f) => f.isTest).length}

## UNIFIED CONTEXT FROM PROJECT
${projectArchitectureSection}

### PROJECT CODE EXAMPLES
${formattedCodeExamples}

### PROJECT GUIDELINES
${formattedGuidelines}

### HISTORICAL REVIEW COMMENTS
${formattedPRComments}

## PR FILES WITH CHANGES
${formattedPRFiles}

## ANALYSIS CONTEXT
${customDocsSection}

## ANALYSIS INSTRUCTIONS

${getCriticalRulesBlock({ importRuleContext: 'pr' })}

**Perform the following holistic analysis stages sequentially for all PR files:**

### **STAGE 1: Project Pattern Analysis (CRITICAL FOR CONSISTENCY)**

1. **CRITICAL FIRST STEP**: Scan ALL code examples in PROJECT CODE EXAMPLES and create a comprehensive list of:
   - Common import statements (especially those containing 'helper', 'util', 'shared', 'common', 'test')
   - Frequently used function calls that appear across multiple examples
   - Project-specific wrappers or utilities (e.g., \`renderWithTestHelpers\` instead of direct \`render\`)
   - Consistent patterns in how operations are performed
   - Testing patterns and helper functions
   - Component patterns and architectural approaches

2. **IMPORTANT**: For each common utility or pattern you identify, note:
   - Which example files demonstrate it (cite specific examples)
   - What the pattern appears to do
   - Whether ALL PR files are using this pattern consistently

3. **HIGH PRIORITY CROSS-FILE CHECKS**: Flag any instances where:
   - Files use direct library calls when multiple examples use project wrappers
   - Common utility functions available in the project are not being imported/used consistently
   - Files deviate from patterns that appear in 3+ examples
   - Test files don't follow established test helper patterns
   - Import statements are inconsistent across similar files

### **STAGE 2: Custom Instructions & Guideline Compliance Analysis**

1. **FIRST AND MOST IMPORTANT**: If custom instructions were provided at the beginning of this prompt, analyze ALL PR files against those custom instructions BEFORE all other analysis. Custom instructions always take precedence.
2. Analyze ALL PR files strictly against the standards, rules, and explanations in PROJECT GUIDELINES
3. Identify specific deviations where any file violates custom instructions OR explicit guidelines. Note the source for each deviation found.
4. Check for consistency of guideline application across all files
5. Ensure architectural decisions are consistent across the PR

### **STAGE 3: Historical Pattern Recognition**

1. **CRITICAL**: Analyze HISTORICAL REVIEW COMMENTS to identify patterns:
   - Types of issues human reviewers frequently flag in similar code
   - Recurring themes across multiple historical comments
   - High-relevance issues (>70% relevance score) that apply to current PR

2. **Apply Historical Insights to Each File**:
   - Identify DEFINITE issues that match historical patterns across PR files
   - Apply reviewer suggestions that are relevant to current changes
   - Look for patterns that span multiple files in the PR

### **STAGE 4: Cross-File Integration Analysis**

1. **Naming and Import Consistency**:
   - Report naming inconsistencies only with specific examples and fixes
   - Report import/export issues only with specific missing/incorrect imports identified
   - Report duplicated logic only with specific refactoring suggestions

2. **Test Coverage and Quality**:
   - Report missing tests only if you can specify EXACTLY which test case should be added
   - Report test pattern deviations only with specific code fixes
   - Do NOT suggest "adding tests" without specifying the exact test

3. **Architectural Integration**:
   - Report breaking changes only if you can identify the SPECIFIC break
   - Report API inconsistencies only with SPECIFIC mismatches identified
   - Report separation of concerns issues only with SPECIFIC refactoring suggestions

### **STAGE 5: Consolidate and Prioritize Issues**

1. **Apply Conflict Resolution Rules**:
   - **Guideline Precedence**: If pattern-based or historical insights contradict explicit guidelines, guidelines take precedence
   - **Cross-File Priority**: Issues affecting multiple files get higher priority
   - **Pattern Consistency**: Missing project-specific utilities/helpers are high priority if pattern appears in 3+ examples

2. **Citation Rules**:
   - For guideline violations: cite the specific guideline document
   - For pattern deviations: cite specific code examples that demonstrate the correct pattern
   - For historical issues: report as standard findings without referencing historical source
   - For cross-file issues: specify all affected files

3. **CRITICAL OUTPUT FILTER - Apply before reporting ANY issue**:
   - **Only report issues where you have a DEFINITE problem AND a SPECIFIC code fix**
   - **Do NOT report issues that require the developer to "verify", "ensure", or "check" something**
   - **Do NOT report issues where you are uncertain** - if you find yourself writing "may", "might", "could", or "consider", do not report it
   - **Do NOT suggest adding comments or documentation**

4. Assess for DEFINITE logic errors or bugs only - do not report speculative issues.
5. DO NOT check if any file referenced in a import statement, is missing.
6. **CRITICAL 'lineNumbers' RULE - MANDATORY COMPLIANCE**:
   - For ANY issue that occurs multiple times in a file, list ONLY the first 3-5 occurrences maximum
   - NEVER provide exhaustive lists of line numbers (e.g., [1,2,3,4,5,6,7,8,9,10...])
   - If an issue affects many lines, use representative examples only
   - Exhaustive line number lists are considered hallucination and must be avoided
   - Example: Instead of listing 20+ line numbers, use [15, 23, 47, "...and 12 other occurrences"]

${getFinalReminderBlock()}

${getCitationRequirementBlock()}

REQUIRED JSON OUTPUT FORMAT:

**REMINDER: For lineNumbers array, use ONLY 3-5 representative line numbers for repeated issues. NEVER provide exhaustive lists.**

${getCodeSuggestionsFormatBlock()}

You must respond with EXACTLY this JSON structure, with no additional text:

{
      "summary": "Brief, high-level summary of the entire PR review...",
  "crossFileIssues": [
    {
          "type": "bug | improvement | convention | architecture",
          "severity": "critical | high | medium",
          "description": "Detailed description of an issue that spans multiple files...",
          "suggestion": "Actionable suggestion to resolve the cross-file issue.",
          "filesInvolved": ["path/to/file1.js", "path/to/file2.ts"]
    }
  ],
  "fileSpecificIssues": {
        "path/to/file1.js": [
      {
        "type": "bug | improvement | convention | performance | security",
        "severity": "critical | high | medium",
            "description": "Description of the issue specific to this file.",
            "lineNumbers": [10, 15],
            "suggestion": "Concrete suggestion for fixing the issue in this file.",
            "codeSuggestion": {
              "startLine": 10,
              "endLine": 15,
              "oldCode": "    const result = data.map(item => item.value);",
              "newCode": "    const result = data?.map(item => item?.value) ?? [];"
            }
      }
    ]
  },
  "recommendations": [
    {
          "type": "refactoring | testing | documentation",
          "description": "A high-level recommendation for improving the codebase...",
          "filesInvolved": ["path/to/relevant/file.js"]
        }
      ]
    }
`);
}

/**
 * Parse LLM analysis response
 *
 * @param {string} rawResponse - Raw LLM response
 * @returns {Object} Parsed analysis response
 */
function parseAnalysisResponse(rawResponse) {
  // rawResponse is now the full LLM response object with structured JSON from tool calling
  const parsedResponse = rawResponse.json;

  if (!parsedResponse) {
    return {
      summary: 'Error parsing LLM response',
      issues: [],
      crossFileIssues: [],
      fileSpecificIssues: {},
      recommendations: [],
      rawResponse,
      parseError: 'Failed to parse JSON from LLM response',
    };
  }

  // Check for holistic review structure, which contains fileSpecificIssues
  if (parsedResponse.fileSpecificIssues || parsedResponse.crossFileIssues || parsedResponse.recommendations) {
    return {
      summary: parsedResponse.summary || 'No summary provided',
      crossFileIssues: parsedResponse.crossFileIssues || [],
      fileSpecificIssues: parsedResponse.fileSpecificIssues || {},
      recommendations: parsedResponse.recommendations || [],
      rawResponse,
    };
  }

  // Fallback to single-file review structure
  return {
    summary: parsedResponse.summary || 'No summary provided',
    issues: parsedResponse.issues || [],
    rawResponse,
  };
}

/**
 * Get PR comment context for historical analysis integration
 *
 * @param {string} filePath - Path to the file being analyzed
 * @param {Object} options - Options for context retrieval
 * @returns {Promise<Object>} Historical PR comment context
 */
async function getPRCommentContext(filePath, options = {}) {
  try {
    const { maxComments = 20, similarityThreshold = 0.15, projectPath = process.cwd(), precomputedQueryEmbedding = null } = options;

    // Normalize file path for comparison
    const normalizedPath = path.normalize(filePath);
    const fileName = path.basename(normalizedPath);

    debug(`[getPRCommentContext] Getting context for ${normalizedPath}`);

    // Use pre-computed embedding if available, otherwise compute it
    let fileContent = '';
    let contentForSearch = '';

    if (precomputedQueryEmbedding) {
      console.log(chalk.blue(`🔍 Using pre-computed query embedding for PR comment search`));
      // We still need the file content for the search function, but not for embedding
      try {
        fileContent = fs.readFileSync(filePath, 'utf8');
        const maxEmbeddingLength = 8000; // Keep consistent with original truncation
        contentForSearch = fileContent.length > maxEmbeddingLength ? fileContent.substring(0, maxEmbeddingLength) : fileContent;
      } catch (readError) {
        debug(`[getPRCommentContext] Could not read file ${filePath}: ${readError.message}`);
        return {
          success: false,
          hasContext: false,
          error: `Could not read file: ${readError.message}`,
          comments: [],
          summary: 'Failed to read file for context analysis',
        };
      }
    } else {
      // Fallback to original behavior if no pre-computed embedding provided
      try {
        fileContent = fs.readFileSync(filePath, 'utf8');
      } catch (readError) {
        debug(`[getPRCommentContext] Could not read file ${filePath}: ${readError.message}`);
        return {
          success: false,
          hasContext: false,
          error: `Could not read file: ${readError.message}`,
          comments: [],
          summary: 'Failed to read file for context analysis',
        };
      }

      // Truncate content for embedding if too long
      const maxEmbeddingLength = 8000; // Reasonable limit for embedding
      contentForSearch = fileContent.length > maxEmbeddingLength ? fileContent.substring(0, maxEmbeddingLength) : fileContent;
    }

    // Detect if this is a test file using existing utility
    const isTest = isTestFile(filePath);

    // Use semantic search to find similar PR comments
    let relevantComments = [];

    console.log(chalk.blue(`🔍 Searching for PR comments with:`));

    console.log(chalk.gray(`  Project Path: ${projectPath}`));
    console.log(chalk.gray(`  File: ${fileName}`));
    console.log(chalk.gray(`  Similarity Threshold: ${similarityThreshold}`));
    console.log(chalk.gray(`  Content Length: ${contentForSearch.length} chars`));
    console.log(chalk.gray(`  Using Pre-computed Embedding: ${precomputedQueryEmbedding ? 'Yes' : 'No'}`));

    try {
      console.log(chalk.blue(`🔍 Attempting hybrid search with chunking...`));
      relevantComments = await findRelevantPRComments(contentForSearch, {
        projectPath,
        limit: maxComments,
        isTestFile: isTest, // Pass test file context for filtering
        precomputedQueryEmbedding: precomputedQueryEmbedding, // Pass pre-computed embedding if available
      });
      console.log(chalk.green(`✅ Hybrid search returned ${relevantComments.length} comments`));
      if (relevantComments.length > 0) {
        console.log(chalk.blue(`Top comment similarities:`));
        relevantComments.slice(0, 3).forEach((comment, idx) => {
          console.log(
            chalk.gray(`  ${idx + 1}. Score: ${comment.similarity_score?.toFixed(3)} - ${comment.comment_text?.substring(0, 80)}...`)
          );
        });
      }
    } catch (dbError) {
      console.log(chalk.yellow(`⚠️ Hybrid search failed: ${dbError.message}`));
      debug(`[getPRCommentContext] Hybrid search failed: ${dbError.message}`);
      // No fallback needed - if hybrid search fails, we just return empty results
      relevantComments = [];
    }

    console.log('Total relevant comments number:', relevantComments.length);

    // Extract patterns and insights
    const patterns = extractCommentPatterns(relevantComments);
    const summary = generateContextSummary(relevantComments, patterns);

    debug(`[getPRCommentContext] Found ${relevantComments.length} relevant comments for ${normalizedPath}`);

    return {
      success: true,
      hasContext: relevantComments.length > 0,
      filePath: normalizedPath,
      comments: relevantComments.map(formatCommentForContext),
      patterns,
      summary,
      metadata: {
        totalCommentsFound: relevantComments.length,
        relevantCommentsReturned: relevantComments.length,
        averageRelevanceScore:
          relevantComments.length > 0 ? relevantComments.reduce((sum, c) => sum + c.similarity_score, 0) / relevantComments.length : 0,
        searchMethod:
          relevantComments.length > 0 && relevantComments[0].similarity_score !== 0.5 ? 'semantic_embedding' : 'file_path_fallback',
      },
    };
  } catch (error) {
    debug(`[getPRCommentContext] Error getting PR comment context: ${error.message}`);
    return {
      success: false,
      hasContext: false,
      error: error.message,
      comments: [],
      summary: 'Failed to retrieve historical context',
    };
  }
}

/**
 * Extract patterns from historical comments
 */
function extractCommentPatterns(comments) {
  const patterns = {
    commonIssues: [],
    reviewPatterns: [],
    technicalConcerns: [],
    suggestedImprovements: [],
  };

  // Analyze comment content for patterns
  const allText = comments
    .map((c) => c.body || '')
    .join(' ')
    .toLowerCase();

  // Common issue keywords
  const issueKeywords = ['bug', 'error', 'issue', 'problem', 'broken', 'fail'];
  patterns.commonIssues = issueKeywords.filter((keyword) => allText.includes(keyword));

  // Review pattern keywords
  const reviewKeywords = ['suggest', 'recommend', 'consider', 'improve', 'better'];
  patterns.reviewPatterns = reviewKeywords.filter((keyword) => allText.includes(keyword));

  // Technical concern keywords
  const techKeywords = ['performance', 'security', 'memory', 'optimization', 'scalability'];
  patterns.technicalConcerns = techKeywords.filter((keyword) => allText.includes(keyword));

  return patterns;
}

/**
 * Generate summary of historical context
 */
function generateContextSummary(comments, patterns) {
  if (comments.length === 0) {
    return 'No relevant historical comments found for this file.';
  }

  const summaryParts = [`Found ${comments.length} relevant historical comments.`];

  if (patterns.commonIssues.length > 0) {
    summaryParts.push(`Common issues mentioned: ${patterns.commonIssues.join(', ')}.`);
  }

  if (patterns.reviewPatterns.length > 0) {
    summaryParts.push(`Review suggestions often involve: ${patterns.reviewPatterns.join(', ')}.`);
  }

  if (patterns.technicalConcerns.length > 0) {
    summaryParts.push(`Technical concerns raised: ${patterns.technicalConcerns.join(', ')}.`);
  }

  // Add recency information
  const recentComments = comments.filter((c) => {
    const daysSince = (Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince <= 30;
  });

  if (recentComments.length > 0) {
    summaryParts.push(`${recentComments.length} comments from the last 30 days.`);
  }

  return summaryParts.join(' ');
}

/**
 * Format comment for context usage
 */
function formatCommentForContext(comment) {
  return {
    id: comment.id,
    author: comment.author || comment.author_login, // Handle both field names
    body: (comment.comment_text || comment.body || '').substring(0, 500), // Handle both field names and truncate
    createdAt: comment.created_at,
    commentType: comment.comment_type,
    filePath: comment.file_path,
    prNumber: comment.pr_number,
    prTitle: comment.pr_title,
    relevanceScore: comment.similarity_score || comment.relevanceScore, // Handle both field names
  };
}

/**
 * Perform holistic PR analysis using unified context
 * @param {Object} options - Analysis options including prFiles and unifiedContext
 * @returns {Promise<Object>} Holistic analysis results
 */
async function performHolisticPRAnalysis(options) {
  try {
    const { prFiles, unifiedContext, customDocs } = options;

    console.log(chalk.blue(`🔍 Performing holistic analysis of ${prFiles.length} files with unified context...`));

    // Retrieve project architecture summary
    console.log(chalk.blue('--- Retrieving Project Architecture Context for Holistic PR Review ---'));
    const projectPath = options.projectPath || process.cwd();
    const projectSummary = await getProjectSummary(projectPath);

    // Create a synthetic file context for holistic analysis
    const holisticContext = {
      file: {
        path: 'PR_HOLISTIC_REVIEW',
        name: 'Pull Request',
        directory: '.',
        directoryName: '.',
        language: 'diff',
        content: prFiles.map((f) => f.diff).join('\n\n'),
        reviewType: 'PR HOLISTIC REVIEW',
        isDiffReview: true,
        prFiles: prFiles, // Add all PR files for context
      },
      context: [
        {
          title: 'Similar Code Examples',
          description: 'Code patterns from the project that are similar to the files being reviewed',
          items: unifiedContext.codeExamples.slice(0, 10),
        },
        {
          title: 'Project Guidelines',
          description: 'Documentation and guidelines relevant to this code',
          items: unifiedContext.guidelines.slice(0, 8),
        },
        {
          title: 'Historical Review Comments',
          description: 'Similar code patterns and issues identified by human reviewers in past PRs',
          items: unifiedContext.prComments.slice(0, 10),
        },
      ],
      customDocs: unifiedContext.customDocChunks || options.relevantCustomDocChunks || customDocs, // Use unified chunks first, then relevant chunks, then full docs
      projectSummary: projectSummary, // Add project architecture summary
      metadata: {
        hasCodeExamples: unifiedContext.codeExamples.length > 0,
        hasGuidelines: unifiedContext.guidelines.length > 0,
        hasPRHistory: unifiedContext.prComments.length > 0,
        hasProjectSummary: !!projectSummary,
        analysisTimestamp: new Date().toISOString(),
        reviewType: 'PR HOLISTIC REVIEW',
        isPRReview: true,
        isHolisticReview: true,
      },
      options: options,
    };

    // Add verbose debug logging similar to individual file reviews
    console.log(chalk.magenta('--- Holistic PR Review: Guidelines Sent to LLM ---'));
    if (unifiedContext.guidelines.length > 0) {
      unifiedContext.guidelines.slice(0, 10).forEach((g, i) => {
        console.log(
          chalk.magenta(
            `  [${i + 1}] Path: ${g.path} ${g.headingText || g.heading_text ? `(Heading: "${g.headingText || g.heading_text}")` : ''}`
          )
        );
        console.log(chalk.gray(`      Content: ${g.content.substring(0, 100).replace(/\n/g, ' ')}...`));
      });
    } else {
      console.log(chalk.magenta('  (None)'));
    }

    console.log(chalk.magenta('--- Holistic PR Review: Code Examples Sent to LLM ---'));
    if (unifiedContext.codeExamples.length > 0) {
      unifiedContext.codeExamples.slice(0, 10).forEach((ex, i) => {
        console.log(chalk.magenta(`  [${i + 1}] Path: ${ex.path} (Similarity: ${ex.similarity?.toFixed(3) || 'N/A'})`));
        console.log(chalk.gray(`      Content: ${ex.content.substring(0, 100).replace(/\\n/g, ' ')}...`));
      });
    } else {
      console.log(chalk.magenta('  (None)'));
    }

    console.log(chalk.magenta('--- Holistic PR Review: Top Historic Comments Sent to LLM ---'));
    if (unifiedContext.prComments.length > 0) {
      unifiedContext.prComments.slice(0, 5).forEach((comment, i) => {
        console.log(
          chalk.magenta(
            `  [${i + 1}] PR #${comment.prNumber} by ${comment.author} (Relevance: ${(comment.relevanceScore * 100).toFixed(1)}%)`
          )
        );
        console.log(chalk.gray(`      File: ${comment.filePath}`));
        console.log(chalk.gray(`      Comment: ${comment.body.substring(0, 100).replace(/\n/g, ' ')}...`));
      });
    } else {
      console.log(chalk.magenta('  (None)'));
    }

    console.log(chalk.magenta('--- Holistic PR Review: Custom Document Chunks Sent to LLM ---'));
    if (unifiedContext.customDocChunks && unifiedContext.customDocChunks.length > 0) {
      unifiedContext.customDocChunks.forEach((chunk, i) => {
        console.log(chalk.magenta(`  [${i + 1}] Document: "${chunk.document_title}" (Chunk ${chunk.chunk_index + 1})`));
        console.log(chalk.gray(`      Similarity: ${chunk.similarity?.toFixed(3) || 'N/A'}`));
        console.log(chalk.gray(`      Content: ${chunk.content.substring(0, 100).replace(/\n/g, ' ')}...`));
      });
    } else {
      console.log(chalk.magenta('  (None)'));
    }
    console.log(chalk.magenta('--- Sending Holistic PR Analysis Prompt to LLM ---'));

    // Call the centralized analysis function
    const parsedResponse = await callLLMForAnalysis(holisticContext, {
      ...options,
      isHolisticPRReview: true,
    });

    // Debug logging
    console.log(chalk.blue(`🐛 Holistic analysis parsed response:`));
    console.log(chalk.gray(`Summary: ${parsedResponse.summary?.substring(0, 100)}...`));
    console.log(chalk.gray(`Cross-file issues: ${parsedResponse.crossFileIssues?.length || 0}`));
    console.log(chalk.gray(`File-specific issues keys: ${Object.keys(parsedResponse.fileSpecificIssues || {}).join(', ')}`));
    console.log(chalk.gray(`Recommendations: ${parsedResponse.recommendations?.length || 0}`));

    // Filter out low severity issues (formatting/style concerns handled by linters)
    // Note: The LLM prompt instructs not to generate low severity issues, but this filter
    // serves as a safety net in case any slip through despite the prompt instructions
    const filteredResponse = filterLowSeverityIssues(parsedResponse, { verbose: options.verbose });

    return {
      success: true,
      filePath: 'PR_HOLISTIC_REVIEW',
      language: 'diff',
      results: {
        summary: filteredResponse.summary || 'Holistic PR review completed',
        crossFileIssues: filteredResponse.crossFileIssues || [],
        fileSpecificIssues: filteredResponse.fileSpecificIssues || {},
        recommendations: filteredResponse.recommendations || [],
      },
      context: {
        codeExamples: unifiedContext.codeExamples.length,
        guidelines: unifiedContext.guidelines.length,
        prComments: unifiedContext.prComments.length,
      },
      metadata: {
        analysisTimestamp: new Date().toISOString(),
        featuresUsed: {
          codeExamples: unifiedContext.codeExamples.length > 0,
          guidelines: unifiedContext.guidelines.length > 0,
          prHistory: unifiedContext.prComments.length > 0,
        },
      },
    };
  } catch (error) {
    console.error(chalk.red(`Error in holistic PR analysis: ${error.message}`));
    return {
      success: false,
      error: error.message,
      filePath: 'PR_HOLISTIC_REVIEW',
    };
  }
}

/**
 * NEW: Gathers all context for a single file.
 * This encapsulates the logic for finding docs, code, and PR comments.
 * @param {string} filePath - Path to the file to get context for.
 * @param {string} content - The content of the file (or diff).
 * @param {Object} options - Analysis options.
 * @returns {Promise<Object>} An object containing the gathered context.
 */
async function getContextForFile(filePath, content, options = {}) {
  const RELEVANT_CHUNK_THRESHOLD = 0.1;
  const W_H1_SIM = 0.2;
  const W_DOC_CONTEXT_MATCH = 0.6;
  const GENERIC_DOC_PENALTY_FACTOR = 0.7;
  const GUIDELINE_CANDIDATE_LIMIT = 100;
  const CODE_EXAMPLE_LIMIT = 40;
  const MAX_FINAL_EXAMPLES = 8;

  // --- Stage 0: Initialize Tables (ONE-TIME SETUP) ---
  // Note: This may be called concurrently. `initializeTables` should be idempotent.
  try {
    await embeddingsSystem.initialize();
  } catch (initError) {
    console.warn(chalk.yellow(`Database initialization warning: ${initError.message}`));
  }

  const projectPath = options.projectPath || (options.directory ? path.resolve(options.directory) : null) || process.cwd();
  const language = detectLanguageFromExtension(path.extname(filePath).toLowerCase());
  const fileTypeInfo = detectFileType(filePath, content);
  const isTestFile = fileTypeInfo.isTest;

  const reviewedSnippetContext = inferContextFromCodeContent(content, language);
  debug('[getContextForFile] Reviewed Snippet Context:', reviewedSnippetContext);

  let analyzedFileEmbedding = null;
  let fileContentQueryEmbedding = null;
  let guidelineQueryEmbedding = null;

  if (content.trim().length > 0) {
    analyzedFileEmbedding = await embeddingsSystem.calculateEmbedding(content.substring(0, MAX_EMBEDDING_CONTENT_LENGTH));
    const queryContent = isTestFile ? `${content}\\n// Looking for similar test files and testing patterns` : content;
    fileContentQueryEmbedding = await embeddingsSystem.calculateQueryEmbedding(queryContent);
  }

  const guidelineQuery = isTestFile
    ? createTestGuidelineQueryForLLMRetrieval(content, reviewedSnippetContext, language)
    : createGuidelineQueryForLLMRetrieval(content, reviewedSnippetContext, language);

  if (guidelineQuery && guidelineQuery.trim().length > 0) {
    guidelineQueryEmbedding = await embeddingsSystem.calculateQueryEmbedding(guidelineQuery);
  }

  console.log(chalk.blue('� Starting parallel context retrieval...'));
  // Helper function to process custom documents in parallel (with caching)
  const processCustomDocuments = async () => {
    // Check if preprocessed chunks are available (from PR-level processing)
    if (options.preprocessedCustomDocChunks && options.preprocessedCustomDocChunks.length > 0) {
      console.log(chalk.blue(`📄 Using preprocessed custom document chunks (${options.preprocessedCustomDocChunks.length} available)`));

      // Use the guideline query for finding relevant custom document chunks
      const relevantChunks = await embeddingsSystem.findRelevantCustomDocChunks(guidelineQuery, options.preprocessedCustomDocChunks, {
        limit: 5,
        similarityThreshold: 0.3,
        queryContextForReranking: reviewedSnippetContext,
        useReranking: true,
        precomputedQueryEmbedding: guidelineQueryEmbedding,
        queryFilePath: filePath,
      });

      console.log(chalk.green(`📄 Found ${relevantChunks.length} relevant custom document chunks`));

      // Log which chunks made the cut
      if (relevantChunks.length > 0) {
        console.log(chalk.cyan('📋 Custom Document Chunks Selected:'));
        relevantChunks.forEach((chunk, i) => {
          console.log(chalk.cyan(`  [${i + 1}] "${chunk.document_title}" (Chunk ${chunk.chunk_index + 1})`));
          console.log(chalk.gray(`      Similarity: ${chunk.similarity?.toFixed(3) || 'N/A'}`));
          console.log(chalk.gray(`      Content: ${chunk.content.substring(0, 80).replace(/\n/g, ' ')}...`));
        });
      }

      return relevantChunks;
    }

    // Fallback to original processing if no preprocessed chunks available
    if (!options.customDocs || options.customDocs.length === 0) {
      return [];
    }

    try {
      console.log(chalk.blue('📄 Processing custom documents for context...'));

      // Check if custom documents are already processed for this project
      let processedChunks = await checkExistingCustomDocumentChunks(projectPath);

      if (!processedChunks || processedChunks.length === 0) {
        console.log(chalk.cyan('📄 Custom documents not yet processed for this project, processing now...'));
        // Process custom documents into chunks (only if not already processed)
        processedChunks = await embeddingsSystem.processCustomDocumentsInMemory(options.customDocs, projectPath);
      } else {
        console.log(chalk.green(`📄 Reusing ${processedChunks.length} already processed custom document chunks`));
      }

      if (processedChunks.length > 0) {
        // Use the guideline query for finding relevant custom document chunks
        const relevantChunks = await embeddingsSystem.findRelevantCustomDocChunks(guidelineQuery, processedChunks, {
          limit: 5,
          similarityThreshold: 0.3,
          queryContextForReranking: reviewedSnippetContext,
          useReranking: true,
          precomputedQueryEmbedding: guidelineQueryEmbedding,
          queryFilePath: filePath,
        });

        console.log(chalk.green(`📄 Found ${relevantChunks.length} relevant custom document chunks`));

        // Log which chunks made the cut
        if (relevantChunks.length > 0) {
          console.log(chalk.cyan('📋 Custom Document Chunks Selected:'));
          relevantChunks.forEach((chunk, i) => {
            console.log(chalk.cyan(`  [${i + 1}] "${chunk.document_title}" (Chunk ${chunk.chunk_index + 1})`));
            console.log(chalk.gray(`      Similarity: ${chunk.similarity?.toFixed(3) || 'N/A'}`));
            console.log(chalk.gray(`      Content: ${chunk.content.substring(0, 80).replace(/\n/g, ' ')}...`));
          });
        }

        return relevantChunks;
      }
    } catch (error) {
      console.error(chalk.red(`Error processing custom documents: ${error.message}`));
    }

    return [];
  };

  // Helper function to check if custom documents are already processed
  const checkExistingCustomDocumentChunks = async (projectPath) => {
    try {
      // Use the statically imported function
      return await embeddingsSystem.getExistingCustomDocumentChunks(projectPath);
    } catch {
      console.log(chalk.gray('No existing custom document chunks found, will process from scratch'));
      return [];
    }
  };

  const [prContextResult, guidelineCandidates, codeExampleCandidates, relevantCustomDocChunks] = await Promise.all([
    getPRCommentContext(filePath, {
      ...options,
      projectPath,
      precomputedQueryEmbedding: fileContentQueryEmbedding,
      maxComments: MAX_PR_COMMENTS_FOR_CONTEXT,
      similarityThreshold: options.prSimilarityThreshold || 0.3,
      timeout: options.prTimeout || 300000,
      repository: options.repository || null,
    }),
    embeddingsSystem.findRelevantDocs(guidelineQuery, {
      ...options,
      projectPath,
      precomputedQueryEmbedding: guidelineQueryEmbedding,
      limit: GUIDELINE_CANDIDATE_LIMIT,
      similarityThreshold: 0.05,
      useReranking: true,
      queryContextForReranking: reviewedSnippetContext,
    }),
    embeddingsSystem.findSimilarCode(isTestFile ? `${content}\\n// Looking for similar test files and testing patterns` : content, {
      ...options,
      projectPath,
      isTestFile,
      precomputedQueryEmbedding: fileContentQueryEmbedding,
      limit: CODE_EXAMPLE_LIMIT,
      similarityThreshold: 0.3,
      queryFilePath: filePath,
      includeProjectStructure: false,
    }),
    processCustomDocuments(), // Add custom document processing as 4th parallel operation
  ]).catch((error) => {
    console.warn(chalk.yellow(`Parallel context retrieval failed: ${error.message}`));
    return [[], [], [], []];
  });

  const prCommentContext = prContextResult?.comments || [];
  const prContextAvailable = prCommentContext.length > 0;
  console.log(chalk.green(`✅ Found ${prCommentContext.length} relevant PR comments`));

  const documentChunks = Array.isArray(guidelineCandidates) ? guidelineCandidates.filter((c) => c.type === 'documentation-chunk') : [];
  const chunksByDocument = new Map();
  for (const chunk of documentChunks) {
    if (!chunksByDocument.has(chunk.path)) {
      chunksByDocument.set(chunk.path, []);
    }
    chunksByDocument.get(chunk.path).push(chunk);
  }

  const scoredDocuments = [];

  for (const [docPath, docChunks] of chunksByDocument.entries()) {
    const docH1 = docChunks[0]?.document_title || path.basename(docPath, path.extname(docPath));

    // FAST-PATH OPTIMIZATION: Use shared utility for generic documents
    let candidateDocFullContext;
    if (isGenericDocument(docPath, docH1)) {
      candidateDocFullContext = getGenericDocumentContext(docPath, docH1);
      debug(`[FAST-PATH] Using pre-computed context for generic document in RAG: ${docPath}`);
    } else {
      candidateDocFullContext = await inferContextFromDocumentContent(docPath, docH1, docChunks, language);
    }
    const relevantChunksForDoc = docChunks.filter((c) => c.similarity >= RELEVANT_CHUNK_THRESHOLD);
    if (relevantChunksForDoc.length === 0) continue;

    const maxChunkScoreInDoc = Math.max(...relevantChunksForDoc.map((c) => c.similarity));
    const avgChunkScoreInDoc = relevantChunksForDoc.reduce((sum, c) => sum + c.similarity, 0) / relevantChunksForDoc.length;
    const numRelevantChunks = relevantChunksForDoc.length;
    const semanticQualityScore = maxChunkScoreInDoc * 0.5 + avgChunkScoreInDoc * 0.3 + Math.min(numRelevantChunks, 5) * 0.04;

    let docLevelContextMatchScore = 0;
    if (
      reviewedSnippetContext.area !== 'Unknown' &&
      candidateDocFullContext.area !== 'Unknown' &&
      candidateDocFullContext.area !== 'General'
    ) {
      if (reviewedSnippetContext.area === candidateDocFullContext.area) {
        docLevelContextMatchScore += 0.8;
        for (const tech of reviewedSnippetContext.dominantTech) {
          if (candidateDocFullContext.dominantTech.map((t) => t.toLowerCase()).includes(tech.toLowerCase())) {
            docLevelContextMatchScore += 0.2;
            break;
          }
        }
      } else if (reviewedSnippetContext.area !== 'GeneralJS_TS') {
        docLevelContextMatchScore -= 0.2;
      }
    }

    let docH1RelevanceToReviewedFile = 0;
    if (docH1 && analyzedFileEmbedding) {
      const docH1Embedding = await embeddingsSystem.calculateEmbedding(docH1);
      if (docH1Embedding) {
        docH1RelevanceToReviewedFile = calculateCosineSimilarity(analyzedFileEmbedding, docH1Embedding);
      }
    }

    const isGenericByName = isGenericDocument(docPath, docH1);
    let genericDocPenaltyFactor = 1.0;
    if (candidateDocFullContext.isGeneralPurposeReadmeStyle || isGenericByName) {
      if (reviewedSnippetContext.area !== 'DevOps' && (docLevelContextMatchScore < 0.8 || isGenericByName)) {
        genericDocPenaltyFactor = GENERIC_DOC_PENALTY_FACTOR;
      }
    }

    let finalDocScore =
      semanticQualityScore * 0.2 + docLevelContextMatchScore * W_DOC_CONTEXT_MATCH + docH1RelevanceToReviewedFile * W_H1_SIM;
    finalDocScore *= genericDocPenaltyFactor;

    scoredDocuments.push({
      path: docPath,
      score: finalDocScore,
      chunks: docChunks.sort((a, b) => b.similarity - a.similarity),
      debug: {
        area: candidateDocFullContext.area,
        tech: candidateDocFullContext.dominantTech.join(', '),
        isGenericStyle: candidateDocFullContext.isGeneralPurposeReadmeStyle || isGenericByName,
        semanticQualityScore: semanticQualityScore.toFixed(4),
        docLevelContextMatchScore: docLevelContextMatchScore.toFixed(4),
        docH1RelevanceToReviewedFile: docH1RelevanceToReviewedFile.toFixed(4),
        genericDocPenaltyFactor: genericDocPenaltyFactor.toFixed(4),
        finalScore: finalDocScore.toFixed(4),
      },
    });
  }
  scoredDocuments.sort((a, b) => b.score - a.score);

  debug('[getContextForFile] Top Scored Documents:');
  scoredDocuments.slice(0, 7).forEach((d) => {
    debug(
      `  Path: ${d.path}, Score: ${d.score.toFixed(4)}, Area: ${d.debug.area}, Tech: ${d.debug.tech}, Generic: ${d.debug.isGenericStyle}`
    );
  });

  const finalGuidelineSnippets = [];
  const relevantDocs = scoredDocuments.filter((doc) => {
    if (doc.score < 0.3) {
      debug(`[getContextForFile] Excluding doc ${doc.path} - score too low: ${doc.score.toFixed(4)}`);
      return false;
    }
    if (
      reviewedSnippetContext.area !== 'Unknown' &&
      doc.debug.area !== 'Unknown' &&
      doc.debug.area !== 'General' &&
      reviewedSnippetContext.area !== doc.debug.area
    ) {
      const hasTechMatch = reviewedSnippetContext.dominantTech.some((tech) => doc.debug.tech.toLowerCase().includes(tech.toLowerCase()));
      if (!hasTechMatch) {
        debug(
          `[getContextForFile] Excluding doc ${doc.path} - area mismatch without tech match: ${doc.debug.area} vs ${reviewedSnippetContext.area}`
        );
        return false;
      }
    }
    return true;
  });

  for (const doc of relevantDocs.slice(0, 4)) {
    if (doc.chunks && doc.chunks.length > 0) {
      finalGuidelineSnippets.push(doc.chunks[0]);
    }
  }

  const uniqueCandidates = [];
  const seenPaths = new Set();
  const normalizedReviewPath = path.resolve(projectPath, filePath);

  for (const candidate of codeExampleCandidates || []) {
    const normalizedCandidatePath = path.resolve(projectPath, candidate.path);
    if (normalizedCandidatePath !== normalizedReviewPath && !candidate.isDocumentation && !seenPaths.has(candidate.path)) {
      uniqueCandidates.push(candidate);
      seenPaths.add(candidate.path);
    }
  }
  uniqueCandidates.sort((a, b) => b.similarity - a.similarity);
  const finalCodeExamples = uniqueCandidates.slice(0, MAX_FINAL_EXAMPLES);

  return {
    language,
    isTestFile,
    finalCodeExamples,
    finalGuidelineSnippets,
    prCommentContext,
    prContextAvailable,
    relevantCustomDocChunks, // Add relevant custom document chunks
  };
}

async function gatherUnifiedContextForPR(prFiles, options = {}) {
  const allProcessedContext = {
    codeExamples: new Map(),
    guidelines: new Map(),
    prComments: new Map(),
    customDocChunks: new Map(),
  };

  // Process custom documents into chunks once at the start for the entire PR
  let globalCustomDocChunks = [];
  if (options.customDocs && options.customDocs.length > 0) {
    const projectPath = options.projectPath || process.cwd();
    console.log(chalk.blue('📄 Processing custom documents once for entire PR...'));

    try {
      // Check if custom documents are already processed for this project
      let processedChunks = await embeddingsSystem.getExistingCustomDocumentChunks(projectPath);

      if (!processedChunks || processedChunks.length === 0) {
        console.log(chalk.cyan('📄 Custom documents not yet processed for this project, processing now...'));
        processedChunks = await embeddingsSystem.processCustomDocumentsInMemory(options.customDocs, projectPath);
      } else {
        console.log(chalk.green(`📄 Reusing ${processedChunks.length} already processed custom document chunks`));
      }

      globalCustomDocChunks = processedChunks;
      console.log(chalk.green(`📄 Custom documents processed: ${globalCustomDocChunks.length} chunks available for PR analysis`));
    } catch (error) {
      console.error(chalk.red(`Error processing custom documents for PR: ${error.message}`));
    }
  }

  const contextPromises = prFiles.map(async (file) => {
    try {
      const filePath = file.filePath;
      const content = file.diffContent || file.content;
      // Pass the pre-processed chunks to avoid reprocessing, but still allow file-specific similarity search
      const optionsWithPreprocessedChunks = {
        ...options,
        customDocs: [], // Remove original custom docs to avoid reprocessing
        preprocessedCustomDocChunks: globalCustomDocChunks, // Pass pre-processed chunks
      };
      const context = await getContextForFile(filePath, content, optionsWithPreprocessedChunks);
      return {
        ...context,
        filePath,
      };
    } catch (error) {
      console.error(chalk.red(`Error gathering context for file ${file.filePath}: ${error.message}`));
      return null; // Return null on error for this file
    }
  });

  const allContexts = (await Promise.all(contextPromises)).filter(Boolean); // Filter out nulls

  // Aggregate and deduplicate results
  for (const context of allContexts) {
    (context.finalCodeExamples || []).forEach((example) => {
      const key = example.path;
      if (
        key &&
        (!allProcessedContext.codeExamples.has(key) || example.similarity > allProcessedContext.codeExamples.get(key).similarity)
      ) {
        allProcessedContext.codeExamples.set(key, example);
      }
    });

    (context.finalGuidelineSnippets || []).forEach((guideline) => {
      const key = `${guideline.path}-${guideline.heading_text || ''}`;
      if (!allProcessedContext.guidelines.has(key) || guideline.similarity > allProcessedContext.guidelines.get(key).similarity) {
        allProcessedContext.guidelines.set(key, guideline);
      }
    });

    (context.prCommentContext || []).forEach((comment) => {
      const key = comment.id;
      if (
        key &&
        (!allProcessedContext.prComments.has(key) || comment.relevanceScore > allProcessedContext.prComments.get(key).relevanceScore)
      ) {
        allProcessedContext.prComments.set(key, comment);
      }
    });

    (context.relevantCustomDocChunks || []).forEach((chunk) => {
      const key = chunk.id;
      if (
        key &&
        (!allProcessedContext.customDocChunks.has(key) || chunk.similarity > allProcessedContext.customDocChunks.get(key).similarity)
      ) {
        allProcessedContext.customDocChunks.set(key, chunk);
      }
    });
  }

  // Convert Maps to sorted arrays
  const deduplicatedCodeExamples = Array.from(allProcessedContext.codeExamples.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, options.maxExamples || 40);

  const deduplicatedGuidelines = Array.from(allProcessedContext.guidelines.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 100);

  const deduplicatedPRComments = Array.from(allProcessedContext.prComments.values())
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 40); // Keep a larger pool of 40 candidates for the final prompt selection

  const deduplicatedCustomDocChunks = Array.from(allProcessedContext.customDocChunks.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10); // Keep top 10 custom document chunks

  return {
    codeExamples: deduplicatedCodeExamples,
    guidelines: deduplicatedGuidelines,
    prComments: deduplicatedPRComments,
    customDocChunks: deduplicatedCustomDocChunks,
  };
}

/**
 * Filter out low severity issues from analysis results
 * Low severity issues are typically formatting/style concerns better handled by linters
 *
 * @param {Object} analysisResults - Analysis results from LLM
 * @param {Object} options - Filtering options
 * @returns {Object} Filtered analysis results without low severity issues
 */
function filterLowSeverityIssues(analysisResults, options = {}) {
  const { verbose = false } = options;

  if (!analysisResults) {
    return analysisResults;
  }

  let filteredCount = 0;

  // Filter single-file issues array
  if (analysisResults.issues && Array.isArray(analysisResults.issues)) {
    const originalCount = analysisResults.issues.length;
    analysisResults.issues = analysisResults.issues.filter((issue) => {
      const severity = (issue.severity || '').toLowerCase();
      if (severity === 'low') {
        if (verbose) {
          console.log(chalk.yellow(`   Filtering low severity issue: "${(issue.description || '').substring(0, 50)}..."`));
        }
        return false;
      }
      return true;
    });
    filteredCount += originalCount - analysisResults.issues.length;
  }

  // Filter cross-file issues (for holistic PR review)
  if (analysisResults.crossFileIssues && Array.isArray(analysisResults.crossFileIssues)) {
    const originalCount = analysisResults.crossFileIssues.length;
    analysisResults.crossFileIssues = analysisResults.crossFileIssues.filter((issue) => {
      const severity = (issue.severity || '').toLowerCase();
      if (severity === 'low') {
        if (verbose) {
          console.log(
            chalk.yellow(`   Filtering low severity cross-file issue: "${(issue.message || issue.description || '').substring(0, 50)}..."`)
          );
        }
        return false;
      }
      return true;
    });
    filteredCount += originalCount - analysisResults.crossFileIssues.length;
  }

  // Filter file-specific issues (for holistic PR review)
  if (analysisResults.fileSpecificIssues && typeof analysisResults.fileSpecificIssues === 'object') {
    for (const filePath of Object.keys(analysisResults.fileSpecificIssues)) {
      const issues = analysisResults.fileSpecificIssues[filePath];
      if (Array.isArray(issues)) {
        const originalCount = issues.length;
        analysisResults.fileSpecificIssues[filePath] = issues.filter((issue) => {
          const severity = (issue.severity || '').toLowerCase();
          if (severity === 'low') {
            if (verbose) {
              console.log(
                chalk.yellow(`   Filtering low severity issue in ${filePath}: "${(issue.description || '').substring(0, 50)}..."`)
              );
            }
            return false;
          }
          return true;
        });
        filteredCount += originalCount - analysisResults.fileSpecificIssues[filePath].length;
      }
    }
  }

  if (filteredCount > 0) {
    console.log(chalk.cyan(`🔇 Filtered ${filteredCount} low severity issue(s) (formatting/style concerns handled by linters)`));
  }

  return analysisResults;
}

/**
 * Filter analysis results based on feedback data using semantic similarity
 *
 * @param {Object} analysisResults - Raw analysis results from LLM
 * @param {Object} feedbackData - Loaded feedback data
 * @param {Object} options - Filtering options
 * @returns {Promise<Object>} Filtered analysis results
 */
async function filterAnalysisResults(analysisResults, feedbackData, options = {}) {
  const { similarityThreshold = 0.7, verbose = false } = options;

  if (!analysisResults || !analysisResults.issues || !Array.isArray(analysisResults.issues)) {
    return analysisResults;
  }

  const originalCount = analysisResults.issues.length;

  // Ensure semantic similarity is initialized for better matching
  await ensureSemanticSimilarityInitialized();

  // Log whether semantic similarity is available
  if (verbose) {
    const usingSemanticSimilarity = isSemanticSimilarityAvailable();
    console.log(
      chalk.cyan(`🔍 Filtering issues using ${usingSemanticSimilarity ? 'semantic + word-based similarity' : 'word-based similarity only'}`)
    );
  }

  // Filter issues based on feedback (now async due to semantic similarity)
  const filterResults = await Promise.all(
    analysisResults.issues.map(async (issue, index) => {
      const issueDescription = issue.description || issue.summary || '';
      const shouldSkip = await shouldSkipSimilarIssue(issueDescription, feedbackData, {
        similarityThreshold,
        verbose,
      });

      if (shouldSkip && verbose) {
        console.log(chalk.yellow(`   Filtered issue ${index + 1}: "${issueDescription.substring(0, 50)}..."`));
      }

      return { issue, shouldSkip };
    })
  );

  const filteredIssues = filterResults.filter((result) => !result.shouldSkip).map((result) => result.issue);

  const filteredCount = originalCount - filteredIssues.length;

  if (verbose && filteredCount > 0) {
    console.log(chalk.green(`✅ Filtered ${filteredCount} dismissed issues, ${filteredIssues.length} remaining`));
  }

  return {
    ...analysisResults,
    issues: filteredIssues,
    metadata: {
      ...analysisResults.metadata,
      feedbackFiltering: {
        originalIssueCount: originalCount,
        filteredIssueCount: filteredCount,
        finalIssueCount: filteredIssues.length,
        usedSemanticSimilarity: isSemanticSimilarityAvailable(),
      },
    },
  };
}

export { runAnalysis, gatherUnifiedContextForPR };
