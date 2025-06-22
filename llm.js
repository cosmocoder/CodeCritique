/**
 * LLM Integration Module
 *
 * This module provides functionality to interact with Large Language Models (LLMs)
 * for code analysis and review. Enhanced to leverage project-specific patterns and
 * feedback from PR reviews for more context-aware recommendations.
 * Currently supports Anthropic's Claude Sonnet 3.7.
 */

import { Anthropic } from '@anthropic-ai/sdk';
import { detectFileType } from './utils.js';
import { getPromptForFileType } from './config-loader.js';
import chalk from 'chalk';
import dotenv from 'dotenv';
import path from 'path';

// dotenv will automatically load .env from the current working directory
dotenv.config();

// Check if API key is available
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(chalk.red('ERROR: ANTHROPIC_API_KEY not found in environment variables.'));
  console.error(chalk.red('Please provide your API key using one of these methods:'));
  console.error(chalk.red('1. Create a .env file in your project directory with:'));
  console.error(chalk.red('   ANTHROPIC_API_KEY=your_api_key_here'));
  console.error(chalk.red('2. Set the environment variable directly when running the command:'));
  console.error(chalk.red('   ANTHROPIC_API_KEY=your_api_key_here npx ai-code-review analyze ...'));

  // Throw an error to stop script execution
  throw new Error('ANTHROPIC_API_KEY is required for code analysis. Please set it in your environment variables.');
}

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Default model
const DEFAULT_MODEL = 'claude-3-7-sonnet-20250219';

// Maximum tokens for response
const MAX_TOKENS = 4096;

// Token budget estimates
const TOKEN_BUDGET = {
  // Approximate token size for different content types
  codePerLine: 5, // ~5 tokens per line of code
  diffPerLine: 7, // ~7 tokens per line of diff
  patternRule: 20, // ~20 tokens per pattern rule
  patternExample: 30, // ~30 tokens per pattern example
  similarCodeExample: 300, // ~300 tokens per similar code example
  systemPrompt: 150, // ~150 tokens for system prompt
  responseReserve: 4096, // Reserve tokens for model response
};

/**
 * Send a prompt to Claude and get a response
 *
 * @param {string} prompt - The prompt to send to Claude
 * @param {Object} options - Options for the request
 * @returns {Promise<Object>} The response from Claude
 */
async function sendPromptToClaude(prompt, options = {}) {
  const { model = DEFAULT_MODEL, maxTokens = MAX_TOKENS, temperature = 0.7, system = '' } = options;

  try {
    console.log(chalk.cyan('Sending prompt to Claude...'));

    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system:
        system ||
        'You are an expert code reviewer with deep knowledge of software engineering principles, design patterns, and best practices.',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    return {
      content: response.content[0].text,
      model: response.model,
      usage: response.usage,
    };
  } catch (error) {
    console.error(chalk.red(`Error sending prompt to Claude: ${error.message}`));
    throw error;
  }
}

/**
 * Analyze code using Claude
 *
 * @param {string} code - The code to analyze
 * @param {string} filePath - Path to the file being analyzed
 * @param {Object} context - Additional context for the analysis
 * @param {Object} options - Options for the request
 * @returns {Promise<Object>} Analysis results
 */
/**
 * Prioritizes patterns for a specific file review
 *
 * @param {Object} patterns - The full patterns object
 * @param {string} filePath - Path to the file being reviewed
 * @param {number} maxPatterns - Maximum number of patterns to return
 * @returns {Array} Prioritized patterns array
 */
function prioritizePatterns(patterns, filePath, maxPatterns = 10) {
  if (!patterns || Object.keys(patterns).length === 0) {
    return [];
  }

  const fileExtension = path.extname(filePath).replace('.', '');

  // Convert patterns object to array for easier processing
  const patternsArray = Object.values(patterns);

  // Score and sort patterns by relevance
  return patternsArray
    .map((pattern) => {
      let relevanceScore = 0;

      // Base score from confidence
      if (pattern.confidence === 'high') {
        relevanceScore += 3;
      } else if (pattern.confidence === 'medium') {
        relevanceScore += 2;
      } else {
        relevanceScore += 1;
      }

      // Bonus for patterns with high frequency
      if (pattern.frequency > 5) {
        relevanceScore += 2;
      } else if (pattern.frequency > 2) {
        relevanceScore += 1;
      }

      // Bonus for file type match
      if (pattern.fileTypes && pattern.fileTypes.includes(fileExtension)) {
        relevanceScore += 3;
      }

      // Bonus for recently observed patterns (likely more current)
      if (pattern.latestCommentDate) {
        const patternDate = new Date(pattern.latestCommentDate);
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        if (patternDate > threeMonthsAgo) {
          relevanceScore += 1;
        }
      }

      // Bonus for patterns that have user feedback
      if (pattern.feedback && pattern.feedback.totalFeedback > 0) {
        relevanceScore += 1;

        // Additional bonus for patterns that have been promoted based on feedback
        if (pattern.feedback.evolutionStatus === 'promoted') {
          relevanceScore += 2;
        }
      }

      return { ...pattern, relevanceScore };
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxPatterns);
}

/**
 * Optimizes content to fit within token limits
 *
 * @param {Object} content - Content object with different sections
 * @param {number} maxTokens - Maximum tokens available
 * @returns {Object} Optimized content
 */
/**
 * Get related file extensions for a given extension
 *
 * @param {string} extension - The file extension (e.g., '.tsx')
 * @returns {Array<string>} Array of related extensions
 */
function getRelatedExtensions(extension) {
  const ext = extension.toLowerCase();

  // Map of related extensions
  const relatedExtMap = {
    '.tsx': ['.ts', '.jsx', '.js'],
    '.ts': ['.tsx', '.js', '.jsx'],
    '.jsx': ['.tsx', '.js', '.ts'],
    '.js': ['.jsx', '.ts', '.tsx'],
    '.scss': ['.css', '.sass'],
    '.css': ['.scss', '.sass'],
    '.sass': ['.scss', '.css'],
    '.vue': ['.js', '.ts', '.jsx', '.tsx'],
    '.svelte': ['.js', '.ts', '.jsx', '.tsx'],
    '.py': ['.pyi'],
    '.pyi': ['.py'],
    '.rb': ['.rake', '.erb'],
    '.php': ['.phtml'],
    '.java': ['.kt', '.scala'],
    '.kt': ['.java', '.scala'],
    '.c': ['.cpp', '.h', '.cc'],
    '.cpp': ['.c', '.h', '.cc'],
    '.h': ['.c', '.cpp', '.cc'],
    '.go': [],
    '.rs': [],
    '.swift': [],
    '.sh': ['.bash', '.zsh'],
    '.graphql': ['.gql'],
    '.gql': ['.graphql'],
  };

  return relatedExtMap[ext] || [];
}

function optimizeTokenUsage(content, maxTokens = 8000) {
  const { code = '', diff = '', patterns = [], similarCode = [], instructions = '', systemPrompt = '' } = content;

  // Calculate approximate token counts
  const codeTokens = (code.split('\n').length || 0) * TOKEN_BUDGET.codePerLine;
  const diffTokens = diff ? (diff.split('\n').length || 0) * TOKEN_BUDGET.diffPerLine : 0;
  const instructionsTokens = instructions.length / 4; // Rough approximation
  const systemTokens = systemPrompt.length / 4; // Rough approximation

  // Calculate available token budget after reserving for response
  const availableTokens = maxTokens - TOKEN_BUDGET.responseReserve - codeTokens - diffTokens - instructionsTokens - systemTokens;

  if (availableTokens <= 0) {
    // If we're already over budget with essential content, truncate code and diff
    return {
      code: truncateLines(code, Math.floor((maxTokens * 0.3) / TOKEN_BUDGET.codePerLine)),
      diff: truncateLines(diff, Math.floor((maxTokens * 0.1) / TOKEN_BUDGET.diffPerLine)),
      patterns: [],
      similarCode: [],
      instructions,
      systemPrompt,
    };
  }

  // Allocate remaining tokens
  const patternsAllocation = Math.min(availableTokens * 0.5, patterns.length * (TOKEN_BUDGET.patternRule + TOKEN_BUDGET.patternExample));
  const similarCodeAllocation = availableTokens - patternsAllocation;

  // Optimize patterns
  const optimizedPatterns = patterns.slice(0, Math.floor(patternsAllocation / (TOKEN_BUDGET.patternRule + TOKEN_BUDGET.patternExample)));

  // Optimize similar code examples
  const optimizedSimilarCode = similarCode
    .slice(0, Math.floor(similarCodeAllocation / TOKEN_BUDGET.similarCodeExample))
    .map((example) => {
      if (!example) return null;

      const maxContentLength = Math.floor((TOKEN_BUDGET.similarCodeExample * 0.8) / TOKEN_BUDGET.codePerLine);
      return {
        ...example,
        content:
          example.content && example.content.length > maxContentLength
            ? example.content.substring(0, maxContentLength) + '\n// ... truncated'
            : example.content,
      };
    })
    .filter(Boolean);

  return {
    code,
    diff,
    patterns: optimizedPatterns,
    similarCode: optimizedSimilarCode,
    instructions,
    systemPrompt,
  };
}

/**
 * Truncates text to a specified number of lines
 *
 * @param {string} text - Text to truncate
 * @param {number} maxLines - Maximum number of lines
 * @returns {string} Truncated text
 */
function truncateLines(text, maxLines) {
  if (!text) return '';

  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;

  return lines.slice(0, maxLines).join('\n') + '\n// ... content truncated due to size ...';
}

/**
 * Analyze code using Claude with enhanced pattern integration
 *
 * @param {string} code - The code to analyze
 * @param {string} filePath - Path to the file being analyzed
 * @param {Object} context - Additional context for the analysis
 * @param {Object} options - Options for the request
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeCode(code, filePath, context = {}, options = {}) {
  const fileExtension = path.extname(filePath);
  const fileName = path.basename(filePath);

  // Detect file type and language
  const fileTypeInfo = detectFileType(filePath, code);

  // Get the appropriate prompt template for this file type
  const promptTemplate = getPromptForFileType(fileTypeInfo.language || fileTypeInfo.type);

  // Construct system prompt based on detected language and file type
  let systemPrompt =
    'You are an expert code reviewer with deep knowledge of software engineering principles, design patterns, and best practices.';

  if (fileTypeInfo.language) {
    systemPrompt += ` You specialize in ${fileTypeInfo.language} programming`;

    if (fileTypeInfo.framework) {
      systemPrompt += ` and ${fileTypeInfo.framework} framework`;
    }

    systemPrompt += '.';
  }

  systemPrompt += ' Provide clear, actionable feedback that helps improve code quality, maintainability, and performance.';
  systemPrompt += ' Analyze code in the context of team patterns and conventions to ensure consistency across the codebase.';

  // Process and prioritize patterns if available
  let prioritizedPatterns = [];
  if (context.patterns && Object.keys(context.patterns).length > 0) {
    prioritizedPatterns = prioritizePatterns(context.patterns, filePath, 10);
  }

  // Process PR feedback patterns if available
  let prFeedbackPatterns = [];
  if (context.prFeedbackPatterns && context.prFeedbackPatterns.length > 0) {
    prFeedbackPatterns = context.prFeedbackPatterns
      .sort((a, b) => {
        // First sort by confidence
        const confValues = { high: 3, medium: 2, low: 1 };
        const confA = confValues[a.confidence] || 0;
        const confB = confValues[b.confidence] || 0;

        if (confB !== confA) return confB - confA;

        // Then by frequency
        return (b.frequency || 0) - (a.frequency || 0);
      })
      .slice(0, 5);
  }

  // Construct the main prompt using the template
  let prompt = promptTemplate
    .replace('{{fileName}}', fileName)
    .replace('{{fileExtension}}', fileExtension.replace('.', ''))
    .replace('{{language}}', fileTypeInfo.language || '')
    .replace('{{framework}}', fileTypeInfo.framework || '');

  // Add code to the prompt
  prompt += `Please review the following code from file "${fileName}":\n\n`;
  prompt += '```' + fileExtension.replace('.', '') + '\n';
  prompt += code;
  prompt += '\n```\n\n';

  // Add team patterns section
  if (prioritizedPatterns.length > 0) {
    prompt += 'TEAM CODING PATTERNS AND CONVENTIONS:\n';
    prioritizedPatterns.forEach((pattern, i) => {
      prompt += `${i + 1}. ${pattern.rule}\n`;

      // Include examples for high confidence patterns
      if (pattern.confidence === 'high' && pattern.examples && pattern.examples.length > 0) {
        prompt += `   Example: \`${pattern.examples[0]}\`\n`;
      }
      prompt += '\n';
    });
  }

  // Add PR review feedback patterns
  if (prFeedbackPatterns.length > 0) {
    prompt += 'COMMON PATTERNS FROM CODE REVIEWS:\n';
    prFeedbackPatterns.forEach((pattern, i) => {
      prompt += `${i + 1}. ${pattern.rule}\n`;
      if (pattern.examples && pattern.examples.length > 0) {
        prompt += `   Example: \`${pattern.examples[0]}\`\n`;
      }
      prompt += '\n';
    });
  }

  // Add context from project guidelines if available
  if (context.projectGuidelines) {
    // Get the file extension to find relevant patterns
    const fileExt = path.extname(filePath).toLowerCase();
    const langType = fileExt.replace('.', '');

    // Find patterns relevant to this file type
    let relevantPatterns = [];

    // First check for patterns specific to this file extension
    if (context.projectGuidelines[langType] && context.projectGuidelines[langType].patterns) {
      relevantPatterns = context.projectGuidelines[langType].patterns;
    }

    // If we don't have enough patterns, look for patterns in related file types
    // For example, if analyzing a .tsx file, also look at .ts patterns
    if (relevantPatterns.length < 3) {
      const relatedExtensions = getRelatedExtensions(fileExt);

      for (const relExt of relatedExtensions) {
        const relType = relExt.replace('.', '');
        if (context.projectGuidelines[relType] && context.projectGuidelines[relType].patterns) {
          relevantPatterns = [...relevantPatterns, ...context.projectGuidelines[relType].patterns];
          if (relevantPatterns.length >= 5) break;
        }
      }
    }

    // Add the patterns to the prompt
    if (relevantPatterns.length > 0) {
      prompt += '\nSIMILAR CODE FROM THE PROJECT:\n';
      prompt += 'The following are examples of similar code from the project that may provide context:\n';

      relevantPatterns.forEach((pattern, i) => {
        prompt += `\nExample ${i + 1} from ${pattern.path}:\n`;
        prompt += '```\n';
        prompt += pattern.content;
        prompt += '\n```\n';
      });

      prompt +=
        '\nPlease analyze these examples to identify any relevant patterns or conventions that should be applied to the code being reviewed.\n';
    }
  }

  // Add code review rules if available
  if (context.rules) {
    prompt += '\nCode Review Rules:\n';
    prompt += context.rules;
    prompt += '\n';
  }

  // Add similar code examples if available
  const similarCode = context.similarCode || [];

  // Optimize token usage based on content
  const optimizedContent = optimizeTokenUsage({
    code,
    patterns: prioritizedPatterns,
    similarCode: similarCode,
    instructions: prompt,
    systemPrompt,
  });

  // If we had to optimize the content, update the prompt with truncated examples
  if (optimizedContent.similarCode.length > 0) {
    prompt += '\nSimilar code patterns from the codebase:\n';
    optimizedContent.similarCode.forEach((example, index) => {
      prompt += `\nExample ${index + 1} (${example.path}):\n`;
      prompt += '```' + path.extname(example.path).replace('.', '') + '\n';
      prompt += example.content;
      prompt += '\n```\n';
    });
  }

  // Add specific review instructions
  prompt += `\nPlease provide a comprehensive code review that includes:
1. Potential bugs or logical errors
2. Performance issues or optimizations
3. Code style and consistency issues
4. Maintainability concerns
5. Security vulnerabilities (if applicable)
6. Specific suggestions for improvement with code examples
7. How well the code aligns with patterns found in the similar code examples

Format your response as follows:
- Summary: A brief overview of the code quality
- Issues: Numbered list of specific issues found
- Suggestions: Concrete code examples showing how to address each issue
- Best Practices: Additional recommendations for improving the code
- Pattern Alignment: How well the code follows patterns found in the similar code examples
`;

  // Send to Claude
  const analysisOptions = {
    ...options,
    system: systemPrompt,
  };

  const response = await sendPromptToClaude(prompt, analysisOptions);

  // Parse the response
  return {
    analysis: response.content,
    model: response.model,
    usage: response.usage,
    filePath,
    patterns: {
      count: prioritizedPatterns.length,
      prFeedback: prFeedbackPatterns.length,
    },
    fileType: fileTypeInfo,
  };
}

/**
 * Analyze a diff using Claude
 *
 * @param {string} diff - The git diff to analyze
 * @param {string} filePath - Path to the file being analyzed
 * @param {Object} context - Additional context for the analysis
 * @param {Object} options - Options for the request
 * @returns {Promise<Object>} Analysis results
 */
/**
 * Analyze a diff using Claude with enhanced pattern integration
 *
 * @param {string} diff - The git diff to analyze
 * @param {string} filePath - Path to the file being analyzed
 * @param {Object} context - Additional context for the analysis
 * @param {Object} options - Options for the request
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeDiff(diff, filePath, context = {}, options = {}) {
  if (!diff || diff.trim() === '') {
    return {
      analysis: 'No changes detected in the diff.',
      filePath,
    };
  }

  const fileExtension = path.extname(filePath);
  const fileName = path.basename(filePath);

  // Detect file type and language
  const fileTypeInfo = detectFileType(filePath, diff);

  // Get the appropriate prompt template for this file type
  const promptTemplate = getPromptForFileType(fileTypeInfo.language || fileTypeInfo.type);

  // Construct system prompt based on detected language and file type
  let systemPrompt =
    'You are an expert code reviewer specializing in reviewing code changes. Focus on the changes in the diff, not the entire codebase.';

  if (fileTypeInfo.language) {
    systemPrompt += ` You have deep expertise in ${fileTypeInfo.language}`;

    if (fileTypeInfo.framework) {
      systemPrompt += ` and ${fileTypeInfo.framework}`;
    }

    systemPrompt += '.';
  }

  systemPrompt += ' Consider team patterns and conventions when evaluating changes to ensure consistency.';

  // Process and prioritize patterns if available
  let prioritizedPatterns = [];
  if (context.patterns && Object.keys(context.patterns).length > 0) {
    prioritizedPatterns = prioritizePatterns(context.patterns, filePath, 5); // Reduce pattern count for diffs
  }

  // Process PR feedback patterns if available
  let prFeedbackPatterns = [];
  if (context.prFeedbackPatterns && context.prFeedbackPatterns.length > 0) {
    prFeedbackPatterns = context.prFeedbackPatterns
      .sort((a, b) => {
        // First sort by confidence
        const confValues = { high: 3, medium: 2, low: 1 };
        const confA = confValues[a.confidence] || 0;
        const confB = confValues[b.confidence] || 0;

        if (confB !== confA) return confB - confA;

        // Then by frequency
        return (b.frequency || 0) - (a.frequency || 0);
      })
      .slice(0, 3); // Limit to top 3 for diffs
  }

  // Construct the main prompt using the template if available
  let prompt = promptTemplate
    .replace('{{fileName}}', fileName)
    .replace('{{fileExtension}}', fileExtension.replace('.', ''))
    .replace('{{language}}', fileTypeInfo.language || '')
    .replace('{{framework}}', fileTypeInfo.framework || '');

  // Add diff to the prompt
  prompt += `Please review the following code changes (diff) from file "${fileName}":\n\n`;
  prompt += '```diff\n';
  prompt += diff;
  prompt += '\n```\n\n';

  // Add team patterns section
  if (prioritizedPatterns.length > 0) {
    prompt += 'RELEVANT TEAM PATTERNS FOR THIS REVIEW:\n';
    prioritizedPatterns.forEach((pattern, i) => {
      prompt += `${i + 1}. ${pattern.rule}\n`;

      // Include examples for high confidence patterns
      if (pattern.confidence === 'high' && pattern.examples && pattern.examples.length > 0) {
        prompt += `   Example: \`${pattern.examples[0]}\`\n`;
      }
      prompt += '\n';
    });
  }

  // Add PR review feedback patterns
  if (prFeedbackPatterns.length > 0) {
    prompt += 'COMMON FEEDBACK FROM SIMILAR CHANGES:\n';
    prFeedbackPatterns.forEach((pattern, i) => {
      prompt += `${i + 1}. ${pattern.rule}\n`;
      if (pattern.examples && pattern.examples.length > 0) {
        prompt += `   Example: \`${pattern.examples[0]}\`\n`;
      }
      prompt += '\n';
    });
  }

  // Add context if available
  if (context.fileContent) {
    prompt += `For context, here is the full file after changes:\n\n`;
    prompt += '```' + fileExtension.replace('.', '') + '\n';
    prompt += context.fileContent;
    prompt += '\n```\n\n';
  }

  // Add code review rules if available
  if (context.rules) {
    prompt += '\nCode Review Rules:\n';
    prompt += context.rules;
    prompt += '\n';
  }

  // Add similar code examples if available
  const similarCode = context.similarCode || [];

  // Optimize token usage based on content
  const optimizedContent = optimizeTokenUsage({
    code: context.fileContent || '',
    diff,
    patterns: prioritizedPatterns,
    similarCode: similarCode,
    instructions: prompt,
    systemPrompt,
  });

  // If we had to optimize the content, update the prompt with truncated examples
  if (optimizedContent.similarCode.length > 0) {
    prompt += '\nSimilar code patterns from the codebase:\n';
    optimizedContent.similarCode.forEach((example, index) => {
      prompt += `\nExample ${index + 1} (${example.path}):\n`;

      // Safely get file extension
      const fileExt = example.path ? path.extname(example.path).replace('.', '') : '';
      prompt += '```' + fileExt + '\n';
      prompt += example.content;
      prompt += '\n```\n';
    });
  }

  // Add specific review instructions
  prompt += `\nPlease provide a focused review of the changes that includes:
1. Potential bugs or logical errors introduced by the changes
2. Performance implications of the changes
3. How well the changes integrate with the existing code and team patterns
4. Suggestions for improving the changes
5. Any potential side effects or unintended consequences
6. Alignment with team conventions and patterns

Format your response as follows:
- Summary: A brief overview of the quality of the changes
- Pattern Alignment: How well the changes align with team patterns
- Issues: Specific issues found in the changes
- Suggestions: Concrete improvements for each issue
`;

  // Send to Claude
  const analysisOptions = {
    ...options,
    system: systemPrompt,
  };

  const response = await sendPromptToClaude(prompt, analysisOptions);

  // Parse the response
  return {
    analysis: response.content,
    model: response.model,
    usage: response.usage,
    filePath,
    patterns: {
      count: prioritizedPatterns.length,
      prFeedback: prFeedbackPatterns.length,
    },
    fileType: fileTypeInfo,
  };
}

/**
 * Generate a summary of multiple code reviews
 *
 * @param {Array<Object>} reviews - Array of code review results
 * @param {Object} options - Options for the request
 * @returns {Promise<Object>} Summary results
 */
/**
 * Generate a summary of multiple code reviews with enhanced pattern insights
 *
 * @param {Array<Object>} reviews - Array of code review results
 * @param {Object} context - Additional context for the summary
 * @param {Object} options - Options for the request
 * @returns {Promise<Object>} Summary results
 */
async function generateReviewSummary(reviews, context = {}, options = {}) {
  if (!reviews || reviews.length === 0) {
    return {
      summary: 'No reviews to summarize.',
    };
  }

  // Construct system prompt
  const systemPrompt =
    'You are an expert at summarizing code reviews and providing actionable insights for developers. Consider team patterns and conventions when synthesizing recommendations.';

  // Process and prioritize patterns if available
  let projectWidePatterns = [];
  if (context.patterns && Object.keys(context.patterns).length > 0) {
    // For summary, we want the highest confidence patterns regardless of file type
    projectWidePatterns = Object.values(context.patterns)
      .filter((pattern) => pattern.confidence === 'high')
      .sort((a, b) => (b.frequency || 0) - (a.frequency || 0))
      .slice(0, 5);
  }

  // Construct the main prompt
  let prompt = `Please summarize the following code reviews for ${reviews.length} files:\n\n`;

  reviews.forEach((review, index) => {
    // Safely handle review data
    const filePath = review.filePath || 'unknown';
    prompt += `Review ${index + 1}: ${filePath}\n`;
    prompt += '---\n';

    // Safely handle analysis content
    if (review.analysis) {
      prompt += review.analysis.substring(0, 500); // Limit size to avoid token limits
      if (review.analysis.length > 500) prompt += '\n... (truncated)';
    } else {
      prompt += '(Analysis not available)';
    }

    prompt += '\n\n';
  });

  // Add pattern insights
  if (projectWidePatterns.length > 0) {
    prompt += '\nKEY TEAM PATTERNS AND CONVENTIONS:\n';
    projectWidePatterns.forEach((pattern, i) => {
      prompt += `${i + 1}. ${pattern.rule}\n`;
      if (pattern.examples && pattern.examples.length > 0) {
        prompt += `   Example: \`${pattern.examples[0]}\`\n`;
      }
    });
    prompt += '\n';
  }

  // Add PR history insights if available
  if (context.prFeedbackInsights && context.prFeedbackInsights.length > 0) {
    prompt += '\nINSIGHTS FROM PR HISTORY:\n';
    context.prFeedbackInsights.slice(0, 3).forEach((insight, i) => {
      prompt += `${i + 1}. ${insight}\n`;
    });
    prompt += '\n';
  }

  prompt += `\nPlease provide a concise summary that includes:
1. Overall code quality assessment
2. Common issues found across multiple files
3. Prioritized recommendations for improvement
4. Patterns that should be addressed team-wide
5. How well the code aligns with team patterns and conventions
6. Positive aspects of the code that should be maintained

Format your response in a clear, actionable way that helps the development team understand the key takeaways.
Include specific references to team patterns where applicable.`;

  // Send to Claude
  const summaryOptions = {
    ...options,
    system: systemPrompt,
  };

  const response = await sendPromptToClaude(prompt, summaryOptions);

  // Return the summary
  return {
    summary: response.content,
    model: response.model,
    usage: response.usage,
    patternInsights: projectWidePatterns.length > 0,
  };
}

/**
 * Extracts insights from PR history patterns for use in summaries
 *
 * @param {Object} prPatterns - Patterns from PR reviews
 * @returns {Array} Array of insight strings
 */
function extractPRHistoryInsights(prPatterns) {
  if (!prPatterns || Object.keys(prPatterns).length === 0) {
    return [];
  }

  const insights = [];

  // Look for high-acceptance patterns
  const highAcceptancePatterns = Object.values(prPatterns)
    .filter((p) => p.feedback && p.feedback.acceptanceRate > 0.7 && p.feedback.totalFeedback >= 5)
    .slice(0, 3);

  if (highAcceptancePatterns.length > 0) {
    insights.push(
      `The team consistently values ${highAcceptancePatterns.map((p) => p.patternType || 'coding patterns').join(', ')} in code reviews.`
    );
  }

  // Look for frequently mentioned areas
  const frequentPatterns = Object.values(prPatterns)
    .filter((p) => p.frequency > 5)
    .sort((a, b) => (b.frequency || 0) - (a.frequency || 0))
    .slice(0, 3);

  if (frequentPatterns.length > 0) {
    insights.push(`Code reviews frequently focus on ${frequentPatterns.map((p) => p.patternType || 'code quality').join(', ')}.`);
  }

  // Look for patterns with examples
  const patternTypes = new Set();
  Object.values(prPatterns)
    .filter((p) => p.examples && p.examples.length > 0 && p.confidence === 'high')
    .forEach((p) => {
      if (p.patternType) patternTypes.add(p.patternType);
    });

  if (patternTypes.size > 0) {
    insights.push(`The team has established clear conventions for ${Array.from(patternTypes).join(', ')}.`);
  }

  return insights;
}

export { sendPromptToClaude };
