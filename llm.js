/**
 * LLM Integration Module
 *
 * This module provides functionality to interact with Large Language Models (LLMs)
 * for code analysis and review. Enhanced to leverage project-specific patterns and
 * feedback from PR reviews for more context-aware recommendations.
 * Currently supports Anthropic's Claude Sonnet 3.7.
 */

import { Anthropic } from '@anthropic-ai/sdk';
import chalk from 'chalk';
import dotenv from 'dotenv';

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

export { sendPromptToClaude };
