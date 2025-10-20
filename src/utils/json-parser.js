/**
 * JSON Parser Utility - Handles Sonnet 4.5 Markdown-Wrapped JSON Responses
 *
 * This utility provides robust JSON parsing that works with both:
 * - Plain JSON responses (Sonnet 4.1 format)
 * - Markdown code block wrapped JSON (Sonnet 4.5 format)
 */

import chalk from 'chalk';

/**
 * Parse JSON from LLM response, handling markdown code blocks
 * Based on the working parseAnalysisResponse function from rag-analyzer.js
 *
 * @param {string} rawResponse - Raw response from LLM
 * @returns {Object|Array|null} Parsed JSON or null if parsing fails
 */
export function parseJsonFromLLMResponse(rawResponse) {
  try {
    // Strip only the OUTER markdown code fences if present (e.g., ```json...```)
    // This handles Claude Sonnet 4.5 wrapping the entire JSON response in code fences
    // Any markdown within the JSON field values is preserved
    let cleanedResponse = rawResponse.trim();

    // Check if response starts with ```json or ``` and ends with ```
    const codeBlockRegex = /^```(?:json)?\s*\n([\s\S]*)\n```$/;
    const match = cleanedResponse.match(codeBlockRegex);

    if (match) {
      cleanedResponse = match[1].trim();
      console.log(chalk.gray('   🧹 Removed outer code fence wrapper from LLM response'));
    }

    const parsedResponse = JSON.parse(cleanedResponse);
    return parsedResponse;
  } catch (error) {
    console.error(chalk.red(`   ❌ Error parsing LLM response: ${error.message}`));
    console.error(chalk.gray(`   📄 Response starts with: ${rawResponse.substring(0, 100)}...`));
    return null;
  }
}
