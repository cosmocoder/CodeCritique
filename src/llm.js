/**
 * LLM Integration Module
 *
 * This module provides functionality to interact with Large Language Models (LLMs)
 * for code analysis and review. Enhanced to leverage project-specific patterns and
 * feedback from PR reviews for more context-aware recommendations.
 * Currently supports Anthropic's Claude Sonnet 4.
 *
 * Prompt Caching:
 * This module uses Anthropic's prompt caching feature for cost optimization.
 * Static content in the system message is cached and reused across multiple
 * requests, reducing input token costs by 75%.
 */

import { Anthropic } from '@anthropic-ai/sdk';
import chalk from 'chalk';
import dotenv from 'dotenv';

// Load env variables if present; do not enforce key at import time
dotenv.config();

let anthropic = null;

/**
 * Get the Anthropic client
 * @returns {Anthropic} The Anthropic client
 */
function getAnthropicClient() {
  if (anthropic) return anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for analysis. Set it in env or .env before running analyze.');
  }
  anthropic = new Anthropic({ apiKey });
  return anthropic;
}

// Default model
const DEFAULT_MODEL = 'claude-sonnet-4-5';

// Maximum tokens for response
const MAX_TOKENS = 4096;

/**
 * Send a prompt to Claude and get a structured JSON response using tool calling.
 * Uses prompt caching for system prompts to reduce token costs.
 *
 * @param {string} prompt - The prompt to send to Claude
 * @param {Object} options - Options for the request
 * @param {string} options.system - System prompt (will be cached for cost optimization)
 * @param {Object} options.jsonSchema - JSON schema for structured output
 * @param {string} options.cacheTtl - Cache TTL: '5m' (default, no extra cost) or '1h' (extended, extra cost for writes)
 * @returns {Promise<Object>} The response from Claude with structured data
 */
async function sendPromptToClaude(prompt, options = {}) {
  const { model = DEFAULT_MODEL, maxTokens = MAX_TOKENS, temperature = 0.7, system = '', jsonSchema = null, cacheTtl = '5m' } = options;

  try {
    console.log(chalk.cyan('Sending prompt to Claude...'));

    const client = getAnthropicClient();

    // Build system content with cache_control for cost optimization
    // The system is passed as an array of blocks with cache_control on the static portion
    // TTL options: '5m' (default, no extra cost) or '1h' (extended, extra cost for cache writes)
    const cacheControl = cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

    const systemContent = system
      ? [
          {
            type: 'text',
            text: system,
            cache_control: cacheControl,
          },
        ]
      : 'You are an expert code reviewer with deep knowledge of software engineering principles, design patterns, and best practices.';

    // Build base request parameters
    const requestParams = {
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemContent,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };

    // Add tool calling if JSON schema is provided
    if (jsonSchema) {
      requestParams.tools = [
        {
          name: 'return_json',
          description: 'Return the final answer strictly as JSON matching the schema.',
          input_schema: jsonSchema,
        },
      ];
      requestParams.tool_choice = { type: 'tool', name: 'return_json' };
    }

    const response = await client.messages.create(requestParams);

    // Log response structure for debugging
    console.log(chalk.gray(`  Response stop_reason: ${response.stop_reason}`));
    console.log(chalk.gray(`  Response content blocks: ${response.content?.length || 0}`));

    // Process response based on whether we used tool calling
    if (jsonSchema) {
      const toolUse = response.content.find((block) => block.type === 'tool_use' && block.name === 'return_json');

      if (!toolUse) {
        // Log actual content for debugging
        console.error(chalk.red('No tool_use block found. Response content:'));
        response.content?.forEach((block, i) => {
          console.error(chalk.gray(`  Block ${i}: type=${block.type}, name=${block.name || 'N/A'}`));
        });
        throw new Error('No structured output received from Claude');
      }

      return {
        content: JSON.stringify(toolUse.input, null, 2),
        model: response.model,
        usage: response.usage,
        json: toolUse.input,
      };
    } else {
      return {
        content: response.content[0]?.text || '',
        model: response.model,
        usage: response.usage,
      };
    }
  } catch (error) {
    console.error(chalk.red(`Error sending prompt to Claude: ${error.message}`));
    throw error;
  }
}

export { sendPromptToClaude };
