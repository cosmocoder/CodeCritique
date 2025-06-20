/**
 * CAG Analyzer Module
 *
 * This module provides functionality for analyzing code using the cached context
 * in the Cache Augmented Generation (CAG) approach for code review.
 * It identifies patterns, best practices, and generates review comments.
 */

import { calculateCosineSimilarity, calculateEmbedding, findRelevantDocs, findSimilarCode } from './embeddings.js';
import {
  detectFileType,
  detectLanguageFromExtension,
  inferContextFromCodeContent,
  inferContextFromDocumentContent,
  isTestFile,
  shouldProcessFile,
} from './utils.js';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';

// Constants for content processing
const MAX_QUERY_CONTEXT_LENGTH = 1500;
const MAX_EMBEDDING_CONTENT_LENGTH = 10000;
const DEFAULT_TRUNCATE_LINES = 300;
const GUIDELINE_TRUNCATE_LINES = 400;
const CONTENT_LENGTH_BONUS_THRESHOLD = 300;
const CONTENT_LENGTH_PENALTY_THRESHOLD = 150;
const DEBUG_PREVIEW_LENGTH = 300;
const RESPONSE_TRUNCATE_LENGTH = 1000;
const MAX_PR_COMMENTS = 50;

// Debug function for logging
function debug(message) {
  const DEBUG = process.env.DEBUG || false;
  if (DEBUG || process.env.VERBOSE === 'true' || process.argv.includes('--verbose')) {
    console.log(chalk.cyan(`[DEBUG] ${message}`));
  }
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

// Helper function for content scoring (project-agnostic)
function calculateContentScore(content) {
  let score = 0;
  if (!content) return 0;

  const lines = content.split('\n');
  const lineCount = lines.length;
  const contentLength = content.length;

  // Basic length heuristic
  if (contentLength > CONTENT_LENGTH_BONUS_THRESHOLD) score += 0.05; // Bonus for non-trivial content
  if (contentLength < CONTENT_LENGTH_PENALTY_THRESHOLD) score -= 0.1; // Penalty for very short

  // Code block presence (simple check)
  if (content.includes('```')) score += 0.15;

  // Technical keywords (generic list, case-insensitive)
  const techKeywords = [
    'component',
    'module',
    'class',
    'function',
    'method',
    'api',
    'props',
    'state',
    'hook',
    'service',
    'endpoint',
    'request',
    'response',
    'error handling',
    'testing',
    'style guide',
    'architecture',
    'pattern',
    'schema',
    'database',
    'query',
    'mutation',
    'event',
    'callback',
    'async',
    'await',
    'promise',
  ];
  const lowerContent = content.toLowerCase();
  let keywordCount = 0;
  techKeywords.forEach((kw) => {
    if (lowerContent.includes(kw)) {
      keywordCount++;
    }
  });
  score += Math.min(0.25, keywordCount * 0.02); // Bonus for keywords, capped slightly higher

  // Penalize README-like structure (heuristic: many '#' headers relative to length)
  const topLevelHeaders = content.match(/^# .*$/gm); // Count lines starting with '# '
  if (topLevelHeaders && lineCount > 0 && topLevelHeaders.length / lineCount > 0.1) {
    // If > 10% of lines are top-level headers
    score -= 0.2; // Stronger penalty
  }

  // Clamp score to prevent extreme values
  return Math.max(-0.3, Math.min(0.3, score));
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
 * Analyze a file using the CAG approach
 *
 * @param {string} filePath - Path to the file to analyze
 * @param {Object} options - Analysis options
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeFile(filePath, options = {}) {
  try {
    console.log(chalk.blue(`Analyzing file: ${filePath}`));

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Determine the project directory for embedding searches
    // Priority: 1. Explicit projectPath option, 2. Directory option, 3. Current working directory (for PR comments)
    const projectPath = options.projectPath || (options.directory ? path.resolve(options.directory) : null) || process.cwd();

    console.log(chalk.gray(`Using project path for embeddings: ${projectPath}`));

    // Warn if no directory was specified and we're using file's directory as fallback
    if (!options.projectPath && !options.directory) {
      console.log(chalk.yellow(`Warning: No --directory specified. Using file's directory as project path.`));
      console.log(chalk.yellow(`If embeddings were generated for a parent directory, specify it with: --directory <path>`));
    }

    // Read file content
    const content = fs.readFileSync(filePath, 'utf8');
    const language = detectLanguageFromExtension(path.extname(filePath).toLowerCase()); // Get language early for context inference

    // Detect file type to check if it's a test file
    const fileTypeInfo = detectFileType(filePath, content);
    const isTestFile = fileTypeInfo.isTest;

    if (isTestFile) {
      console.log(chalk.blue(`Detected test file: ${filePath}`));
    }

    // --- Stage 0: Initialize Tables (ONE-TIME SETUP) ---
    console.log(chalk.blue('--- Stage 0: Initializing Database Tables ---'));
    try {
      // Import the initializeTables function
      const { initializeTables } = await import('./embeddings.js');
      await initializeTables();
      console.log(chalk.green('✅ Database tables initialized successfully'));
    } catch (initError) {
      console.warn(chalk.yellow(`Database initialization warning: ${initError.message}`));
      // Continue with analysis even if table initialization fails
    }

    // --- PHASE 1: UNDERSTAND THE CODE SNIPPET BEING REVIEWED ---
    const reviewedSnippetContext = inferContextFromCodeContent(content, language);
    debug('[analyzeFile] Reviewed Snippet Context:', reviewedSnippetContext);

    // +++ Get embedding for the file under review (for H1 proxy similarity - can be removed if H1 sim logic changes) +++
    let analyzedFileEmbedding = null;
    if (content.trim().length > 0) {
      analyzedFileEmbedding = await calculateEmbedding(content.substring(0, MAX_EMBEDDING_CONTENT_LENGTH));
      if (!analyzedFileEmbedding) {
        debug(`[analyzeFile] Could not generate embedding for the content of ${filePath}. H1 proxy similarity will be skipped.`);
      }
    } else {
      debug(`[analyzeFile] Content of ${filePath} is empty. H1 proxy similarity will be skipped.`);
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

    // --- Stage 1: PARALLEL CONTEXT RETRIEVAL ---
    console.log(chalk.blue('--- Stage 1: Parallel Context Retrieval (PR Comments + Documentation + Code Examples) ---'));

    // Prepare queries and options for parallel execution
    const guidelineQuery = isTestFile
      ? createTestGuidelineQueryForLLMRetrieval(content, reviewedSnippetContext, language)
      : createGuidelineQueryForLLMRetrieval(content, reviewedSnippetContext, language);

    const prContextOptions = {
      ...options,
      maxComments: MAX_PR_COMMENTS,
      similarityThreshold: options.prSimilarityThreshold || 0.3,
      timeout: options.prTimeout || 300000,
      projectPath: projectPath,
      repository: options.repository || null,
    };

    const GUIDELINE_CANDIDATE_LIMIT = 100;
    const CODE_EXAMPLE_LIMIT = 40;

    // Execute all three context retrieval operations in parallel
    console.log(chalk.blue('🚀 Starting parallel context retrieval...'));
    const [prContextResult, guidelineCandidates, codeExampleCandidates] = await Promise.all([
      // 1. PR Comment Context Retrieval
      getPRCommentContext(filePath, prContextOptions).catch((error) => {
        console.warn(chalk.yellow(`PR comment context unavailable: ${error.message}`));
        debug(`[analyzeFile] PR context error: ${error.stack}`);
        return { success: false, hasContext: false, comments: [] };
      }),

      // 2. Documentation Guidelines Retrieval
      findRelevantDocs(guidelineQuery, {
        similarityThreshold: 0.05,
        limit: GUIDELINE_CANDIDATE_LIMIT,
        queryFilePath: filePath,
        useReranking: true,
        queryContextForReranking: reviewedSnippetContext,
        projectPath: projectPath,
      }).catch((error) => {
        console.warn(chalk.yellow(`Documentation context unavailable: ${error.message}`));
        return [];
      }),

      // 3. Similar Code Examples Retrieval
      findSimilarCode(isTestFile ? `${content}\n// Looking for similar test files and testing patterns` : content, {
        similarityThreshold: 0.3,
        limit: CODE_EXAMPLE_LIMIT,
        queryFilePath: filePath,
        includeProjectStructure: false,
        projectPath: projectPath,
        isTestFile: isTestFile,
      }).catch((error) => {
        console.warn(chalk.yellow(`Code examples context unavailable: ${error.message}`));
        return [];
      }),
    ]);

    // Process PR comment results
    let prCommentContext = [];
    let prContextAvailable = false;
    if (prContextResult && prContextResult.comments && prContextResult.comments.length > 0) {
      prCommentContext = prContextResult.comments;
      prContextAvailable = true;
      console.log(chalk.green(`✅ Found ${prCommentContext.length} relevant PR comments`));
    } else {
      console.log(chalk.yellow('❌ No relevant PR comments found'));
    }

    console.log(
      chalk.green(
        `🎉 Parallel context retrieval completed - PR: ${prCommentContext.length}, Guidelines: ${guidelineCandidates.length}, Code: ${codeExampleCandidates.length}`
      )
    );

    // --- Stage 2: PROCESS DOCUMENTATION GUIDELINES ---
    console.log(chalk.blue('--- Stage 2: Processing Documentation Guidelines ---'));

    const RELEVANT_CHUNK_THRESHOLD = 0.1;
    const W_H1_SIM = 0.2;
    const W_DOC_CONTEXT_MATCH = 0.6;
    const GENERIC_DOC_REGEX = /(README|RUNBOOK|CONTRIBUTING|CHANGELOG|LICENSE|SETUP|INSTALL)(\.md|$)/i;
    const GENERIC_DOC_PENALTY_FACTOR = 0.7;

    // --- Stage 3 (was PHASE 4): DOCUMENT SCORING AND SELECTION ---
    console.log(chalk.blue('--- Stage 3: Document Scoring and Selection ---'));
    // Filter guidelineCandidates to only those that are document chunks, if findSimilarCode somehow returns other types
    const documentChunks = Array.isArray(guidelineCandidates) ? guidelineCandidates.filter((c) => c.type === 'documentation-chunk') : [];
    console.log(
      chalk.blue(
        `[analyzeFile] Received ${documentChunks.length} document chunks from findSimilarCode (out of ${
          guidelineCandidates?.length || 0
        } total candidates).`
      )
    );

    const chunksByDocument = new Map();
    for (const chunk of documentChunks) {
      if (!chunksByDocument.has(chunk.path)) {
        chunksByDocument.set(chunk.path, []);
      }
      chunksByDocument.get(chunk.path).push(chunk);
    }

    const scoredDocuments = [];

    for (const [docPath, docChunks] of chunksByDocument.entries()) {
      const docH1 = docChunks[0]?.document_title || path.basename(docPath, path.extname(docPath)); // All chunks from same doc share same document_title
      // Infer context of the *candidate document* using H1 and its chunks
      // Pass language of the code snippet for context, could be refined if doc lang is known
      const candidateDocFullContext = await inferContextFromDocumentContent(docPath, docH1, docChunks, language);
      debug(`[analyzeFile] Context for Doc ${docPath}:`, candidateDocFullContext);

      // Chunks in docChunks already have their contextually re-ranked `finalScore` from findSimilarCode
      // We will use this score directly.
      const relevantChunksForDoc = docChunks.filter((c) => c.similarity >= RELEVANT_CHUNK_THRESHOLD); // c.similarity is the finalScore from findSimilarCode

      if (relevantChunksForDoc.length === 0) {
        debug(`[analyzeFile] Doc ${docPath} has 0 chunks meeting RELEVANT_CHUNK_THRESHOLD (${RELEVANT_CHUNK_THRESHOLD}), skipping.`);
        continue;
      }

      const maxChunkScoreInDoc = Math.max(...relevantChunksForDoc.map((c) => c.similarity));
      const avgChunkScoreInDoc = relevantChunksForDoc.reduce((sum, c) => sum + c.similarity, 0) / relevantChunksForDoc.length;
      const numRelevantChunks = relevantChunksForDoc.length;

      // Score based on aggregated quality of its *already contextually-reranked* chunks from findSimilarCode
      let semanticQualityScore = maxChunkScoreInDoc * 0.5 + avgChunkScoreInDoc * 0.3 + Math.min(numRelevantChunks, 5) * 0.04;

      let docLevelContextMatchScore = 0;
      if (
        reviewedSnippetContext.area !== 'Unknown' &&
        candidateDocFullContext.area !== 'Unknown' &&
        candidateDocFullContext.area !== 'General'
      ) {
        if (reviewedSnippetContext.area === candidateDocFullContext.area) {
          docLevelContextMatchScore += 0.8; // VERY_HEAVY_BOOST_DOC_AREA_MATCH
          let techMatch = false;
          for (const tech of reviewedSnippetContext.dominantTech) {
            if (candidateDocFullContext.dominantTech.map((t) => t.toLowerCase()).includes(tech.toLowerCase())) {
              docLevelContextMatchScore += 0.2; // MODERATE_BOOST_DOC_TECH_MATCH
              techMatch = true;
              break;
            }
          }
          debug(
            `[analyzeFile] Doc ${docPath} Area Match! Snippet: ${reviewedSnippetContext.area}, Doc: ${candidateDocFullContext.area}. Tech match: ${techMatch}. Score bonus: ${docLevelContextMatchScore}`
          );
        } else if (reviewedSnippetContext.area !== 'GeneralJS_TS') {
          // Don't penalize if snippet is general JS/TS
          docLevelContextMatchScore -= 0.2; // REDUCED PENALTY - automatic classifier uses different categorization
          debug(
            `[analyzeFile] Doc ${docPath} Area MISMATCH! Snippet: ${reviewedSnippetContext.area}, Doc: ${candidateDocFullContext.area}. Score penalty: -0.8`
          );
        }
      }

      // H1 match to the *overall query context* (file being reviewed)
      // This uses the `analyzedFileEmbedding` (embedding of the file being reviewed)
      // vs the H1 of the candidate doc.
      let docH1RelevanceToReviewedFile = 0;
      if (docH1 && analyzedFileEmbedding) {
        const docH1Embedding = await calculateEmbedding(docH1);
        if (docH1Embedding) {
          docH1RelevanceToReviewedFile = calculateCosineSimilarity(analyzedFileEmbedding, docH1Embedding);
        } else {
          debug(`[analyzeFile] Could not embed H1 for ${docPath}: "${docH1}"`);
        }
      } else if (!analyzedFileEmbedding) {
        debug('[analyzeFile] Cannot calculate docH1RelevanceToReviewedFile, analyzedFileEmbedding is null');
      }
      debug(
        `[analyzeFile] Doc ${docPath} H1 ("${docH1.substring(0, 30)}") relevance to reviewed file: ${docH1RelevanceToReviewedFile.toFixed(
          4
        )}`
      );

      let genericDocPenaltyFactor = 1.0; // No penalty by default

      // Check if document matches generic document pattern
      const isGenericByName = GENERIC_DOC_REGEX.test(docPath);

      // Apply penalty to generic documents
      if (candidateDocFullContext.isGeneralPurposeReadmeStyle || isGenericByName) {
        // Always penalize generic docs unless reviewing DevOps code or has very high context match
        if (reviewedSnippetContext.area !== 'DevOps' && (docLevelContextMatchScore < 0.8 || isGenericByName)) {
          genericDocPenaltyFactor = GENERIC_DOC_PENALTY_FACTOR; // Use the 0.7 factor
          debug(`[analyzeFile] Doc ${docPath} is generic document, applying penalty factor: ${genericDocPenaltyFactor}`);
        }
      }

      // Final Document Score
      let finalDocScore =
        semanticQualityScore * 0.2 + // Quality of its best chunks (already context-ranked by findSimilarCode)
        docLevelContextMatchScore * W_DOC_CONTEXT_MATCH + // Explicit F/E, B/E match based on full doc
        docH1RelevanceToReviewedFile * W_H1_SIM; // H1 of doc vs. content of file being reviewed

      finalDocScore *= genericDocPenaltyFactor; // Apply penalty at the end

      scoredDocuments.push({
        path: docPath,
        score: finalDocScore,
        chunks: docChunks.sort((a, b) => b.similarity - a.similarity), // chunks already have finalScore from findSimilarCode as .similarity
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
    debug('[analyzeFile] Top Scored Documents (after new scoring):');
    scoredDocuments.slice(0, 7).forEach((d) => {
      console.log(
        chalk.cyanBright(
          `  Path: ${d.path}, Score: ${d.score.toFixed(4)}, Area: ${d.debug.area}, Tech: ${d.debug.tech}, Generic: ${
            d.debug.isGenericStyle
          }`
        )
      );
      console.log(
        chalk.gray(
          `    (Debug: SemQ=${d.debug.semanticQualityScore}, CtxMatch=${d.debug.docLevelContextMatchScore}, H1Rel=${d.debug.docH1RelevanceToReviewedFile}, PenaltyF=${d.debug.genericDocPenaltyFactor})`
        )
      );
    });

    // --- Stage 4 (was PHASE 5): SELECT FINAL SNIPPETS FOR LLM ---
    console.log(chalk.blue('--- Stage 4: Selecting Final Snippets for LLM ---'));
    const MAX_FINAL_DOCUMENTS = 4;
    const MAX_CHUNKS_PER_DOCUMENT = 1; // <<< Changed to 1 as per discussion to get best chunk from best docs
    const MIN_DOC_SCORE_FOR_INCLUSION = 0.3; // Minimum score to include a document
    let finalGuidelineSnippets = [];

    // Filter out low-scoring documents and those with area mismatches
    const relevantDocs = scoredDocuments.filter((doc) => {
      // Exclude if score is too low
      if (doc.score < MIN_DOC_SCORE_FOR_INCLUSION) {
        debug(`[analyzeFile] Excluding doc ${doc.path} - score too low: ${doc.score.toFixed(4)}`);
        return false;
      }

      // Exclude if there's a strong area mismatch (unless areas are unknown/general)
      if (
        reviewedSnippetContext.area !== 'Unknown' &&
        doc.debug.area !== 'Unknown' &&
        doc.debug.area !== 'General' &&
        reviewedSnippetContext.area !== doc.debug.area
      ) {
        // Check if it at least has matching technology
        const hasTechMatch = reviewedSnippetContext.dominantTech.some((tech) => doc.debug.tech.toLowerCase().includes(tech.toLowerCase()));
        if (!hasTechMatch) {
          debug(
            `[analyzeFile] Excluding doc ${doc.path} - area mismatch without tech match: ${doc.debug.area} vs ${reviewedSnippetContext.area}`
          );
          return false;
        }
      }

      return true;
    });

    for (const doc of relevantDocs.slice(0, MAX_FINAL_DOCUMENTS)) {
      if (doc.chunks && doc.chunks.length > 0) {
        // Chunks are already sorted by their `similarity` (which is findSimilarCode's finalScore)
        finalGuidelineSnippets.push(doc.chunks[0]);
      }
    }
    // This replaces the old finalGuidelineSnippets selection logic

    console.log(
      chalk.green(
        `Selected ${finalGuidelineSnippets.length} final guideline snippets from ${relevantDocs.length} relevant documents (filtered from ${scoredDocuments.length} scored documents, derived from ${documentChunks.length} initial relevant chunks).`
      )
    );

    // --- Stage 3: PROCESS CODE EXAMPLES ---
    console.log(chalk.blue('--- Stage 3: Processing Code Examples ---'));

    // Filter and process the code examples we got from parallel retrieval
    const uniqueCandidates = [];
    const seenPaths = new Set();
    const normalizedReviewPath = path.resolve(filePath);

    for (const candidate of codeExampleCandidates) {
      // Exclude the file being reviewed and documentation files
      const normalizedCandidatePath = path.resolve(candidate.path);
      if (!seenPaths.has(candidate.path) && !candidate.isDocumentation && normalizedCandidatePath !== normalizedReviewPath) {
        uniqueCandidates.push(candidate);
        seenPaths.add(candidate.path);
      }
    }

    // Sort by relevance and limit
    uniqueCandidates.sort((a, b) => b.similarity - a.similarity);
    const MAX_FINAL_EXAMPLES = 8;
    let finalCodeExamples = uniqueCandidates.slice(0, MAX_FINAL_EXAMPLES);

    // Log if we filtered out the file being reviewed
    const filteredSelf = codeExampleCandidates.some((c) => path.resolve(c.path) === normalizedReviewPath);
    if (filteredSelf) {
      console.log(chalk.yellow(`Filtered out the file being reviewed (${filePath}) from code examples.`));
    }

    console.log(chalk.green(`Found ${finalCodeExamples.length} final code examples from ${codeExampleCandidates.length} candidates.`));

    // Log the top code examples with their similarity scores
    console.log(chalk.cyan('--- Code Examples Found ---'));
    if (finalCodeExamples.length > 0) {
      finalCodeExamples.forEach((ex, idx) => {
        console.log(chalk.cyan(`  [${idx + 1}] ${ex.path} (similarity: ${ex.similarity?.toFixed(3) || 'N/A'})`));
      });
    } else {
      console.log(chalk.cyan('  (None found)'));
    }
    console.log(chalk.cyan('---------------------------'));

    let finalCodeExamplesForContext = finalCodeExamples;

    // --- Stage 4: PREPARE CONTEXT FOR LLM ---
    console.log(chalk.blue('--- Stage 4: Preparing Context for LLM ---'));

    // Format the lists that will be passed
    const formattedCodeExamples = formatContextItems(finalCodeExamplesForContext, 'code');
    const formattedGuidelines = formatContextItems(finalGuidelineSnippets, 'guideline');

    // --- Log the context being sent to the LLM --- >
    console.log(chalk.magenta('--- Guidelines Sent to LLM ---'));
    if (formattedGuidelines.length > 0) {
      formattedGuidelines.forEach((g, i) => {
        console.log(chalk.magenta(`  [${i + 1}] Path: ${g.path} ${g.headingText ? `(Heading: "${g.headingText}")` : ''}`));
        console.log(chalk.gray(`      Content: ${g.content.substring(0, 100).replace(/\n/g, ' ')}...`));
      });
    } else {
      console.log(chalk.magenta('  (None)'));
    }

    console.log(chalk.magenta('--- Code Examples Sent to LLM ---'));
    if (finalCodeExamplesForContext.length > 0) {
      finalCodeExamplesForContext.forEach((ex, i) => {
        console.log(chalk.magenta(`  [${i + 1}] Path: ${ex.path} (Similarity: ${ex.similarity?.toFixed(3) || 'N/A'})`));
        console.log(chalk.gray(`      Content: ${ex.content.substring(0, 100).replace(/\n/g, ' ')}...`));
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
    const analysisResults = await callLLMForAnalysis(context, options);

    return {
      success: true,
      filePath,
      language,
      results: analysisResults,
      context: {
        codeExamples: finalCodeExamples.length,
        guidelines: finalGuidelineSnippets.length,
        prComments: prCommentContext.length,
        prContextAvailable: prContextAvailable,
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
    },
    context: contextSections,
    codeExamples,
    guidelineSnippets,
    metadata: {
      hasCodeExamples: finalCodeExamples.length > 0,
      hasGuidelines: finalGuidelineSnippets.length > 0,
      hasPRHistory: prCommentContext.length > 0,
      analysisTimestamp: new Date().toISOString(),
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
    // Prepare the prompt using the dedicated function
    const prompt = options?.isTestFile ? generateTestFileAnalysisPrompt(context) : generateAnalysisPrompt(context);

    // Call LLM with the prompt
    const llmResponse = await sendPromptToLLM(prompt, {
      temperature: 0, // Force deterministic output
      maxTokens: options.maxTokens || 4096,
      model: options.model || 'claude-3-5-sonnet-20241022', // Using latest model
      isJsonMode: true, // Request JSON output if supported
    });

    // Parse the raw LLM response
    const analysisResponse = parseAnalysisResponse(llmResponse);

    // Return the parsed analysis results
    return analysisResponse;
  } catch (error) {
    console.error(chalk.red(`Error calling LLM for analysis: ${error.message}`));
    console.error(error.stack);
    throw error;
  }
}

// LLM call function
async function sendPromptToLLM(prompt, llmOptions) {
  try {
    // Import the actual LLM module
    const llm = await import('./llm.js');
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
      prHistorySection = `

CONTEXT C: HISTORICAL REVIEW COMMENTS
Similar code patterns and issues identified by human reviewers in past PRs

`;
      prComments.items.forEach((comment, idx) => {
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

  // Corrected prompt with full two-stage analysis + combined output stage
  return `
You are an expert code reviewer acting as a senior developer on this specific project.
Your task is to review the following code file by performing a two-stage analysis based **only** on the provided context, prioritizing documented guidelines and historical review patterns.

FILE TO REVIEW:
Path: ${file.path}
Language: ${file.language}

\`\`\`${file.language}
${file.content}
\`\`\`

CONTEXT FROM PROJECT:

CONTEXT A: EXPLICIT GUIDELINES FROM DOCUMENTATION
${formattedGuidelines}

CONTEXT B: SIMILAR CODE EXAMPLES FROM PROJECT
${formattedCodeExamples}

${prHistorySection}

INSTRUCTIONS:

**Perform the following analysis stages sequentially:**

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
7.  Format the final, consolidated, and prioritized list of issues, along with a brief overall summary, **strictly** according to the JSON structure below.
8.  Respond **only** with the valid JSON object. Do not include any other text before or after the JSON.

JSON Output Structure:
{
  "summary": "Brief summary of the review, highlighting adherence to documented guidelines and consistency with code examples, plus any major issues found.",
  "issues": [
    {
      "type": "bug | improvement | convention | performance | security",
      "severity": "critical | high | medium | low",
      "description": "Description of the issue, clearly stating the deviation from the prioritized project pattern (guideline or example) OR the nature of the bug/improvement.",
      "lineNumbers": [array of relevant line numbers in the reviewed file],
      "suggestion": "Concrete suggestion for fixing the issue or aligning with the prioritized inferred pattern. Ensure the suggestion is additive if adding missing functionality (like a hook) and doesn't wrongly suggest replacing existing, unrelated code."
    }
  ]
}
`;
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

  // Test-specific prompt
  return `
You are an expert test code reviewer acting as a senior developer on this specific project.
Your task is to review the following test file by performing a comprehensive analysis focused on testing best practices and patterns.

TEST FILE TO REVIEW:
Path: ${file.path}
Language: ${file.language}

\`\`\`${file.language}
${file.content}
\`\`\`

CONTEXT FROM PROJECT:

CONTEXT A: TESTING GUIDELINES AND BEST PRACTICES
${formattedGuidelines}

CONTEXT B: SIMILAR TEST EXAMPLES FROM PROJECT
${formattedCodeExamples}

INSTRUCTIONS:

**Perform the following test-specific analysis:**

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
3. Format the output according to the JSON structure below.

JSON Output Structure:
{
  "summary": "Brief summary of the test file review, highlighting coverage completeness, adherence to testing best practices, and any critical issues found.",
  "issues": [
    {
      "type": "bug | improvement | convention | performance | coverage",
      "severity": "critical | high | medium | low",
      "description": "Description of the issue, clearly stating the problem with the test implementation or coverage gap.",
      "lineNumbers": [array of relevant line numbers in the test file],
      "suggestion": "Concrete suggestion for improving the test, adding missing coverage, or following testing best practices."
    }
  ]
}

Respond **only** with the valid JSON object. Do not include any other text before or after the JSON.
`;
}

/**
 * Parse LLM analysis response
 *
 * @param {string} response - LLM response
 * @returns {Object} Parsed analysis results
 */
function parseAnalysisResponse(response) {
  try {
    // First try to parse the response directly as JSON
    try {
      const parsed = JSON.parse(response);
      return parsed;
    } catch (directJsonError) {
      console.log(chalk.yellow('Response is not directly parseable as JSON, trying to extract JSON...'));
    }

    // Try to extract JSON from response with different patterns
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/) || response.match(/{[\s\S]*?}/);

    if (jsonMatch) {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      console.log(chalk.blue('Found potential JSON match:'));
      console.log(chalk.gray(jsonStr.substring(0, DEBUG_PREVIEW_LENGTH) + '... (truncated)'));

      try {
        const parsed = JSON.parse(jsonStr);
        console.log(chalk.green('Successfully extracted and parsed JSON from response'));
        return parsed;
      } catch (parseError) {
        console.warn(chalk.yellow(`Failed to parse extracted JSON: ${parseError.message}`));
      }
    } else {
      console.warn(chalk.yellow('No JSON pattern matched in the response'));
    }

    console.warn(chalk.yellow('Failed to extract valid JSON from response, constructing fallback response'));

    // If JSON extraction fails, construct a basic response with the raw text
    const truncatedResponse =
      response.length > RESPONSE_TRUNCATE_LENGTH ? response.substring(0, RESPONSE_TRUNCATE_LENGTH) + '... (truncated)' : response;
    return {
      summary: 'Analysis was performed but results could not be parsed into the expected format.',
      issues: [
        {
          type: 'improvement',
          severity: 'low',
          description: 'LLM response could not be parsed into structured format',
          lineNumbers: [],
          suggestion: 'Review raw response below for insights',
        },
      ],
      rawResponse: truncatedResponse,
    };
  } catch (error) {
    console.warn(chalk.yellow(`Error parsing LLM response: ${error.message}`));

    // Return a basic valid structure
    return {
      summary: 'Failed to parse LLM response into structured format',
      issues: [],
      error: error.message,
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
    const { dateRange = null, maxComments = 20, similarityThreshold = 0.15, projectPath = process.cwd() } = options;

    // Normalize file path for comparison
    const normalizedPath = path.normalize(filePath);
    const fileExtension = path.extname(normalizedPath);
    const fileName = path.basename(normalizedPath);
    const directoryPath = path.dirname(normalizedPath);

    debug(`[getPRCommentContext] Getting context for ${normalizedPath}`);

    // Import database functions
    const { findRelevantPRComments } = await import('./src/pr-history/database.js');

    // Read the file content to create embedding for semantic search
    let fileContent = '';
    try {
      const fs = await import('node:fs');
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

    // Detect if this is a test file using existing utility
    const isTest = isTestFile(filePath);

    // Truncate content for embedding if too long
    const maxEmbeddingLength = 8000; // Reasonable limit for embedding
    const truncatedContent = fileContent.length > maxEmbeddingLength ? fileContent.substring(0, maxEmbeddingLength) : fileContent;

    // Use semantic search to find similar PR comments
    let relevantComments = [];

    console.log(chalk.blue(`🔍 Searching for PR comments with:`));

    console.log(chalk.gray(`  Project Path: ${projectPath}`));
    console.log(chalk.gray(`  File: ${fileName}`));
    console.log(chalk.gray(`  Similarity Threshold: ${similarityThreshold}`));
    console.log(chalk.gray(`  Content Length: ${truncatedContent.length} chars`));

    try {
      console.log(chalk.blue(`🔍 Attempting hybrid search with chunking...`));
      relevantComments = await findRelevantPRComments(truncatedContent, {
        projectPath,
        limit: maxComments,
        isTestFile: isTest, // Pass test file context for filtering
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
 * Score comment relevance to a specific file path
 */
async function scoreCommentRelevance(comments, targetFilePath, options = {}) {
  const { relevanceThreshold = 0.3 } = options;
  const targetFileName = path.basename(targetFilePath);
  const targetExtension = path.extname(targetFilePath);

  const scoredComments = [];

  for (const comment of comments) {
    let score = 0;

    // Direct file path match (highest score)
    if (comment.file_path === targetFilePath) {
      score += 1.0;
    }
    // File name match in different directory
    else if (comment.file_path && path.basename(comment.file_path) === targetFileName) {
      score += 0.7;
    }
    // Same file extension
    else if (comment.file_path && path.extname(comment.file_path) === targetExtension) {
      score += 0.3;
    }

    // Content relevance based on keywords
    if (comment.body) {
      const contentScore = calculateContentRelevance(comment.body, targetFilePath);
      score += contentScore * 0.5;
    }

    // Review type weighting
    if (comment.comment_type === 'review_comment') {
      score += 0.2; // Inline code comments are more relevant
    }

    // Recency bonus (more recent comments slightly more relevant)
    if (comment.created_at) {
      const daysSinceComment = (Date.now() - new Date(comment.created_at).getTime()) / (1000 * 60 * 60 * 24);
      const recencyBonus = Math.max(0, 0.1 - (daysSinceComment / 365) * 0.1); // Small bonus, decaying over year
      score += recencyBonus;
    }

    // Only include comments above threshold
    if (score >= relevanceThreshold) {
      scoredComments.push({
        ...comment,
        relevanceScore: score,
      });
    }
  }

  return scoredComments;
}

/**
 * Calculate content relevance based on keywords and context
 */
function calculateContentRelevance(commentBody, targetFilePath) {
  if (!commentBody || !targetFilePath) return 0;

  const lowerBody = commentBody.toLowerCase();
  const fileName = path.basename(targetFilePath).toLowerCase();
  const fileNameWithoutExt = path.basename(targetFilePath, path.extname(targetFilePath)).toLowerCase();

  let relevanceScore = 0;

  // File name mentions
  if (lowerBody.includes(fileName)) {
    relevanceScore += 0.5;
  }
  if (lowerBody.includes(fileNameWithoutExt)) {
    relevanceScore += 0.3;
  }

  // Technical keywords that might be relevant
  const technicalKeywords = [
    'function',
    'method',
    'class',
    'component',
    'module',
    'import',
    'export',
    'bug',
    'error',
    'fix',
    'issue',
    'problem',
    'refactor',
    'optimize',
    'test',
    'testing',
    'coverage',
    'performance',
    'security',
    'validation',
  ];

  const keywordMatches = technicalKeywords.filter((keyword) => lowerBody.includes(keyword)).length;

  relevanceScore += Math.min(keywordMatches * 0.05, 0.3); // Cap at 0.3

  return Math.min(relevanceScore, 1.0);
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

export { analyzeFile, getPRCommentContext };
