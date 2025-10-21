/**
 * LLM Integration Module
 *
 * This module provides functionality to interact with Large Language Models (LLMs)
 * for code analysis and review. Enhanced to leverage project-specific patterns and
 * feedback from PR reviews for more context-aware recommendations.
 * Currently supports Anthropic's Claude Sonnet 4.
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
 * Send a prompt to Claude and get a structured JSON response using tool calling
 *
 * @param {string} prompt - The prompt to send to Claude
 * @param {Object} options - Options for the request
 * @param {Object} options.jsonSchema - JSON schema for structured output
 * @returns {Promise<Object>} The response from Claude with structured data
 */
async function sendPromptToClaude(prompt, options = {}) {
  const { model = DEFAULT_MODEL, maxTokens = MAX_TOKENS, temperature = 0.7, system = '', jsonSchema = null } = options;

  try {
    console.log(chalk.cyan('Sending prompt to Claude...'));

    const client = getAnthropicClient();

    // Use structured output with tool calling if schema is provided
    if (jsonSchema) {
      const tools = [
        {
          name: 'return_json',
          description: 'Return the final answer strictly as JSON matching the schema.',
          input_schema: jsonSchema,
        },
      ];

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        tools,
        tool_choice: { type: 'tool', name: 'return_json' },
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

      // Find the tool_use block and extract the structured data
      const toolUse = response.content.find((block) => block.type === 'tool_use' && block.name === 'return_json');

      if (!toolUse) {
        throw new Error('No structured output received from Claude');
      }

      return {
        content: JSON.stringify(toolUse.input, null, 2), // For backward compatibility
        model: response.model,
        usage: response.usage,
        json: toolUse.input, // The parsed JavaScript object
      };
    } else {
      // Fallback to regular text response
      const response = await client.messages.create({
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
    }
  } catch (error) {
    console.error(chalk.red(`Error sending prompt to Claude: ${error.message}`));
    throw error;
  }
}

export { sendPromptToClaude };
