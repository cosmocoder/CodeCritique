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

    const client = getAnthropicClient();
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
  } catch (error) {
    console.error(chalk.red(`Error sending prompt to Claude: ${error.message}`));
    throw error;
  }
}

export { sendPromptToClaude };
