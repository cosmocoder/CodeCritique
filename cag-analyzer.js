/**
 * CAG Analyzer Module
 *
 * This module provides functionality for analyzing code using the cached context
 * in the Cache Augmented Generation (CAG) approach for code review.
 * It identifies patterns, best practices, and generates review comments.
 */

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import {
  calculateCosineSimilarity,
  calculateEmbedding,
  calculateQueryEmbedding,
  findRelevantDocs,
  findSimilarCode,
  initializeTables,
} from './embeddings.js';
import * as llm from './llm.js';
import { findRelevantPRComments } from './src/pr-history/database.js';
import {
  debug,
  detectFileType,
  detectLanguageFromExtension,
  inferContextFromCodeContent,
  inferContextFromDocumentContent,
  isTestFile,
  shouldProcessFile,
} from './utils.js';

// Constants for content processing
const MAX_QUERY_CONTEXT_LENGTH = 1500;
const MAX_EMBEDDING_CONTENT_LENGTH = 10000;
const DEFAULT_TRUNCATE_LINES = 300;
const GUIDELINE_TRUNCATE_LINES = 400;
const DEBUG_PREVIEW_LENGTH = 300;
const RESPONSE_TRUNCATE_LENGTH = 1000;
const MAX_PR_COMMENTS_FOR_CONTEXT = 15;

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
 * Run an analysis using the CAG approach (single file or holistic PR)
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

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read file content - use diff content if this is a diff-only review
    let content;
    if (options.diffOnly && options.diffContent) {
      content = options.diffContent;
      console.log(chalk.blue(`Analyzing diff only for ${path.basename(filePath)}`));
    } else {
      content = fs.readFileSync(filePath, 'utf8');
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
    const { language, isTestFile, finalCodeExamples, finalGuidelineSnippets, prCommentContext, prContextAvailable } =
      await getContextForFile(filePath, content, options);

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
      { ...options, isTestFile } // Pass isTestFile flag in options
    );

    // Call LLM for analysis
    const analysisResults = await callLLMForAnalysis(context, { ...options, isTestFile });

    return {
      success: true,
      filePath,
      language,
      results: analysisResults,
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
        },
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
  // Extract file name and directory
  const fileName = path.basename(filePath);
  const dirPath = path.dirname(filePath);
  const dirName = path.basename(dirPath);

  // Determine if this is a diff-only review
  const isDiffReview = options.diffOnly && options.diffContent;
  const reviewType = isDiffReview ? 'DIFF REVIEW' : 'FULL FILE REVIEW';

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
      items: prCommentContext.map((comment) => ({
        type: 'pr_comment',
        pr_number: comment.prNumber,
        author: comment.author,
        comment_text: comment.body,
        file_path: comment.filePath,
        comment_type: comment.commentType,
        similarity_score: comment.relevanceScore,
        created_at: comment.createdAt,
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
    metadata: {
      hasCodeExamples: finalCodeExamples.length > 0,
      hasGuidelines: finalGuidelineSnippets.length > 0,
      hasPRHistory: prCommentContext.length > 0,
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
    const model = options.model || 'claude-sonnet-4-20250514';
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

Your response must start with { and end with } with no additional text.`;
}

// LLM call function
async function sendPromptToLLM(prompt, llmOptions) {
  try {
    if (!llm || typeof llm.sendPromptToClaude !== 'function') {
      throw new Error('LLM module does not contain required function: sendPromptToClaude');
    }

    const response = await llm.sendPromptToClaude(prompt, llmOptions);

    // The real function returns an object with {content, model, usage}
    // We need to return just the content part
    if (response && typeof response === 'object' && response.content) {
      return response.content;
    } else {
      console.warn(chalk.yellow('Unexpected LLM response format, attempting to use response directly'));
      return response;
    }
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
  const { file, codeExamples, guidelineSnippets } = context;

  // Format code examples
  const formattedCodeExamples =
    codeExamples
      .map((ex) => {
        const langIdentifier = ex.language || '';
        return `
CODE EXAMPLE ${ex.index} (Similarity: ${ex.similarity})
Path: ${ex.path}
Language: ${ex.language}

\`\`\`${langIdentifier}
${ex.content}
\`\`\`
`;
      })
      .join('\n') || 'No relevant code examples found.';

  // Format guideline snippets
  const formattedGuidelines =
    guidelineSnippets
      .map((ex) => {
        const langIdentifier = ex.language || 'text';
        let title = `GUIDELINE ${ex.index} (Source: ${ex.path}, Similarity: ${ex.similarity})`;
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
      .join('\n') || 'No specific guideline snippets found.';

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

      prHistorySection += `Consider these historical patterns when analyzing the current code. `;
      prHistorySection += `Look for similar issues and apply the insights from past human reviews.\n\n`;

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
    ? 'Your task is to review ONLY the changed lines in the following git diff by performing a two-stage analysis based **only** on the provided context, prioritizing documented guidelines and historical review patterns.'
    : 'Your task is to review the following code file by performing a two-stage analysis based **only** on the provided context, prioritizing documented guidelines and historical review patterns.';

  const fileSection = isDiffReview
    ? `GIT DIFF TO REVIEW (FOCUS ONLY ON CHANGED LINES):
Path: ${file.path}
Language: ${file.language}
Base Branch: ${file.diffInfo?.baseBranch || 'master'}
Target Branch: ${file.diffInfo?.targetBranch || 'HEAD'}

IMPORTANT: The content below is a git diff. Review ONLY the lines that are added (+) or modified.
Do NOT comment on unchanged context lines or the entire file structure.

\`\`\`diff
${file.content}
\`\`\``
    : `FILE TO REVIEW:
Path: ${file.path}
Language: ${file.language}

\`\`\`${file.language}
${file.content}
\`\`\``;

  // Corrected prompt with full two-stage analysis + combined output stage
  return finalizePrompt(`
You are an expert code reviewer acting as a senior developer on this specific project.
${reviewInstructions}

${fileSection}

CONTEXT FROM PROJECT:

CONTEXT A: EXPLICIT GUIDELINES FROM DOCUMENTATION
${formattedGuidelines}

CONTEXT B: SIMILAR CODE EXAMPLES FROM PROJECT
${formattedCodeExamples}

${prHistorySection}

INSTRUCTIONS:

${
  isDiffReview
    ? `**DIFF REVIEW MODE - FOCUS ONLY ON CHANGED LINES**
You are reviewing a git diff. ONLY analyze the lines that are:
- Added (marked with +)
- Modified (changed from previous version)
DO NOT comment on:
- Unchanged context lines
- Overall file structure
- Existing code that wasn't modified
- Missing imports unless they're directly related to the changed lines

`
    : ''
}**Perform the following analysis stages sequentially:**

**STAGE 1: Guideline-Based Review**
1.  Analyze the 'FILE TO REVIEW' strictly against the standards, rules, and explanations provided in 'CONTEXT A: EXPLICIT GUIDELINES'.
2.  Identify any specific deviations where the reviewed code violates an explicit guideline. Note the guideline source (path or index) for each deviation found.
3.  Temporarily ignore 'CONTEXT B: SIMILAR CODE EXAMPLES' during this stage.

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
1.  **CRITICAL**: If 'CONTEXT C: HISTORICAL REVIEW COMMENTS' is present, analyze each historical comment carefully:
    - Look for patterns in the types of issues human reviewers have identified in similar code
    - Check if any of the historical issues apply to the current file being reviewed
    - Pay special attention to comments with high relevance scores (>70%)
2.  **Apply Historical Insights**: For each historical comment:
    - Check if the same type of issue exists in the current file
    - Consider the reviewer's suggestions and see if they apply to the current context
    - Look for recurring themes across multiple historical comments
3.  **Prioritize Historical Issues**: Issues that have been flagged by human reviewers in similar contexts should be given high priority
4.  **Learn from Past Reviews**: Use the historical comments to understand what human reviewers consider important in this codebase

**STAGE 4: Consolidate, Prioritize, and Generate Output**
1.  Combine the potential issues identified in Stage 1 (Guideline-Based), Stage 2 (Example-Based), and Stage 3 (Historical Review Comments).
2.  **Apply Conflict Resolution AND Citation Rules:**
    *   **Guideline Precedence:** If an issue identified in Stage 2 (from code examples) or Stage 3 (from historical comments) **contradicts** an explicit guideline from Stage 1, **discard the conflicting issue**. Guidelines always take precedence.
    *   **Citation Priority:** When reporting an issue:
       *   If the relevant convention or standard is defined in 'CONTEXT A: EXPLICIT GUIDELINES', cite the guideline document.
       *   For implicit patterns discovered from code examples (like helper utilities, common practices), cite the specific code examples that demonstrate the pattern.
       *   For issues identified from historical review comments, report them as standard code review findings without referencing the historical source.
       *   **IMPORTANT**: When citing implicit patterns from Context B, be specific about which files demonstrate the pattern and what the pattern is.
3.  **Special attention to implicit patterns**: Issues related to not using project-specific utilities or helpers should be marked as high priority if the pattern appears consistently across multiple examples in Context B.
4.  **Special attention to historical patterns**: Issues that have been previously identified by human reviewers in similar code (from Context C) should be given high priority, especially those with high relevance scores.
5.  Assess for any potential logic errors or bugs within the reviewed code itself, independent of conventions, and include them as separate issues.
6.  Ensure all reported issue descriptions clearly state the deviation/problem and suggestions align with the prioritized context (guidelines first, then examples, then historical patterns). Avoid general advice conflicting with context.
7.  **CRITICAL 'lineNumbers' RULE**: For issues that are widespread within a single file, list only the first few occurrences (AT MOST 5). Do NOT list every single line number for a file-specific issue.
8.  Format the final, consolidated, and prioritized list of issues, along with a brief overall summary, **strictly** according to the JSON structure below.
9.  CRITICAL: Respond ONLY with valid JSON - start with { and end with }, no additional text.

REQUIRED JSON OUTPUT FORMAT:

You must respond with EXACTLY this JSON structure, with no additional text:

{
  "summary": "Brief summary of the review, highlighting adherence to documented guidelines and consistency with code examples, plus any major issues found.",
  "issues": [
    {
      "type": "bug | improvement | convention | performance | security",
      "severity": "critical | high | medium | low",
      "description": "Description of the issue, clearly stating the deviation from the prioritized project pattern (guideline or example) OR the nature of the bug/improvement.",
      "lineNumbers": [42, 55, 61],
      "suggestion": "Concrete suggestion for fixing the issue or aligning with the prioritized inferred pattern. Ensure the suggestion is additive if adding missing functionality (like a hook) and doesn't wrongly suggest replacing existing, unrelated code."
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
  const { file, codeExamples, guidelineSnippets } = context;

  // Format code examples
  const formattedCodeExamples =
    codeExamples
      .map((ex) => {
        const langIdentifier = ex.language || '';
        return `
TEST EXAMPLE ${ex.index} (Similarity: ${ex.similarity})
Path: ${ex.path}
Language: ${ex.language}

\`\`\`${langIdentifier}
${ex.content}
\`\`\`
`;
      })
      .join('\n') || 'No relevant test examples found.';

  // Format guideline snippets
  const formattedGuidelines =
    guidelineSnippets
      .map((ex) => {
        const langIdentifier = ex.language || 'text';
        let title = `TESTING GUIDELINE ${ex.index} (Source: ${ex.path}, Similarity: ${ex.similarity})`;
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
      .join('\n') || 'No specific testing guideline snippets found.';

  // Detect if this is a diff review
  const isDiffReview = file.reviewType === 'DIFF REVIEW';
  const reviewInstructions = isDiffReview
    ? 'Your task is to review ONLY the changed lines in the following test file git diff by performing a comprehensive analysis focused on testing best practices and patterns.'
    : 'Your task is to review the following test file by performing a comprehensive analysis focused on testing best practices and patterns.';

  const fileSection = isDiffReview
    ? `TEST FILE GIT DIFF TO REVIEW (FOCUS ONLY ON CHANGED LINES):
Path: ${file.path}
Language: ${file.language}
Base Branch: ${file.diffInfo?.baseBranch || 'master'}
Target Branch: ${file.diffInfo?.targetBranch || 'HEAD'}

IMPORTANT: The content below is a git diff. Review ONLY the lines that are added (+) or modified in the test file.
Do NOT comment on unchanged context lines or the entire test file structure.

\`\`\`diff
${file.content}
\`\`\``
    : `TEST FILE TO REVIEW:
Path: ${file.path}
Language: ${file.language}

\`\`\`${file.language}
${file.content}
\`\`\``;

  // Test-specific prompt
  return finalizePrompt(`
You are an expert test code reviewer acting as a senior developer on this specific project.
${reviewInstructions}

${fileSection}

CONTEXT FROM PROJECT:

CONTEXT A: TESTING GUIDELINES AND BEST PRACTICES
${formattedGuidelines}

CONTEXT B: SIMILAR TEST EXAMPLES FROM PROJECT
${formattedCodeExamples}

INSTRUCTIONS:

${
  isDiffReview
    ? `**DIFF REVIEW MODE - FOCUS ONLY ON CHANGED LINES**
You are reviewing a git diff of a test file. ONLY analyze the lines that are:
- Added (marked with +)
- Modified (changed from previous version)
DO NOT comment on:
- Unchanged context lines
- Overall test file structure
- Existing tests that weren't modified
- Missing test cases unless they're directly related to the changed lines

`
    : ''
}**Perform the following test-specific analysis:**

**STAGE 1: Test Coverage and Completeness**
1. Analyze if the test file provides adequate coverage for the functionality it's testing.
2. Identify any missing test cases or edge cases that should be covered.
3. Check if both positive and negative test scenarios are included.

**STAGE 2: Test Quality and Best Practices**
1. Evaluate test naming conventions - are test names descriptive and follow project patterns?
2. Check test organization - are tests properly grouped and structured?
3. Assess assertion quality - are assertions specific and meaningful?
4. Review test isolation - does each test run independently without side effects?
5. Examine setup/teardown patterns - are they used appropriately?

**STAGE 3: Testing Patterns and Conventions (CRITICAL)**
1. **IMPORTANT**: Carefully analyze ALL code examples in Context B to identify:
   - Common helper functions or utilities that appear across multiple test files
   - Consistent patterns in how certain operations are performed (e.g., rendering, mocking, assertions)
   - Any project-specific abstractions or wrappers around standard testing libraries
2. **CRITICAL**: Compare the reviewed test file against these discovered patterns. Flag any instances where:
   - The test directly uses a library function when other tests use a project-specific wrapper
   - Common helper utilities available in the project are not being used
   - The test deviates from established patterns shown in Context B examples
3. Check for proper use of mocking, stubbing, and test doubles following project patterns.
4. Verify that test data and fixtures follow project conventions.
5. Ensure async tests are handled correctly using project patterns.
6. Look for any test anti-patterns or deviations from established project testing practices.

**STAGE 4: Performance and Maintainability**
1. Identify any tests that might be slow or resource-intensive.
2. Check for code duplication that could be refactored using helper functions.
3. Ensure tests are maintainable and will not break easily with minor code changes.

**STAGE 5: Consolidate and Generate Output**
1. **CRITICAL**: Prioritize issues where the test deviates from implicit project patterns shown in Context B (similar test examples), especially regarding test utilities and helper functions.
2. Provide concrete suggestions that align with the project's testing patterns, referencing specific examples from Context B when applicable.
3. Assess for any potential logic errors or bugs within the reviewed code itself, independent of conventions, and include them as separate issues.
4. **CRITICAL 'lineNumbers' RULE**: For issues that are widespread (e.g., incorrect mocking strategy used in multiple tests), list only the first few occurrences (AT MOST 5). Do NOT list every single line number.
5. Format the output according to the JSON structure below.

REQUIRED JSON OUTPUT FORMAT:

You must respond with EXACTLY this JSON structure, with no additional text:

{
  "summary": "Brief summary of the test file review, highlighting coverage completeness, adherence to testing best practices, and any critical issues found.",
  "issues": [
    {
      "type": "bug | improvement | convention | performance | coverage",
      "severity": "critical | high | medium | low",
      "description": "Description of the issue, clearly stating the problem with the test implementation or coverage gap.",
      "lineNumbers": [25, 38],
      "suggestion": "Concrete suggestion for improving the test, adding missing coverage, or following testing best practices."
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
  const { file, context: contextSections } = context;

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
- **PR**: #${comment.pr_number} by ${comment.author}
- **File**: ${comment.file_path}
- **Type**: ${comment.comment_type}
- **Relevance**: ${(comment.similarity_score * 100).toFixed(1)}%
- **Review**: ${comment.comment_text}

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
`;
    })
    .join('\n');

  return finalizePrompt(`
You are an expert code reviewer performing a holistic review of a Pull Request with ${prFiles.length} files.
Analyze ALL files together to identify cross-file issues, consistency problems, and overall code quality.

## PULL REQUEST OVERVIEW
- **Total Files**: ${prFiles.length}
- **Source Files**: ${prFiles.filter((f) => !f.isTest).length}
- **Test Files**: ${prFiles.filter((f) => f.isTest).length}

## UNIFIED CONTEXT FROM PROJECT

### PROJECT CODE EXAMPLES
${formattedCodeExamples}

### PROJECT GUIDELINES
${formattedGuidelines}

### HISTORICAL REVIEW COMMENTS
${formattedPRComments}

## PR FILES WITH CHANGES
${formattedPRFiles}

## ANALYSIS INSTRUCTIONS

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

### **STAGE 2: Guideline Compliance Analysis**

1. Analyze ALL PR files strictly against the standards, rules, and explanations in PROJECT GUIDELINES
2. Identify specific deviations where any file violates explicit guidelines
3. Check for consistency of guideline application across all files
4. Note guideline source (path or index) for each deviation found
5. Ensure architectural decisions are consistent across the PR

### **STAGE 3: Historical Pattern Recognition**

1. **CRITICAL**: Analyze HISTORICAL REVIEW COMMENTS to identify patterns:
   - Types of issues human reviewers frequently flag in similar code
   - Recurring themes across multiple historical comments
   - High-relevance issues (>70% relevance score) that apply to current PR

2. **Apply Historical Insights to Each File**:
   - Check if similar issues exist in any PR file
   - Apply reviewer suggestions that are relevant to current changes
   - Look for patterns that span multiple files in the PR

### **STAGE 4: Cross-File Integration Analysis**

1. **Naming and Import Consistency**:
   - Verify consistent naming conventions across all files
   - Check import/export consistency and completeness
   - Identify duplicated logic that could be shared

2. **Test Coverage and Quality**:
   - For each source file change, verify corresponding test updates
   - Ensure test files follow established patterns from code examples
   - Check if test coverage is adequate for new functionality

3. **Architectural Integration**:
   - Look for potential breaking changes across files
   - Check API consistency between related files
   - Verify proper separation of concerns across the PR
   - Identify missing error handling or edge cases

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

3. **Special Attention Areas**:
   - **Project-specific patterns**: Issues where files don't use established project utilities/helpers
   - **Historical patterns**: Issues previously flagged by human reviewers in similar contexts
   - **Cross-file consistency**: Ensure similar changes follow the same patterns across all files
   - **Test patterns**: Verify test files follow established testing conventions from examples

4. Assess for any potential logic errors or bugs within the reviewed code itself, independent of conventions, and include them as separate issues.
5. **CRITICAL 'lineNumbers' RULE**: For issues that are widespread within a single file, list only the first few occurrences (AT MOST 5). Do NOT list every single line number for a file-specific issue.

REQUIRED JSON OUTPUT FORMAT:

You must respond with EXACTLY this JSON structure, with no additional text:

{
      "summary": "Brief, high-level summary of the entire PR review...",
  "crossFileIssues": [
    {
          "type": "bug | improvement | convention | architecture",
      "severity": "critical | high | medium | low",
          "description": "Detailed description of an issue that spans multiple files...",
          "suggestion": "Actionable suggestion to resolve the cross-file issue.",
          "filesInvolved": ["path/to/file1.js", "path/to/file2.ts"]
    }
  ],
  "fileSpecificIssues": {
        "path/to/file1.js": [
      {
        "type": "bug | improvement | convention | performance | security",
        "severity": "critical | high | medium | low",
            "description": "Description of the issue specific to this file.",
            "lineNumbers": [10, 15],
            "suggestion": "Concrete suggestion for fixing the issue in this file."
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
  try {
    const parsedResponse = JSON.parse(rawResponse);

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
  } catch (error) {
    console.error(chalk.red(`Error parsing LLM response: ${error.message}`));
    return {
      summary: 'Error parsing LLM response',
      issues: [],
      crossFileIssues: [],
      fileSpecificIssues: {},
      recommendations: [],
      rawResponse,
      parseError: error.message,
    };
  }
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
    const { prFiles, unifiedContext } = options;

    console.log(chalk.blue(`🔍 Performing holistic analysis of ${prFiles.length} files with unified context...`));

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
      metadata: {
        hasCodeExamples: unifiedContext.codeExamples.length > 0,
        hasGuidelines: unifiedContext.guidelines.length > 0,
        hasPRHistory: unifiedContext.prComments.length > 0,
        analysisTimestamp: new Date().toISOString(),
        reviewType: 'PR HOLISTIC REVIEW',
        isPRReview: true,
        isHolisticReview: true,
      },
      options: options,
    };

    // Add verbose debug logging similar to individual file reviews
    debug('--- Holistic PR Review: Guidelines Sent to LLM ---');
    if (unifiedContext.guidelines.length > 0) {
      unifiedContext.guidelines.slice(0, 10).forEach((g, i) => {
        debug(`  [${i + 1}] Path: ${g.path} ${g.headingText || g.heading_text ? `(Heading: "${g.headingText || g.heading_text}")` : ''}`);
        debug(`      Content: ${g.content.substring(0, 100).replace(/\n/g, ' ')}...`);
      });
    } else {
      debug('  (None)');
    }

    debug('--- Holistic PR Review: Code Examples Sent to LLM ---');
    if (unifiedContext.codeExamples.length > 0) {
      unifiedContext.codeExamples.slice(0, 10).forEach((ex, i) => {
        debug(`  [${i + 1}] Path: ${ex.path} (Similarity: ${ex.similarity?.toFixed(3) || 'N/A'})`);
        debug(`      Content: ${ex.content.substring(0, 100).replace(/\\n/g, ' ')}...`);
      });
    } else {
      debug('  (None)');
    }

    debug('--- Holistic PR Review: Top Historic Comments Sent to LLM ---');
    if (unifiedContext.prComments.length > 0) {
      unifiedContext.prComments.slice(0, 5).forEach((comment, i) => {
        debug(`  [${i + 1}] PR #${comment.prNumber} by ${comment.author} (Relevance: ${(comment.relevanceScore * 100).toFixed(1)}%)`);
        debug(`      File: ${comment.filePath}`);
        debug(`      Comment: ${comment.body.substring(0, 100).replace(/\n/g, ' ')}...`);
      });
    } else {
      debug('  (None)');
    }
    debug('--- Sending Holistic PR Analysis Prompt to LLM ---');

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

    return {
      success: true,
      filePath: 'PR_HOLISTIC_REVIEW',
      language: 'diff',
      results: {
        summary: parsedResponse.summary || 'Holistic PR review completed',
        crossFileIssues: parsedResponse.crossFileIssues || [],
        fileSpecificIssues: parsedResponse.fileSpecificIssues || {},
        recommendations: parsedResponse.recommendations || [],
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
    await initializeTables();
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
    analyzedFileEmbedding = await calculateEmbedding(content.substring(0, MAX_EMBEDDING_CONTENT_LENGTH));
    const queryContent = isTestFile ? `${content}\\n// Looking for similar test files and testing patterns` : content;
    fileContentQueryEmbedding = await calculateQueryEmbedding(queryContent);
  }

  const guidelineQuery = isTestFile
    ? createTestGuidelineQueryForLLMRetrieval(content, reviewedSnippetContext, language)
    : createGuidelineQueryForLLMRetrieval(content, reviewedSnippetContext, language);

  if (guidelineQuery && guidelineQuery.trim().length > 0) {
    guidelineQueryEmbedding = await calculateQueryEmbedding(guidelineQuery);
  }

  console.log(chalk.blue('🚀 Starting parallel context retrieval...'));
  const [prContextResult, guidelineCandidates, codeExampleCandidates] = await Promise.all([
    getPRCommentContext(filePath, {
      ...options,
      projectPath,
      precomputedQueryEmbedding: fileContentQueryEmbedding,
      maxComments: MAX_PR_COMMENTS_FOR_CONTEXT,
      similarityThreshold: options.prSimilarityThreshold || 0.3,
      timeout: options.prTimeout || 300000,
      repository: options.repository || null,
    }),
    findRelevantDocs(guidelineQuery, {
      ...options,
      projectPath,
      precomputedQueryEmbedding: guidelineQueryEmbedding,
      limit: GUIDELINE_CANDIDATE_LIMIT,
      similarityThreshold: 0.05,
      useReranking: true,
      queryContextForReranking: reviewedSnippetContext,
    }),
    findSimilarCode(isTestFile ? `${content}\\n// Looking for similar test files and testing patterns` : content, {
      ...options,
      projectPath,
      isTestFile,
      precomputedQueryEmbedding: fileContentQueryEmbedding,
      limit: CODE_EXAMPLE_LIMIT,
      similarityThreshold: 0.3,
      queryFilePath: filePath,
      includeProjectStructure: false,
    }),
  ]).catch((error) => {
    console.warn(chalk.yellow(`Parallel context retrieval failed: ${error.message}`));
    return [[], [], []];
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
  const GENERIC_DOC_REGEX = /(README|RUNBOOK|CONTRIBUTING|CHANGELOG|LICENSE|SETUP|INSTALL)(\\.md|$)/i;

  for (const [docPath, docChunks] of chunksByDocument.entries()) {
    const docH1 = docChunks[0]?.document_title || path.basename(docPath, path.extname(docPath));
    const candidateDocFullContext = await inferContextFromDocumentContent(docPath, docH1, docChunks, language);
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
      const docH1Embedding = await calculateEmbedding(docH1);
      if (docH1Embedding) {
        docH1RelevanceToReviewedFile = calculateCosineSimilarity(analyzedFileEmbedding, docH1Embedding);
      }
    }

    const isGenericByName = GENERIC_DOC_REGEX.test(docPath);
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
  const normalizedReviewPath = path.resolve(filePath);

  for (const candidate of codeExampleCandidates || []) {
    const normalizedCandidatePath = path.resolve(candidate.path);
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
  };
}

async function gatherUnifiedContextForPR(prFiles, options = {}) {
  const allProcessedContext = {
    codeExamples: new Map(),
    guidelines: new Map(),
    prComments: new Map(),
  };

  const contextPromises = prFiles.map(async (file) => {
    try {
      const filePath = file.filePath;
      const content = file.diffContent || file.content;
      // Use the new, modular context gathering function
      const context = await getContextForFile(filePath, content, options);
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

  return {
    codeExamples: deduplicatedCodeExamples,
    guidelines: deduplicatedGuidelines,
    prComments: deduplicatedPRComments,
  };
}

export { runAnalysis, gatherUnifiedContextForPR };
