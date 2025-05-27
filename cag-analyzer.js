/**
 * CAG Analyzer Module
 *
 * This module provides functionality for analyzing code using the cached context
 * in the Cache Augmented Generation (CAG) approach for code review.
 * It identifies patterns, best practices, and generates review comments.
 */

import { calculateCosineSimilarity, calculateEmbedding, findSimilarCode } from './embeddings.js';
import { detectLanguageFromExtension, inferContextFromCodeContent, inferContextFromDocumentContent, shouldProcessFile } from './utils.js';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';

// Debug function for logging
function debug(message) {
  const DEBUG = process.env.DEBUG || false;
  if (DEBUG || process.env.VERBOSE === 'true' || process.argv.includes('--verbose')) {
    console.log(chalk.cyan(`[DEBUG] ${message}`));
  }
}

// Helper function for content scoring (project-agnostic)
function calculateContentScore(content, language) {
  let score = 0;
  if (!content) return 0;

  const lines = content.split('\n');
  const lineCount = lines.length;
  const contentLength = content.length;

  // Basic length heuristic
  if (contentLength > 300) score += 0.05; // Bonus for non-trivial content
  if (contentLength < 150) score -= 0.1; // Penalty for very short

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
  const codeContext = codeSnippet.substring(0, 1500); // Limit snippet length in query
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
    // Priority: 1. Explicit projectPath option, 2. Directory option, 3. File's directory
    const projectPath =
      options.projectPath || (options.directory ? path.resolve(options.directory) : null) || path.dirname(path.resolve(filePath));

    console.log(chalk.gray(`Using project path for embeddings: ${projectPath}`));

    // Read file content
    const content = fs.readFileSync(filePath, 'utf8');
    const language = detectLanguageFromExtension(path.extname(filePath).toLowerCase()); // Get language early for context inference

    // --- PHASE 1: UNDERSTAND THE CODE SNIPPET BEING REVIEWED ---
    const reviewedSnippetContext = inferContextFromCodeContent(content, language);
    debug('[analyzeFile] Reviewed Snippet Context:', reviewedSnippetContext);
    // +++ END +++

    // +++ Get embedding for the file under review (for H1 proxy similarity - can be removed if H1 sim logic changes) +++
    let analyzedFileEmbedding = null;
    if (content.trim().length > 0) {
      analyzedFileEmbedding = await calculateEmbedding(content.substring(0, 10000));
      if (!analyzedFileEmbedding) {
        debug(`[analyzeFile] Could not generate embedding for the content of ${filePath}. H1 proxy similarity will be skipped.`);
      }
    } else {
      debug(`[analyzeFile] Content of ${filePath} is empty. H1 proxy similarity will be skipped.`);
    }
    // +++ END +++

    // Check if file should be processed
    if (!shouldProcessFile(filePath, content)) {
      console.log(chalk.yellow(`Skipping file based on exclusion patterns: ${filePath}`));
      return {
        success: true,
        skipped: true,
        message: 'File skipped based on exclusion patterns',
      };
    }

    // --- Stage 1 (was PHASE 2): GENERATE CONTEXTUAL QUERY FOR DOCUMENTATION ---
    console.log(chalk.blue('--- Stage 1: Generating Contextual Guideline Query ---'));
    const guidelineQuery = createGuidelineQueryForLLMRetrieval(content, reviewedSnippetContext, language);
    console.log(
      chalk.blue('[analyzeFile DEBUG] Using new dynamic guidelineQuery (first 300 chars): '),
      guidelineQuery.substring(0, 300) + '...'
    );

    const GUIDELINE_CANDIDATE_LIMIT = 100; // <<< INCREASED from 30, as findSimilarCode will do more contextual ranking
    const MAX_FINAL_GUIDELINES = 5; // This is for LLM context, might be MAX_FINAL_DOCUMENTS later
    const RELEVANT_CHUNK_THRESHOLD = 0.3; // <<< LOWERED, findSimilarCode's reranking is primary now

    // These weights are for document-level scoring AFTER findSimilarCode returns its contextually ranked chunks
    const W_AVG_CHUNK_SIM = 0.2; // Weight for average chunk similarity (less emphasis now)
    const W_H1_SIM = 0.2; // Weight for H1 proxy similarity (less emphasis now)
    const W_DOC_CONTEXT_MATCH = 0.6; // <<< NEW: Heavy weight for explicit document context match

    // Regex for generic documentation files to be penalized
    const GENERIC_DOC_REGEX = /(README|RUNBOOK|CONTRIBUTING|CHANGELOG|LICENSE|SETUP|INSTALL)(\.md|$)/i;
    const GENERIC_DOC_PENALTY_FACTOR = 0.7;

    // --- Stage 2 (was PHASE 3): RETRIEVE AND CONTEXTUALLY RE-RANK CHUNKS ---
    console.log(chalk.blue('--- Stage 2: Retrieving and Contextually Re-ranking Chunks ---'));
    const guidelineCandidates = await findSimilarCode(guidelineQuery, {
      similarityThreshold: 0.1, // Keep low, let findSimilarCode's reranking and our doc scoring handle it
      limit: GUIDELINE_CANDIDATE_LIMIT, // Pass the increased limit
      queryFilePath: filePath, // For logging or non-path heuristics if any
      searchStrategy: 'hybrid',
      excludeNonDocs: true, // Ensure we are searching document_chunks table
      queryContextForReranking: reviewedSnippetContext, // <<< PASS SNIPPET CONTEXT
      projectPath: projectPath, // Use the determined project path
    });

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
      const candidateDocFullContext = inferContextFromDocumentContent(docPath, docH1, docChunks, language);
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
          docLevelContextMatchScore -= 0.8; // VERY_HEAVY_PENALTY_DOC_AREA_MISMATCH
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
      if (candidateDocFullContext.isGeneralPurposeReadmeStyle && docLevelContextMatchScore < 0.4) {
        genericDocPenaltyFactor = GENERIC_DOC_PENALTY_FACTOR; // Use the 0.7 factor
        debug(`[analyzeFile] Doc ${docPath} is generic and low context match, applying penalty factor: ${genericDocPenaltyFactor}`);
      }

      // Final Document Score
      let finalDocScore =
        semanticQualityScore * W_AVG_CHUNK_SIM + // Quality of its best chunks (already context-ranked by findSimilarCode)
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
          isGenericStyle: candidateDocFullContext.isGeneralPurposeReadmeStyle,
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
    let finalGuidelineSnippets = [];

    for (const doc of scoredDocuments.slice(0, MAX_FINAL_DOCUMENTS)) {
      if (doc.chunks && doc.chunks.length > 0) {
        // Chunks are already sorted by their `similarity` (which is findSimilarCode's finalScore)
        finalGuidelineSnippets.push(doc.chunks[0]);
      }
    }
    // This replaces the old finalGuidelineSnippets selection logic

    console.log(
      chalk.green(
        `Selected ${finalGuidelineSnippets.length} final guideline snippets from ${scoredDocuments.length} scored documents (derived from ${documentChunks.length} initial relevant chunks).`
      )
    );

    // --- Stage 2 of original plan (Code Example Retrieval) becomes Stage 5 here ---
    console.log(chalk.blue('--- Stage 5: Retrieving Code Examples ---'));
    const CODE_EXAMPLE_LIMIT = 60; // Compromise: Capture target file at ~position 52
    const MAX_FINAL_EXAMPLES = 5; // How many to pass to LLM
    const highSimilarityThreshold = 0.9; // Reverted threshold

    // Use file content for finding similar code
    const codeExampleCandidates = await findSimilarCode(content, {
      similarityThreshold: 0.3, // <<< LOWERED: Ensure we don't filter out the expected file
      limit: CODE_EXAMPLE_LIMIT,
      useReranking: false, // <<< DISABLED: Test with no reranking at all
      queryFilePath: filePath,
      // Ensure includeProjectStructure is false for this call if not needed
      includeProjectStructure: false,
      searchStrategy: 'vector_only', // Use pure vector similarity for code
      excludeNonDocs: false,
      searchType: 'code', // Specify that we're searching for code examples
      projectPath: projectPath, // Use the determined project path
    });

    // Filter out any documentation files that might have slipped in
    let finalCodeExamples = codeExampleCandidates.filter((result) => !result.isDocumentation);

    // Always limit to MAX_FINAL_EXAMPLES to provide more context
    finalCodeExamples = finalCodeExamples.slice(0, MAX_FINAL_EXAMPLES);

    console.log(
      chalk.green(
        `Found ${finalCodeExamples.length} final code examples after filtering/limiting ${codeExampleCandidates.length} candidates.`
      )
    );

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

    // --- Prepare Context --- //
    let finalCodeExamplesForContext = [];

    // First, prepare the potential list of final code examples (filtered and limited)
    let potentialFinalCodeExamples = codeExampleCandidates.filter((result) => !result.isDocumentation);
    const topCodeExample = potentialFinalCodeExamples.length > 0 ? potentialFinalCodeExamples[0] : null;

    if (topCodeExample && topCodeExample.similarity >= highSimilarityThreshold) {
      // High similarity: Use ONLY the top code example, NO guidelines
      console.log(chalk.blue(`Using ONLY the top code example and NO guidelines due to high similarity.`));
      finalCodeExamplesForContext = [topCodeExample];
    } else {
      // Lower similarity: Use filtered code examples (limited) and filtered guidelines
      finalCodeExamplesForContext = potentialFinalCodeExamples.slice(0, MAX_FINAL_EXAMPLES);
    }

    // Format the lists that will be passed
    const formattedCodeExamples = finalCodeExamplesForContext.map((example, idx) => ({
      index: idx + 1,
      path: example.path,
      similarity: example.similarity.toFixed(2),
      language: example.language || 'unknown',
      content: example.content, // Assuming truncation happens later or is not needed here
    }));
    const formattedGuidelines = finalGuidelineSnippets.map((guideline, idx) => {
      // Correctly format similarity, handling non-numbers
      const similarityFormatted = typeof guideline.similarity === 'number' ? guideline.similarity.toFixed(2) : 'N/A'; // Default if not a number

      // <<< ADD TRUNCATION FOR GUIDELINES >>>
      const maxLines = 400; // Or choose another limit
      const lines = guideline.content.split('\n');
      const truncatedContent =
        lines.length > maxLines
          ? lines.slice(0, maxLines).join('\n') + `\n... (truncated, ${lines.length - maxLines} more lines)`
          : guideline.content;
      // <<< END TRUNCATION >>>

      return {
        index: idx + 1,
        path: guideline.path,
        headingText: guideline.headingText || null,
        similarity: similarityFormatted,
        language: guideline.language || 'text',
        content: truncatedContent,
        type: guideline.type || 'documentation',
      };
    });

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
      options
    );

    // Call LLM for analysis
    const analysisResults = await callLLMForAnalysis(context, options);

    return {
      success: true,
      filePath,
      language,
      results: analysisResults,
      similarExamples: finalCodeExamples.map((ex) => ({
        path: ex.path,
        similarity: ex.similarity,
      })),
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
 * @param {Object} options - Options
 * @returns {Object} Context for LLM
 */
function prepareContextForLLM(filePath, content, language, finalCodeExamples, finalGuidelineSnippets, options = {}) {
  // Extract file name and directory
  const fileName = path.basename(filePath);
  const dirPath = path.dirname(filePath);
  const dirName = path.basename(dirPath);

  // Format similar code examples
  // console.log(chalk.yellow('[DEBUG] Content of finalCodeExamples BEFORE formatting map:'), finalCodeExamples.map(ex => ({ path: ex.path, similarity: ex.similarity, type: typeof ex.similarity })));

  const codeExamples = finalCodeExamples.map((example, idx) => {
    // Correctly format similarity, handling non-numbers
    const similarityFormatted = typeof example.similarity === 'number' ? example.similarity.toFixed(2) : 'N/A'; // Default if not a number

    const maxLines = 300;
    const lines = example.content.split('\n');
    const truncatedContent =
      lines.length > maxLines
        ? lines.slice(0, maxLines).join('\n') + `\n... (truncated, ${lines.length - maxLines} more lines)`
        : example.content;
    return {
      index: idx + 1,
      path: example.path,
      similarity: similarityFormatted, // Assign the already formatted string
      language: example.language || 'unknown',
      content: truncatedContent,
    };
  });
  // Format guideline snippets
  const guidelineSnippets = finalGuidelineSnippets.map((guideline, idx) => {
    // Correctly format similarity, handling non-numbers
    const similarityFormatted = typeof guideline.similarity === 'number' ? guideline.similarity.toFixed(2) : 'N/A'; // Default if not a number

    // <<< ADD TRUNCATION FOR GUIDELINES >>>
    const maxLines = 400; // Or choose another limit
    const lines = guideline.content.split('\n');
    const truncatedContent =
      lines.length > maxLines
        ? lines.slice(0, maxLines).join('\n') + `\n... (truncated, ${lines.length - maxLines} more lines)`
        : guideline.content;
    // <<< END TRUNCATION >>>

    return {
      index: idx + 1,
      path: guideline.path,
      headingText: guideline.headingText || null,
      similarity: similarityFormatted,
      language: guideline.language || 'text',
      content: truncatedContent,
      type: guideline.type || 'documentation',
    };
  });

  return {
    file: {
      path: filePath,
      name: fileName,
      directory: dirPath,
      directoryName: dirName,
      language,
      content,
    },
    codeExamples,
    guidelineSnippets,
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
    // Extract file information from context
    const { file, codeExamples, guidelineSnippets } = context;

    // Prepare the prompt using the dedicated function
    const prompt = generateAnalysisPrompt(context);

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

  // Corrected prompt with full two-stage analysis + combined output stage
  return `
You are an expert code reviewer acting as a senior developer on this specific project.
Your task is to review the following code file by performing a two-stage analysis based **only** on the provided context, prioritizing documented guidelines.

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

INSTRUCTIONS:

**Perform the following analysis stages sequentially:**

**STAGE 1: Guideline-Based Review**
1.  Analyze the 'FILE TO REVIEW' strictly against the standards, rules, and explanations provided in 'CONTEXT A: EXPLICIT GUIDELINES'.
2.  Identify any specific deviations where the reviewed code violates an explicit guideline. Note the guideline source (path or index) for each deviation found.
3.  Temporarily ignore 'CONTEXT B: SIMILAR CODE EXAMPLES' during this stage.

**STAGE 2: Code Example-Based Review**
1.  Analyze the 'FILE TO REVIEW' against the patterns and implicit conventions demonstrated in 'CONTEXT B: SIMILAR CODE EXAMPLES'. Focus on aspects like coding style, naming, structure, error handling, styling, etc., *especially if they were NOT covered by explicit guidelines in Stage 1*.
2.  Identify any specific deviations where the reviewed code is inconsistent with the patterns shown in the similar code examples. Note the code example source (path or index) for each deviation found.
3.  Pay close attention to high-similarity examples in Context B, as they represent strong evidence of common practices.

**STAGE 3: Consolidate, Prioritize, and Generate Output**
1.  Combine the potential issues identified in Stage 1 (Guideline-Based) and Stage 2 (Example-Based).
2.  **Apply Conflict Resolution AND Citation Rules:**
    *   **Guideline Precedence:** If an issue identified in Stage 2 (from code examples) **contradicts** an explicit guideline from Stage 1, **discard the Stage 2 issue**. Guidelines always take precedence.
    *   **Citation Priority:** When reporting an issue:
        *   If the relevant convention or standard (like translation handling, styling, component structure, etc.) is defined or explained in 'CONTEXT A: EXPLICIT GUIDELINES', you **MUST** cite the specific guideline document (from Context A) as the source in your description. **Under NO circumstances should you cite code examples (Context B) as the source for conventions explicitly covered by the guidelines.**
        *   Only cite code examples (from Context B) as the source for conventions or patterns *not explicitly covered* in the guidelines (Context A).
        *   **Reporting:** If an issue violates both a guideline (Stage 1) and is inconsistent with examples (Stage 2), report it as a violation of the guideline, citing **only** the guideline document from Context A.
3.  Assess for any potential logic errors or bugs within the reviewed code itself, independent of conventions, and include them as separate issues.
4.  Ensure all reported issue descriptions clearly state the deviation/problem and suggestions align with the prioritized context (guidelines first, then examples). Avoid general advice conflicting with context.
5.  Format the final, consolidated, and prioritized list of issues, along with a brief overall summary, **strictly** according to the JSON structure below.
6.  Respond **only** with the valid JSON object. Do not include any other text before or after the JSON.

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
      // console.log(chalk.yellow(`JSON parse error: ${directJsonError.message}`)); // Too verbose for normal runs
    }

    // Try to extract JSON from response with different patterns
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/) || response.match(/{[\s\S]*?}/);

    if (jsonMatch) {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      console.log(chalk.blue('Found potential JSON match:'));
      console.log(chalk.gray(jsonStr.substring(0, 300) + '... (truncated)'));

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
    const truncatedResponse = response.length > 1000 ? response.substring(0, 1000) + '... (truncated)' : response;
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
 * Load project-specific guidelines using embeddings search
 *
 * @param {string} fileContent - Content of the file being analyzed (for similarity search)
 * @param {string} queryFilePath - Path to the file being analyzed (for reranking)
 * @returns {Promise<Array>} Guidelines found through embeddings
 */
async function loadProjectGuidelines(fileContent, queryFilePath, projectPath = null) {
  // Create a query that will find relevant documentation AND conventions
  const baseFileName = queryFilePath ? path.basename(queryFilePath, path.extname(queryFilePath)) : '';
  const guidelineQuery = `
    Project documentation, coding standards, guidelines, and conventions relevant to ${baseFileName}.
    How to implement features like those in ${baseFileName} and follow best practices in this codebase.
    Standard patterns for error handling, testing, component structure, code style, translations used in files like ${baseFileName}.
    ${fileContent.substring(0, 1000)} // Keep increased context from file
  `;

  // *** ADJUST THESE PARAMETERS ***
  const GUIDELINE_RETRIEVAL_LIMIT = 12; // Increased limit further
  const CODE_GUIDELINE_THRESHOLD = 0.6; // Be stricter about code examples
  const MAX_SNIPPET_LENGTH = 5000; // Max characters per snippet (adjust as needed)

  try {
    console.log(chalk.blue('Fetching project guidelines from embeddings...'));

    const guidelineResults = await findSimilarCode(guidelineQuery, {
      similarityThreshold: 0.3, // Reverted threshold back to 0.3
      limit: GUIDELINE_RETRIEVAL_LIMIT, // Get top candidates (limit is 12)
      includeProjectStructure: true,
      useReranking: true, // Keep reranking enabled
      queryFilePath: queryFilePath, // Pass file path for reranking
      projectPath: projectPath || path.dirname(path.resolve(queryFilePath)), // Use passed projectPath or fall back to file directory
    });

    // Log received results (keep this for debugging)
    console.log(chalk.yellow('--- Results received by loadProjectGuidelines ---'));
    console.log(`Received ${guidelineResults?.length || 0} results.`);
    console.log(chalk.yellow('-----------------------------------------------'));

    // --- SIMPLIFIED FILTER LOGIC: Keep all results returned by findSimilarCode within the limit ---
    const guidelineSnippets = guidelineResults.map((guideline, index) => {
      // *** ADD CONTENT TRUNCATION HERE ***
      let truncatedContent = guideline.content || '';
      if (truncatedContent.length > MAX_SNIPPET_LENGTH) {
        debug(
          `[loadProjectGuidelines] Truncating snippet content for: ${guideline.path} (from ${truncatedContent.length} to ${MAX_SNIPPET_LENGTH} chars)`
        );
        truncatedContent = truncatedContent.substring(0, MAX_SNIPPET_LENGTH) + '...';
      }
      // Return the mapped object with potentially truncated content
      return {
        index: index + 1,
        path: guideline.file_path || guideline.path,
        similarity: guideline.similarity,
        language: guideline.language || 'text',
        content: truncatedContent, // Use truncated content
        type: guideline.type || 'documentation',
        headingText: guideline.headingText || null,
      };
    });

    console.log(chalk.green(`Found ${guidelineSnippets.length} guideline snippets after filtering.`));

    // Log if project structure was included
    const hasProjectStructure = guidelineSnippets.some((g) => g.type === 'project-structure');
    if (hasProjectStructure) {
      console.log(chalk.green('Project directory structure included in final guidelines'));
    }

    // If we didn't find any guidelines, add a generic one
    if (guidelineSnippets.length === 0) {
      console.log(chalk.yellow('No project guidelines found in embeddings. Using generic guidelines.'));
      guidelineSnippets.push({
        index: 1,
        path: 'generic-guidelines',
        similarity: 1.0,
        language: '',
        content:
          'No specific project guidelines found. Follow general best practices for the language and maintain consistency with the existing code style.',
        type: 'documentation',
        headingText: null,
      });
    }

    return guidelineSnippets;
  } catch (error) {
    console.error(chalk.red(`Error loading project guidelines: ${error.message}`));
    // Return a basic guideline if there's an error
    return [
      {
        index: 1,
        path: 'generic-guidelines',
        similarity: 1.0,
        language: '',
        content:
          'Error loading project guidelines. Follow general best practices for the language and maintain consistency with the existing code style.',
        type: 'documentation',
        headingText: null,
      },
    ];
  }
}

export { analyzeFile };
